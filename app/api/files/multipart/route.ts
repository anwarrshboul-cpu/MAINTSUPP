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
import { demoIdentityAllowed } from "../../../lib/tenant-access";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";
import {
  recordTokenUse,
  resolveJobToken,
  type EvidenceKind,
} from "../../../lib/job-tokens";
import {
  kindForColumnKey,
  reconcileAttachmentCounts,
} from "../../../lib/attachment-counts";

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

function attachmentPayload(row: typeof attachments.$inferSelect) {
  return {
    id: row.id,
    requestId: row.requestId,
    kind: row.kind,
    boardColumnId: row.boardColumnId,
    originalName: row.originalName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    inlineUrl: `/api/files/${row.id}`,
    downloadUrl: `/api/files/${row.id}?download=1`,
  };
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
  const { actor, authenticated, db } = scope;
  let orgId = scope.orgId;
  /*
   * See the matching note in `../route.ts`. A demo identity — the sidebar's
   * "Preview User / TESTING ACCESS" switcher — is deliberately not
   * `authenticated`, and this route read that as "anonymous stranger with no
   * job link" and answered "This link does not belong to that job."
   *
   * This is the path every file over 900 KB takes, so it is the one a real
   * photograph or video actually hits: a phone picture is 2–5 MB. That is why
   * uploading images and videos failed from the board while a small test file
   * went through — they are different routes.
   */
  const isOperator = authenticated || demoIdentityAllowed();
  const kind = allowedKinds.has(requestedKind as AttachmentKind)
    ? (requestedKind as AttachmentKind)
    : null;
  const boardColumnId = requestedColumnId.trim().slice(0, 100);
  if (!requestId || !kind) {
    return {
      response: Response.json(
        { error: "A work order and valid file section are required." },
        { status: 400 },
      ),
    } as const;
  }

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
   */
  let scopedToken: Awaited<ReturnType<typeof resolveJobToken>> = null;
  if (!isOperator && uploadToken) {
    scopedToken = await resolveJobToken(db, uploadToken);
    if (scopedToken) orgId = scopedToken.organisationId;
  }

  // A binned job takes no uploads — see the same filter on the direct path.
  const [workOrder] = await db
    .select()
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.id, requestId),
        eq(maintenanceRequests.organisationId, orgId),
        isNull(maintenanceRequests.deletedAt),
      ),
    )
    .limit(1);
  if (!workOrder) {
    return {
      response: Response.json({ error: "Work order not found." }, { status: 404 }),
    } as const;
  }

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
  if (boardColumnId) {
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
   * What the link is allowed to do, now that we know whose it is.
   *
   * The token was resolved above because it chooses the tenant; this is the
   * authorisation half — it must belong to THIS job, and it must permit this
   * kind of evidence. An unauthenticated caller without one gets nothing.
   *
   * (The `uploadToken` argument spent a long time being accepted and never
   * read: declared in the signature, sent faithfully by `client-upload.ts` from
   * both the POST body and the `X-Upload-Token` header, and referenced by
   * nothing — so authorisation on the path every large file takes was
   * `scopedDb` alone, which never refuses.)
   */
  if (!isOperator) {
    if (
      !scopedToken ||
      scopedToken.requestId !== workOrder.id ||
      // Belt and braces, as on the direct route: the lookup above already used
      // the token's organisation, so this cannot fail — it is here so that a
      // future change to either side cannot quietly separate them.
      scopedToken.organisationId !== workOrder.organisationId
    ) {
      return {
        response: Response.json(
          { error: "This link does not belong to that job." },
          { status: 403 },
        ),
      } as const;
    }
    if (!scopedToken.allowedKinds.includes(storedKind as EvidenceKind)) {
      return {
        response: Response.json(
          { error: `This link cannot upload ${storedKind} evidence.` },
          { status: 403 },
        ),
      } as const;
    }
    await recordTokenUse(db, scopedToken.id);
  }

  return {
    actor,
    orgId,
    kind: storedKind,
    workOrder,
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

function validUploadKey(
  key: string,
  orgId: string,
  requestId: string,
  kind: AttachmentKind,
) {
  return (
    key.startsWith(`${orgId}/maintenance/${requestId}/${kind}/`) &&
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
    metadata.requestId !== requestId ||
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
    const payload = (await request.json()) as Record<string, unknown>;
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
    );
    if ("response" in authorization) return authorization.response;
    const { db, kind, workOrder, actorEmail, boardColumnId, orgId, scopedToken } =
      authorization;
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
      const key = `${orgId}/maintenance/${requestId}/${kind}/${fileId}-${cleanName}`;
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
    if (!key || !uploadId || !validUploadKey(key, orgId, requestId, kind)) {
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
          request: requestPayload(workOrder),
        });
      }

      try {
        const [created] = await db
          .insert(attachments)
          .values({
            id: completed.fileId,
            organisationId: orgId,
            requestId,
            siteId: workOrder.siteId,
            kind,
            boardColumnId,
            objectKey: key,
            originalName: completed.originalName,
            contentType: completed.contentType,
            byteSize,
            uploadedByEmail,
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
             */
            pending: Boolean(scopedToken),
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
        const updatedRequest = await reconcileAttachmentCounts(db, orgId, requestId);

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
        return Response.json(
          {
            file: attachmentPayload(created),
            request: requestPayload(updatedRequest),
          },
          { status: 201 },
        );
      } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
        await storage.delete(key);
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
    return Response.json(
      { error: `The video could not be uploaded.${detail}` },
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
    );
    if ("response" in authorization) return authorization.response;
    if (
      !key ||
      !uploadId ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      !validUploadKey(key, authorization.orgId, requestId, authorization.kind)
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
    return Response.json(
      { error: `The video part could not be uploaded.${detail}` },
      { status: 503 },
    );
  }
}
