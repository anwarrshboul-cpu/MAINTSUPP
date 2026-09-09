/**
 * What an attachment is allowed to be, and what type it should be stored as.
 *
 * ONE COPY. The allow-lists lived in `app/api/files/route.ts` and again in
 * `app/api/files/multipart/route.ts`. They happened to agree, but nothing made
 * them: the two routes are the direct and the over-1-MiB path for the same
 * upload, so a type added to one and forgotten in the other means a file the
 * product accepts at 900 KB and refuses at 1.1 MB.
 *
 * `INLINE_SAFE_TYPES` in `app/api/files/[id]/route.ts` is deliberately NOT
 * folded in here. It is a smaller list answering a different question — what a
 * browser may render on this origin, rather than what may be stored — and
 * merging the two would quietly widen it.
 */

/**
 * Types that may be stored.
 *
 * SVG is absent on purpose: it is a script container.
 */
export const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/x-matroska",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/x-zip-compressed",
]);

/**
 * Extensions that may be stored, and the type each one means.
 *
 * The map is the single declaration: `ALLOWED_EXTENSIONS` is derived from its
 * keys, so an extension can never be admitted without also saying what it is.
 * Every value is a member of `ALLOWED_MIME_TYPES`, asserted below.
 */
const EXTENSION_TO_MIME = new Map<string, string>([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["mov", "video/quicktime"],
  ["m4v", "video/x-m4v"],
  ["mkv", "video/x-matroska"],
  ["pdf", "application/pdf"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ppt", "application/vnd.ms-powerpoint"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["txt", "text/plain"],
  ["csv", "text/csv"],
  ["zip", "application/zip"],
]);

export const ALLOWED_EXTENSIONS = new Set(EXTENSION_TO_MIME.keys());

/** Types that carry no information — a header that declined to say. */
const UNINFORMATIVE_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "unknown/unknown",
]);

export function fileExtension(name: string): string {
  const parts = String(name ?? "").split(".");
  return parts.length > 1 ? (parts.pop() ?? "").toLowerCase() : "";
}

/**
 * Whether this file may be stored at all.
 *
 * AND, not OR. This was `allowedTypes.has(type) || allowedExtensions.has(ext)`,
 * and BOTH halves are supplied by the caller — so naming a file `poc.png` while
 * declaring `Content-Type: text/html` satisfied the extension half and stored
 * the HTML type, which the serving route then echoed back with
 * `Content-Disposition: inline`. That is script execution on the application's
 * own origin, and a contractor job link — no session at all — was enough to
 * plant it.
 *
 * An empty declared type still falls through to the extension: a browser that
 * declines to guess must not cost somebody a legitimate upload. An
 * *uninformative but present* type is treated the same way, which is the one
 * behaviour change here and the reason this function moved — see
 * `resolveStoredMime`.
 */
export function isAllowedFile(file: { name: string; type?: string }): boolean {
  const declared = String(file.type ?? "").trim().toLowerCase();
  const typeOk = UNINFORMATIVE_TYPES.has(declared)
    ? true
    : ALLOWED_MIME_TYPES.has(declared);
  return typeOk && ALLOWED_EXTENSIONS.has(fileExtension(file.name));
}

export type ResolvedMime = {
  /** What to store, or null when nothing may be assumed. */
  mime: string | null;
  /** Where it came from — `declared` is the source's own header. */
  source: "declared" | "derived" | "unresolved";
  /** The source's header, verbatim, whatever it said. Never discarded. */
  declared: string;
};

/**
 * The type an attachment should be STORED as.
 *
 * Why this exists. monday's CDN returned no Content-Type at all for 200 of the
 * 3,107 exported assets. The migration's first pass substituted
 * `application/octet-stream` for the blank — and that turned an acceptable
 * silence into a rejected declaration, because the upload validator refuses a
 * declared type outside the allow-list. Worse than the 415: a photograph stored
 * as octet-stream is served with an attachment disposition, so 123 JPEGs of the
 * inside of shops would have downloaded instead of appearing on the job.
 *
 * The extension is the better evidence when the header says nothing, and it is
 * only trusted against the allow-list — an unknown extension resolves to
 * `unresolved` and must be listed by the caller, never guessed. The source's
 * own header is returned either way so provenance survives.
 */
export function resolveStoredMime(input: {
  declaredType?: string | null;
  filename: string;
}): ResolvedMime {
  const declared = String(input.declaredType ?? "").trim();
  const lowered = declared.toLowerCase();

  if (ALLOWED_MIME_TYPES.has(lowered)) {
    return { mime: lowered, source: "declared", declared };
  }

  /*
   * ONLY SILENCE FALLS BACK TO THE EXTENSION.
   *
   * A source that declares `text/html` for a file named `evil.png` is making an
   * assertion, not declining to make one, and answering it with `image/png`
   * would be this helper overriding a positive claim with a weaker signal —
   * exactly the confusion the upload validator's AND rule exists to prevent.
   * `isAllowedFile` refuses that upload before it reaches here, but a helper
   * that is only safe because of where it happens to be called is a trap for
   * the next caller. An unrecognised declaration is unresolved, full stop.
   */
  if (!UNINFORMATIVE_TYPES.has(lowered)) {
    return { mime: null, source: "unresolved", declared };
  }

  const derived = EXTENSION_TO_MIME.get(fileExtension(input.filename));
  if (derived) return { mime: derived, source: "derived", declared };

  /*
   * Silence, and an extension outside the allow-list. Neither half is evidence,
   * so nothing is assumed and the caller reports it individually — the
   * migration lists such a file rather than inventing a type for it.
   */
  return { mime: null, source: "unresolved", declared };
}

/* Every extension must map to a type the product will actually store. */
for (const [extension, mime] of EXTENSION_TO_MIME) {
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    throw new Error(
      `attachment-mime: .${extension} maps to ${mime}, which is not an allowed type`,
    );
  }
}
