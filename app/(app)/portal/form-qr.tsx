"use client";

import { useMemo } from "react";
import qrcode from "qrcode-generator";
import { Icon } from "../../components";

/**
 * A QR CODE FOR THE FORM'S SHARE LINK.
 *
 * Drawn in the browser from the exact string the Copy button copies
 * (`form.presentedUrl`), so the code, the link on screen and the link in the
 * clipboard are always the same link — rotate the token or switch Shorten URL
 * and the code changes with them. Nothing is sent anywhere to make it: a
 * third-party QR service would be handed every workspace's live intake link.
 *
 * Dark modules on a white field with a four-module quiet zone, whatever the
 * dashboard's theme — a code drawn in brand colours or on a dark background is
 * a code a cheap phone camera fails to read.
 */

const QUIET = 4;

function matrixFor(text: string) {
  /* Type 0 picks the smallest version that fits; level M survives a scuffed
     printout without making a short link needlessly dense. */
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const dark: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col += 1) line.push(qr.isDark(row, col));
    dark.push(line);
  }
  return { size, dark };
}

function fileNameFor(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "form"}-qr-code.png`;
}

export default function FormQrCode({ url, title }: { url: string; title: string }) {
  const matrix = useMemo(() => (url ? matrixFor(url) : null), [url]);

  /* One SVG path for every dark module: crisp at any zoom, and tiny. */
  const path = useMemo(() => {
    if (!matrix) return "";
    const parts: string[] = [];
    matrix.dark.forEach((line, row) =>
      line.forEach((on, col) => {
        if (on) parts.push(`M${col + QUIET} ${row + QUIET}h1v1h-1z`);
      }),
    );
    return parts.join("");
  }, [matrix]);

  if (!matrix) return null;
  const span = matrix.size + QUIET * 2;

  /**
   * A print-ready PNG: the code at 16px a module, with the form's name under
   * it so a code taped up beside a till says what it is for.
   */
  function download() {
    if (!matrix) return;
    const scale = 16;
    const caption = 56;
    const canvas = document.createElement("canvas");
    canvas.width = span * scale;
    canvas.height = span * scale + caption;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    matrix.dark.forEach((line, row) =>
      line.forEach((on, col) => {
        if (on) context.fillRect((col + QUIET) * scale, (row + QUIET) * scale, scale, scale);
      }),
    );
    context.font = "600 26px system-ui, -apple-system, Segoe UI, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(title, canvas.width / 2, span * scale + caption / 2 - 8, canvas.width - 32);
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = fileNameFor(title);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <section className="form-qr" aria-label="QR code for this form">
      <svg
        className="form-qr__code"
        viewBox={`0 0 ${span} ${span}`}
        role="img"
        aria-label={`QR code that opens ${title}`}
        shapeRendering="crispEdges"
      >
        <rect width={span} height={span} fill="#ffffff" />
        <path d={path} fill="#000000" />
      </svg>
      <div className="form-qr__side">
        <strong>QR code</strong>
        <span>
          Scanning it opens this form. Download it to print, put on a card or send to
          another store.
        </span>
        <button type="button" className="form-qr__download" onClick={download}>
          <Icon name="download" size={15} />
          Download QR code
        </button>
      </div>
    </section>
  );
}
