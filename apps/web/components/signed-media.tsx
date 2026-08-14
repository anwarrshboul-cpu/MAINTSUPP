"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * Rendering a file out of a private bucket.
 *
 * NOTHING IS READABLE BY URL ALONE. `attachments.object_key` is a key, not a
 * location, so `<img src={file.object_key}>` draws a broken image on every job
 * — which is exactly what the portal and the share page did before this
 * component existed. Bytes come back through a signed URL that the API mints
 * only after running the same access check that guards the job the attachment
 * hangs off, and that URL is good for about five minutes.
 *
 * Three consequences shape everything below:
 *
 *   1. The URL CANNOT BE FETCHED ON THE SERVER. A page rendered at build time,
 *      or one whose HTML sits in a CDN for an hour, ships a URL that expired
 *      long before a reader saw it. So the mint happens in the browser, at the
 *      moment the picture is about to be needed.
 *   2. It is minted LAZILY — one request per picture, and only when the tile is
 *      near the viewport. A share link is opened from WhatsApp on mobile data
 *      in a service corridor; a job with twelve photographs must not cost
 *      twelve signed URLs and twelve downloads to read the description.
 *   3. An expired URL is RECOVERABLE. If the browser comes back from the
 *      background and the image 403s, the tile mints a fresh one rather than
 *      leaving a torn-page icon and no way to fix it.
 *
 * The tile reserves its space before any bytes arrive (`aspect-ratio` in
 * globals.css), so a page of photographs never reflows under a reader's thumb.
 */

type SignedResponse = { url: string };

type State = "idle" | "loading" | "ready" | "failed";

export function SignedImage({
  path,
  name,
  note,
  children,
}: {
  /** An endpoint that answers `{ url }`: `/uploads/:id/url` or the share one. */
  path: string;
  name: string;
  /** A short line under the picture — "via share link", "awaiting release". */
  note?: string;
  /** Controls that belong to this picture, rendered under the caption. */
  children?: React.ReactNode;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<State>("idle");
  const [open, setOpen] = useState(false);
  const frame = useRef<HTMLLIElement>(null);
  const alive = useRef(true);
  /* One retry, then the tile admits defeat. A signed URL that fails twice is a
     missing object or a revoked scope, and retrying that forever is a loop. */
  const retried = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const mint = useCallback(async () => {
    setState("loading");
    const result = await api<SignedResponse>(path);
    if (!alive.current) return;
    if (!result.ok || !result.data.url) {
      setState("failed");
      return;
    }
    setUrl(result.data.url);
    setState("ready");
  }, [path]);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    /* No IntersectionObserver (an old WebView) means the picture loads at once
       rather than never — degraded, not broken. Deferred by a tick so the
       fetch, and the state it sets, still start outside the render this effect
       belongs to, exactly as the observer callback would. */
    if (typeof IntersectionObserver === "undefined") {
      const timer = setTimeout(() => {
        void mint();
      }, 0);
      return () => clearTimeout(timer);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void mint();
        }
      },
      // Started a screen early, so the picture is there by the time it is
      // scrolled to rather than blank-then-popping.
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [mint]);

  return (
    <li className={`shot${open ? " is-open" : ""}`} ref={frame}>
      <button
        type="button"
        className="shot__frame"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={name}
      >
        {url ? (
          /* eslint-disable-next-line @next/next/no-img-element -- next/image
             would need this API host in `remotePatterns` and would cache the
             optimised copy far beyond the five minutes the signed URL lives,
             so the second reader gets a 403 baked into the CDN. */
          <img
            src={url}
            alt={name}
            loading="lazy"
            decoding="async"
            onError={() => {
              if (retried.current) {
                setState("failed");
                return;
              }
              // Most likely the URL aged out while the tab was in the
              // background. Mint a new one before calling it broken.
              retried.current = true;
              setUrl(null);
              void mint();
            }}
          />
        ) : (
          <span className="shot__ph">
            {state === "failed" ? "Preview unavailable" : "Loading…"}
          </span>
        )}
      </button>
      <span className="shot__cap" title={name}>
        {name}
      </span>
      {note ? <span className="shot__note">{note}</span> : null}
      {children}
    </li>
  );
}

/**
 * A file that is not a picture — a certificate, an invoice, a method statement.
 *
 * Minted on the click, never before: a URL handed out with the page is dead by
 * the time anyone reads that far. The API answers a PDF with
 * `content-disposition: attachment`, so assigning `location` starts a download
 * and leaves this page where it was — which also sidesteps the popup blocker
 * that would eat an asynchronous `window.open`.
 */
export function SignedFileButton({
  path,
  name,
  size = "sm",
}: {
  path: string;
  name: string;
  /*
   * "sm" (36px) is the default because this button was written for a file row
   * under a 120px thumbnail, where two full-height buttons are wider than the
   * picture they act on. Screens where it is the row's PRIMARY control — a
   * certificate on the compliance register, an invoice's document — pass "md"
   * and get the 44px touch target the rest of the portal uses.
   */
  size?: "sm" | "md";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        className={`p-btn p-btn--ghost${size === "sm" ? " p-btn--sm" : ""}`}
        disabled={busy}
        // The row shows the filename; the button says only "Open", so the
        // accessible name has to carry which file it opens.
        aria-label={`Open ${name}`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await api<SignedResponse>(path);
          setBusy(false);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          window.location.href = result.data.url;
        }}
      >
        {busy ? "Opening…" : "Open"}
      </button>
      {error ? (
        <span className="p-small p-bad" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
