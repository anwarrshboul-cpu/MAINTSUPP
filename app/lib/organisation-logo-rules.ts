/**
 * THE WORKSPACE LOGO — what may be stored, decided without a database.
 *
 * A workspace (a customer) may put its own mark on ITS portal: beside the
 * workspace name in the sidebar, in the account menu, and on the cover of the
 * reports the portal issues to it. MAINTSUPP's own brand is never replaced —
 * the MAINTSUPP mark in the sidebar, the marketing site and the report titles
 * are untouched by anything here.
 *
 * WHAT IS ACCEPTED, AND WHY EACH LIMIT IS WHERE IT IS
 *
 *   - PNG, JPEG and WebP ONLY. No SVG, ever: an SVG is a document that can carry
 *     script, and the owner's decision was that there is no requirement for one.
 *     No GIF or HEIC either — a logo is a still mark, and HEIC does not render in
 *     most browsers.
 *   - 2 MB at most (`LOGO_MAX_BYTES`), the owner's figure. A logo drawn at 28px in
 *     a sidebar needs a small fraction of that; the ceiling exists so a phone
 *     photograph of a sign cannot become a 12 MB image on every page load.
 *   - 16–4096 px on each side (`LOGO_MIN_EDGE`, `LOGO_MAX_EDGE`). The upper bound
 *     is what stops a 2 MB PNG that DECOMPRESSES to hundreds of megabytes of
 *     pixels from being served to every member's browser; the lower one refuses a
 *     1×1 tracking pixel posing as a logo.
 *
 * WHAT IS TRUSTED: NOTHING THE CALLER SAYS
 *
 * The declared type, the file name and the size are all the caller's claims. The
 * bytes decide: `inspectLogo` requires the declared type, the extension and the
 * file's own signature (`app/lib/file-signature.ts`) to agree, then reads the
 * image's dimensions out of its header. The stored type is the one the bytes
 * proved, and it is served back only from this list — so nothing the caller
 * named can ever become the response's `Content-Type`.
 *
 * Importless apart from the signature rules, so the tests call it directly.
 */

import {
  SIGNATURE_BYTES,
  signatureMatches,
  typeAgreesWithExtension,
} from "./file-signature";

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

const EXTENSION_FOR: Record<LogoType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const TYPE_FOR_EXTENSION: Record<string, LogoType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** The owner's ceiling: about 2 MB. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Above this a logo is uploaded in parts through `/api/branding/logo/upload` —
 * the #78 direct-upload path — because the Workers form parser refuses a
 * `multipart/form-data` body at 1 MiB. The same figure as `DIRECT_UPLOAD_LIMIT`
 * in `app/lib/client-upload.ts`, for the same reason.
 */
export const LOGO_DIRECT_LIMIT = 900 * 1024;
export const LOGO_MIN_EDGE = 16;
export const LOGO_MAX_EDGE = 4096;
/** What the file picker offers. The server does not rely on it. */
export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * The JPEG the browser draws for the documents (a PDF and a Word file embed a
 * JPEG natively, and WebP not at all). A derivative, like the board's
 * thumbnails: small, and never the only copy of anything.
 */
export const LOGO_PRINT_MAX_BYTES = 512 * 1024;
export const LOGO_PRINT_MAX_EDGE = 1200;

export const LOGO_TYPE_REFUSAL = "The logo must be a PNG, JPEG or WebP image.";
export const LOGO_SIZE_REFUSAL = "The logo must be 2 MB or smaller.";
export const LOGO_UNREADABLE_REFUSAL = "The logo could not be read as an image. Save it again as a PNG, JPEG or WebP and try again.";
export const LOGO_EDGE_REFUSAL = `The logo must be between ${LOGO_MIN_EDGE} and ${LOGO_MAX_EDGE} pixels on each side.`;

export type LogoRefusal = { ok: false; status: number; error: string };

const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/**
 * The type a declaration names — the declared type, or the extension when the
 * browser declined to guess. `null` for anything outside the three.
 */
export function declaredLogoType(contentType: string, fileName: string): LogoType | null {
  const declared = (contentType ?? "").trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") {
    return (LOGO_TYPES as readonly string[]).includes(declared) ? (declared as LogoType) : null;
  }
  return TYPE_FOR_EXTENSION[extensionOf(fileName)] ?? null;
}

/**
 * The refusal for a DECLARATION — what `start` can judge before any byte is
 * sent: the type, the extension, their agreement and the size. `null` when it
 * may proceed; the bytes are still checked at the end.
 */
export function logoDeclarationRefusal(
  contentType: string,
  fileName: string,
  byteSize: number,
): LogoRefusal | null {
  const type = declaredLogoType(contentType, fileName);
  if (
    !type ||
    !TYPE_FOR_EXTENSION[extensionOf(fileName)] ||
    TYPE_FOR_EXTENSION[extensionOf(fileName)] !== type ||
    !typeAgreesWithExtension(contentType, fileName)
  ) {
    return { ok: false, status: 415, error: LOGO_TYPE_REFUSAL };
  }
  if (!Number.isInteger(byteSize) || byteSize < 1) {
    return { ok: false, status: 400, error: "Choose a logo to upload." };
  }
  if (byteSize > LOGO_MAX_BYTES) {
    return { ok: false, status: 413, error: LOGO_SIZE_REFUSAL };
  }
  return null;
}

/* ── Reading an image's size from its own header ─────────────────────────── */

const u16be = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
const u16le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number) =>
  bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const u32be = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

export type ImageSize = { width: number; height: number; components?: number };

/** PNG: the IHDR chunk is always first, at a fixed offset. */
function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/*
 * JPEG: walk the marker segments to the first start-of-frame. Every segment but
 * the standalone markers carries its own length, so the walk skips EXIF and
 * colour profiles however large they are. SOF4, SOF8 and SOF12 are not frames
 * (DHT, JPG, DAC), which is why they are absent from the set.
 */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    let marker = bytes[at + 1]!;
    // Fill bytes: any number of 0xFF may precede a marker.
    while (marker === 0xff && at + 2 < bytes.length) {
      at += 1;
      marker = bytes[at + 1]!;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // End of image, or the scan began, before any frame: not a readable JPEG.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(bytes, at + 2);
    if (length < 2) return null;
    if (JPEG_FRAMES.has(marker)) {
      if (at + 9 >= bytes.length) return null;
      return {
        height: u16be(bytes, at + 5),
        width: u16be(bytes, at + 7),
        components: bytes[at + 9],
      };
    }
    at += 2 + length;
  }
  return null;
}

/** WebP: the first chunk after the RIFF header says which of three encodings it is. */
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    // A lossy key frame: three tag bytes, the 9D 01 2A start code, then 14-bit sizes.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | ((bytes[24]! << 24) >>> 0);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  return null;
}

/** What the bytes themselves are, of the three — never what anyone said. */
export function sniffLogoType(bytes: Uint8Array): LogoType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return null;
}

export function imageSize(type: LogoType, bytes: Uint8Array): ImageSize | null {
  if (type === "image/png") return pngSize(bytes);
  if (type === "image/jpeg") return jpegSize(bytes);
  return webpSize(bytes);
}

export type InspectedLogo = {
  ok: true;
  type: LogoType;
  extension: string;
  width: number;
  height: number;
  byteSize: number;
};

/**
 * THE WHOLE CHECK, on the whole file. Used by both upload paths, after the
 * bytes are in hand — the single-shot route before it stores anything, the
 * parts route after the bucket has assembled the object (and it deletes the
 * object when this refuses).
 */
export function inspectLogo(
  contentType: string,
  fileName: string,
  bytes: Uint8Array,
): InspectedLogo | LogoRefusal {
  const declared = logoDeclarationRefusal(contentType, fileName, bytes.byteLength);
  if (declared) return declared;
  const type = declaredLogoType(contentType, fileName)!;
  const head = bytes.subarray(0, Math.min(bytes.byteLength, SIGNATURE_BYTES));
  if (!signatureMatches(type, fileName, head) || sniffLogoType(bytes) !== type) {
    return { ok: false, status: 415, error: LOGO_TYPE_REFUSAL };
  }
  const size = imageSize(type, bytes);
  if (!size || !(size.width > 0) || !(size.height > 0)) {
    return { ok: false, status: 415, error: LOGO_UNREADABLE_REFUSAL };
  }
  if (
    size.width < LOGO_MIN_EDGE ||
    size.height < LOGO_MIN_EDGE ||
    size.width > LOGO_MAX_EDGE ||
    size.height > LOGO_MAX_EDGE
  ) {
    return { ok: false, status: 422, error: LOGO_EDGE_REFUSAL };
  }
  return {
    ok: true,
    type,
    extension: EXTENSION_FOR[type],
    width: size.width,
    height: size.height,
    byteSize: bytes.byteLength,
  };
}

/**
 * The documents' JPEG. Baseline or progressive, grey or colour — the two
 * colour models a PDF can draw from a JPEG without a conversion; a CMYK JPEG
 * would print inverted in some readers, so it is refused rather than guessed at.
 */
export function inspectPrintRendition(bytes: Uint8Array): (ImageSize & { ok: true }) | LogoRefusal {
  if (bytes.byteLength < 1 || bytes.byteLength > LOGO_PRINT_MAX_BYTES) {
    return { ok: false, status: 413, error: "The print copy of the logo must be 512 KB or smaller." };
  }
  if (sniffLogoType(bytes) !== "image/jpeg") {
    return { ok: false, status: 415, error: "The print copy of the logo must be a JPEG." };
  }
  const size = jpegSize(bytes);
  if (
    !size ||
    !(size.components === 1 || size.components === 3) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > LOGO_PRINT_MAX_EDGE ||
    size.height > LOGO_PRINT_MAX_EDGE
  ) {
    return { ok: false, status: 422, error: "The print copy of the logo could not be read." };
  }
  return { ok: true, ...size };
}

/* ── Where it lives, and what the browser is given instead ───────────────── */

/**
 * The object key. The SERVER names it — the browser never chooses a path — and
 * it sits under the workspace's own prefix, beside its documents, in the same
 * private bucket.
 */
export function logoObjectKey(organisationId: string, logoId: string, type: LogoType): string {
  return `${organisationId}/branding/logo/${logoId}.${EXTENSION_FOR[type]}`;
}

/** The documents' JPEG sits beside the original, under the same id. */
export function printRenditionKey(objectKey: string): string {
  return `${objectKey}.print.jpg`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Whether a key a caller hands back (on `sign-part`, a part, `complete` or
 * `abort`) is a logo key of THIS workspace. The session row is the real proof;
 * this refuses a foreign or malformed key before any lookup is made with it.
 */
export function isLogoKeyOf(organisationId: string, key: string): boolean {
  if (!key || key.length > 400 || !key.startsWith(`${organisationId}/branding/logo/`)) return false;
  return new RegExp(`^${UUID}\\.(png|jpg|webp)$`).test(key.slice(`${organisationId}/branding/logo/`.length));
}

/**
 * The address the browser is given. `v` is the logo's own id, so a new logo is
 * a new URL and the old one may be cached `immutable` — and it is not a
 * credential: the route authorises every request whatever `v` says.
 */
export function logoImageUrl(logoId: string, rendition: "original" | "print" = "original"): string {
  return `/api/branding/logo/image?v=${encodeURIComponent(logoId)}${rendition === "print" ? "&rendition=print" : ""}`;
}
