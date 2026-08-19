import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { AttachmentKind, MaintenanceRequest } from "../../lib/types";
import { ensureDatabase } from "../../../db/init";
import {
  type EvidenceKind,
  recordTokenUse,
  resolveJobToken,
} from "../../lib/job-tokens";
import {
  activityLog,
  attachments,
  maintenanceBoardColumns,
  maintenanceRequests,
} from "../../../db/schema";
import { boardKeyForRequest } from "../../lib/board-registry";
import { demoIdentityAllowed } from "../../lib/tenant-access";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";

const MAX_STANDARD_FILE_SIZE = 25 * 1024 * 1024;
const MAX_VIDEO_FILE_SIZE = 90 * 1024 * 1024;
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

function isVideo(file: File) {
  return file.type.startsWith("video/") ||
    ["mp4", "webm", "mov", "m4v", "mkv"].includes(fileExtension(file.name));
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
function isAllowedFile(file: File) {
  // An empty type means the browser declined to guess; fall back to the
  // extension rather than refusing a legitimate upload outright.
  const declared = file.type.trim();
  const typeOk = declared ? allowedTypes.has(declared) : true;
  return typeOk && allowedExtensions.has(fileExtension(file.name));
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
    // Read by the viewer's "Added by …" line. The column has always been
    // written; it was simply never served.
    uploadedByEmail: row.uploadedByEmail,
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

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function unavailable(error?: unknown) {
  // A session that has ended is not an outage: 503 tells a browser to retry
  // something no amount of retrying will fix, and blames the workspace for
  // what a person fixes by signing in. See `anonymousRefusal`.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json(
    { error: "The file list is temporarily unavailable." },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  try {
    return await listFiles(request);
  } catch (error) {
    /*
     * This handler had no catch at all, so `scopedDb` refusing an anonymous
     * caller escaped as an unhandled throw and the framework answered 500 with
     * an empty body — an outage where every sibling route says "sign in", and a
     * stack trace in the log for a request that was correctly refused.
     */
    return unavailable(error);
  }
}

async function listFiles(request: Request) {
  const search = new URL(request.url).searchParams;
  const requestId = search.get("requestId")?.trim();
  const requestedKind = search.get("kind")?.trim() as AttachmentKind | undefined;
  const columnId = search.get("columnId")?.trim().slice(0, 100) || null;
  const kind = requestedKind && allowedKinds.has(requestedKind)
    ? requestedKind
    : null;
  const limit = Math.min(Math.max(Number(search.get("limit")) || 100, 1), 100);

  await ensureDatabase();
  /*
   * The file INDEX requires a session. It used to carry
   * `{ allowAnonymous: true }`, which was meant for the contractor upload in
   * the POST below and landed here instead — on the one handler that lists
   * every attachment in the workspace.
   *
   * That was worse than it looks, because `allowAnonymous` does not mean "no
   * tenant": `resolveTenantAccess` still falls back to the primary
   * organisation, so an anonymous caller was handed the live client's evidence
   * index — every attachment id, the job it belongs to, its filename, type and
   * size. The ids are the capability for the bytes, so it handed out the keys
   * as well as the catalogue.
   *
   * A contractor does not need this endpoint: the share link returns the
   * photographs for its own job.
   */
  const { db, orgId } = await scopedDb(request);

  /*
   * A column filter matches THE SAME rows the board counts for that cell.
   *
   * /api/board draws the two photo columns from rows filed by
   * `board_column_id` PLUS rows that carry only the matching `kind` and no
   * column — the app's own uploads store the kind, the monday import stored
   * the column, and both are the cell's photographs. This list filtered by
   * column alone, so the hover card fetched an empty answer for a cell whose
   * strip was visibly full of pictures: count said three, card said "open to
   * manage these files". The predicate below is the counting rule, verbatim.
   */
  let columnFilter;
  if (columnId) {
    const [columnRow] = await db
      .select({ key: maintenanceBoardColumns.key })
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.id, columnId),
          eq(maintenanceBoardColumns.organisationId, orgId),
        ),
      )
      .limit(1);
    const columnKind =
      columnRow?.key === "issuePictures"
        ? "issue"
        : columnRow?.key === "completedPictures"
          ? "completion"
          : null;
    columnFilter = columnKind
      ? or(
          eq(attachments.boardColumnId, columnId),
          and(eq(attachments.kind, columnKind), isNull(attachments.boardColumnId)),
        )
      : eq(attachments.boardColumnId, columnId);
  }

  const where = and(
    eq(attachments.organisationId, orgId),
    requestId ? eq(attachments.requestId, requestId) : undefined,
    kind ? eq(attachments.kind, kind) : undefined,
    columnFilter,
  );
  const rows = await db
    .select()
    .from(attachments)
    .where(where)
    .orderBy(desc(attachments.createdAt))
    .limit(limit);
  return Response.json({ files: rows.map(attachmentPayload) });
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    /*
     * A contractor uploading from a job link has no session; the token is what
     * proves them, and it is checked below before anything is written.
     *
     * The organisation is then taken FROM THE TOKEN rather than from the
     * ambient request, because an anonymous request resolves to the primary
     * organisation whatever the token says — so a link issued by a second
     * tenant would otherwise write into the first. See `tokenOrgId` below.
     */
    const scope = await scopedDb(request, { allowAnonymous: true });
    const { actor, authenticated, db } = scope;
    /*
     * Somebody operating the dashboard, as opposed to a contractor holding a
     * link.
     *
     * `authenticated` alone was wrong here, and it is why uploading from the
     * board failed with "This upload link has expired. Submit a new request."
     * The role switcher in the sidebar — "Preview User / TESTING ACCESS" — is a
     * demo identity, and a demo identity is deliberately NOT `authenticated`.
     * So every branch below read a signed-in coordinator as an anonymous
     * stranger, looked for the job link they do not have, and refused them.
     *
     * `scopedDbWithCapability` already draws the line in exactly this place and
     * for exactly this reason; this only says the same thing on the upload
     * path. `demoIdentityAllowed()` is `NODE_ENV !== "production"`, so in
     * production this is identical to the check it replaces and no stranger
     * gains anything.
     */
    const isOperator = authenticated || demoIdentityAllowed();
    let orgId = scope.orgId;
    const form = await request.formData();
    const file = form.get("file");
    const requestId = String(form.get("requestId") ?? "").trim();
    const requestedKind = String(form.get("kind") ?? "issue") as AttachmentKind;
    let kind = allowedKinds.has(requestedKind) ? requestedKind : "issue";
    const boardColumnId = String(form.get("columnId") ?? "")
      .trim()
      .slice(0, 100);
    const uploadToken = String(form.get("uploadToken") ?? "").trim();

    if (!(file instanceof File) || !requestId) {
      return Response.json(
        { error: "A file and work order ID are required." },
        { status: 400 },
      );
    }
    if (!isAllowedFile(file)) {
      return Response.json(
        {
          error:
            "Unsupported file type. Add an image, video, PDF, Office file, text file or ZIP.",
        },
        { status: 415 },
      );
    }
    const maxSize = isVideo(file)
      ? MAX_VIDEO_FILE_SIZE
      : MAX_STANDARD_FILE_SIZE;
    if (file.size > maxSize) {
      return Response.json(
        {
          error: isVideo(file)
            ? "Videos must be 90 MB or smaller."
            : "Files must be 25 MB or smaller.",
        },
        { status: 413 },
      );
    }

    /*
      * The token is resolved BEFORE the job is looked up, because it decides
      * which tenant we are in.
      *
      * It used to be resolved afterwards, and the job was found using the
      * ambient `orgId`. For an anonymous caller that is always the PRIMARY
      * organisation — so the only thing standing between a second tenant's
      * link and the first tenant's data was job ids happening not to collide.
      * They are not guaranteed not to: `/api/maintenance` mints `MN-<n>`
      * per organisation, so two tenants onboarded through the public form hold
      * identical ids.
      *
      * Taking the organisation from the token removes the coincidence. A
      * session-backed caller keeps the tenant their membership resolved.
      */
    let scopedToken: Awaited<ReturnType<typeof resolveJobToken>> = null;
    if (!isOperator && uploadToken) {
      scopedToken = await resolveJobToken(db, uploadToken);
      if (scopedToken) orgId = scopedToken.organisationId;
    }

    /*
     * A job in the recycle bin does not accept new files. Its row survives a
     * delete — that is what makes restoring it possible — so without this
     * filter an upload would attach evidence to a job nobody can see, and the
     * file would appear out of nowhere if the job were later restored.
     * "Not found" rather than a specific refusal: as far as this route is
     * concerned a binned job is not there.
     */
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
      return Response.json({ error: "Work order not found." }, { status: 404 });
    }

    // Belt and braces: the token's tenant and the job's must be the same one.
    // The lookup above already guarantees it; this says so, so that a future
    // change to either cannot quietly separate them.
    if (scopedToken && scopedToken.organisationId !== workOrder.organisationId) {
      return Response.json(
        { error: "This link does not belong to that job." },
        { status: 403 },
      );
    }

    if (boardColumnId) {
      // The column must belong to the board this work order is placed on —
      // not to "maintenance" as a literal, which refused every Store
      // Documentation certificate. See `boardKeyForRequest`.
      const boardKey = await boardKeyForRequest(db, orgId, workOrder.id);
      const [column] = await db
        .select({ id: maintenanceBoardColumns.id })
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
        return Response.json(
          { error: "The file column no longer exists." },
          { status: 404 },
        );
      }
      kind = "general";
    }

    // Z3 — a scoped contractor link carries its own permitted evidence kinds.
    //
    // The legacy reporter token below is left untouched: it exists so someone
    // submitting the public form can attach fault photos, and widening it would
    // let any reporter link write completion evidence. A contractor link is a
    // different grant, so it is checked first and separately.
    /*
     * `!isOperator`, not `!actor`.
     *
     * `getWorkspaceActor` never fails — it returns a preview identity when
     * there is no session — so `actor` is always truthy and `!actor` was always
     * false. Every branch below was therefore unreachable: the contractor
     * link's job binding and allowed-kinds check, `recordTokenUse`, the public
     * token's hash and expiry, and the "issue evidence only" rule. The route
     * accepted an `uploadToken` form field and ignored it entirely.
     */
    if (!isOperator && uploadToken) {
      if (scopedToken && scopedToken.requestId !== workOrder.id) {
        return Response.json(
          { error: "This link does not belong to that job." },
          { status: 403 },
        );
      }
      if (scopedToken && !scopedToken.allowedKinds.includes(kind as EvidenceKind)) {
        return Response.json(
          { error: `This link cannot upload ${kind} evidence.` },
          { status: 403 },
        );
      }
      if (scopedToken) {
        // Counts towards the link's usage so a coordinator can see whether the
        // contractor ever opened it.
        await recordTokenUse(db, scopedToken.id);
      }
    }

    if (!isOperator && !scopedToken) {
      const validUntil = workOrder.publicUploadTokenExpiresAt
        ? new Date(workOrder.publicUploadTokenExpiresAt).getTime()
        : 0;
      const suppliedHash = uploadToken ? await sha256(uploadToken) : "";
      if (
        !workOrder.publicUploadTokenHash ||
        suppliedHash !== workOrder.publicUploadTokenHash ||
        validUntil < Date.now()
      ) {
        return Response.json(
          { error: "This upload link has expired. Submit a new request." },
          { status: 403 },
        );
      }
      if (kind !== "issue") {
        return Response.json(
          { error: "Public requests can only add issue evidence." },
          { status: 403 },
        );
      }
    }

    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env as unknown as { BUCKET?: R2Bucket };
    if (!runtimeEnv.BUCKET) {
      return Response.json(
        { error: "File storage is unavailable." },
        { status: 503 },
      );
    }

    const id = crypto.randomUUID();
    const cleanName = safeFileName(file.name) || `upload-${id}`;
    const key = `${orgId}/maintenance/${requestId}/${kind}/${id}-${cleanName}`;
    await runtimeEnv.BUCKET.put(key, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
        contentDisposition: `inline; filename="${cleanName}"`,
      },
      customMetadata: {
        requestId,
        kind,
        ...(boardColumnId ? { boardColumnId } : {}),
        uploadedBy: actor?.email ?? "public-form",
        originalName: file.name,
      },
    });

    try {
      const [created] = await db
        .insert(attachments)
        .values({
          id,
          organisationId: orgId,
          requestId,
          siteId: workOrder.siteId,
          kind,
          boardColumnId: boardColumnId || null,
          objectKey: key,
          originalName: file.name,
          contentType: file.type || "application/octet-stream",
          byteSize: file.size,
          /*
           * Who really uploaded this.
           *
           * `actor.email` is never empty — `getWorkspaceActor` returns a
           * preview identity when there is no session — so an anonymous
           * contractor's photograph was filed under an internal-looking
           * address and the link that sent it was recorded nowhere. After the
           * fact there was no way to tell which of a job's links produced which
           * photo. The token id is a truthful answer to "who".
           */
          uploadedByEmail: scopedToken
            ? `contractor-link:${scopedToken.id}`
            : actor?.email ?? "public-form",
          /*
           * Evidence from a public link waits for a coordinator.
           *
           * `pending` and `submitted_via` were added in migration 0012 for
           * exactly this — "uploads through a public link land here first, a
           * coordinator accepts or rejects before they join the job's evidence
           * record" — and then never written, so `pending` was always 0. The
           * review queue filters on `pending = true` and was therefore
           * permanently empty, the accept/reject screen showed nothing, and
           * rejection could never match a row. Anonymous evidence published
           * itself straight onto the job.
           */
          pending: Boolean(scopedToken),
          submittedVia: scopedToken ? scopedToken.id : null,
        })
        .returning();

      const [updatedRequest] = await db
        .update(maintenanceRequests)
        .set({
          attachmentCount: sql`${maintenanceRequests.attachmentCount} + 1`,
          issueAttachmentCount:
            kind === "issue"
              ? sql`${maintenanceRequests.issueAttachmentCount} + 1`
              : maintenanceRequests.issueAttachmentCount,
          completedAttachmentCount:
            kind === "completion"
              ? sql`${maintenanceRequests.completedAttachmentCount} + 1`
              : maintenanceRequests.completedAttachmentCount,
          generalAttachmentCount:
            kind === "general"
              ? sql`${maintenanceRequests.generalAttachmentCount} + 1`
              : maintenanceRequests.generalAttachmentCount,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(maintenanceRequests.id, requestId), eq(maintenanceRequests.organisationId, orgId)))
        .returning();

      await db.insert(activityLog).values({
        id: crypto.randomUUID(),
        organisationId: orgId,
        entityType: "maintenance_request",
        entityId: requestId,
        action: "request.file_uploaded",
        actorEmail: actor?.email ?? "public-form",
        detail: JSON.stringify({
          fileId: id,
          fileName: file.name,
          kind,
          boardColumnId: boardColumnId || null,
          contentType: file.type,
        }),
      });

      return Response.json(
        { file: attachmentPayload(created), request: requestPayload(updatedRequest) },
        { status: 201 },
      );
    } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
      await runtimeEnv.BUCKET.delete(key);
      throw error;
    }
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const detail =
      process.env.NODE_ENV === "development" && error instanceof Error
        ? ` ${error.message}`
        : "";
    return Response.json(
      { error: `The file could not be uploaded.${detail}` },
      { status: 503 },
    );
  }
}
