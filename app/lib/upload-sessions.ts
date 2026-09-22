/**
 * DIRECT UPLOADS — what `start` agreed to, remembered until the upload ends.
 *
 * A file over 900 KB is uploaded in parts. On a deployment whose storage can
 * sign part URLs (S3 — Supabase Storage in production) the browser puts each
 * part straight into the private bucket on a write-only URL the route signs
 * for exactly that part; elsewhere (Miniflare R2 locally, the filesystem driver
 * on Railway) the parts still travel through `PUT /api/files/multipart`. Either
 * way the bytes of a 50 MB video never pass through a Vercel function, whose
 * request body is capped at 4.5 MB.
 *
 * Because the server may never see those bytes, it remembers at `start`:
 *   - WHO began the upload (`uploaderKey`) and in WHICH workspace;
 *   - the key it chose — the browser never names a path;
 *   - the declared type and the EXACT size, and the part plan derived from it;
 *   - when the whole session expires.
 * Every later step must match that row. Every change of state is CONDITIONAL
 * on the state it expects, so two callers (or a caller and the daily sweep)
 * can never both act on one upload.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { uploadSessions } from "../../db/schema";
import type { ScopedDatabase } from "./tenant-db";

type Db = ScopedDatabase["db"];
export type UploadSession = typeof uploadSessions.$inferSelect;

/** S3's floor for every part except the last, and the size each part is planned at. */
export const UPLOAD_PART_SIZE = 5 * 1024 * 1024;
/** A whole upload must finish within this; a 50 MB video on a slow phone takes minutes. */
export const UPLOAD_SESSION_LIFETIME_MS = 6 * 60 * 60 * 1000;
/** One part URL is good for this long, and is signed only when the browser asks. */
export const PART_URL_LIFETIME_SECONDS = 15 * 60;
/**
 * How many uploads one uploader may have in flight at once. A board drop of a
 * handful of photographs is well inside it; a script opening sessions to park
 * parts in the bucket is not. Parts cost storage from the moment they land.
 */
export const MAX_PENDING_UPLOADS_PER_UPLOADER = 8;
/** A `finalizing` session is left alone this long past expiry — `complete` may still be running. */
const FINALIZING_GRACE_MS = 60 * 60 * 1000;

export type Transport = "direct" | "proxy";

/**
 * Which bucket an upload is going into. `documents` is the private `job-media`
 * bucket (every workspace file); `cms-media` is the website's own bucket
 * (decision K). The sweep aborts an abandoned upload in the bucket it names.
 */
export type UploadTarget = "documents" | "cms-media";

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

/**
 * Whether the parts the BUCKET lists are exactly the parts the plan names.
 *
 * Numbers always: 1..n, each once, nothing else. Sizes only where the provider
 * reports one — Supabase Storage's ListParts answers `Size` 0 for every part
 * (measured on the Staging bucket), and a check that can never pass there
 * would refuse every direct upload. The size is still held on three other
 * sides: each part URL SIGNS its content-length (the bucket refused a
 * different size — measured), the assembled object's size is compared with
 * the declared size after `complete`, and its first bytes with its type.
 */
export function partsMatchPlan(
  listed: Array<{ partNumber: number; size: number }>,
  plan: ReturnType<typeof partPlan>,
): boolean {
  return (
    listed.length === plan.partCount &&
    listed.every(
      (part, index) =>
        part.partNumber === index + 1 && (!(part.size > 0) || part.size === plan.sizeOf(index + 1)),
    )
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * WHO an upload belongs to, as a stable string — taken from the grant that
 * actually AUTHORISED the call (`resolveUploadAuthority`'s `via`), never from
 * whatever else the request happened to carry. A dead link sent alongside a
 * signed-in editor's session authorised nothing, so it names nobody:
 *   - `job-token`: the job link (`link:<id>`);
 *   - `request-token`: a legacy request-row token has no id, so its hash —
 *     two people holding the same link are the same grant, which is what the
 *     link means;
 *   - `capability`: the signed-in user, or — locally only, where the testing
 *     switcher stands in for a session — the acting identity.
 */
export async function uploaderKey(input: {
  via: "job-token" | "request-token" | "capability";
  tokenId: string | null;
  uploadToken: string;
  userId: string | null;
  authenticated: boolean;
  actorEmail: string;
}): Promise<string> {
  if (input.via === "job-token" && input.tokenId) return `link:${input.tokenId}`;
  if (input.via === "request-token" && input.uploadToken) {
    return `token:${(await sha256Hex(input.uploadToken)).slice(0, 32)}`;
  }
  if (input.authenticated && input.userId) return `user:${input.userId}`;
  return `actor:${input.actorEmail.trim().toLowerCase()}`;
}

/** How many of this uploader's sessions are still in flight in this workspace. */
export async function pendingUploadCount(
  db: Db,
  organisationId: string,
  uploader: string,
  now = Date.now(),
): Promise<number> {
  const rows = await db
    .select({ expiresAt: uploadSessions.expiresAt })
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.organisationId, organisationId),
        eq(uploadSessions.uploader, uploader),
        eq(uploadSessions.state, "pending"),
      ),
    )
    .limit(MAX_PENDING_UPLOADS_PER_UPLOADER * 4);
  // Expired rows are the sweep's to close; they no longer count against anyone.
  return rows.filter((row) => Date.parse(row.expiresAt) > now).length;
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
    /* Absent means `documents`, the column's default — every caller before K. */
    target?: UploadTarget;
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

/**
 * Move a session from one of `from` to `to`, and say whether THIS call did it.
 * One conditional UPDATE: of two callers racing for the same transition,
 * exactly one gets `true`.
 */
export async function transitionUploadSession(
  db: Db,
  id: string,
  organisationId: string,
  from: string[],
  to: "finalizing" | "completed" | "aborted" | "failed" | "expired",
  now = Date.now(),
): Promise<boolean> {
  const [moved] = await db
    .update(uploadSessions)
    .set(to === "finalizing" ? { state: to } : { state: to, finalizedAt: new Date(now).toISOString() })
    .where(
      and(
        eq(uploadSessions.id, id),
        eq(uploadSessions.organisationId, organisationId),
        inArray(uploadSessions.state, from),
      ),
    )
    .returning({ id: uploadSessions.id });
  return Boolean(moved);
}

/** `pending` → `finalizing`, once. False when another `complete` (or an abort) got there first. */
export function claimFinalize(db: Db, id: string, organisationId: string): Promise<boolean> {
  return transitionUploadSession(db, id, organisationId, ["pending"], "finalizing");
}

/** How a claimed `complete` ended. Only from `finalizing`: nothing else may overwrite it. */
export function settleUploadSession(
  db: Db,
  id: string,
  organisationId: string,
  state: "completed" | "failed",
  now = Date.now(),
): Promise<boolean> {
  return transitionUploadSession(db, id, organisationId, ["finalizing"], state, now);
}

/** `pending` → `aborted`. Only the caller that wins this may abort the upload in storage. */
export function abandonUploadSession(db: Db, id: string, organisationId: string): Promise<boolean> {
  return transitionUploadSession(db, id, organisationId, ["pending"], "aborted");
}

/**
 * The daily sweep, oldest first: every pending session past its expiry — and a
 * `finalizing` one only an hour past it, so a `complete` still running is left
 * alone — is aborted in storage (its parts are discarded) and then marked
 * `expired`, conditionally, so a session that finished meanwhile keeps its
 * state. Nothing about a document changes: an expired session never had a row.
 */
export async function expireUploadSessions(
  db: Db,
  abortInStorage: (objectKey: string, uploadId: string, target: UploadTarget) => Promise<void>,
  options: { now?: number; limit?: number } = {},
): Promise<{ considered: number; expired: number; failed: number }> {
  const now = options.now ?? Date.now();
  const candidates = await db
    .select()
    .from(uploadSessions)
    .where(inArray(uploadSessions.state, ["pending", "finalizing"]))
    .orderBy(asc(uploadSessions.expiresAt))
    .limit(options.limit ?? 500);
  let expired = 0;
  let failed = 0;
  for (const session of candidates) {
    // Compared here, not in SQL: see the note on `ensureUploadSessions`.
    const deadline = Date.parse(session.expiresAt) + (session.state === "finalizing" ? FINALIZING_GRACE_MS : 0);
    if (deadline > now) continue;
    try {
      await abortInStorage(session.objectKey, session.uploadId, session.target === "cms-media" ? "cms-media" : "documents");
      if (await transitionUploadSession(db, session.id, session.organisationId, ["pending", "finalizing"], "expired", now)) {
        expired += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { considered: candidates.length, expired, failed };
}
