/**
 * Receiving one uploaded file, for the routes that are not `uploads.ts`.
 *
 * WHY THIS EXISTS AT ALL. `routes/uploads.ts` owns the upload pipeline and its
 * multipart reader is module-private, so a compliance certificate and an invoice
 * PDF cannot call it. What they must not do is invent a second pipeline: the
 * rules that matter — the byte ceiling, the magic-number sniff that refuses a
 * file dressed up as another type, the minted object key, the private bucket,
 * the short-lived signed URL — all live in `lib/files.ts` and `lib/storage.ts`
 * and are imported here unchanged. The only thing restated below is the reading
 * of the body, which is why this file is thirty lines and not three hundred.
 *
 * If `uploads.ts` ever exports its reader, delete this and use that one.
 */
import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { Env } from "./middleware.ts";
import {
  checkUpload,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  MULTIPART_SLACK_BYTES,
  safeOriginalName,
} from "./files.ts";

export type ReceivedFile = {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
  originalName: string;
  /** The rest of the form, for the fields that ride along with the file. */
  form: FormData;
};

export type Received =
  | { ok: true; file: ReceivedFile }
  | { ok: false; status: 400 | 413 | 415; error: string };

const isFileLike = (value: unknown): value is File =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as File).arrayBuffer === "function";

/**
 * Reads the one file out of a multipart body, or explains why not.
 *
 * `Content-Length` is checked first so an oversized body is refused before it is
 * buffered — but it is a claim like any other and a chunked request can omit it,
 * which is why `checkUpload` measures the real bytes afterwards. The header
 * check is a cheap early exit, never the limit.
 */
export async function receiveOneFile(c: Context<Env>): Promise<Received> {
  const declaredLength = Number(c.req.header("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_UPLOAD_BYTES + MULTIPART_SLACK_BYTES
  ) {
    return {
      ok: false,
      status: 413,
      error: `Files must be ${MAX_UPLOAD_MB}MB or smaller.`,
    };
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) {
    return { ok: false, status: 400, error: "Send the file as form data." };
  }

  const field = form.get("file");
  if (!isFileLike(field)) {
    return { ok: false, status: 400, error: "Attach a file." };
  }

  const bytes = new Uint8Array(await field.arrayBuffer());
  // The declared type is a claim to be contradicted; the sniffed type wins and
  // is what gets stored. See the header of lib/files.ts.
  const check = checkUpload(field.type ?? "", bytes);
  if (!check.ok) return { ok: false, status: check.status, error: check.error };

  return {
    ok: true,
    file: {
      bytes,
      contentType: check.contentType,
      extension: check.extension,
      originalName: safeOriginalName(field.name ?? ""),
      form,
    },
  };
}

/** The bytes' fingerprint, recorded so a swapped file is a comparison. */
export const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Every id these routes take is a uuid path parameter.
 *
 * Checked before it reaches a query because Postgres raises `invalid input
 * syntax for type uuid` on anything else — a 500 with a stack trace, where the
 * honest answer is the same 404 an unknown id gets.
 */
export const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `YYYY-MM-DD` date, or null.
 *
 * Both columns this guards are `date`, not `timestamptz`: an expiry and a due
 * date are calendar facts, and handing Postgres a timestamp would make "expires
 * on the 30th" depend on the reader's timezone. Anything that is not a real
 * calendar date — "2026-02-31", "tomorrow" — is rejected rather than coerced,
 * because a silently shifted expiry date is a compliance failure nobody sees.
 */
export function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trips only if the day exists: `new Date("2026-02-31")` rolls forward.
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}
