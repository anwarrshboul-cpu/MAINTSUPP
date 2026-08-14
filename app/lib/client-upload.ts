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
const MULTIPART_CHUNK_SIZE = 5 * 1024 * 1024;
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

async function readApi<T>(response: Response): Promise<T> {
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
        : friendlyError(response.status, body);
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
      const uploaded = await readApi<MultipartPartResponse>(response);
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

  if (file.size > DIRECT_UPLOAD_LIMIT) {
    return multipartUpload({
      file,
      requestId,
      kind,
      columnId,
      uploadToken,
      onProgress,
    });
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
    return result;
  } catch (error) {
    if (error instanceof UploadApiError && error.status === 413) {
      return multipartUpload({
        file,
        requestId,
        kind,
        columnId,
        uploadToken,
        onProgress,
      });
    }
    throw error;
  }
}
