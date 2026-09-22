/**
 * DOES A FILE'S FIRST BYTES MATCH WHAT IT CLAIMS TO BE?
 *
 * Both halves of the allowlist — the declared type and the extension — are
 * supplied by the caller (see `isAllowedFile` in the two upload routes). That
 * was the only type control, and since uploads over 900 KB now go straight from
 * the browser to the private bucket, the server never sees those bytes pass by.
 * So every upload is checked here once its bytes are stored: the first
 * `SIGNATURE_BYTES` are read back and compared with the format the file says it
 * is. A PNG that is really HTML, or a "PDF" that is an executable, is refused
 * and its bytes deleted before any row names it.
 *
 * Deliberately TOLERANT where formats genuinely vary — a mismatch here refuses a
 * real person's photograph — and deliberately silent about plain text and CSV,
 * which have no signature at all. The serving side stays hardened on its own
 * (`GET /api/files/[id]` never renders an uploaded type it does not trust), so
 * this is a second wall, not the only one.
 */

/* 1 KB: a PDF header may sit a little way in; every other signature is at the start. */
export const SIGNATURE_BYTES = 1024;

const ascii = (bytes: Uint8Array, from: number, length: number) =>
  String.fromCharCode(...bytes.subarray(from, from + length));

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((value, index) => bytes[offset + index] === value);

/* ISO base media (MP4, MOV, M4V, HEIC): a size, then a box type at offset 4. A
   camera file normally opens with `ftyp`; older QuickTime files can open with
   another top-level box, which is still the same container. */
const ISO_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"]);
const isoBaseMedia = (bytes: Uint8Array) => ISO_BOXES.has(ascii(bytes, 4, 4));

const zip = (bytes: Uint8Array) =>
  startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
  startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
  startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);

/* The legacy Office compound-file header (.doc, .xls, .ppt). */
const compoundFile = (bytes: Uint8Array) =>
  startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/* EBML, the container WebM and Matroska share. */
const ebml = (bytes: Uint8Array) => startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);

/* A PDF's header may follow a little leading junk; readers accept that, so do we. */
const pdf = (bytes: Uint8Array) => ascii(bytes, 0, bytes.length).includes("%PDF-");

type Check = (bytes: Uint8Array) => boolean;

const BY_TYPE: Record<string, Check> = {
  "image/jpeg": (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  "image/png": (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/gif": (bytes) => ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a",
  "image/webp": (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP",
  "image/heic": isoBaseMedia,
  "image/heif": isoBaseMedia,
  "video/mp4": isoBaseMedia,
  "video/quicktime": isoBaseMedia,
  "video/x-m4v": isoBaseMedia,
  "video/webm": ebml,
  "video/x-matroska": ebml,
  "application/pdf": pdf,
  "application/zip": zip,
  "application/x-zip-compressed": zip,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": zip,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": zip,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": zip,
  "application/msword": compoundFile,
  "application/vnd.ms-excel": compoundFile,
  "application/vnd.ms-powerpoint": compoundFile,
};

/* When a browser sends no type at all, the extension is the claim. */
const BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mkv: "video/x-matroska",
  pdf: "application/pdf",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
};

/**
 * True when `head` (the file's first bytes) is consistent with the declared
 * type — or, with no declared type, with the extension. Text and CSV have no
 * signature and always pass; every other allowed type must match its own.
 */
export function signatureMatches(contentType: string, fileName: string, head: Uint8Array): boolean {
  const declared = (contentType ?? "").trim().toLowerCase();
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (declared === "text/plain" || declared === "text/csv") return true;
  const type = declared || BY_EXTENSION[extension] || "";
  if (!type && (extension === "txt" || extension === "csv")) return true;
  const check = BY_TYPE[type];
  if (!check) return false;
  return head.length > 0 && check(head);
}

export const SIGNATURE_REFUSAL =
  "This file's contents do not match its type. Save it again in its real format and upload that.";
