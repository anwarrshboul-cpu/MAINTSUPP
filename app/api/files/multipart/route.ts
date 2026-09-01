import { and, eq, isNull } from "drizzle-orm";
import type { AttachmentKind, MaintenanceRequest } from "../../../lib/types";
import { ensureDatabase } from "../../../../db/init";
import {
  activityLog,
  attachments,
  maintenanceBoardColumns,
  maintenanceRequests,
} from "../../../../db/schema";
import { boardKeyForRequest } from "../../../lib/board-registry";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";
import { auditActor, recordAudit } from "../../../lib/audit";
import {
  kindForColumnKey,
  reconcileAttachmentCounts,
} from "../../../lib/attachment-counts";
import {
  type Anchors,
  anchorRefusal,
  anchorReferencesRefusal,
  anchorSegment,
  attachmentPayload,
  documentFieldUpdates,
  planVersion,
  readAnchors,
  resolveSiteId,
  restorePredecessor,
  standDownPredecessor,
} from "../documents";
import {
  pendingReview,
  resolveUploadAuthority,
  resolveUploadTenant,
} from "../upload-authority";

const MAX_STANDARD_FILE_SIZE = 25 * 1024 * 1024;
const MAX_VIDEO_FILE_SIZE = 90 * 1024 * 1024;
const MAX_PART_SIZE = 5 * 1024 * 1024;
const allowedKinds = new Set<AttachmentKind>([
  "issue",
  "completion",
  "general",
]);
const allowedTypes = new Set([
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
const allowedExtensions = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "heic",
  "heif",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "mkv",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "csv",
  "zip",
]);
const videoExtensions = new Set(["mp4", "webm", "mov", "m4v", "mkv"]);

function safeFileName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function fileExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isVideo(originalName: string, contentType: string) {
  return (
    contentType.startsWith("video/") ||
    videoExtensions.has(fileExtension(originalName))
  );
}

/**
 * Whether this file may be stored at all.
 *
 * AND, not OR. This was `allowedTypes.has(type) || allowedExtensions.has(ext)`,
 * and BOTH halves are supplied by the caller — so naming a file `poc.png` while
 * declaring `Content-Type: text/html` satisfied the extension half and stored
 * the HTML type, which `GET /api/files/[id]` then echoed back as the response
 * type with `Content-Disposition: inline`. That is script execution on the
 * application's own origin, and a contractor job link — no session at all — was
 * enough to plant it.
 *
 * Requiring both closes it at the door: a declared type outside the list is
 * refused however the file is named, and a name outside the list is refused
 * however it is declared. SVG is absent from both lists on purpose, and the OR
 * was quietly defeating that.
 *
 * The serving side is hardened independently in `files/[id]/route.ts` — a file
 * stored before this change must not become executable just because it is old.
 */
function isAllowedFile(originalName: string, contentType: string) {
  const declared = (contentType ?? "").trim();
  const typeOk = declared ? allowedTypes.has(declared) : true;
  return typeOk && allowedExtensions.has(fileExtension(originalName));
}

/*
 * `attachmentPayload` used to be declared here as well, and the two copies had
 * already drifted: this one omitted `uploadedByEmail`, so which fields a caller
 * received depended on how large their file was. It now comes from
 * `../documents` along with the field rules, so there is one answer to the
 * question "what is a document".
 */

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

async function bucket() {
  const { env } = await import("cloudflare:workers");
  const runtimeEnv = env as unknown as { BUCKET?: R2Bucket };
  return runtimeEnv.BUCKET;
}

async function authorizeUpload(
  request: Request,
  requestId: string,
  requestedKind: string,
  uploadToken: string,
  requestedColumnId: string,
  /*
   * The other three anchors (W07-07). Optional so the PUT part handler — which
   * carries them in headers and has already had them validated by `start` —
   * need not repeat the lookups for every 5 MB chunk.
   */
  extraAnchors: Partial<Anchors> = {},
) {
  await ensureDatabase();
  /*
   * `allowAnonymous`, because a contractor on a job link has no session and the
   * token below is what proves them.
   *
   * Without it `scopedDb` threw before the token was ever looked at, so a
   * contractor could upload a 200 KB photograph through the direct route and
   * nothing at all over 900 KB — every real phone picture — and the refusal
   * they got was "sign in", which is not something a job link can do.
   */
  const scope = await scopedDb(request, { allowAnonymous: true });
  const { actor, db } = scope;
  let orgId = scope.orgId;
  /*
   * `isOperator = authenticated || demoIdentityAllowed()` used to stand here and
   * decide every branch below. It is gone — see `../upload-authority.ts`. What
   * it was covering for is real and is preserved: the sidebar's "Preview User /
   * TESTING ACCESS" switcher is deliberately not `authenticated`, and reading
   * that as "anonymous stranger with no job link" is what made uploading a
   * photograph from the board answer "This link does not belong to that job."
   * A capability check reads the switcher's ROLE instead, so it keeps working
   * and now says something true in production as well.
   */
  const kind = allowedKinds.has(requestedKind as AttachmentKind)
    ? (requestedKind as AttachmentKind)
    : null;
  const boardColumnId = requestedColumnId.trim().slice(0, 100);
  const anchors = readAnchors({
    requestId,
    siteId: extraAnchors.siteId,
    unitId: extraAnchors.unitId,
    contractorId: extraAnchors.contractorId,
  });
  if (!kind) {
    return {
      response: Response.json(
        { error: "A valid file section is required." },
        { status: 400 },
      ),
    } as const;
  }
  // W07-07 — a job is no longer mandatory, but SOMETHING is.
  const missingAnchor = anchorRefusal(anchors);
  if (missingAnchor) return { response: missingAnchor } as const;

  /*
   * THE TOKEN IS RESOLVED BEFORE THE JOB IS LOOKED UP, because it decides which
   * tenant we are in. This is the same ordering `../route.ts` uses, and for the
   * same reason.
   *
   * An anonymous caller's ambient `orgId` is always the PRIMARY organisation.
   * Looking the job up with that and checking the token afterwards would mean
   * the only thing standing between a second tenant's link and the first
   * tenant's job is the two ids happening not to collide — and they are not
   * guaranteed not to, because `/api/maintenance` mints `MN-<n>` per
   * organisation, so two tenants onboarded through the public form hold
   * identical ids. Taking the organisation from the token removes the
   * coincidence. A session-backed caller keeps the tenant their membership
   * resolved.
   *
   * Resolved UNCONDITIONALLY now, not only when there is no session: see the
   * matching note in `../route.ts`. A signed-in client holding a public link is
   * exercising the LINK's grant, and skipping the token because a session exists
   * would refuse them where an anonymous visitor passes.
   */
  const tenant = await resolveUploadTenant(db, orgId, uploadToken);
  orgId = tenant.orgId;
  const scopedToken = tenant.token;

  // A binned job takes no uploads — see the same filter on the direct path.
  // Skipped entirely for a document with no job (W07-07).
  const [workOrder] = requestId
    ? await db
        .select()
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.id, requestId),
            eq(maintenanceRequests.organisationId, orgId),
            isNull(maintenanceRequests.deletedAt),
          ),
        )
        .limit(1)
    : [];
  if (requestId && !workOrder) {
    return {
      response: Response.json({ error: "Work order not found." }, { status: 404 }),
    } as const;
  }

  /*
   * The other three anchors, checked against THIS tenant before any bytes move.
   * The deployed DDL has no foreign key on `site_id` or `unit_id`, so this is the
   * only thing standing between a typo and a document filed against nothing.
   */
  const badAnchor = await anchorReferencesRefusal(db, orgId, anchors);
  if (badAnchor) return { response: badAnchor } as const;

  /*
   * THE COLUMN IS RESOLVED BEFORE THE GRANT IS CHECKED, and it did not used to
   * be.
   *
   * A file that names a column is stored under that column's kind, so the kind
   * the grant must be checked against is not known until the column is known.
   * This block ran AFTER the check and began `if (kind !== "general") return
   * 400` — so the contractor page's issue slot, which sends the issue column's
   * id alongside `kind=issue`, was refused outright on the path every file
   * over ~900 KB takes. That is every photograph a phone produces. The direct
   * route had the mirror-image fault: it rewrote the kind to "general" first
   * and then compared "general" against a grant of `issue`, answering 403.
   *
   * Ordering it this way means one rule decides what is written and the grant
   * is checked against exactly that.
   */
  let storedKind = kind;
  if (boardColumnId && workOrder) {
    // Scoped to the work order's own board, not the literal "maintenance" —
    // Store Documentation's twelve file columns live on another board and were
    // refused outright. See `boardKeyForRequest`.
    const boardKey = await boardKeyForRequest(db, orgId, workOrder.id);
    const [column] = await db
      .select({
        id: maintenanceBoardColumns.id,
        key: maintenanceBoardColumns.key,
      })
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.id, boardColumnId),
          eq(maintenanceBoardColumns.boardId, boardKey),
          eq(maintenanceBoardColumns.type, "files"),
          eq(maintenanceBoardColumns.organisationId, orgId),
        ),
      )
      .limit(1);
    if (!column) {
      return {
        response: Response.json(
          { error: "The file column no longer exists." },
          { status: 404 },
        ),
      } as const;
    }
    storedKind = kindForColumnKey(column.key);
  }

  /*
   * WHAT THE CALLER IS ALLOWED TO DO — the W07-01 fix, shared with `../route.ts`.
   *
   * This used to be `if (!isOperator) { …token checks… }`, which is to say the
   * checks ran for everyone EXCEPT a caller with a session, and no check at all
   * ran for one. Authorisation on the path every file over ~900 KB takes — which
   * is every photograph a phone produces — was `scopedDb` alone, and `scopedDb`
   * never refuses on grounds of permission.
   *
   * `resolveUploadAuthority` is those same token rules with a `board.edit` floor
   * underneath, and with the token consulted BEFORE the session rather than only
   * in its absence. See `../upload-authority.ts` for why that order is the whole
   * of the fix.
   *
   * (The `uploadToken` argument also spent a long time being accepted and never
   * read: declared in the signature, sent faithfully by `client-upload.ts` from
   * both the POST body and the `X-Upload-Token` header, and referenced by
   * nothing.)
   */
  const authority = await resolveUploadAuthority({
    request,
    scope,
    orgId,
    workOrder: workOrder ?? null,
    storedKind,
    uploadToken,
    jobToken: scopedToken,
  });
  if (authority.denied) return { response: authority.denied } as const;

  return {
    actor,
    scope,
    orgId,
    kind: storedKind,
    workOrder,
    anchors,
    via: authority.via,
    db,
    boardColumnId: boardColumnId || null,
    actorEmail: actor.email,
    /*
     * The token itself, not just the fact that it authorised.
     *
     * The caller has to record WHICH link produced the file and hold the file
     * for review, and neither is derivable from `actorEmail` —
     * `getWorkspaceActor` returns a preview identity when there is no session,
     * so an anonymous contractor and a signed-in coordinator are
     * indistinguishable by the time authorisation is over. `../route.ts` had
     * the token in scope at its insert and used it; this route did not, and
     * quietly filed every large contractor upload as internal and approved.
     */
    scopedToken,
  } as const;
}

/**
 * A resumed upload is writing where its `start` said it would.
 *
 * The prefix is re-derived from `anchorSegment` rather than from `requestId`
 * directly, because a document with no job is now legitimate and its key is
 * named after whichever anchor it does have. Deriving it two different ways
 * would let a jobless multipart upload begin and then be refused at every part.
 */
function validUploadKey(
  key: string,
  orgId: string,
  anchors: Anchors,
  kind: AttachmentKind,
) {
  return (
    key.startsWith(`${orgId}/maintenance/${anchorSegment(anchors)}/${kind}/`) &&
    key.length < 512
  );
}

async function completeMetadata(
  objectKey: string,
  requestId: string,
  kind: AttachmentKind,
  boardColumnId: string | null,
) {
  const storage = await bucket();
  const head = await storage?.head(objectKey);
  if (!head) return null;
  const metadata = head.customMetadata ?? {};
  if (
    /*
     * `|| ""` on both sides, because a jobless document (W07-07) starts its
     * upload with an empty `requestId` and R2 does not promise to round-trip an
     * empty custom-metadata value — it may come back as `undefined`. Comparing
     * the raw values would then make every contractor certificate over ~900 KB
     * fail at `complete` with "The completed file metadata is invalid", after
     * every byte had already been uploaded.
     */
    (metadata.requestId || "") !== (requestId || "") ||
    metadata.kind !== kind ||
    (metadata.boardColumnId || null) !== boardColumnId ||
    !metadata.fileId ||
    !metadata.originalName
  ) {
    return null;
  }
  return {
    storage,
    head,
    metadata,
    fileId: metadata.fileId,
    originalName: metadata.originalName,
    contentType: metadata.contentType || "application/octet-stream",
  };
}

export async function POST(request: Request) {
  try {
    /*
     * A BODY THAT IS NOT A JSON OBJECT IS A BAD REQUEST, NOT AN OUTAGE.
     *
     * The unguarded read let three ordinary client mistakes fall through every
     * branch into the 503 at the bottom of this handler, which tells a browser
     * to retry something no retry can fix. Measured against the running server:
     * an empty body answered 503 "Unexpected end of JSON input", a body of
     * literal `null` PARSES and then answered 503 "Cannot read properties of
     * null (reading 'action')", and malformed JSON answered 503 with V8's
     * parser message. In development those strings are appended to the reply,
     * so an internal runtime message was being handed to the caller as well.
     *
     * `/api/board` guards its body in exactly this way and for exactly this
     * reason. An array is not a record either — `payload.action` on one is
     * `undefined`, which reached the "start" comparison and then the key
     * validation, so it refused for the wrong reason.
     */
    const parsed = (await request.json().catch(() => null)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json(
        { error: "The request body must be a JSON object." },
        { status: 400 },
      );
    }
    const payload = parsed as Record<string, unknown>;
    const action = String(payload.action ?? "");
    const requestId = String(payload.requestId ?? "").trim();
    const requestedKind = String(payload.kind ?? "issue");
    const uploadToken = String(payload.uploadToken ?? "").trim();
    const requestedColumnId = String(payload.columnId ?? "").trim();
    const authorization = await authorizeUpload(
      request,
      requestId,
      requestedKind,
      uploadToken,
      requestedColumnId,
      // W07-07 — the other three anchors, so a document with no job can be
      // filed against a site, a unit or a contractor instead.
      {
        siteId: String(payload.siteId ?? "").trim(),
        unitId: String(payload.unitId ?? "").trim(),
        contractorId: String(payload.contractorId ?? "").trim(),
      },
    );
    if ("response" in authorization) return authorization.response;
    const {
      db,
      kind,
      workOrder,
      actorEmail,
      boardColumnId,
      orgId,
      scopedToken,
      anchors,
      scope,
      via,
    } = authorization;
    /*
     * WHO REALLY UPLOADED THIS — the same rule `../route.ts` applies, which
     * this route was missing.
     *
     * `actor.email` is never empty, so a contractor's photograph arriving
     * through a public link was attributed to an internal-looking address and
     * the link that carried it was recorded nowhere. After the fact there was
     * no way to tell which of a job's links produced which photograph. The
     * token id is a truthful answer to "who", and it is the SAME string the
     * direct route writes, so the two paths cannot be told apart by a reader.
     */
    const uploadedByEmail = scopedToken
      ? `contractor-link:${scopedToken.id}`
      : actorEmail;
    const storage = await bucket();
    if (!storage) {
      return Response.json(
        { error: "File storage is unavailable." },
        { status: 503 },
      );
    }

    if (action === "start") {
      const originalName = String(payload.originalName ?? "").trim().slice(0, 255);
      const contentType = String(
        payload.contentType ?? "application/octet-stream",
      ).trim();
      const byteSize = Number(payload.byteSize);
      if (
        !originalName ||
        !Number.isInteger(byteSize) ||
        byteSize < 1 ||
        !isAllowedFile(originalName, contentType)
      ) {
        return Response.json(
          { error: "Choose a supported file to upload." },
          { status: 415 },
        );
      }
      const video = isVideo(originalName, contentType);
      const maxSize = video ? MAX_VIDEO_FILE_SIZE : MAX_STANDARD_FILE_SIZE;
      if (byteSize > maxSize) {
        return Response.json(
          {
            error: video
              ? "Videos must be 90 MB or smaller."
              : "Files must be 25 MB or smaller.",
          },
          { status: 413 },
        );
      }

      const fileId = crypto.randomUUID();
      const cleanName = safeFileName(originalName) || `upload-${fileId}`;
      // Named after whichever anchor this document has — see `anchorSegment`.
      const key = `${orgId}/maintenance/${anchorSegment(anchors)}/${kind}/${fileId}-${cleanName}`;
      const upload = await storage.createMultipartUpload(key, {
        httpMetadata: {
          contentType,
          contentDisposition: `inline; filename="${cleanName}"`,
        },
        customMetadata: {
          requestId,
          organisationId: orgId,
          kind,
          ...(boardColumnId ? { boardColumnId } : {}),
          fileId,
          originalName,
          contentType,
          byteSize: String(byteSize),
          uploadedBy: uploadedByEmail,
        },
      });
      return Response.json(
        { key: upload.key, uploadId: upload.uploadId, fileId },
        { status: 201 },
      );
    }

    const key = String(payload.key ?? "");
    const uploadId = String(payload.uploadId ?? "");
    if (!key || !uploadId || !validUploadKey(key, orgId, anchors, kind)) {
      return Response.json(
        { error: "The upload session is invalid." },
        { status: 400 },
      );
    }
    const multipart = storage.resumeMultipartUpload(key, uploadId);

    if (action === "abort") {
      await multipart.abort();
      return Response.json({ aborted: true });
    }

    if (action === "complete") {
      const parts = Array.isArray(payload.parts)
        ? payload.parts
            .map((part) => {
              const value = part as Record<string, unknown>;
              return {
                partNumber: Number(value.partNumber),
                etag: String(value.etag ?? ""),
              };
            })
            .filter(
              (part) =>
                Number.isInteger(part.partNumber) &&
                part.partNumber > 0 &&
                part.etag.length > 0,
            )
        : [];
      if (!parts.length || parts.length > 100) {
        return Response.json(
          { error: "The uploaded file parts are incomplete." },
          { status: 400 },
        );
      }
      await multipart.complete(parts);
      const completed = await completeMetadata(
        key,
        requestId,
        kind,
        boardColumnId,
      );
      if (!completed) {
        await storage.delete(key);
        return Response.json(
          { error: "The completed file metadata is invalid." },
          { status: 400 },
        );
      }
      const byteSize = Number(completed.metadata.byteSize);
      const video = isVideo(completed.originalName, completed.contentType);
      const maxSize = video ? MAX_VIDEO_FILE_SIZE : MAX_STANDARD_FILE_SIZE;
      if (
        !Number.isInteger(byteSize) ||
        byteSize !== completed.head.size ||
        byteSize > maxSize
      ) {
        await storage.delete(key);
        return Response.json(
          { error: "The completed file size could not be verified." },
          { status: 400 },
        );
      }

      const [existing] = await db
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.id, completed.fileId),
            eq(attachments.objectKey, key),
            eq(attachments.organisationId, orgId),
          ),
        )
        .limit(1);
      if (existing) {
        return Response.json({
          file: attachmentPayload(existing),
          request: workOrder ? requestPayload(workOrder) : null,
        });
      }

      /*
       * W07-02 metadata and W07-03 lineage, read from the `complete` body.
       *
       * Both are read here rather than at `start` because `start` only reserves
       * a key: the row does not exist until now, so this is the first moment
       * either can be written, and a caller that abandons an upload has not
       * changed anything.
       */
      const fields = documentFieldUpdates({
        ...("title" in payload ? { title: payload.title } : {}),
        ...("documentType" in payload
          ? { documentType: payload.documentType }
          : {}),
        ...("description" in payload
          ? { description: payload.description }
          : {}),
        ...("expiryDate" in payload ? { expiryDate: payload.expiryDate } : {}),
      });
      if (!fields.ok) {
        // The bytes are already in the bucket; a refused row must not leave them
        // there, or an abandoned certificate accumulates storage for ever.
        await storage.delete(key);
        return Response.json({ error: fields.error }, { status: 400 });
      }

      const replacesId = String(payload.replaces ?? "").trim().slice(0, 120);
      let version: Awaited<ReturnType<typeof planVersion>> | null = null;
      if (replacesId) {
        if (via !== "capability") {
          await storage.delete(key);
          return Response.json(
            { error: "This link cannot replace an existing document." },
            { status: 403 },
          );
        }
        version = await planVersion(db, orgId, replacesId);
        if (!version.ok) {
          await storage.delete(key);
          return version.denied;
        }
        await standDownPredecessor(db, orgId, version.predecessor.id);
      }

      try {
        const [created] = await db
          .insert(attachments)
          .values({
            id: completed.fileId,
            organisationId: orgId,
            // W07-07 anchors, with an explicit site beating the job's inherited
            // one — see `resolveSiteId`.
            requestId: requestId || version?.plan.carried.requestId || null,
            siteId: resolveSiteId(
              anchors.siteId,
              workOrder?.siteId ?? version?.plan.carried.siteId,
            ),
            unitId: anchors.unitId || version?.plan.carried.unitId || null,
            contractorId:
              anchors.contractorId || version?.plan.carried.contractorId || null,
            kind,
            boardColumnId,
            objectKey: key,
            originalName: completed.originalName,
            contentType: completed.contentType,
            byteSize,
            uploadedByEmail,
            title: fields.values.title ?? version?.plan.carried.title ?? null,
            documentType:
              fields.values.documentType ??
              version?.plan.carried.documentType ??
              null,
            description:
              fields.values.description ??
              version?.plan.carried.description ??
              null,
            expiryDate:
              fields.values.expiryDate ??
              version?.plan.carried.expiryDate ??
              null,
            rootDocumentId: version?.ok ? version.plan.rootDocumentId : null,
            versionNo: version?.ok ? version.plan.versionNo : 1,
            isCurrent: true,
            /*
             * EVIDENCE FROM A PUBLIC LINK WAITS FOR A COORDINATOR — and until
             * now it did so only if it was small enough.
             *
             * `../route.ts` sets these two, so a contractor's photograph under
             * ~900 KB landed `pending` and appeared in the review queue. Every
             * file above that threshold takes THIS route, which set neither —
             * and a phone photograph is 2–5 MB, so in practice the review queue
             * saw the test files and nothing else. Anonymous evidence published
             * itself straight onto the job exactly as it did before migration
             * 0012, on the path that carries the real photographs.
             *
             * A signed-in operator's upload is not pending, here as there.
             *
             * Keyed on the GRANT rather than on the presence of a token object —
             * see `pendingReview`.
             */
            pending: pendingReview(via),
            submittedVia: scopedToken ? scopedToken.id : null,
          })
          .returning();

        /*
         * RECOUNTED, NOT INCREMENTED.
         *
         * This was four conditional `+ 1`s, one per kind. Correct arithmetic
         * on a number that was already wrong: `db/init.ts` sets a job's issue
         * counter to its undifferentiated total on every cold start where the
         * job has attachments and no issue-kind row, so incrementing from
         * there compounds the lie rather than correcting it — MN-1055 reported
         * five photographs against three rows. A COUNT converges from whatever
         * the counter had drifted to. See `app/lib/attachment-counts.ts`.
         */
        const updatedRequest = requestId
          ? await reconcileAttachmentCounts(db, orgId, requestId)
          : null;

        // The job's own timeline, where there is a job.
        if (requestId) {
          await db.insert(activityLog).values({
            id: crypto.randomUUID(),
            organisationId: orgId,
            entityType: "maintenance_request",
            entityId: requestId,
            action: "request.file_uploaded",
            actorEmail,
            detail: JSON.stringify({
              fileId: completed.fileId,
              fileName: completed.originalName,
              kind,
              boardColumnId,
              contentType: completed.contentType,
              multipart: true,
            }),
          });
        }

        /*
         * W07-12 — the Audit viewer's stream, which this route never reached.
         * Written whether or not there is a job, because a contractor's
         * certificate has no timeline to appear on and is exactly the document
         * somebody will later need to account for. See `../route.ts` for the
         * naming convention; the two routes must produce indistinguishable
         * events, or document history splits by file size.
         */
        await recordAudit({
          db,
          organisationId: orgId,
          actor: auditActor(scope),
          action: version?.ok ? "document.version_added" : "document.uploaded",
          entityType: "document",
          entityId: completed.fileId,
          summary: version?.ok
            ? `Replaced ${version.predecessor.originalName} with ${completed.originalName} (version ${version.plan.versionNo}).`
            : `Uploaded ${completed.originalName}.`,
          detail: {
            fileId: completed.fileId,
            fileName: completed.originalName,
            contentType: completed.contentType,
            byteSize,
            kind,
            boardColumnId,
            requestId: requestId || null,
            siteId: anchors.siteId || workOrder?.siteId || null,
            unitId: anchors.unitId || null,
            contractorId: anchors.contractorId || null,
            via,
            multipart: true,
            ...(version?.ok
              ? {
                  replacedFileId: version.predecessor.id,
                  rootDocumentId: version.plan.rootDocumentId,
                  versionNo: version.plan.versionNo,
                }
              : {}),
          },
          request,
        });

        return Response.json(
          {
            file: attachmentPayload(created),
            request: updatedRequest ? requestPayload(updatedRequest) : null,
          },
          { status: 201 },
        );
      } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
        await storage.delete(key);
        // The lineage must not be left headless by a failed insert.
        if (version?.ok) {
          await restorePredecessor(db, orgId, version.predecessor.id);
        }
        throw error;
      }
    }

    return Response.json({ error: "Unknown upload action." }, { status: 400 });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const detail =
      process.env.NODE_ENV === "development" && error instanceof Error
        ? ` ${error.message}`
        : "";
    /*
     * "The file", not "The video".
     *
     * This route was written for video and is now the path EVERY upload over
     * 900 KB takes — `DIRECT_UPLOAD_LIMIT` in app/lib/client-upload.ts, lowered
     * from 4 MB because the Workers runtime refuses to parse a form body at or
     * above 1 MiB. So a coordinator whose PAT certificate failed was told the
     * video could not be uploaded, about a PDF, and had no way to tell whether
     * the message was about their file at all.
     */
    return Response.json(
      { error: `The file could not be uploaded.${detail}` },
      { status: 503 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const requestId = request.headers.get("X-Upload-Request-Id")?.trim() ?? "";
    const requestedKind = request.headers.get("X-Upload-Kind")?.trim() ?? "";
    const uploadToken = request.headers.get("X-Upload-Token")?.trim() ?? "";
    const requestedColumnId =
      request.headers.get("X-Upload-Column-Id")?.trim() ?? "";
    const key = request.headers.get("X-Upload-Key") ?? "";
    const uploadId = request.headers.get("X-Upload-Id") ?? "";
    const partNumber = Number(request.headers.get("X-Upload-Part"));
    const authorization = await authorizeUpload(
      request,
      requestId,
      requestedKind,
      uploadToken,
      requestedColumnId,
      /*
       * The same anchors `start` was given, so `validUploadKey` below re-derives
       * the identical prefix. Without them a jobless document would `start`
       * successfully against a `.../unfiled/...` key and then have every part
       * refused, because the part handler would compute a different prefix from
       * an empty `requestId`.
       */
      {
        siteId: request.headers.get("X-Upload-Site-Id")?.trim() ?? "",
        unitId: request.headers.get("X-Upload-Unit-Id")?.trim() ?? "",
        contractorId:
          request.headers.get("X-Upload-Contractor-Id")?.trim() ?? "",
      },
    );
    if ("response" in authorization) return authorization.response;
    if (
      !key ||
      !uploadId ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      !validUploadKey(key, authorization.orgId, authorization.anchors, authorization.kind)
    ) {
      return Response.json(
        { error: "The upload part is invalid." },
        { status: 400 },
      );
    }

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_PART_SIZE) {
      return Response.json(
        { error: "Each upload part must be 5 MB or smaller." },
        { status: 413 },
      );
    }
    const storage = await bucket();
    if (!storage) {
      return Response.json(
        { error: "File storage is unavailable." },
        { status: 503 },
      );
    }
    const multipart = storage.resumeMultipartUpload(key, uploadId);
    const part = await multipart.uploadPart(partNumber, bytes);
    return Response.json({ part });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const detail =
      process.env.NODE_ENV === "development" && error instanceof Error
        ? ` ${error.message}`
        : "";
    // "The file", not "The video" — see the matching note on POST. Every
    // upload over 900 KB sends its parts here, whatever it is.
    return Response.json(
      { error: `The file part could not be uploaded.${detail}` },
      { status: 503 },
    );
  }
}
