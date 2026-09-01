import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  activityLog,
  attachments,
  maintenanceRequests,
} from "../../../../db/schema";
import type { MaintenanceRequest } from "../../../lib/types";
import { resolveJobToken } from "../../../lib/job-tokens";
import {
  anonymousRefusal,
  scopedDb,
  scopedDbWithCapability,
} from "../../../lib/tenant-db";
import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import { reconcileAttachmentCounts } from "../../../lib/attachment-counts";
import {
  attachmentPayload,
  documentFieldSnapshot,
  documentFieldUpdates,
  releaseComplianceLinks,
} from "../documents";

/**
 * The only types rendered inline in the browser.
 *
 * Deliberately much smaller than the upload allowlist: a Word document or a zip
 * is legitimate to STORE and has no business being rendered by a browser on
 * this origin. SVG is absent on purpose — it is a script container.
 *
 * Anything not listed is served as `application/octet-stream` with an
 * attachment disposition, which downloads rather than executes.
 */
const INLINE_SAFE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
]);

/**
 * The bucket, resolved once for both handlers in this file.
 *
 * Each `await import("cloudflare:workers")` and each `R2Bucket` annotation is
 * its own unresolved-type error while the Workers types are absent, so a
 * second copy of this pair silently moved the project's 20-error baseline to
 * 22 — and that baseline is what tells the next person whether they broke
 * something. One accessor, two callers, no drift.
 */
async function bucket() {
  const { env } = await import("cloudflare:workers");
  return (env as unknown as { BUCKET?: R2Bucket }).BUCKET;
}


function contentDisposition(name: string, download: boolean) {
  const ascii = name.replace(/[^\x20-\x7E]+/g, "-").replace(/["\\]/g, "-");
  const mode = download ? "attachment" : "inline";
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function parseRange(value: string | null, size: number) {
  const match = value?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const requestedStart = match[1] ? Number(match[1]) : null;
  const requestedEnd = match[2] ? Number(match[2]) : null;
  if (requestedStart === null && requestedEnd === null) return null;

  const start =
    requestedStart === null
      ? Math.max(size - Math.min(requestedEnd ?? 0, size), 0)
      : requestedStart;
  const end = Math.min(
    requestedStart === null ? size - 1 : (requestedEnd ?? size - 1),
    size - 1,
  );
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return null;
  }
  return { start, end, length: end - start + 1 };
}

function requestPayload(
  row: typeof maintenanceRequests.$inferSelect,
): MaintenanceRequest {
  const payload = { ...row } as Record<string, unknown>;
  delete payload.publicUploadTokenHash;
  delete payload.publicUploadTokenExpiresAt;
  delete payload.createdByEmail;
  delete payload.organisationId;
  delete payload.legacyClientId;
  delete payload.createdAt;
  delete payload.updatedAt;
  return payload as unknown as MaintenanceRequest;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureDatabase();
  /*
   * A contractor's job link may fetch that job's photographs, and nothing else.
   *
   * Without this the share link is a 500 in production: the page shows the
   * fault photos, and every one of them resolves here, where an anonymous
   * caller has no session and `scopedDb` throws. It appears to work in
   * development only because the demo identity answers as a super admin.
   *
   * The token does two jobs. It permits the read at all, and it decides which
   * tenant and which job the read is confined to — so a link for job B cannot
   * fetch job A's evidence even though attachment ids are unguessable. The
   * organisation comes from the token rather than from the ambient request,
   * because an anonymous request resolves to the primary organisation whatever
   * the token says.
   *
   * A signed-in caller ignores all of this and reads their own workspace as
   * before; the token path is only consulted when there is no session.
   */
  const shareToken = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  /*
   * A SESSION THAT HAS ENDED IS NOT AN OUTAGE — and on this route it was a 500.
   *
   * Without a token `allowAnonymous` is false, so `scopedDb` refuses a caller
   * with no session by throwing. This handler had no catch, so the throw
   * escaped and the framework answered 500 WITH AN EMPTY BODY. Measured against
   * the deployed preview: a real id, a nonexistent id and a malformed id all
   * gave the identical empty 500 — the throw happens before the row lookup —
   * while the same request with any `?token=` value returned a clean 404,
   * which isolates the refusal as the only cause.
   *
   * The sibling index route already carries this fix and names the symptom in
   * the same words (app/api/files/route.ts, `unavailable`): "an outage where
   * every sibling route says 'sign in', and a stack trace in the log for a
   * request that was correctly refused". It was applied there and not here, and
   * this is the busier route of the two — every thumbnail on a board resolves
   * through it, so one expired session produced a burst of false 500s in error
   * monitoring instead of a single sign-in prompt.
   *
   * Wrapped at the call rather than around the whole handler, which is the
   * idiom PUT below already uses: `anonymousRefusal` answers the refusal and
   * anything else is re-thrown, so a genuine fault is still a fault.
   */
  let scope: Awaited<ReturnType<typeof scopedDb>>;
  try {
    scope = await scopedDb(request, { allowAnonymous: Boolean(shareToken) });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  const { db, orgId, authenticated } = scope;

  const linkScope =
    !authenticated && shareToken ? await resolveJobToken(db, shareToken) : null;
  if (!authenticated && shareToken && !linkScope) {
    // Unknown, expired and revoked are one answer, so a dead link cannot be
    // used to probe whether a file exists.
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const readableOrgId = linkScope ? linkScope.organisationId : orgId;
  const [record] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, readableOrgId)))
    .limit(1);
  if (!record) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  // The link reaches its own job's evidence only. Same 404 as a missing file:
  // a token holder learns nothing about what exists outside their job.
  if (linkScope && record.requestId !== linkScope.requestId) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const storage = await bucket();
  if (!storage) {
    return Response.json({ error: "File storage is unavailable." }, { status: 503 });
  }

  const search = new URL(request.url).searchParams;
  const download = search.get("download") === "1";

  /*
   * `?thumb=1` serves a derivative if one exists, and the original if not.
   *
   * The board draws up to three 22px tiles per photo cell. Serving the
   * originals into them means a 4.5 MB, 4284x5712 photograph decoded into a
   * thumbnail — measured, not guessed — and with two photo columns across 744
   * rows that is tens of megabytes for a screenful. On a phone it is the
   * difference between a board that loads and one that does not.
   *
   * The derivative is written by `db/monday-export/generate-thumbnails.mjs`,
   * which resizes with sharp outside the Worker — workerd has no image
   * pipeline, so this cannot happen on the request path.
   *
   * Falling back rather than 404ing is the important part: a file uploaded
   * through the app has no derivative until that script runs again, and a
   * missing thumbnail must degrade to a heavy image, never to a broken one.
   */
  const wantsThumbnail = search.get("thumb") === "1";
  const thumbnailKey = `${record.objectKey}.thumb`;
  const thumbnailHead = wantsThumbnail
    ? await storage.head(thumbnailKey)
    : null;
  const servingThumbnail = Boolean(thumbnailHead);
  const key = servingThumbnail ? thumbnailKey : record.objectKey;

  const head = servingThumbnail ? thumbnailHead : await storage.head(record.objectKey);
  if (!head) {
    return Response.json({ error: "File bytes are unavailable." }, { status: 404 });
  }

  // A thumbnail is a few kilobytes and never ranged; only video seeking needs it.
  const range = !download && !servingThumbnail && record.contentType.startsWith("video/")
    ? parseRange(request.headers.get("range"), head.size)
    : null;
  const object = await storage.get(
    key,
    range ? { range: { offset: range.start, length: range.length } } : undefined,
  );
  if (!object) {
    return Response.json({ error: "File bytes are unavailable." }, { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);

  /*
   * What the browser is allowed to do with these bytes.
   *
   * The stored `content_type` came from the uploader and used to be echoed
   * straight back with `Content-Disposition: inline`, so a file named
   * `poc.png` declaring `text/html` was served as HTML on this origin and ran.
   * The upload path now refuses that combination, but bytes stored BEFORE that
   * fix are still in the bucket — so the decision is made here as well, where
   * it does not depend on the upload path having been right.
   *
   * Only a small set is rendered inline. Everything else is served as an opaque
   * download whatever it claims to be: a spreadsheet the browser downloads is
   * the correct experience; one the browser executes is not.
   */
  const stored = (record.contentType || "").toLowerCase();
  const inlineSafe = servingThumbnail || INLINE_SAFE_TYPES.has(stored);
  const servedType = servingThumbnail
    ? "image/webp"
    : inlineSafe
      ? stored
      : "application/octet-stream";
  const forceAttachment = download || !inlineSafe;

  headers.set("Content-Type", servedType);
  headers.set(
    "Content-Disposition",
    contentDisposition(record.originalName, forceAttachment),
  );
  /*
   * Without this a browser may sniff past the type above and run whatever it
   * decides the bytes are, which would undo the whole paragraph.
   */
  headers.set("X-Content-Type-Options", "nosniff");
  // Even if something is rendered, it may not fetch, script, or be framed.
  // `sandbox` drops same-origin privileges for the document itself.
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  );
  /*
   * Both objects are immutable by construction, so both may say so. An
   * attachment id is minted per upload and no route ever rewrites bytes under
   * an existing id — "replacing" a file is delete-and-reupload, which is a
   * NEW id and therefore a new URL. The original used to carry max-age=300,
   * which made the hover preview refetch a multi-megabyte photograph every
   * five minutes for a card that had already shown it.
   */
  headers.set("Cache-Control", "private, max-age=86400, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(range?.length ?? object.size));
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
  }

  return new Response(object.body, {
    status: range ? 206 : 200,
    headers,
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureDatabase();

  /*
   * Deleting evidence needs `board.edit`, like writing a thumbnail two handlers
   * up does.
   *
   * This was a bare `scopedDb`, which answers "whose data is this" and never
   * "may you" — so any signed-in member of the workspace, including a `client`
   * whose capabilities are `board.view` and `data.export` and nothing else,
   * could permanently destroy any attachment in the tenant: bytes, row,
   * compliance certificates, completion photographs. The destructive verb was
   * the one left open while the harmless one was guarded.
   */
  const guard = await scopedDbWithCapability(request, "board.edit");
  if (guard.denied) return guard.denied;
  const { actor, db, orgId } = guard.scope;
  const [record] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, orgId)))
    .limit(1);
  if (!record) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const storage = await bucket();
  if (!storage) {
    return Response.json({ error: "File storage is unavailable." }, { status: 503 });
  }

  /*
   * A COMPLIANCE SLOT MUST NOT BE LEFT POINTING AT NOTHING.
   *
   * `compliance_documents.attachment_id` is declared with `.references()` in
   * `db/schema.ts` and HAS NO FOREIGN KEY in the deployed Postgres DDL, so
   * nothing cascades and nothing refuses — deleting a document simply leaves the
   * compliance row naming an id that no longer resolves, and the register offers
   * a certificate link that 404s. Nulled, not deleted: the store still needs a
   * PAT certificate, it just no longer holds one, and removing the row would
   * discard the obligation along with the evidence.
   *
   * Before the row goes, so a failure here stops the delete rather than
   * stranding the pointer.
   */
  await releaseComplianceLinks(db, orgId, id);

  // The thumbnail goes with it. Without this every deleted photograph leaves
  // its 96px derivative in the bucket permanently, with nothing left to
  // reference it.
  await storage.delete([record.objectKey, `${record.objectKey}.thumb`]);
  await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.organisationId, orgId)));

  let updatedRequest: typeof maintenanceRequests.$inferSelect | undefined;
  if (record.requestId) {
    /*
     * RECOUNTED, NOT DECREMENTED.
     *
     * `max(x - 1, 0)` cannot repair a counter that was never right: a job
     * whose issue counter had been inflated to 3 by the boot back-fill in
     * `db/init.ts` still reads 2 after its only real fault photograph is
     * deleted, and the coordinator is still promised two photographs that do
     * not exist. Counting the rows that remain converges from any starting
     * value and makes a repeat of this request a no-op. See
     * `app/lib/attachment-counts.ts`.
     */
    updatedRequest = await reconcileAttachmentCounts(db, orgId, record.requestId);

    await db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: orgId,
      entityType: "maintenance_request",
      entityId: record.requestId,
      action: "request.file_deleted",
      actorEmail: actor.email,
      detail: JSON.stringify({
        fileId: record.id,
        fileName: record.originalName,
        kind: record.kind,
      }),
    });
  }

  /*
   * W07-12 — WRITTEN OUTSIDE `if (record.requestId)`, and that is the fix.
   *
   * The `activity_log` insert above sits inside that branch because it writes to
   * a JOB's timeline and a document with no job has no timeline to write to.
   * The consequence was that an attachment with no `request_id` was permanently
   * destroyed leaving NO trace in either stream — no timeline entry, and no
   * audit event, because documents never wrote audit events at all. W07-07 makes
   * jobless documents ordinary rather than exceptional (a contractor's insurance
   * certificate has no work order), so that silent hole was about to become the
   * common case for exactly the documents most worth accounting for.
   *
   * Written AFTER the destruction, deliberately. The rule `DELETE /api/trash`
   * states: the row and its bytes have just been destroyed, so this event is the
   * only surviving record that they existed — and an event claiming a deletion
   * that then failed would be worse than no event at all.
   */
  await recordAudit({
    db,
    organisationId: orgId,
    actor: auditActor(guard.scope),
    action: "document.deleted",
    entityType: "document",
    entityId: record.id,
    summary: `Permanently deleted ${record.originalName}.`,
    detail: {
      permanent: true,
      fileId: record.id,
      fileName: record.originalName,
      title: record.title,
      documentType: record.documentType,
      expiryDate: record.expiryDate,
      kind: record.kind,
      byteSize: record.byteSize,
      contentType: record.contentType,
      requestId: record.requestId,
      siteId: record.siteId,
      unitId: record.unitId,
      contractorId: record.contractorId,
      boardColumnId: record.boardColumnId,
      versionNo: record.versionNo,
      rootDocumentId: record.rootDocumentId ?? record.id,
    },
    request,
  });

  return Response.json({
    deleted: true,
    request: updatedRequest ? requestPayload(updatedRequest) : null,
  });
}

/**
 * PATCH /api/files/[id] — the document's own fields.
 *
 * W07-02 and W07-05. There was no PATCH on either file route at all: the only
 * other verb that writes here is `PUT`, and that stores a WebP thumbnail. So a
 * document's title, type, description and expiry could be set at upload and
 * never corrected, and "archive" did not exist — the only way to remove
 * something was to destroy it.
 *
 * WHAT THIS MAY NOT TOUCH, and the list is the point. Not the bytes, not
 * `object_key`, not `original_name`, not the organisation, not the uploader, not
 * the job, the site or the version lineage. Editing a document's description
 * must not be able to move it to another tenant's site or re-point it at another
 * job — those are anchor changes, and an anchor change is a different, auditable
 * operation. `original_name` in particular stays the byte-truth: the file a
 * person downloaded must keep matching the copy on their disk, which is why
 * `title` is a separate column rather than a rename.
 *
 * PATCH semantics throughout: an absent key is unchanged, an explicit value is
 * set, an explicit null clears. That is why `documentFieldUpdates` returns a
 * SPARSE object — spreading a complete one into `.set()` would rewrite every
 * field on every edit, so renaming a certificate would silently erase its expiry
 * date and the register would read it as permanently compliant.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureDatabase();

  /*
   * `board.edit`, like DELETE two handlers up and like the thumbnail PUT below.
   * Editing a document's expiry date changes what the compliance register says
   * about a store, so it is an editor's action, not a reader's.
   *
   * Wrapped because `scopedDbWithCapability` THROWS for an anonymous caller
   * rather than returning a refusal — the same reason PUT wraps it.
   */
  let guard: Awaited<ReturnType<typeof scopedDbWithCapability>>;
  try {
    guard = await scopedDbWithCapability(request, "board.edit");
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  if (guard.denied) return guard.denied;
  const { db, orgId, actor } = guard.scope;

  const body = (await request.json().catch(() => null)) as unknown;
  // A body of literal `null` PARSES, so the catch never fires and every
  // `body.x` below would throw straight into a 503. An array is not a record
  // either. Same guard `/api/board` and the multipart route both use.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { error: "The request body must be a JSON object." },
      { status: 400 },
    );
  }
  const payload = body as Record<string, unknown>;

  const [record] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, orgId)))
    .limit(1);
  if (!record) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const fields = documentFieldUpdates(payload);
  // A malformed expiry is answered here. The Postgres CHECK on `expiry_date`
  // would otherwise make it a database error, and the route's catch-all would
  // report an outage for what is really a typo.
  if (!fields.ok) {
    return Response.json({ error: fields.error }, { status: 400 });
  }
  const values: Partial<typeof attachments.$inferSelect> = { ...fields.values };

  /*
   * W07-05 — ARCHIVE, the half of "archive or remove" that did not exist.
   *
   * Soft and reversible, which is the whole difference from DELETE: the bytes
   * stay, the row stays, and the document simply stops being live. `listFiles`
   * filters archived rows out by default, so an archived certificate leaves the
   * register exactly as a deleted one would — without being unrecoverable.
   *
   * `archived: true` on an already-archived document keeps the original
   * timestamp rather than refreshing it: when it was archived is a fact, and an
   * idempotent request must not rewrite history.
   */
  let archiveAction: "archived" | "restored" | null = null;
  if ("archived" in payload) {
    const wantArchived = payload.archived === true;
    const isArchived = Boolean(record.archivedAt);
    if (wantArchived && !isArchived) {
      values.archivedAt = new Date().toISOString();
      values.archivedBy = actor.email;
      archiveAction = "archived";
    } else if (!wantArchived && isArchived) {
      values.archivedAt = null;
      values.archivedBy = null;
      archiveAction = "restored";
    }
  }

  if (!Object.keys(values).length) {
    // Nothing was asked for. A no-op is not an error, and answering 400 would
    // make a form that submits unchanged fields look broken.
    return Response.json({ file: attachmentPayload(record), unchanged: true });
  }

  values.metadataUpdatedAt = new Date().toISOString();
  values.metadataUpdatedBy = actor.email;

  const [updated] = await db
    .update(attachments)
    .set(values)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, orgId)))
    .returning();

  /*
   * W07-12. `changeDetail` reduces the edit to the fields that actually moved,
   * so the Audit viewer renders a before/after table rather than a blob — and so
   * an edit that touched one field does not read as having touched everything.
   */
  await recordAudit({
    db,
    organisationId: orgId,
    actor: auditActor(guard.scope),
    action:
      archiveAction === "archived"
        ? "document.archived"
        : archiveAction === "restored"
          ? "document.restored"
          : "document.metadata_updated",
    entityType: "document",
    entityId: id,
    summary:
      archiveAction === "archived"
        ? `Archived ${updated.title || updated.originalName}.`
        : archiveAction === "restored"
          ? `Restored ${updated.title || updated.originalName} from the archive.`
          : `Updated the details of ${updated.title || updated.originalName}.`,
    detail: changeDetail(
      documentFieldSnapshot(record),
      documentFieldSnapshot(updated),
    ),
    request,
  });

  return Response.json({ file: attachmentPayload(updated) });
}

/** A thumbnail is a few kilobytes. Anything larger is not a thumbnail. */
const MAX_THUMBNAIL_BYTES = 512 * 1024;

/**
 * Stores a pre-rendered thumbnail beside its original.
 *
 * The Workers runtime has no image pipeline, so a derivative cannot be made on
 * the request path. `db/monday-export/generate-thumbnails.mjs` resizes with
 * sharp outside the Worker and PUTs the result here; `GET /api/files/[id]?thumb=1`
 * then serves it, falling back to the original when it is absent.
 *
 * Why an endpoint rather than writing R2 directly: the bucket the dev server
 * reads is Miniflare's, whose on-disk layout is an internal detail and differs
 * from the one `wrangler r2 object put` writes. Going through the app is the
 * only way to be sure the bytes land where the app will look for them — the
 * same reason the asset import uploads through `/api/files` rather than
 * writing rows and objects separately.
 *
 * Guarded by `board.edit`. Writing a derivative changes what every viewer of
 * that board sees, so it is an editor's action, not a reader's.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureDatabase();

  /*
   * A missing derivative is a nicety; an anonymous caller asking for one is not
   * an outage. The public form uploads a photograph with no session behind it,
   * and the browser then offers a thumbnail here — where
   * `scopedDbWithCapability` THROWS for an anonymous request instead of
   * returning a refusal, which surfaced as a 500 on an ordinary submission.
   * Refused the way every other route refuses, so the log stays honest about
   * what is actually broken.
   */
  let guard: Awaited<ReturnType<typeof scopedDbWithCapability>>;
  try {
    guard = await scopedDbWithCapability(request, "board.edit");
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    throw error;
  }
  if (guard.denied) return guard.denied;
  const { db, orgId } = guard.scope;

  const [record] = await db
    .select({ objectKey: attachments.objectKey })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.organisationId, orgId)))
    .limit(1);
  if (!record) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) {
    return Response.json({ error: "No thumbnail bytes were sent." }, { status: 400 });
  }
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
    return Response.json(
      { error: "That is larger than a thumbnail should ever be." },
      { status: 413 },
    );
  }

  /*
   * WebP only, checked by signature rather than by the caller's word.
   *
   * "RIFF" then "WEBP" at byte 8. A derivative endpoint that stored whatever it
   * was handed would be an arbitrary write into the bucket under a key derived
   * from someone else's file.
   */
  const isWebp =
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isWebp) {
    return Response.json(
      { error: "A thumbnail must be WebP." },
      { status: 415 },
    );
  }

  const storage = await bucket();
  if (!storage) {
    return Response.json({ error: "File storage is unavailable." }, { status: 503 });
  }

  await storage.put(`${record.objectKey}.thumb`, bytes, {
    httpMetadata: { contentType: "image/webp" },
  });

  return Response.json({ ok: true, bytes: bytes.byteLength });
}
