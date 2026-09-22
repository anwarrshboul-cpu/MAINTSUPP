/**
 * DIRECT UPLOADS — what `start` agreed to, remembered until the upload ends.
 *
 * A file over 900 KB is uploaded in parts. On a deployment whose storage can
 * sign part URLs (S3 — Supabase Storage in production) the browser puts each
 * part straight into the private bucket on a write-only URL the route signs
 * for exactly that part; elsewhere (Miniflare R2 locally, the filesystem driver
 * on Railway) the parts still travel through `PUT /api/files/multipart`. Either
 * way the bytes of a 90 MB video never pass through a Vercel function, whose
 * request body is capped at 4.5 MB.
 *
 * Because the server may never see those bytes, it remembers at `start`:
 *   - WHO began the upload (`uploaderKey`) and in WHICH workspace;
 *   - the key it chose — the browser never names a path;
 *   - the declared type and the EXACT size, and the part plan derived from it;
 *   - when the whole session expires.
 * Every later step must match that row. `claimFinalize` moves it from
 * `pending` to `finalizing` in one conditional UPDATE, so `complete` runs once.
 */

import { and, eq, inArray } from "drizzle-orm";
import { uploadSessions } from "../../db/schema";
import type { ScopedDatabase } from "./tenant-db";

type Db = ScopedDatabase["db"];
export type UploadSession = typeof uploadSessions.$inferSelect;

/** S3's floor for every part except the last, and the size each part is planned at. */
export const UPLOAD_PART_SIZE = 5 * 1024 * 1024;
/** A whole upload must finish within this; a 90 MB video on a slow phone takes minutes. */
export const UPLOAD_SESSION_LIFETIME_MS = 6 * 60 * 60 * 1000;
/** One part URL is good for this long, and is signed only when the browser asks. */
export const PART_URL_LIFETIME_SECONDS = 15 * 60;

export type Transport = "direct" | "proxy";

/**
 * What a storage driver's multipart handle must offer for the browser to send
 * parts straight to it. The S3 driver has both; Miniflare's R2 and the
 * filesystem driver have neither, and keep the proxied path.
 */
export interface DirectPartTransport {
  presignPart(partNumber: number, contentLength: number, expiresSeconds: number): string;
  listParts(): Promise<Array<{ partNumber: number; etag: string; size: number }>>;
}

export function directTransport(multipart: unknown): DirectPartTransport | null {
  const candidate = multipart as Partial<DirectPartTransport> | null;
  return candidate &&
    typeof candidate.presignPart === "function" &&
    typeof candidate.listParts === "function"
    ? (candidate as DirectPartTransport)
    : null;
}

/** How a file of `byteSize` bytes is cut: every part `UPLOAD_PART_SIZE`, the last one the rest. */
export function partPlan(byteSize: number, partSize = UPLOAD_PART_SIZE) {
  const partCount = Math.max(1, Math.ceil(byteSize / partSize));
  return {
    partSize,
    partCount,
    sizeOf(partNumber: number): number {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) return 0;
      return partNumber < partCount ? partSize : byteSize - partSize * (partCount - 1);
    },
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * WHO an upload belongs to, as a stable string.
 *
 * A job link is the grant when there is one (a signed-in coordinator holding a
 * contractor link is exercising the LINK — the same order `resolveUploadTenant`
 * uses), then the signed-in user, then — locally only, where the testing
 * switcher stands in for a session — the acting identity. A legacy request-row
 * token has no id of its own, so its hash stands in: two people holding the
 * same link are the same grant, which is exactly what the link means.
 */
export async function uploaderKey(input: {
  tokenId: string | null;
  uploadToken: string;
  userId: string | null;
  authenticated: boolean;
  actorEmail: string;
}): Promise<string> {
  if (input.tokenId) return `link:${input.tokenId}`;
  if (input.uploadToken) return `token:${(await sha256Hex(input.uploadToken)).slice(0, 32)}`;
  if (input.authenticated && input.userId) return `user:${input.userId}`;
  return `actor:${input.actorEmail.trim().toLowerCase()}`;
}

export async function createUploadSession(
  db: Db,
  values: {
    organisationId: string;
    fileId: string;
    objectKey: string;
    uploadId: string;
    uploader: string;
    transport: Transport;
    contentType: string;
    originalName: string;
    byteSize: number;
  },
  now = Date.now(),
): Promise<UploadSession> {
  const plan = partPlan(values.byteSize);
  const [row] = await db
    .insert(uploadSessions)
    .values({
      id: crypto.randomUUID(),
      ...values,
      partSize: plan.partSize,
      partCount: plan.partCount,
      state: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + UPLOAD_SESSION_LIFETIME_MS).toISOString(),
    })
    .returning();
  return row;
}

/** The session behind a key and upload id, in this workspace — or null. */
export async function findUploadSession(
  db: Db,
  where: { organisationId: string; objectKey: string; uploadId: string },
): Promise<UploadSession | null> {
  const [row] = await db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.organisationId, where.organisationId),
        eq(uploadSessions.objectKey, where.objectKey),
        eq(uploadSessions.uploadId, where.uploadId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether THIS caller may act on this session now.
 *
 * Not found, someone else's, and a mismatched key all answer the same 404 — a
 * caller probing for another person's upload learns nothing about whether it
 * exists. An ended session says so plainly (410), because the person it belongs
 * to needs to know to start again.
 */
export function sessionRefusal(
  session: UploadSession | null,
  uploader: string,
  now = Date.now(),
): { status: number; error: string } | null {
  if (!session || session.uploader !== uploader) {
    return { status: 404, error: "The upload session is invalid." };
  }
  if (session.state !== "pending") {
    return { status: 410, error: "This upload has already ended. Start it again." };
  }
  if (Date.parse(session.expiresAt) <= now) {
    return { status: 410, error: "This upload took too long and has expired. Start it again." };
  }
  return null;
}

/** `pending` → `finalizing`, once. False when another `complete` got there first. */
export async function claimFinalize(db: Db, id: string, organisationId: string): Promise<boolean> {
  const [claimed] = await db
    .update(uploadSessions)
    .set({ state: "finalizing" })
    .where(
      and(
        eq(uploadSessions.id, id),
        eq(uploadSessions.organisationId, organisationId),
        eq(uploadSessions.state, "pending"),
      ),
    )
    .returning({ id: uploadSessions.id });
  return Boolean(claimed);
}

export async function settleUploadSession(
  db: Db,
  id: string,
  organisationId: string,
  state: "completed" | "aborted" | "failed" | "expired",
  now = Date.now(),
): Promise<void> {
  await db
    .update(uploadSessions)
    .set({ state, finalizedAt: new Date(now).toISOString() })
    .where(and(eq(uploadSessions.id, id), eq(uploadSessions.organisationId, organisationId)));
}

/**
 * The daily sweep: every pending (or stuck finalizing) session past its expiry
 * is aborted in storage — which discards its parts — and marked `expired`.
 * Nothing about a document changes: an expired session never had a row.
 */
export async function expireUploadSessions(
  db: Db,
  abortInStorage: (objectKey: string, uploadId: string) => Promise<void>,
  options: { now?: number; limit?: number } = {},
): Promise<{ considered: number; expired: number; failed: number }> {
  const now = options.now ?? Date.now();
  const candidates = await db
    .select()
    .from(uploadSessions)
    .where(inArray(uploadSessions.state, ["pending", "finalizing"]))
    .limit(options.limit ?? 500);
  let expired = 0;
  let failed = 0;
  for (const session of candidates) {
    // Compared here, not in SQL: see the note on `ensureUploadSessions`.
    if (Date.parse(session.expiresAt) > now) continue;
    try {
      await abortInStorage(session.objectKey, session.uploadId);
      await settleUploadSession(db, session.id, session.organisationId, "expired", now);
      expired += 1;
    } catch {
      failed += 1;
    }
  }
  return { considered: candidates.length, expired, failed };
}
