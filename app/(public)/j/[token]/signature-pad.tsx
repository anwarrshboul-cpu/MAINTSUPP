"use client";

/**
 * Sign here — the contractor's mark at completion.
 *
 * A canvas rather than a typed name, because a typed name is not a signature:
 * it proves somebody could read the keyboard. What this is actually for is the
 * moment six months later when an invoice is queried and somebody asks who
 * said the work was finished. The name, the time and the mark are recorded
 * together on the job.
 *
 * Pointer events, not touch or mouse: one code path covers a finger, a stylus
 * and a mouse, and a stylus on an engineer's tablet is the common case.
 * `touch-action: none` on the canvas is what stops the page scrolling under
 * the hand mid-stroke — without it, signing on a phone scrolls the form away.
 *
 * The canvas is sized from its rendered box multiplied by the device pixel
 * ratio, so a signature drawn on a phone is not a four-pixel-wide smear when
 * it is looked at on a laptop later.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export function SignaturePad({
  onChange,
  disabled = false,
}: {
  /** The PNG data URL, or null once cleared. */
  onChange: (signature: string | null) => void;
  disabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasMark, setHasMark] = useState(false);

  /** Sets the backing store to the rendered size at full device resolution. */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.round(box.width * ratio);
    const height = Math.round(box.height * ratio);
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineWidth = 2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#0b1a24";
  }, []);

  useEffect(() => {
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  const pointAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    // Capture, so a stroke that leaves the canvas still ends cleanly rather
    // than leaving the pad thinking a finger is still down.
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const { x, y } = pointAt(event);
    context.beginPath();
    context.moveTo(x, y);
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    const { x, y } = pointAt(event);
    context.lineTo(x, y);
    context.stroke();
    if (!hasMark) setHasMark(true);
  };

  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // A stroke just ended, so there is a mark by definition.
    onChange(canvas.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasMark(false);
    onChange(null);
  };

  return (
    <div className="signature">
      <div className="signature__head">
        <span>Signature</span>
        <button type="button" onClick={clear} disabled={disabled || !hasMark}>
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="signature__pad"
        // A pointer here is a pen, not a scroll. Without this the page moves
        // under the hand and the signature is a straight line.
        style={{ touchAction: "none" }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        aria-label="Sign to confirm the work is complete"
      />
      <small>
        {hasMark
          ? "Signed. Your name and the time are recorded with the job."
          : "Optional. Sign with a finger, a stylus or a mouse."}
      </small>
    </div>
  );
}
