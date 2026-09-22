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
 * The declared types a file with this extension may honestly carry. A caller
 * supplies both the name and the type, and the two used to be checked against
 * the allowlist SEPARATELY — so `x.mp4` declared `text/plain` passed both,
 * earned the video limit from its name and skipped the byte check as
 * text. They must now agree with each other. The alternatives are the ones
 * real browsers send: Windows labels a CSV `application/vnd.ms-excel`, some
 * browsers label an M4V as MP4, and HEIC/HEIF are used interchangeably.
 */
const TYPES_FOR_EXTENSION: Record<string, string[]> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  heic: ["image/heic", "image/heif"],
  heif: ["image/heif", "image/heic"],
  mp4: ["video/mp4"],
  m4v: ["video/x-m4v", "video/mp4"],
  mov: ["video/quicktime"],
  webm: ["video/webm"],
  mkv: ["video/x-matroska"],
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  txt: ["text/plain"],
  csv: ["text/csv", "application/vnd.ms-excel"],
  zip: ["application/zip", "application/x-zip-compressed"],
};

const extensionOf = (fileName: string) => fileName.split(".").pop()?.toLowerCase() ?? "";
const undeclared = (type: string) => !type || type === "application/octet-stream";

/** Whether the declared type is one this file's extension may carry. No declared type defers to the extension. */
export function typeAgreesWithExtension(contentType: string, fileName: string): boolean {
  const declared = (contentType ?? "").trim().toLowerCase();
  if (undeclared(declared)) return true;
  return (TYPES_FOR_EXTENSION[extensionOf(fileName)] ?? []).includes(declared);
}

/* What the file is claimed to be, once the extension has spoken for a missing
   type and a CSV's Excel label has been read as the text it is. */
function effectiveType(contentType: string, fileName: string): string {
  const declared = (contentType ?? "").trim().toLowerCase();
  const extension = extensionOf(fileName);
  if (extension === "csv" && (undeclared(declared) || declared === "text/csv" || declared === "application/vnd.ms-excel")) {
    return "text/csv";
  }
  if (extension === "txt" && (undeclared(declared) || declared === "text/plain")) return "text/plain";
  if (undeclared(declared)) return BY_EXTENSION[extension] ?? "";
  return declared;
}

/**
 * True when `head` (the file's first bytes) is consistent with what the file
 * claims to be. Plain text and CSV have no signature — and are accepted as such
 * ONLY under a `.txt` or `.csv` name; every other allowed type must match its
 * own signature.
 */
export function signatureMatches(contentType: string, fileName: string, head: Uint8Array): boolean {
  const type = effectiveType(contentType, fileName);
  if (type === "text/plain" || type === "text/csv") {
    const extension = extensionOf(fileName);
    return extension === "txt" || extension === "csv";
  }
  const check = BY_TYPE[type];
  if (!check) return false;
  return head.length > 0 && check(head);
}

export const SIGNATURE_REFUSAL =
  "This file's contents do not match its type. Save it again in its real format and upload that.";
