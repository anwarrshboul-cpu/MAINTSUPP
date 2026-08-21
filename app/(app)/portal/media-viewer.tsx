"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * The full-screen media viewer, as monday.com opens a photograph.
 *
 * What was here before was a modal card: a light panel inset 8–24px from the
 * edges with the image squeezed inside it, `<` and `>` glyphs 42px wide, and
 * `src` pointed straight at the original. On a 390px phone that meant a small
 * picture in a small box — and because some of the 2,915 attachments are 4 MB
 * camera JPEGs, tapping one showed an empty grey stage for as long as the
 * download took. Two of the three things monday does were missing outright:
 * there was no swipe, and no zoom.
 *
 * So: a dark full-screen surface, the picture fitted to the whole screen, the
 * 96px thumbnail painted first and the original swapped in behind it when it
 * arrives, swipe between the pictures on the item, pinch and double-tap to
 * zoom, and a toolbar that can rotate, download, delete and close.
 *
 * The transform work is split deliberately between two elements. The track
 * moves horizontally and is the *paging* gesture; the media inside a slide
 * carries scale, pan and rotation. They never both move at once — swiping is
 * only offered at scale 1 — which is what keeps the gesture code legible.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../../components";
import { formatShortDateTime } from "../../lib/format-date";
import "./media-viewer.css";

export interface MediaViewerFile {
  id: string;
  originalName: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  inlineUrl: string;
  downloadUrl: string;
  /**
   * Optional because the list route does not serve it yet — the column exists
   * on `attachments` as `uploaded_by_email`. The patch is in the handover; the
   * viewer simply omits the line until the field arrives rather than printing
   * "Unknown", which is worse than silence.
   */
  uploadedByEmail?: string | null;
}

/** The ceiling on pinch and on the `+` key. Past this a phone photo is mush. */
const MAX_SCALE = 5;
/** Where a double-tap lands. monday jumps to roughly this, not to the ceiling. */
const DOUBLE_TAP_SCALE = 2.5;
/** How far a thumb must travel sideways before it counts as "next picture". */
const SWIPE_DISTANCE = 56;
/** How far down before the drag counts as "put it away". */
const DISMISS_DISTANCE = 120;
/** Two taps closer together than this are one double-tap. */
const DOUBLE_TAP_WINDOW = 320;

/**
 * What belongs in an image viewer.
 *
 * A PDF rendered into an `<img>` is a broken-image glyph, and a Word document
 * is the same. Only pictures and video are shown on the stage; everything else
 * is routed by `openTargetFor` to the place it can actually be read.
 */
export function isViewableMedia(contentType: string) {
  return contentType.startsWith("image/") || contentType.startsWith("video/");
}

export function humanSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(value > 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

/**
 * The glyph for a file that has no picture of its own.
 *
 * A PDF, a spreadsheet and a zip are three different things to someone
 * scanning a column, and one generic square says none of that.
 */
export function glyphFor(contentType: string): IconName {
  if (contentType.startsWith("video/")) return "camera";
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "document";
  if (contentType.includes("spreadsheet") || contentType.includes("excel")) {
    return "grid";
  }
  if (contentType.includes("zip") || contentType.includes("compressed")) {
    return "folder";
  }
  if (contentType.startsWith("text/")) return "list";
  return "document";
}

export type FileOpenTarget =
  | { mode: "viewer" }
  | { mode: "tab"; href: string }
  | { mode: "download"; href: string };

/**
 * Where a tap on a file should go.
 *
 * Pictures and video open the viewer. A PDF opens in its own tab, where the
 * browser's own reader can page through it — the serving route already allows
 * `application/pdf` inline, and nothing else that is not a picture. Everything
 * else downloads, because there is no honest way to show a .docx or a .zip on
 * a phone.
 */
export function openTargetFor(file: {
  contentType: string;
  inlineUrl: string;
  downloadUrl: string;
}): FileOpenTarget {
  if (isViewableMedia(file.contentType)) return { mode: "viewer" };
  if (file.contentType === "application/pdf") {
    return { mode: "tab", href: file.inlineUrl };
  }
  return { mode: "download", href: file.downloadUrl };
}

/** `?thumb=1` on a URL that may already carry a query. */
function thumbUrl(inlineUrl: string) {
  return `${inlineUrl}${inlineUrl.includes("?") ? "&" : "?"}thumb=1`;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high);
}

function formatWhen(value: string) {
  const at = new Date(value);
  // An unreadable stamp shows itself rather than a dash: on a file's own detail
  // line, the raw string is at least evidence of what was stored.
  if (Number.isNaN(at.getTime())) return value;
  return formatShortDateTime(at);
}

/** The part of an email a human reads as a name. */
function uploaderLabel(email: string | null | undefined) {
  if (!email) return null;
  const [name] = email.split("@");
  if (!name) return email;
  return name
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * One picture, drawn twice.
 *
 * The 96px WebP derivative is about 1 KB and is very often already in the
 * browser's cache — it is what the board cell drew. It goes down first, scaled
 * up and blurred, so the stage is never black; the original fades in on top of
 * it when it has decoded. Without this, opening a 4 MB photograph on a phone
 * is several seconds of nothing, which reads as a broken app rather than a
 * slow network.
 *
 * Both neighbours are mounted by the parent, so their thumbnails — and then
 * their originals — are fetched while you are still looking at this one. That
 * is what makes the swipe feel instant.
 */
function MediaSlide({
  file,
  isCurrent,
  transform,
  mediaRef,
}: {
  file: MediaViewerFile;
  isCurrent: boolean;
  transform: string;
  mediaRef?: (element: HTMLElement | null) => void;
}) {
  const [fullLoaded, setFullLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (file.contentType.startsWith("video/")) {
    return (
      <div className="mv-media" ref={mediaRef}>
        <video
          className="mv-video"
          src={file.inlineUrl}
          controls
          playsInline
          preload="metadata"
          // Only the picture on the stage may play. A neighbour that started
          // itself would be sound coming from an image nobody can see.
          autoPlay={isCurrent}
          muted={!isCurrent}
        />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="mv-media" ref={mediaRef}>
        <div className="mv-broken" role="status">
          <Icon name="alert" size={30} />
          <strong>This image could not be loaded</strong>
          <a className="mv-button mv-button--solid" href={file.downloadUrl} download>
            <Icon name="download" size={17} />
            Download instead
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mv-media" ref={mediaRef} style={{ transform }}>
      <img
        className={`mv-image mv-image--thumb${fullLoaded ? " is-hidden" : ""}`}
        src={thumbUrl(file.inlineUrl)}
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable={false}
      />
      <img
        className={`mv-image mv-image--full${fullLoaded ? " is-loaded" : ""}`}
        src={file.inlineUrl}
        alt={file.originalName}
        decoding="async"
        draggable={false}
        onLoad={() => setFullLoaded(true)}
        onError={() => setFailed(true)}
      />
      {!fullLoaded && <span className="mv-spinner" aria-hidden="true" />}
    </div>
  );
}

export function MediaViewer({
  files,
  currentId,
  contextLabel,
  onNavigate,
  onClose,
  onDelete,
}: {
  /** Every picture and video in the cell or section that was opened. */
  files: MediaViewerFile[];
  currentId: string;
  /** Quiet line under the filename — the work order and the column. */
  contextLabel?: string;
  onNavigate: (fileId: string) => void;
  onClose: () => void;
  /** Omitted where the caller cannot delete; the button is then not drawn. */
  onDelete?: (fileId: string) => void | Promise<void>;
}) {
  const index = files.findIndex((file) => file.id === currentId);
  const current = index >= 0 ? files[index] : null;

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [drag, setDrag] = useState({ x: 0, y: 0, active: false });
  const [shownId, setShownId] = useState(currentId);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mediaRef = useRef<HTMLElement | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef({
    mode: "none" as "none" | "swipe" | "pan" | "pinch",
    axis: "" as "" | "x" | "y",
    startX: 0,
    startY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    startScale: 1,
    startDistance: 1,
    startedOnMedia: false,
    moved: false,
    lastTapAt: 0,
    /*
     * How far the finger has travelled, kept here as well as in `drag` state.
     *
     * The state exists to move the track while the finger is down; the ref is
     * what the release is judged against. Reading the state in the pointerup
     * handler is a race — React had not always committed the last pointermove
     * by the time the finger came up, so the handler saw `{0, 0}` and the
     * swipe was silently dropped. It reproduced under load, which is exactly
     * when a phone is most likely to be in this state.
     */
    dx: 0,
    dy: 0,
  });

  const titleId = useId();

  /*
   * Zoom, pan and rotation belong to one picture, not to the viewer.
   *
   * Adjusted during render rather than in an effect: React's own guidance for
   * "reset some state when a prop changes", and the only version of this that
   * does not paint the next photograph at the previous one's zoom for a frame
   * before correcting itself.
   */
  if (shownId !== currentId) {
    setShownId(currentId);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setRotation(0);
    setDrag({ x: 0, y: 0, active: false });
  }

  /*
   * The page behind must not scroll while a full-screen surface is over it.
   * Restoring the previous value rather than clearing it matters: the evidence
   * manager is itself a locking dialog, and clearing would unlock the page
   * underneath it the moment a picture was closed.
   */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /*
   * Focus goes in, and comes back out to wherever it was.
   *
   * `document.activeElement` is read at mount and restored on unmount, so
   * closing with Esc returns the caret to the thumbnail that was tapped and a
   * keyboard user is not dropped at the top of the document.
   */
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, []);

  const goTo = useCallback(
    (nextIndex: number) => {
      const target = files[nextIndex];
      if (target) onNavigate(target.id);
    },
    [files, onNavigate],
  );

  const zoomTo = useCallback((nextScale: number) => {
    const next = clamp(nextScale, 1, MAX_SCALE);
    setScale(next);
    if (next === 1) setOffset({ x: 0, y: 0 });
  }, []);

  /* Esc, the arrows, the zoom keys — the desktop half of the same viewer. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // The evidence manager listens for Escape too. Stopping the event at
        // the window means one press closes one surface, innermost first.
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goTo(index - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goTo(index + 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        goTo(0);
      } else if (event.key === "End") {
        event.preventDefault();
        goTo(files.length - 1);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomTo(scale + 0.5);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomTo(scale - 0.5);
      } else if (event.key === "0") {
        event.preventDefault();
        zoomTo(1);
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        setRotation((value) => (value + 90) % 360);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [files.length, goTo, index, onClose, scale, zoomTo]);

  /**
   * How far the picture may be dragged before it leaves the screen.
   *
   * Measured from the element's layout size rather than its painted rect,
   * because the painted rect already has the scale in it. A quarter-turn swaps
   * the axes, which is why rotation is consulted here.
   */
  const clampOffset = useCallback(
    (next: { x: number; y: number }, atScale: number) => {
      const element = mediaRef.current;
      const stage = stageRef.current;
      if (!element || !stage) return next;
      const quarterTurned = rotation % 180 !== 0;
      const width = (quarterTurned ? element.offsetHeight : element.offsetWidth) * atScale;
      const height = (quarterTurned ? element.offsetWidth : element.offsetHeight) * atScale;
      const limitX = Math.max(0, (width - stage.clientWidth) / 2);
      const limitY = Math.max(0, (height - stage.clientHeight) / 2);
      return {
        x: clamp(next.x, -limitX, limitX),
        y: clamp(next.y, -limitY, limitY),
      };
    },
    [rotation],
  );

  /** Double-tap keeps the tapped point under the finger. */
  const toggleZoomAt = useCallback(
    (clientX: number, clientY: number) => {
      if (scale > 1) {
        setScale(1);
        setOffset({ x: 0, y: 0 });
        return;
      }
      const stage = stageRef.current;
      setScale(DOUBLE_TAP_SCALE);
      if (!stage) return;
      const box = stage.getBoundingClientRect();
      const fromCentreX = clientX - (box.left + box.width / 2);
      const fromCentreY = clientY - (box.top + box.height / 2);
      setOffset(
        clampOffset(
          {
            x: fromCentreX * (1 - DOUBLE_TAP_SCALE),
            y: fromCentreY * (1 - DOUBLE_TAP_SCALE),
          },
          DOUBLE_TAP_SCALE,
        ),
      );
    },
    [clampOffset, scale],
  );

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const gesture = gestureRef.current;
    const pointers = pointersRef.current;
    // Captured so a finger that leaves the stage keeps steering the picture.
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 1) {
      gesture.mode = scale > 1 ? "pan" : "swipe";
      gesture.axis = "";
      gesture.startX = event.clientX;
      gesture.startY = event.clientY;
      gesture.startOffsetX = offset.x;
      gesture.startOffsetY = offset.y;
      gesture.moved = false;
      gesture.dx = 0;
      gesture.dy = 0;
      // Read at press, because pointer capture retargets everything after it
      // to the stage — by pointerup there is no way left to tell whether the
      // press landed on the picture or on the dark around it.
      gesture.startedOnMedia = Boolean(
        (event.target as Element | null)?.closest?.(".mv-media"),
      );
      if (gesture.mode === "swipe") setDrag({ x: 0, y: 0, active: true });
    } else if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      gesture.mode = "pinch";
      gesture.startDistance =
        Math.hypot(first.x - second.x, first.y - second.y) || 1;
      gesture.startScale = scale;
      setDrag({ x: 0, y: 0, active: false });
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;

    if (gesture.mode === "pinch" && pointers.size >= 2) {
      const [first, second] = [...pointers.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const next = clamp(
        gesture.startScale * (distance / gesture.startDistance),
        1,
        MAX_SCALE,
      );
      setScale(next);
      setOffset((current) => clampOffset(current, next));
      return;
    }

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      gesture.moved = true;
      // Lock the axis once, so a slightly diagonal swipe does not both page
      // and dismiss.
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }

    if (gesture.mode === "pan") {
      setOffset(
        clampOffset(
          { x: gesture.startOffsetX + dx, y: gesture.startOffsetY + dy },
          scale,
        ),
      );
    } else if (gesture.mode === "swipe" && gesture.moved) {
      // Upward is resisted: there is nothing above to go to.
      const next =
        gesture.axis === "x"
          ? { x: dx, y: 0 }
          : { x: 0, y: dy > 0 ? dy : dy * 0.2 };
      gesture.dx = next.x;
      gesture.dy = next.y;
      setDrag({ ...next, active: true });
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const pointers = pointersRef.current;
    pointers.delete(event.pointerId);
    const gesture = gestureRef.current;

    if (gesture.mode === "pinch") {
      if (pointers.size === 1) {
        // One finger left: carry on as a pan from where the picture now is.
        const [remaining] = [...pointers.values()];
        gesture.mode = scale > 1 ? "pan" : "swipe";
        gesture.startX = remaining.x;
        gesture.startY = remaining.y;
        gesture.startOffsetX = offset.x;
        gesture.startOffsetY = offset.y;
        gesture.moved = false;
      } else if (pointers.size === 0) {
        gesture.mode = "none";
        if (scale <= 1.02) {
          setScale(1);
          setOffset({ x: 0, y: 0 });
        }
      }
      return;
    }

    /**
     * A press that went nowhere.
     *
     * Shared between the two single-pointer modes because a tap means the same
     * thing in both, and when it was only wired into the swipe branch a
     * double-tap could zoom IN but never back out: past scale 1 the press
     * starts a pan, and the pan branch returned before it ever counted a tap.
     */
    const finishTap = () => {
      if (!gesture.startedOnMedia) {
        // The dark around the picture is a close button, as it is on monday.
        onClose();
        return;
      }
      const now = Date.now();
      if (now - gesture.lastTapAt < DOUBLE_TAP_WINDOW) {
        gesture.lastTapAt = 0;
        toggleZoomAt(event.clientX, event.clientY);
      } else {
        gesture.lastTapAt = now;
      }
    };

    if (gesture.mode === "pan") {
      if (pointers.size === 0) {
        gesture.mode = "none";
        if (!gesture.moved) finishTap();
      }
      return;
    }

    if (gesture.mode !== "swipe") return;
    const { dx: x, dy: y } = gesture;
    setDrag({ x: 0, y: 0, active: false });
    gesture.mode = "none";

    if (!gesture.moved) {
      finishTap();
      return;
    }

    if (gesture.axis === "y" && y > DISMISS_DISTANCE) {
      onClose();
      return;
    }
    if (gesture.axis === "x" && Math.abs(x) > SWIPE_DISTANCE) {
      goTo(x < 0 ? index + 1 : index - 1);
    }
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    pointersRef.current.delete(event.pointerId);
    gestureRef.current.mode = pointersRef.current.size ? gestureRef.current.mode : "none";
    setDrag({ x: 0, y: 0, active: false });
  }

  /** ctrl+wheel is what a trackpad pinch arrives as. */
  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey) return;
    zoomTo(scale - event.deltaY * 0.01);
  }

  /** Tab must not walk out of a modal surface. */
  function handleKeyDownCapture(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const root = rootRef.current;
    if (!root) return;
    const focusable = [
      ...root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.offsetParent !== null || element === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /*
   * Three slides at most: the one being looked at and the one on either side.
   * They are placed by percentage from the current index, so the track only
   * ever carries the drag offset and the arithmetic stays readable.
   */
  const slides = useMemo(
    () =>
      [index - 1, index, index + 1]
        .filter((at) => at >= 0 && at < files.length)
        .map((at) => ({ at, file: files[at] })),
    [files, index],
  );

  /*
   * `document` is read directly rather than behind a mounted flag. The viewer
   * is only ever rendered in response to a tap, so it cannot be part of the
   * server-rendered tree and there is no hydration pass for it to disagree
   * with. The guard is for the server render of the module, not for hydration.
   */
  if (typeof document === "undefined" || !current) return null;

  const uploader = uploaderLabel(current.uploadedByEmail);
  const isImage = current.contentType.startsWith("image/");
  const transform =
    `translate3d(${offset.x}px, ${offset.y}px, 0)` +
    ` scale(${scale}) rotate(${rotation}deg)`;

  return createPortal(
    <div
      className={`mv-root${drag.active ? " is-dragging" : ""}`}
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <header className="mv-bar mv-bar--top">
        <div className="mv-meta">
          <strong id={titleId} title={current.originalName}>
            {current.originalName}
          </strong>
          <small>
            {[
              contextLabel,
              humanSize(current.byteSize),
              uploader ? `Added by ${uploader}` : null,
              formatWhen(current.createdAt),
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </div>
        <p className="mv-counter" aria-live="polite">
          {index + 1} of {files.length}
        </p>
        <button
          className="mv-button"
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close viewer"
        >
          <Icon name="close" size={20} />
        </button>
      </header>

      <div
        className="mv-stage"
        ref={stageRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
      >
        <div
          className="mv-track"
          style={{ transform: `translate3d(${drag.x}px, ${drag.y}px, 0)` }}
        >
          {slides.map(({ at, file }) => (
            <div
              className={`mv-slide${at === index ? " is-current" : ""}`}
              key={file.id}
              style={{ left: `${(at - index) * 100}%` }}
              aria-hidden={at === index ? undefined : true}
            >
              <MediaSlide
                file={file}
                isCurrent={at === index}
                transform={at === index ? transform : "none"}
                mediaRef={
                  at === index
                    ? (element) => {
                        mediaRef.current = element;
                      }
                    : undefined
                }
              />
            </div>
          ))}
        </div>

        {files.length > 1 && (
          <>
            <button
              className="mv-arrow mv-arrow--previous"
              type="button"
              disabled={index === 0}
              onClick={() => goTo(index - 1)}
              aria-label="Previous file"
            >
              <Icon name="chevron" size={22} />
            </button>
            <button
              className="mv-arrow mv-arrow--next"
              type="button"
              disabled={index === files.length - 1}
              onClick={() => goTo(index + 1)}
              aria-label="Next file"
            >
              <Icon name="chevron" size={22} />
            </button>
          </>
        )}
      </div>

      <footer className="mv-bar mv-bar--bottom">
        {isImage && (
          <>
            <button
              className="mv-button"
              type="button"
              onClick={() => zoomTo(scale - 0.5)}
              disabled={scale <= 1}
              aria-label="Zoom out"
            >
              <MinusMark />
            </button>
            <span className="mv-zoom" aria-hidden="true">
              {Math.round(scale * 100)}%
            </span>
            <button
              className="mv-button"
              type="button"
              onClick={() => zoomTo(scale + 0.5)}
              disabled={scale >= MAX_SCALE}
              aria-label="Zoom in"
            >
              <PlusMark />
            </button>
            <button
              className="mv-button"
              type="button"
              onClick={() => setRotation((value) => (value + 90) % 360)}
              aria-label="Rotate 90 degrees"
            >
              <RotateMark />
            </button>
          </>
        )}
        <a
          className="mv-button"
          href={current.downloadUrl}
          download
          aria-label={`Download ${current.originalName}`}
        >
          <Icon name="download" size={19} />
        </a>
        {onDelete && (
          <button
            className="mv-button mv-button--danger"
            type="button"
            onClick={() => void onDelete(current.id)}
            aria-label={`Delete ${current.originalName}`}
          >
            <TrashMark />
          </button>
        )}
      </footer>
    </div>,
    document.body,
  );
}

/*
 * Three marks the shared icon set does not carry.
 *
 * `Icon` has no rotate, no minus and no bin, and the nearest matches would
 * mislead — `refresh` is a sync arrow and `close` is already the close button
 * two places along this same toolbar. Drawn here, at the same 1.7 stroke as
 * the rest, rather than added to a shared file another agent is editing.
 */
function RotateMark() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10a8 8 0 1 0-1.6 6" />
      <path d="M20 4v6h-6" />
    </svg>
  );
}

function TrashMark() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M10 7V5h4v2M6 7l1 12h10l1-12" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

function PlusMark() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M12 6v12M6 12h12" />
    </svg>
  );
}

function MinusMark() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M6 12h12" />
    </svg>
  );
}
