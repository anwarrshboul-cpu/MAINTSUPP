"use client";

/**
 * Sending bytes to the API, and asking it what it will take.
 *
 * THE RULES ARE NOT COPIED HERE. `GET /uploads/limits` states the size ceiling
 * and the accepted content types at runtime, because a second copy of "10MB,
 * JPEG/PNG/WebP/HEIC/PDF" in this repository is a copy that drifts from
 * `apps/api/src/lib/files.ts` the first time either changes — and the way that
 * drift presents is a form that cheerfully accepts a file the server then
 * refuses, after the upload has already cost somebody their mobile data.
 *
 * Everything below is advisory. The API sniffs the magic number, measures the
 * real byte length and refuses on both, whatever this file believed.
 */

import { useEffect, useRef, useState } from "react";
import { api, type ApiResult } from "./api";

export type UploadLimits = {
  maxBytes: number;
  maxMb: number;
  /** Canonical content types, exactly as the API's allow-list spells them. */
  accept: string[];
  signedUrlTtlSeconds: number;
};

let inFlight: Promise<UploadLimits | null> | undefined;

/**
 * The limits, fetched once per page load and shared by every form on it.
 *
 * A failure is not memoised — the next form to ask tries again, so a page
 * opened during a blip is not stuck without limits until it is reloaded.
 */
export function uploadLimits(): Promise<UploadLimits | null> {
  if (!inFlight) {
    inFlight = api<UploadLimits>("/uploads/limits").then((result) => {
      if (!result.ok) {
        inFlight = undefined;
        return null;
      }
      return result.data;
    });
  }
  return inFlight;
}

/** The same fetch, for a component that needs to re-render when it lands. */
export function useUploadLimits(): UploadLimits | null {
  const [limits, setLimits] = useState<UploadLimits | null>(null);
  useEffect(() => {
    let alive = true;
    uploadLimits().then((value) => {
      if (alive) setLimits(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return limits;
}

/**
 * The `accept` attribute for a file input.
 *
 * Before the limits land this is a broad hint rather than a guess at the
 * allow-list: `accept` only filters what the picker offers, and offering too
 * much costs a clear error message where offering too little hides the
 * photograph somebody came to send.
 */
export const acceptAttribute = (limits: UploadLimits | null): string =>
  limits ? limits.accept.join(",") : "image/*,application/pdf";

/** "JPEG, PNG, WebP, HEIC or PDF", built from whatever the API allows today. */
export function describeAccepted(limits: UploadLimits | null): string {
  if (!limits || limits.accept.length === 0) return "a photograph or a PDF";
  const names = limits.accept.map((type) => type.split("/")[1].toUpperCase());
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * Browser spellings of types the API stores under one canonical name.
 *
 * Safari says `image/heic` where some Android builds say `image/heif` for the
 * same file, and a few stacks still emit `image/pjpeg`. The API folds these
 * before it checks its allow-list; without the same folding here the local
 * pre-check would refuse a photograph the server would have accepted.
 */
const ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/heif": "image/heic",
  "image/heic-sequence": "image/heic",
  "image/heif-sequence": "image/heic",
};

/**
 * Why this file cannot be sent, or "" if it can.
 *
 * Deliberately lenient about a missing or `application/octet-stream` type: a
 * phone camera roll routinely reports one of those for a perfectly good HEIC,
 * and the server decides from the bytes anyway. The check that earns its place
 * is the size one, because it is the only one that saves a five-megabyte
 * upload over a shop's mobile signal before it starts.
 */
export function rejectionFor(file: File, limits: UploadLimits | null): string {
  if (!limits) return ""; // limits unknown: let the API be the one to refuse
  if (file.size === 0) return "That file is empty.";
  if (file.size > limits.maxBytes) {
    return `Each file must be ${limits.maxMb}MB or smaller — take the photograph again at a lower resolution.`;
  }

  const declared = file.type.split(";")[0].trim().toLowerCase();
  const canonical = ALIASES[declared] ?? declared;
  if (!canonical || canonical === "application/octet-stream") return "";
  if (!limits.accept.includes(canonical)) {
    return `That file type is not accepted. Send ${describeAccepted(limits)}.`;
  }
  return "";
}

/**
 * One file, one request, to any of the API's upload endpoints.
 *
 * The field name is `file` on every one of them, and extra fields (a kind, an
 * uploader's name) ride in the same body — see `apps/api/src/routes/uploads.ts`.
 * `api()` is used rather than a bare `fetch` so the session cookie still goes
 * with it on the authenticated route; it leaves the content type alone for a
 * FormData body, which is what makes the boundary survive.
 */
export function uploadFile<T>(
  path: string,
  file: File,
  fields: Record<string, string> = {},
): Promise<ApiResult<T>> {
  const body = new FormData();
  body.append("file", file, file.name);
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  return api<T>(path, { method: "POST", body });
}

/* ------------------------------------------------------------ the queue -- */

/** One file on its way. `sent` means the API accepted it, nothing more. */
export type Queued = {
  id: string;
  file: File;
  state: "ready" | "sending" | "sent" | "failed";
  error?: string;
};

let seq = 0;

/**
 * A list of files, sent one at a time, each keeping its own outcome.
 *
 * SEQUENTIAL, deliberately. These uploads happen from a phone on a shop's
 * mobile signal: six parallel multipart bodies share one narrow uplink, so they
 * all land late together and no progress line can say anything true in the
 * meantime. One at a time also means a rate limit answered on the second file
 * stops the other four instead of racing them.
 *
 * ALREADY-SENT FILES ARE SKIPPED on a retry. The API would happily store a
 * second copy, and then somebody has to work out which duplicate to discard.
 *
 * The per-file state is the point of the whole hook: a photograph that failed
 * must stay on screen as a failure, with the API's own reason next to it. A
 * count cannot tell the person holding the phone WHICH picture did not arrive.
 */
export function useUploadQueue(path: string, max = 10) {
  const [items, setItems] = useState<Queued[]>([]);
  const [busy, setBusy] = useState(false);
  /* Read inside the send loop, which would otherwise close over the list as it
     was when the button was pressed. */
  const live = useRef<Queued[]>([]);
  const limits = useUploadLimits();

  const commit = (next: Queued[]) => {
    live.current = next;
    setItems(next);
  };

  const mark = (id: string, changes: Partial<Queued>) =>
    commit(
      live.current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );

  /** Adds what it can and returns why anything was left out, or "". */
  function choose(list: FileList | null): string {
    if (!list || list.length === 0) return "";
    let rejected = "";
    const next = [...live.current];
    for (const file of Array.from(list)) {
      if (next.length >= max) {
        rejected = `Send up to ${max} files at a time.`;
        continue;
      }
      const why = rejectionFor(file, limits);
      if (why) {
        rejected = why;
        continue;
      }
      seq += 1;
      next.push({ id: `q${seq}`, file, state: "ready" });
    }
    commit(next);
    return rejected;
  }

  function drop(id: string) {
    commit(live.current.filter((item) => item.id !== id));
  }

  function clear() {
    commit([]);
  }

  async function send(
    fields: Record<string, string> = {},
  ): Promise<{ sent: number; failed: number }> {
    setBusy(true);
    let sent = 0;
    let failed = 0;
    for (const item of live.current.filter((entry) => entry.state !== "sent")) {
      mark(item.id, { state: "sending", error: undefined });
      const result = await uploadFile(path, item.file, fields);
      if (result.ok) {
        sent += 1;
        mark(item.id, { state: "sent" });
      } else {
        failed += 1;
        mark(item.id, { state: "failed", error: result.error });
      }
    }
    setBusy(false);
    return { sent, failed };
  }

  return { items, choose, send, drop, clear, busy, limits };
}

/** `POST /public/intake/upload` — `photo` is the claim ticket, not a key. */
export type IntakeTicket = { ok: true; photo: string; originalName: string };
