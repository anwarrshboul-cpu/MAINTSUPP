/**
 * THE WEBSITE'S MEDIA LIBRARY — decision K. What may be stored, where it lives,
 * and how the public reaches it. Pure: no database, no storage, no React.
 *
 * SEPARATE FROM THE CUSTOMERS' FILES, LOGICALLY AND PHYSICALLY.
 *
 * A workspace's photographs, certificates and quotes live in the private
 * `job-media` bucket, behind `/api/files` and its authorisation, and nothing
 * here changes that. Website media lives in its own bucket (`cms-media`, the
 * `CMS_BUCKET` binding), in its own tables (`cms_media`, `cms_media_versions`),
 * with no organisation at all — it is MAINTSUPP's own site — and only platform
 * staff may upload, replace, edit, archive or delete it.
 *
 * THE READ MODEL, AND WHY THIS ONE.
 *
 * The bucket stays PRIVATE. The public reads a file through one app route,
 * `/media/<mediaId>/<versionId>/<name>`, which streams it from the bucket with
 * `Cache-Control: public, max-age=31536000, immutable`. Chosen over a public
 * bucket with direct URLs because:
 *   - nothing in storage is listable or guessable from outside: the only way to
 *     a file is a URL the site itself printed;
 *   - it works identically locally (Miniflare R2), on Railway (a directory) and
 *     on Vercel (Supabase Storage), with no host to add to any CSP and no
 *     Supabase URL in the page;
 *   - the response carries this app's own hardening — `nosniff`, a sandboxing
 *     CSP, an allowlisted Content-Type — rather than whatever the provider sends;
 *   - the CDN still does the work: the bytes under a key never change (a
 *     replacement is a new version with a new key), so a file is served from
 *     Vercel's edge after the first request, and the function wakes only on a
 *     miss. `CDN-Cache-Control` holds the edge copy for a day, so a deleted file
 *     stops being served from the edge within one.
 *
 * WHAT IT DOES NOT PROMISE. Anything uploaded here can be seen by anyone who has
 * its address — that is what a website asset is for. It is unlisted, not
 * private. `MEDIA_OMISSIONS` says so on the screen.
 */

import { claimViolation, isMediaIdValue } from "./cms-blocks.ts";
import { typeAgreesWithExtension } from "./file-signature.ts";
import { uploadSizeRefusal } from "./upload-policy.ts";

export type MediaKind = "image" | "video" | "document";

/**
 * The types the website may carry, each with the extensions that honestly name
 * it. Narrower than the documents allowlist on purpose: every one of these is
 * displayed by a visitor's browser, on this origin. No SVG (a script container),
 * no HEIC (browsers cannot draw it — convert to JPEG), no QuickTime (Safari
 * only — export as MP4), no Office files (download them from a page as a PDF).
 */
export const CMS_MEDIA_TYPES: Readonly<Record<string, { kind: MediaKind; extensions: readonly string[] }>> = {
  "image/jpeg": { kind: "image", extensions: ["jpg", "jpeg"] },
  "image/png": { kind: "image", extensions: ["png"] },
  "image/webp": { kind: "image", extensions: ["webp"] },
  "image/gif": { kind: "image", extensions: ["gif"] },
  "video/mp4": { kind: "video", extensions: ["mp4"] },
  "video/webm": { kind: "video", extensions: ["webm"] },
  "application/pdf": { kind: "document", extensions: ["pdf"] },
};

/** What the upload control accepts — the same list, for the browser's file picker. */
export const CMS_MEDIA_ACCEPT = Object.entries(CMS_MEDIA_TYPES)
  .flatMap(([type, entry]) => [type, ...entry.extensions.map((extension) => `.${extension}`)])
  .join(",");

const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/**
 * The type and kind of a file offered for upload, or null. BOTH halves of the
 * claim — the declared type and the extension — must be on the list and must
 * agree with each other (`typeAgreesWithExtension`), for the reason
 * `/api/files/multipart` gives: `x.png` declared `text/html` must never pass on
 * its name. A missing type is read from the extension; the bytes are checked
 * against it once they are stored (`signatureMatches`).
 */
export function mediaTypeFor(originalName: string, declaredType: string): { type: string; kind: MediaKind } | null {
  const extension = extensionOf(originalName);
  const declared = (declaredType ?? "").trim().toLowerCase();
  const type =
    declared && declared !== "application/octet-stream"
      ? declared
      : Object.keys(CMS_MEDIA_TYPES).find((candidate) => CMS_MEDIA_TYPES[candidate].extensions.includes(extension));
  if (!type) return null;
  const entry = CMS_MEDIA_TYPES[type];
  if (!entry || !entry.extensions.includes(extension)) return null;
  if (!typeAgreesWithExtension(type, originalName)) return null;
  return { type, kind: entry.kind };
}

/** The one size policy (`upload-policy.ts`): video 50 MB, everything else 25 MB. */
export function mediaSizeRefusal(kind: MediaKind, byteSize: number): string | null {
  return uploadSizeRefusal(kind === "video", byteSize);
}

/* ------------------------------------------------------------------ */
/* Ids, keys and addresses                                             */
/* ------------------------------------------------------------------ */

const MEDIA_ID = /^med_[a-f0-9]{32}$/;
const VERSION_ID = /^mv_[a-f0-9]{32}$/;
const MEDIA_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export const newMediaId = () => `med_${crypto.randomUUID().replace(/-/g, "")}`;
export const newVersionId = () => `mv_${crypto.randomUUID().replace(/-/g, "")}`;

/* The block validator's own check (`cms-blocks.ts` cannot import this file). */
export const isMediaId = (value: unknown): value is string => isMediaIdValue(value) && MEDIA_ID.test(value);
export const isVersionId = (value: unknown): value is string => typeof value === "string" && VERSION_ID.test(value);

/** The web-sized rendition's name, beside the original. Never an upload's own name. */
export const DISPLAY_RENDITION = "display.webp";

/**
 * The file name as it appears in the key and the URL: lower-case letters,
 * digits, dots, hyphens and underscores, its real extension kept. Nothing a URL
 * has to encode, so the address the page prints is exactly the key it reads.
 */
export function mediaFileName(originalName: string, fallback = "file"): string {
  const extension = extensionOf(originalName);
  const stem = originalName
    .slice(0, originalName.length - (extension ? extension.length + 1 : 0))
    .normalize("NFKD")
    /* The accents NFKD separated out go, rather than becoming hyphens: "Façade" is "facade". */
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const name = `${stem || fallback}${extension ? `.${extension}` : ""}`;
  /* An upload may not take the rendition's name: the two would share a key. */
  if (name === DISPLAY_RENDITION) return `original-${DISPLAY_RENDITION}`;
  return MEDIA_NAME.test(name) ? name : `${fallback}${extension ? `.${extension}` : ""}`;
}

/**
 * Where a version's bytes live. Every key is under `cms/` and names its asset and
 * its version, so a key is never reused: a replacement is a new version id and
 * therefore a new key, which is what makes `immutable` true.
 */
export function mediaObjectKey(mediaId: string, versionId: string, name: string): string {
  return `cms/${mediaId}/${versionId}/${name}`;
}

/** The public address of a key the site stores. */
export function mediaUrl(objectKey: string): string {
  return `/${objectKey.replace(/^cms\//, "media/")}`;
}

/**
 * An asset named by its public address inside ordinary text — a `cta` block's
 * href, a link in a body. Global, and the id is group 1. See `mediaIdsIn`.
 */
const MEDIA_PATH_IN_TEXT = /\/media\/(med_[a-f0-9]{32})\//g;

/**
 * The key a public `/media/...` request names, or null. The three segments are
 * checked against their own shapes before any storage call, so nothing but a
 * well-formed website key can ever be read through the route.
 */
export function keyFromMediaPath(mediaId: unknown, versionId: unknown, name: unknown): string | null {
  if (!isMediaId(mediaId) || !isVersionId(versionId)) return null;
  if (typeof name !== "string" || !MEDIA_NAME.test(name) || name.includes("..")) return null;
  return mediaObjectKey(mediaId, versionId, name);
}

/** The prefix every key of one version shares — what `complete` checks a session's key against. */
export function versionPrefix(mediaId: string, versionId: string): string {
  return `cms/${mediaId}/${versionId}/`;
}

/* ------------------------------------------------------------------ */
/* What the public route may send                                      */
/* ------------------------------------------------------------------ */

/**
 * The only types the public route will send, and the only way it sets a
 * Content-Type: from this list, never from the object's own metadata. Anything
 * else — which the upload path cannot store — is refused rather than served.
 */
export const SERVABLE_MEDIA_TYPES = new Set([...Object.keys(CMS_MEDIA_TYPES)]);

/**
 * What the response may do once a browser has it: nothing. It may not script,
 * fetch, or be treated as same-origin; an image may be drawn and a video played.
 */
export const MEDIA_RESPONSE_CSP =
  "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

/** Browsers keep a file for a year and never revalidate it: the bytes under a key never change. */
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Vercel's edge keeps its copy a day, so a deleted file stops being served from the edge within one. */
export const MEDIA_CDN_CACHE_CONTROL = "public, max-age=86400";

/* ------------------------------------------------------------------ */
/* Image dimensions, read from the bytes                               */
/* ------------------------------------------------------------------ */

/** How much of an image is read to find its size. JPEG's size can follow a long EXIF block. */
export const DIMENSION_BYTES = 256 * 1024;

const u16be = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1];
const u16le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8);
const u24le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
const u32be = (bytes: Uint8Array, at: number) =>
  ((bytes[at] << 24) >>> 0) + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
const tag = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

/**
 * An image's width and height, from its own header — never from what the
 * browser said. Null when the bytes do not say (a truncated read, a malformed
 * file): the image is then stored without dimensions and drawn without them.
 */
export function imageDimensions(type: string, bytes: Uint8Array): { width: number; height: number } | null {
  const valid = (width: number, height: number) =>
    width > 0 && height > 0 && width <= 50_000 && height <= 50_000 ? { width, height } : null;
  if (type === "image/png" && bytes.length >= 24 && tag(bytes, 12) === "IHDR") {
    return valid(u32be(bytes, 16), u32be(bytes, 20));
  }
  if (type === "image/gif" && bytes.length >= 10) return valid(u16le(bytes, 6), u16le(bytes, 8));
  if (type === "image/webp" && bytes.length >= 16 && tag(bytes, 0) === "RIFF" && tag(bytes, 8) === "WEBP") {
    const chunk = tag(bytes, 12);
    if (chunk === "VP8 " && bytes.length >= 30) return valid(u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
    if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      return valid(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
    if (chunk === "VP8X" && bytes.length >= 30) return valid(1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
    return null;
  }
  if (type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker === 0xff) {
        at += 1; // fill byte
        continue;
      }
      /* Markers with no length: TEM, RST0–7, SOI, EOI. */
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2;
        continue;
      }
      /* Start of frame (every SOFn but DHT C4, JPG C8 and DAC CC). */
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return valid(u16be(bytes, at + 7), u16be(bytes, at + 5));
      }
      at += 2 + u16be(bytes, at + 2);
    }
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

export const MEDIA_RULES = { titleMax: 120, altMax: 300, captionMax: 300 } as const;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * A title and alt text as submitted, cleaned — or why not. Alt text is public
 * (it is what a screen reader says and what a search engine indexes), so it is
 * held to the site's copy rules like any other published word.
 */
export function cleanMediaMeta(input: { title?: unknown; altText?: unknown }):
  | { ok: true; title?: string; altText?: string | null }
  | { ok: false; reason: string } {
  const out: { ok: true; title?: string; altText?: string | null } = { ok: true };
  if (input.title !== undefined) {
    const title = text(input.title, MEDIA_RULES.titleMax);
    if (!title) return { ok: false, reason: `A title is 1–${MEDIA_RULES.titleMax} characters.` };
    out.title = title;
  }
  if (input.altText !== undefined) {
    if (input.altText !== null && typeof input.altText !== "string") return { ok: false, reason: "Alt text must be text." };
    const altText = text(input.altText, MEDIA_RULES.altMax);
    const broken = altText ? claimViolation(altText) : null;
    if (broken) return { ok: false, reason: `Alt text: ${broken}.` };
    out.altText = altText;
  }
  return out;
}

/** A title from a file name, for an upload that did not name one. */
export function titleFromFileName(originalName: string): string {
  const stem = originalName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return (stem || "Untitled").slice(0, MEDIA_RULES.titleMax);
}

/* ------------------------------------------------------------------ */
/* Where an asset is used                                              */
/* ------------------------------------------------------------------ */

/**
 * Every media id a block body names, at any depth — what "in use" is measured by.
 *
 * TWO WAYS TO NAME ONE, because there are two ways to use one. An `image` or a
 * `video` block EMBEDS an asset and carries its id in `mediaId`. Everything else
 * can only LINK to one — a `cta` block's href, a link inside a body — and that is
 * a `/media/med_…/mv_…/name.pdf` address sitting in an ordinary string. A PDF is
 * in this library precisely so that it can be linked, so counting `mediaId` alone
 * meant a brochure in use on a LIVE page read as "Not used yet": Delete stayed
 * enabled, the 409 never fired, and the delete 404ed a link on a published page.
 * Every string value is therefore scanned for the public address as well, under
 * any key and at any depth — which also counts the next block kind that links
 * rather than embeds, with no change here.
 */
export function mediaIdsIn(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (node: unknown, key?: string) => {
    if (typeof node === "string") {
      if (key === "mediaId" && isMediaId(node)) found.add(node);
      for (const match of node.matchAll(MEDIA_PATH_IN_TEXT)) found.add(match[1]);
      return;
    }
    if (Array.isArray(node)) node.forEach((entry) => visit(entry));
    else if (node && typeof node === "object") {
      for (const [name, child] of Object.entries(node as Record<string, unknown>)) visit(child, name);
    }
  };
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  visit(parsed);
  return [...found];
}

/**
 * What the library deliberately does not do, printed on the screen from here
 * so the screen and the tests read one list.
 */
export const MEDIA_OMISSIONS: readonly string[] = [
  "Anything uploaded here can be seen by anyone who has its address — it is a website asset. It is unlisted (nothing in storage can be browsed from outside), not private. Never upload a customer's document here; those belong in a workspace.",
  "Images, MP4 and WebM video, and PDFs only. SVG is refused (it can carry script), HEIC is refused (browsers cannot display it — save it as JPEG), and QuickTime is refused (it plays in Safari only — export it as MP4). Video up to 50 MB, everything else up to 25 MB.",
  "Replacing a file keeps the same asset: every page that uses it shows the new file straight away, and the earlier file stays in its history until the asset is deleted, so a replacement can be undone. The previous file's own address keeps working until then.",
  "An asset used on any website page — live or draft — cannot be deleted; archive it instead. Archived assets keep working where they are used and leave the picker. A version of a page recorded in its history is not counted as a use, so restoring an old version that named a deleted asset is refused.",
  "A deleted file stops being served at once by the site, and within a day by the CDN's edge; a visitor's browser may keep a copy it already has.",
  "A delete reads where the asset is used and then removes the files; the two are not one step. An asset put onto a page in the moment between them loses its file, and the page then shows a broken image until another is chosen. Only platform staff can do either, so the window is small — but it exists.",
  "A delete removes the files first and the asset second. If it stops in between, the asset is still listed but its files are gone, so it shows as broken until the delete is run again — which finishes it. Nothing is ever left the other way round: an asset that is still listed has never had its files removed silently.",
  "Images are shown in a web-sized copy made in your browser at upload (up to 1600 pixels, WebP). A browser that cannot make one (Safari cannot encode WebP) uploads the original only, and pages show the original.",
];
