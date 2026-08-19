"use client";

import type {
  AttachmentKind,
  AttachmentRecord,
  MaintenanceRequest,
} from "./types";

/*
 * Above this, upload in parts. 900 KB, not the 4 MB it used to be.
 *
 * The single-shot route takes a `multipart/form-data` body and calls
 * `request.formData()`. The Workers runtime refuses to parse a form body at or
 * above 1 MiB and answers a bare `413 Payload Too Large` — not the route's own
 * JSON error, because nothing in the route has run yet. So every photograph
 * between 1 MiB and 4 MiB failed to upload from the board, from a job, and
 * from a contractor link, with a message no part of this codebase wrote.
 *
 * Measured against the running server rather than assumed: 1000 KB uploads and
 * returns 201, 1024 KB returns 413, and a 6 MB *raw* PUT to the multipart route
 * is accepted — the limit is on form parsing, not on request size. 900 KB
 * leaves room for the rest of the form (the request id, kind, column id and
 * the multipart framing) inside the 1 MiB budget.
 *
 * The multipart path has no such ceiling because it PUTs
 * `application/octet-stream` and never calls `formData()`. It was already the
 * path for anything over 4 MB; this simply starts using it sooner.
 */
const DIRECT_UPLOAD_LIMIT = 900 * 1024;

/**
 * The smallest part S3 and R2 will accept anywhere except at the end of an
 * upload. Not a tuning knob — a protocol constant.
 */
const STORAGE_MINIMUM_PART_SIZE = 5 * 1024 * 1024;

/**
 * What a platform proxy in front of this app will carry in one request body.
 *
 * Vercel's is 4.5 MB and it is enforced at the edge, before the function runs:
 * the caller gets a bare `413` that no line of this codebase wrote. Railway has
 * no such cap. Used below only to explain a failure, never to size a part —
 * see the next block for why it cannot be.
 */
const PROXY_REQUEST_BODY_LIMIT = 4_500_000;

/*
 * WHY THIS IS 5 MiB AND CANNOT BE LOWERED, AND WHAT THAT COSTS ON VERCEL.
 *
 * The brief was to pick a chunk size that works on Railway and on Vercel. There
 * is no such size, and the arithmetic is short enough to check:
 *
 *   - S3 and R2 refuse any part except the LAST one below 5 MiB
 *     (5,242,880 bytes), at CompleteMultipartUpload, with `EntityTooSmall`.
 *     `db/r2-over-s3.ts` is a thin, faithful client — `uploadPart` PUTs the
 *     bytes and `complete` POSTs the part list — so that refusal arrives
 *     unmodified. It is caught by the `<Error` scan in `complete()` there and
 *     reaches the browser as a 503.
 *   - `app/api/files/multipart/route.ts` refuses any part ABOVE 5 MiB:
 *     `MAX_PART_SIZE = 5 * 1024 * 1024`, answered as a 413.
 *
 * Those two bounds meet. For an upload with more than one part, 5 MiB is not
 * the best size, it is the ONLY legal size this route will pass.
 *
 *   - Vercel refuses any request body above 4.5 MB, at the edge.
 *
 * 5 MiB is 5,242,880 and the cap is 4,500,000, so a non-final part is 742,880
 * bytes too big to reach a Vercel function, and every smaller part is too small
 * for the bucket. Lowering the constant to, say, 4 MiB would not fix Vercel's
 * uploads; it would BREAK Railway's. Nothing in the split would look wrong —
 * the filesystem driver in `db/node-r2.ts` has no minimum at all, so it
 * concatenates whatever it is given and every local test would pass — and the
 * failure would appear only on the deployment that has `S3_*` configured, which
 * is the one holding the real photographs.
 *
 * SO WHAT WORKS ON VERCEL TODAY. A file small enough to be ONE part, because a
 * single part is the last part and the 5 MiB floor does not apply to it. That
 * is the whole reason this constant sits where it does rather than lower: with
 * the chunk at 5 MiB, everything from `DIRECT_UPLOAD_LIMIT` up to 5 MiB is sent
 * as exactly one part of its own size, and everything up to 4.5 MB of that
 * range is inside Vercel's cap and uploads fine. The reported symptom — "over
 * 900 KB fails on Vercel" — is really "over 4.5 MB fails on Vercel"; between
 * 900 KB and 4.5 MB the existing path already works there, which is worth
 * knowing before anyone changes it in the belief that it does not.
 *
 * WHAT DOES NOT, AND WHY THE ROUTE HAS TO CHANGE SHAPE. Above 4.5 MB on Vercel
 * there is nothing this file can do. One HTTP request carries one S3 part, so
 * the part is the body and the body is capped; no chunking arrangement makes a
 * ≥5 MiB part fit through a 4.5 MB hole. Buffering several sub-cap chunks into
 * one part on the server needs state that survives between invocations, and a
 * Vercel function has none. The fix is to stop sending the bytes through the
 * function: sign an UploadPart URL and let the browser PUT to the bucket
 * directly. `db/r2-over-s3.ts` already carries the SigV4 signer that would need
 * — it signs `?uploads` and `?uploadId=…&partNumber=…` today — so the work is a
 * new presign action on the multipart route plus a branch here, and it is a
 * route change, not a constant change. `db/node-r2.ts` cannot presign (it says
 * so), but a filesystem deployment is by definition not behind Vercel's proxy,
 * so it keeps this path.
 *
 * Until that exists, the honest position is: this constant is correct, Railway
 * is unaffected, and Vercel's ceiling for an attachment is 4.5 MB against the
 * 25 MB and 90 MB the validator advertises. `partUploadError` below makes that
 * ceiling say so when it is hit instead of promising a retry that will not
 * happen.
 */
const MULTIPART_CHUNK_SIZE = STORAGE_MINIMUM_PART_SIZE;
const MAX_STANDARD_FILE_SIZE = 25 * 1024 * 1024;
const MAX_VIDEO_FILE_SIZE = 90 * 1024 * 1024;
const videoExtensions = new Set(["mp4", "webm", "mov", "m4v", "mkv"]);

type UploadResponse = {
  file: AttachmentRecord;
  request?: MaintenanceRequest;
};

type MultipartStartResponse = {
  key: string;
  uploadId: string;
  fileId: string;
};

type MultipartPartResponse = {
  part: {
    partNumber: number;
    etag: string;
  };
};

class UploadApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "UploadApiError";
    this.status = status;
  }
}

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isVideo(file: File) {
  return file.type.startsWith("video/") || videoExtensions.has(extension(file.name));
}

function friendlyError(status: number, body: string) {
  if (status === 413 || /payload too large/i.test(body)) {
    return "This file is too large for a single upload. It will be sent in smaller parts.";
  }
  if (status === 401) return "Your session has expired. Sign in and try again.";
  if (status === 403) {
    return "This upload link has expired. Submit a new request and attach the file again.";
  }
  return body.trim() || "The file could not be uploaded.";
}

/**
 * What went wrong when a PART was refused.
 *
 * `friendlyError` cannot be used here, and using it was a second defect sitting
 * behind the first. Its 413 message is "This file is too large for a single
 * upload. It will be sent in smaller parts." — true on the direct path, where
 * `uploadEvidenceFile` really does catch the 413 and switch to this one. On
 * this path there is no smaller path left to fall back to, so a Vercel-capped
 * upload told the user their file was about to be sent in parts while the
 * upload had already failed and been aborted.
 *
 * The two 413s are told apart by their bodies, not by guesswork. The route
 * answers with its own JSON — `{"error":"Each upload part must be 5 MB or
 * smaller."}` — and `readApi` prefers that whenever it is there. A 413 with no
 * JSON error in it did not come from the route at all: nothing in the
 * application had run yet, which is exactly the signature of a platform proxy
 * rejecting the body at the edge.
 */
function partUploadError(status: number, body: string) {
  if (status !== 413) return friendlyError(status, body);
  /*
   * Each limit is stated in the unit its owner states it in, so the two numbers
   * can be checked against their sources: the part size in MiB, as S3 and the
   * route both express it ("Each upload part must be 5 MB or smaller."), and
   * the proxy cap in decimal MB, as Vercel expresses it.
   */
  const parts = `${MULTIPART_CHUNK_SIZE / 1024 / 1024} MB`;
  const cap = `${PROXY_REQUEST_BODY_LIMIT / 1_000_000} MB`;
  return (
    `This upload was rejected before it reached the server. It is sent in ` +
    `${parts} parts — the smallest the file store will accept — and this ` +
    `deployment will not carry a request body over ${cap}. Files up to ${cap} ` +
    `upload normally; anything larger cannot be sent from here yet.`
  );
}

async function readApi<T>(
  response: Response,
  describe: (status: number, body: string) => string = friendlyError,
): Promise<T> {
  const body = await response.text();
  let payload: Record<string, unknown> = {};
  if (body) {
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : describe(response.status, body);
    throw new UploadApiError(message, response.status);
  }
  return payload as T;
}

function validateFile(file: File) {
  const video = isVideo(file);
  const maxSize = video ? MAX_VIDEO_FILE_SIZE : MAX_STANDARD_FILE_SIZE;
  if (file.size > maxSize) {
    throw new Error(
      video
        ? "Videos must be 90 MB or smaller."
        : "Files must be 25 MB or smaller.",
    );
  }
}

async function directUpload({
  file,
  requestId,
  kind,
  columnId,
  uploadToken,
}: {
  file: File;
  requestId: string;
  kind: AttachmentKind;
  columnId?: string;
  uploadToken?: string;
}) {
  const form = new FormData();
  form.set("file", file);
  form.set("requestId", requestId);
  form.set("kind", kind);
  if (columnId) form.set("columnId", columnId);
  if (uploadToken) form.set("uploadToken", uploadToken);
  return readApi<UploadResponse>(
    await fetch("/api/files", { method: "POST", body: form }),
  );
}

async function multipartUpload({
  file,
  requestId,
  kind,
  columnId,
  uploadToken,
  onProgress,
}: {
  file: File;
  requestId: string;
  kind: AttachmentKind;
  columnId?: string;
  uploadToken?: string;
  onProgress?: (progress: number) => void;
}) {
  const start = await readApi<MultipartStartResponse>(
    await fetch("/api/files/multipart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        requestId,
        kind,
        columnId,
        originalName: file.name,
        contentType: file.type || "application/octet-stream",
        byteSize: file.size,
        uploadToken,
      }),
    }),
  );

  const parts: Array<{ partNumber: number; etag: string }> = [];
  const partCount = Math.ceil(file.size / MULTIPART_CHUNK_SIZE);

  try {
    for (let index = 0; index < partCount; index += 1) {
      const startOffset = index * MULTIPART_CHUNK_SIZE;
      const endOffset = Math.min(startOffset + MULTIPART_CHUNK_SIZE, file.size);
      const chunk = file.slice(startOffset, endOffset);
      const response = await fetch("/api/files/multipart", {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Upload-Request-Id": requestId,
          "X-Upload-Kind": kind,
          ...(columnId ? { "X-Upload-Column-Id": columnId } : {}),
          "X-Upload-Key": start.key,
          "X-Upload-Id": start.uploadId,
          "X-Upload-Part": String(index + 1),
          ...(uploadToken ? { "X-Upload-Token": uploadToken } : {}),
        },
        body: chunk,
      });
      const uploaded = await readApi<MultipartPartResponse>(
        response,
        partUploadError,
      );
      parts.push(uploaded.part);
      onProgress?.(Math.round(((index + 1) / partCount) * 92));
    }

    const completed = await readApi<UploadResponse>(
      await fetch("/api/files/multipart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          requestId,
          kind,
          columnId,
          key: start.key,
          uploadId: start.uploadId,
          parts,
          uploadToken,
        }),
      }),
    );
    onProgress?.(100);
    return completed;
  } catch (error) {
    fetch("/api/files/multipart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "abort",
        requestId,
        kind,
        columnId,
        key: start.key,
        uploadId: start.uploadId,
        uploadToken,
      }),
    }).catch(() => undefined);
    throw error;
  }
}

/**
 * The board-strip derivative, made where the pixels already are.
 *
 * The server cannot make one — the Workers runtime has no image pipeline, and
 * until now derivatives came only from an OFFLINE script over the import. So
 * every photograph uploaded through the app was served at full camera
 * resolution into a 22px board tile until somebody re-ran that script: the
 * exact cost `?thumb=1` exists to avoid, paid on precisely the newest files.
 *
 * Same recipe as the script: 96px, centre-crop cover, WebP — so a tile drawn
 * from this is indistinguishable from a tile drawn from the import. BEST
 * EFFORT by design: the PUT needs an editor's session (a public-form
 * submitter is refused, correctly), Safari cannot encode WebP (`toBlob`
 * answers null), and none of that may fail the upload the person actually
 * asked for — the fallback is the original serving in the tile, heavier but
 * never broken, exactly as before.
 */
const THUMBNAIL_EDGE = 96;

async function offerThumbnail(file: File, attachmentId: string) {
  if (!file.type.startsWith("image/")) return;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_EDGE;
    canvas.height = THUMBNAIL_EDGE;
    const context = canvas.getContext("2d");
    if (!context) return;
    /* Centre-crop cover, matching generate-thumbnails.mjs. */
    const scale = Math.max(
      THUMBNAIL_EDGE / bitmap.width,
      THUMBNAIL_EDGE / bitmap.height,
    );
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(
      bitmap,
      (THUMBNAIL_EDGE - width) / 2,
      (THUMBNAIL_EDGE - height) / 2,
      width,
      height,
    );
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.72),
    );
    /* Not WebP (Safari), or somehow enormous: the server would refuse it. */
    if (!blob || !blob.type.includes("webp") || blob.size > 512 * 1024) return;
    await fetch(`/api/files/${encodeURIComponent(attachmentId)}`, {
      method: "PUT",
      headers: { "Content-Type": "image/webp" },
      body: blob,
    });
  } catch {
    /* The upload itself already succeeded; a missing derivative costs bytes,
       never correctness. */
  }
}

export async function uploadEvidenceFile({
  file,
  requestId,
  kind,
  columnId,
  uploadToken,
  onProgress,
}: {
  file: File;
  requestId: string;
  kind: AttachmentKind;
  columnId?: string;
  uploadToken?: string;
  onProgress?: (progress: number) => void;
}): Promise<UploadResponse> {
  validateFile(file);
  onProgress?.(0);

  const finish = async (result: UploadResponse) => {
    if (result.file?.id) await offerThumbnail(file, result.file.id);
    return result;
  };

  if (file.size > DIRECT_UPLOAD_LIMIT) {
    return finish(
      await multipartUpload({
        file,
        requestId,
        kind,
        columnId,
        uploadToken,
        onProgress,
      }),
    );
  }

  try {
    const result = await directUpload({
      file,
      requestId,
      kind,
      columnId,
      uploadToken,
    });
    onProgress?.(100);
    return finish(result);
  } catch (error) {
    if (error instanceof UploadApiError && error.status === 413) {
      return finish(
        await multipartUpload({
          file,
          requestId,
          kind,
          columnId,
          uploadToken,
          onProgress,
        }),
      );
    }
    throw error;
  }
}
