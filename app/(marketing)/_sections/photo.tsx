"use client";

/**
 * Photo slot — ported from the landing page's `.ph` system.
 *
 * The original layers generated SVG artwork underneath a photograph, so a
 * missing or slow file degrades to the artwork rather than a broken image box.
 * That guarantee is kept exactly.
 *
 * ONE DELIBERATE CHANGE. The original painted photographs as CSS
 * `background-image` on a `<div>`, which means all 43 of them carried no alt
 * text at all. Here the photograph is a real `<img>` inside a `<picture>`, so
 * it has alt text and can serve the AVIF and WebP variants that already exist
 * in the repo. Visually identical — same slot, same cover framing, same fade.
 *
 * Retries are preserved too: three attempts with backoff, because a single
 * dropped packet on mobile data should not strand an image for the visit.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { altFor } from "./photo-slot";
import { photoWidths } from "./photo-widths";

export type ArtKind = "city" | "shelf" | "room" | "seats" | "tool" | "stage";

/** Deterministic PRNG — the artwork must be identical on server and client. */
function seeded(n: number) {
  let s = n;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function cityArt(w: number, h: number, uid: string) {
  const r = seeded(20250611);
  const g = h * 0.82;
  let out = "";
  for (let b = 0; b < 3; b++) {
    const op = [0.55, 0.8, 1][b];
    const fill = ["#2A4B6B", "#1B3E60", "#12304D"][b];
    let x = -20;
    while (x < w + 30) {
      const bw = (w / 26) * (0.7 + r() * 1.1);
      const bh = g * (0.18 + r() * (0.2 + b * 0.16));
      const y = g - bh;
      out += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="${fill}" opacity="${op}"/>`;
      const cols = Math.max(2, Math.floor(bw / 16));
      const rows = Math.max(2, Math.floor(bh / 22));
      for (let c = 0; c < cols; c++)
        for (let q = 0; q < rows; q++) {
          if (r() > (b === 2 ? 0.34 : 0.5)) continue;
          const wx = x + 5 + c * (bw / cols);
          const wy = y + 12 + q * (bh / rows);
          if (wy > g - 10) continue;
          out += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="${(bw / cols * 0.45).toFixed(0)}" height="${Math.min(8, bh / rows * 0.5).toFixed(0)}" fill="${r() > 0.7 ? "#8FE3E8" : "#6FD3DA"}" opacity="${(0.2 + r() * 0.6).toFixed(1)}"/>`;
        }
      x += bw + 3 + r() * 14;
    }
  }
  return (
    `<defs><linearGradient id="sk${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#081726"/><stop offset=".45" stop-color="#0E2C46"/><stop offset=".8" stop-color="#22506F"/><stop offset="1" stop-color="#4A4A52"/></linearGradient>` +
    `<linearGradient id="gl${uid}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#E8863C" stop-opacity=".5"/><stop offset="1" stop-color="#0DA1A9" stop-opacity="0"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#sk${uid})"/><rect y="${g - h * 0.42}" width="${w}" height="${h * 0.42}" fill="url(#gl${uid})"/>${out}` +
    `<rect y="${g}" width="${w}" height="${h - g}" fill="#0A1B2B"/>`
  );
}

function shelfArt(w: number, h: number) {
  let out = `<rect width="${w}" height="${h}" fill="#0C2439"/>`;
  for (let i = 0; i < 5; i++) {
    const t = i / 5;
    const x1 = w * (0.06 + t * 0.26);
    const x2 = w * (0.94 - t * 0.26);
    const yt = h * (0.36 + t * 0.1);
    const yb = h * (0.86 - t * 0.16);
    out += `<rect x="${x1.toFixed(0)}" y="${yt.toFixed(0)}" width="${(w * 0.08).toFixed(0)}" height="${(yb - yt).toFixed(0)}" fill="#1B3A5C" opacity="${(0.9 - t * 0.14).toFixed(2)}"/>`;
    out += `<rect x="${(x2 - w * 0.08).toFixed(0)}" y="${yt.toFixed(0)}" width="${(w * 0.08).toFixed(0)}" height="${(yb - yt).toFixed(0)}" fill="#16324F" opacity="${(0.9 - t * 0.14).toFixed(2)}"/>`;
  }
  for (let i = 0; i < 5; i++) {
    const tt = i / 5;
    const lw = w * (0.42 - tt * 0.22);
    out += `<rect x="${(w / 2 - lw / 2).toFixed(0)}" y="${(h * (0.16 + tt * 0.16)).toFixed(0)}" width="${lw.toFixed(0)}" height="${(h * 0.014).toFixed(0)}" rx="3" fill="#FFD9A8" opacity="${(0.85 - tt * 0.1).toFixed(2)}"/>`;
  }
  return out;
}

function roomArt(w: number, h: number, c1 = "#1B3F63", c2 = "#0C2439", uid = "r") {
  return (
    `<defs><linearGradient id="rg${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#rg${uid})"/>` +
    `<path d="M0 ${h}V${h * 0.72}L${w * 0.5} ${h * 0.52}L${w} ${h * 0.72}V${h}Z" fill="#000" opacity=".22"/>` +
    `<circle cx="${w * 0.5}" cy="${h * 0.4}" r="${w * 0.38}" fill="#5FB8BE" opacity=".14"/>` +
    `<rect x="${w * 0.1}" y="${h * 0.14}" width="${w * 0.8}" height="${h * 0.02}" rx="4" fill="#FFE3BC" opacity=".55"/>`
  );
}

function seatsArt(w: number, h: number) {
  let out = `<rect width="${w}" height="${h}" fill="#210C11"/>`;
  out += `<rect x="${w * 0.1}" y="${h * 0.12}" width="${w * 0.8}" height="${h * 0.3}" rx="3" fill="#4A6A8A"/>`;
  out += `<ellipse cx="${w / 2}" cy="${h * 0.3}" rx="${w * 0.6}" ry="${h * 0.28}" fill="#FF9A5C" opacity=".09"/>`;
  for (let r = 0; r < 6; r++) {
    const t = r / 6;
    const y = h * (0.52 + t * 0.4);
    const sw = w * (0.1 + t * 0.05);
    const inset = w * (0.2 - t * 0.2);
    for (let x = inset - sw; x < w - inset; x += sw + 4) {
      out += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${sw.toFixed(0)}" height="${(h * 0.07).toFixed(0)}" rx="5" fill="#5B1B22" opacity="${(0.75 + t * 0.22).toFixed(2)}"/>`;
    }
  }
  return out;
}

function toolArt(w: number, h: number, c1 = "#0B1E29", c2 = "#0DA1A9", glyphPath = "M20 6 9 17l-5-5") {
  return (
    `<rect width="${w}" height="${h}" fill="${c1}"/>` +
    `<circle cx="${w * 0.68}" cy="${h * 0.32}" r="${w * 0.46}" fill="${c2}" opacity=".55"/>` +
    `<circle cx="${w * 0.24}" cy="${h * 0.76}" r="${w * 0.34}" fill="${c2}" opacity=".32"/>` +
    `<g transform="translate(${w * 0.5 - w * 0.18},${h * 0.28}) scale(${w * 0.36 / 24})" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${glyphPath}</g>`
  );
}

function stageArt(w: number, h: number, n = 0, uid = "s") {
  const cols = ["#123A5A", "#16406A", "#1B4670", "#204C78", "#255280", "#2A5888", "#2F5E90"];
  let out = `<defs><linearGradient id="sg${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${cols[n % 7]}"/><stop offset="1" stop-color="#0B2136"/></linearGradient></defs>`;
  out += `<rect width="${w}" height="${h}" fill="url(#sg${uid})"/>`;
  for (let i = 0; i < 7; i++) {
    const cx = w * (0.08 + i * 0.14);
    const on = i <= n;
    out += `<circle cx="${cx.toFixed(0)}" cy="${h * 0.5}" r="${h * (on ? 0.13 : 0.1)}" fill="${on ? "#0DA1A9" : "#ffffff"}" opacity="${on ? 0.9 : 0.16}"/>`;
    if (i < 6) out += `<rect x="${cx + h * 0.15}" y="${h * 0.49}" width="${w * 0.14 - h * 0.3}" height="${h * 0.02}" fill="#fff" opacity="${i < n ? 0.5 : 0.14}"/>`;
  }
  out += `<text x="${w * 0.08 + w * 0.14 * n}" y="${h * 0.53}" text-anchor="middle" style="font:700 ${h * 0.14}px Manrope,sans-serif;fill:#fff">${n + 1}</text>`;
  return out;
}

export type PhotoSlotProps = {
  /** File stem under /assets/photos, e.g. "hero-london-maintenance". */
  slot: string;
  w?: number;
  h?: number;
  art?: ArtKind;
  c1?: string;
  c2?: string;
  /** Glyph for the `tool` artwork. Accepts the raw path `d` string. */
  glyph?: string;
  /** Stage index for the `stage` artwork. */
  n?: number;
  /**
   * Describes the photograph. Optional only because it falls back to the
   * registry in `photo-slot.tsx` — every slot has an entry there, so a
   * photograph can never reach the page undescribed.
   */
  alt?: string;
  /** The source's authoring note. Not rendered; kept for traceability. */
  desc?: string;
  /** `sizes` hint, or the browser guesses wrong and over-fetches. */
  sizes?: string;
  priority?: boolean;
  className?: string;
  children?: ReactNode;
};

export function PhotoSlot({
  slot,
  w = 1200,
  h = 800,
  art = "city",
  c1,
  c2,
  glyph,
  n = 0,
  alt,
  sizes = "(min-width: 1024px) 620px, (min-width: 640px) 50vw, 100vw",
  priority = false,
  className = "",
  children,
}: PhotoSlotProps) {
  // useId rather than Math.random: the artwork is server-rendered, and a random
  // gradient id would differ between server and client and break hydration.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const vw = 800;
  const vh = Math.round(800 * (h / w || 0.66));
  const body =
    art === "shelf" ? shelfArt(vw, vh)
    : art === "room" ? roomArt(vw, vh, c1, c2, uid)
    : art === "seats" ? seatsArt(vw, vh)
    : art === "tool" ? toolArt(vw, vh, c1, c2, glyph)
    : art === "stage" ? stageArt(vw, vh, n, uid)
    : cityArt(vw, vh, uid);

  /*
   * The hero photograph is server-rendered and often finishes decoding before
   * React hydrates and attaches `onLoad` — so the event never fires, the image
   * never gets `.is-loaded`, and it sits at opacity 0 forever behind the
   * artwork. Checking `complete` on the node as it mounts closes that race.
   */
  const measure = (node: HTMLImageElement | null) => {
    if (node?.complete && node.naturalWidth > 0 && !loaded) setLoaded(true);
  };

  // Three attempts with backoff, as the original did.
  useEffect(() => {
    if (!failed || attempt >= 2) return;
    const next = attempt + 1;
    const timer = window.setTimeout(() => {
      setFailed(false);
      setAttempt(next);
    }, next * 800);
    return () => window.clearTimeout(timer);
  }, [attempt, failed]);

  const widths = photoWidths[slot] ?? [];
  const srcSet = (ext: "avif" | "webp") =>
    widths.map((width) => `/assets/photos/${slot}-${width}.${ext} ${width}w`).join(", ");

  return (
    <div className={`ph${className ? ` ${className}` : ""}`}>
      <div
        className="ph__art"
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${body}</svg>`,
        }}
      />
      {!(failed && attempt >= 2) && (
        <picture>
          {widths.length > 0 && (
            <>
              <source type="image/avif" srcSet={srcSet("avif")} sizes={sizes} />
              <source type="image/webp" srcSet={srcSet("webp")} sizes={sizes} />
            </>
          )}
          <img
            key={attempt}
            ref={measure}
            className={`ph__img${loaded ? " is-loaded" : ""}`}
            src={`/assets/photos/${slot}.jpg`}
            alt={alt ?? altFor(slot)}
            sizes={sizes}
            loading={priority ? "eager" : "lazy"}
            decoding={priority ? "sync" : "async"}
            fetchPriority={priority ? "high" : "auto"}
            width={1600}
            height={1000}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        </picture>
      )}
      {children}
    </div>
  );
}
