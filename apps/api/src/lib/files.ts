/**
 * What may be uploaded, decided from the bytes.
 *
 * THE DECLARED CONTENT TYPE IS NOT EVIDENCE. `Content-Type` in a multipart part
 * is a string the client chose; so is the filename and so is its extension.
 * Accepting either as proof is how a bucket that "only holds photographs" ends
 * up holding an HTML page that runs on the API's origin, or a 400MB file that
 * a browser announced as 2KB.
 *
 * So every upload is checked twice:
 *   1. against the real byte length, after the body has been read;
 *   2. against the file's magic number, which is the only claim the file makes
 *      about itself that it cannot lie about without ceasing to be that file.
 *
 * The sniffed type wins and is what gets stored, and the extension on disk is
 * derived from the sniffed type — never from the name the client sent.
 */
import { randomUUID } from "node:crypto";

/**
 * 10MB.
 *
 * A phone photograph off a modern handset is 2-6MB; an iPhone HEIC is closer to
 * 2MB and the JPEG the same camera produces is 4-5MB. 10MB clears both with
 * room for a large PDF certificate, and is small enough that a hundred queued
 * uploads cannot exhaust the API container's memory — the multipart body is
 * buffered to read it, so this limit is also the per-request memory ceiling.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

/**
 * Slack allowed on top of the limit when pre-checking `Content-Length`.
 *
 * A multipart body carries boundaries, part headers and the other form fields
 * as well as the file, so the envelope is always a little larger than its
 * contents. 16KB is generous for that and still refuses an oversized upload
 * before a byte of it is buffered.
 */
export const MULTIPART_SLACK_BYTES = 16 * 1024;

/**
 * The allow-list, and the extension each type gets on disk.
 *
 * Photographs from a phone (JPEG, PNG, WebP, HEIC) plus PDF for the paperwork —
 * certificates, invoices, method statements. Nothing else: SVG is an HTML
 * document in a trenchcoat, and an archive or an Office file is a delivery
 * mechanism nobody asked this product for.
 */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

export const ALLOWED_CONTENT_TYPES = Object.keys(EXTENSIONS);

/**
 * Names a browser may use for a type stored under one canonical name.
 *
 * Safari sends `image/heic`, some Android builds send `image/heif` for the same
 * file, and old IE-era stacks still emit `image/pjpeg`. These are the same
 * format, so they are folded rather than rejected — the check that matters is
 * the magic number below.
 */
const ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/heif": "image/heic",
  "image/heic-sequence": "image/heic",
  "image/heif-sequence": "image/heic",
};

/** Strips the `; charset=` tail and folds aliases. */
export function canonicaliseContentType(declared: string): string {
  const base = declared.split(";")[0].trim().toLowerCase();
  return ALIASES[base] ?? base;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * ISO base media brands that mean "this is a HEIF/HEIC still".
 * `mif1`/`msf1` are the generic HEIF brands an Android camera may emit.
 * `avif` is deliberately absent — it is a different codec and not on the list.
 */
const HEIF_BRANDS = new Set([
  "heic", "heix", "heim", "heis",
  "hevc", "hevx", "hevm", "hevs",
  "mif1", "msf1",
]);

const asciiAt = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (bytes.length < at + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

/** The type the bytes actually are, or null for anything not on the list. */
export function sniffContentType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  // SOI + the first marker. Every JPEG variant starts FF D8 FF.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (PNG_MAGIC.every((byte, index) => bytes[index] === byte)) {
    return "image/png";
  }
  // RIFF container with a WEBP fourcc. `RIFF` alone is also WAV and AVI.
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  // ISO-BMFF: a size field, then `ftyp`, then the brand.
  if (asciiAt(bytes, 4, "ftyp")) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (HEIF_BRANDS.has(brand)) return "image/heic";
  }
  if (asciiAt(bytes, 0, "%PDF-")) return "application/pdf";

  return null;
}

export type UploadCheck =
  | { ok: true; contentType: string; extension: string }
  | { ok: false; status: 413 | 415; error: string };

/**
 * The one gate every upload path goes through.
 *
 * `declared` is treated as a claim to be contradicted, not believed. An absent
 * or `application/octet-stream` claim is not a contradiction — plenty of real
 * Android cameras send exactly that for a HEIC — so it falls through to the
 * sniff. A claim that disagrees with the bytes is refused outright: nothing
 * legitimate produces that, and it is the signature of somebody dressing one
 * format up as another.
 */
export function checkUpload(declared: string, bytes: Uint8Array): UploadCheck {
  if (bytes.length === 0) {
    return { ok: false, status: 415, error: "That file is empty." };
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Files must be ${MAX_UPLOAD_MB}MB or smaller. Take the photograph again at a lower resolution.`,
    };
  }

  const actual = sniffContentType(bytes);
  if (!actual) {
    return {
      ok: false,
      status: 415,
      error: "Upload a JPEG, PNG, WebP or HEIC photograph, or a PDF document.",
    };
  }

  const claimed = canonicaliseContentType(declared);
  const madeAClaim = claimed && claimed !== "application/octet-stream";
  if (madeAClaim && !(claimed in EXTENSIONS)) {
    return {
      ok: false,
      status: 415,
      error: "Upload a JPEG, PNG, WebP or HEIC photograph, or a PDF document.",
    };
  }
  if (madeAClaim && claimed !== actual) {
    return {
      ok: false,
      status: 415,
      error: "That file's contents do not match the type it was sent as.",
    };
  }

  return { ok: true, contentType: actual, extension: EXTENSIONS[actual] };
}

/**
 * A fresh key under `prefix`.
 *
 * The uuid means two people uploading `IMG_0001.jpg` on the same job do not
 * collide, and that a key is not derivable from anything a caller knows. The
 * extension comes from the SNIFFED type, so `invoice.pdf.html` lands on disk as
 * `<uuid>.pdf` or does not land at all.
 */
export function objectKeyFor(prefix: string, extension: string): string {
  return `${prefix}/${randomUUID()}.${extension}`;
}

/**
 * The original filename, kept for display only.
 *
 * It is shown in the portal next to the thumbnail, so it must not carry path
 * separators (which would make it read as a location) or control characters
 * (which can rewrite a terminal line in a log). It never influences where the
 * bytes go.
 */
export function safeOriginalName(name: string, fallback = "upload"): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "-")
    .trim()
    .slice(0, 200);
  return cleaned || fallback;
}

/** The attachment kinds a caller may name, from the `attachment_kind` enum. */
export const ATTACHMENT_KINDS = new Set([
  "issue_picture",
  "completed_picture",
  "file",
]);

/** Photographs are pictures; paperwork is a file. */
export function defaultKindFor(contentType: string): string {
  return contentType === "application/pdf" ? "file" : "issue_picture";
}
