import { and, asc, desc, eq, gte, isNotNull, isNull, like, lte, or, sql } from "drizzle-orm";
import type { AttachmentKind, MaintenanceRequest } from "../../lib/types";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  attachments,
  maintenanceBoardColumns,
  maintenanceRequests,
} from "../../../db/schema";
import { boardKeyForRequest } from "../../lib/board-registry";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import { auditActor, recordAudit } from "../../lib/audit";
import {
  kindForColumnKey,
  reconcileAttachmentCounts,
} from "../../lib/attachment-counts";
import {
  anchorRefusal,
  anchorReferencesRefusal,
  anchorSegment,
  attachmentPayload,
  carriedKind,
  documentFieldUpdates,
  effectiveAnchors,
  liveDocumentFilter,
  planVersion,
  readAnchors,
  resolveSiteId,
  restorePredecessor,
  standDownPredecessor,
} from "./documents";
import {
  pendingReview,
  resolveUploadAuthority,
  resolveUploadTenant,
} from "./upload-authority";

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

/*
 * `sha256` used to live here, for the legacy request-token comparison. It moved
 * to `./upload-authority.ts` with the check it served, so the two upload routes
 * cannot end up hashing the same token two different ways.
 */

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

function text(value: string | null, max: number) {
  return value?.trim().slice(0, max) ?? "";
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
  /*
   * W07-11 — OFFSET, BECAUSE THERE WAS NO WAY PAST THE FIRST HUNDRED.
   *
   * `limit` has always been clamped to 100 and there was no offset, no page and
   * no cursor, so the 101st document in a workspace was unreachable through this
   * API at all — and worse than unreachable, invisible: a caller totalling what
   * it received got `min(real, 100)` and had no way to know the number was a
   * ceiling rather than a count. That is how a register ends up confidently
   * reporting 100 certificates when it holds 340.
   *
   * `page` is accepted as well as `offset` because it is what a paginated UI
   * naturally holds; whichever is given, the answer carries `total`, `page` and
   * `pageCount` so the caller never has to infer them from the length of the
   * array. `/api/audit` answers in exactly this shape.
   */
  const page = Math.max(Number(search.get("page")) || 1, 1);
  const offset = Math.max(
    Number(search.get("offset")) || (page - 1) * limit,
    0,
  );

  // W07-11 filters. Each is optional and each is an exact id or an explicit
  // range — no name matching, so nothing here can quietly widen a query.
  const siteId = text(search.get("siteId"), 120);
  const unitId = text(search.get("unitId"), 120);
  const contractorId = text(search.get("contractorId"), 120);
  const documentType = text(search.get("documentType"), 80);
  const expiryFrom = text(search.get("expiryFrom"), 10);
  const expiryTo = text(search.get("expiryTo"), 10);
  const query = text(search.get("q"), 120);
  /*
   * `archived` is tri-state, and the default is the load-bearing part.
   *
   * Absent means LIVE DOCUMENTS ONLY — current version, not archived — because
   * that is what every existing caller means by "the files on this cell", and a
   * default that included superseded versions would triple the board's photo
   * strip the first time a certificate was replaced. "true" asks for the archive
   * specifically; "all" is the audit view, and is the only way to see history.
   */
  const archived = text(search.get("archived"), 10).toLowerCase();
  const versionsOf = text(search.get("versionsOf"), 120);

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

  /*
   * The version/archive predicate. See `liveDocumentFilter` for why the default
   * is not merely a convenience.
   *
   * `versionsOf` overrides it entirely: asking for a document's history means
   * asking for its superseded versions, so filtering them out would answer the
   * question with an empty list. It is scoped to one lineage, so it cannot be
   * used to dump every version in the workspace by accident.
   */
  const lineageFilter = versionsOf
    ? or(
        eq(attachments.rootDocumentId, versionsOf),
        eq(attachments.id, versionsOf),
      )
    : undefined;
  const stateFilter = versionsOf
    ? undefined
    : archived === "all"
      ? undefined
      : archived === "true"
        ? and(eq(attachments.isCurrent, true), isNotNull(attachments.archivedAt))
        : liveDocumentFilter();

  const where = and(
    eq(attachments.organisationId, orgId),
    requestId ? eq(attachments.requestId, requestId) : undefined,
    kind ? eq(attachments.kind, kind) : undefined,
    columnFilter,
    siteId ? eq(attachments.siteId, siteId) : undefined,
    unitId ? eq(attachments.unitId, unitId) : undefined,
    contractorId ? eq(attachments.contractorId, contractorId) : undefined,
    documentType ? eq(attachments.documentType, documentType) : undefined,
    /*
     * An expiry range NEVER matches an undated document, in either direction.
     *
     * `expiry_date IS NULL >= '2027-01-01'` is unknown, not false, so a bare
     * comparison already excludes them — but only by accident of SQL's
     * three-valued logic, and only while the comparison stays a comparison. Said
     * explicitly so that "expiring in the next 30 days" cannot ever be answered
     * with a pile of certificates that have no expiry recorded at all, which is
     * the opposite of what the person asking is chasing.
     */
    expiryFrom
      ? and(isNotNull(attachments.expiryDate), gte(attachments.expiryDate, expiryFrom))
      : undefined,
    expiryTo
      ? and(isNotNull(attachments.expiryDate), lte(attachments.expiryDate, expiryTo))
      : undefined,
    /*
     * Search covers the three names a person might remember it by: the title
     * they gave it, the filename it arrived as, and its type. `original_name`
     * is included because for most of this table's life it was the ONLY name a
     * document had, so a search that ignored it would fail on every row
     * uploaded before W07-02 existed.
     */
    query
      ? or(
          like(attachments.title, `%${query}%`),
          like(attachments.originalName, `%${query}%`),
          like(attachments.documentType, `%${query}%`),
        )
      : undefined,
    lineageFilter,
    stateFilter,
  );

  /*
   * The total is COUNTED, not inferred from the page.
   *
   * Without it a caller cannot tell a full page from the last page, and the only
   * number it could report — the length of `files` — is the page size. That is
   * the specific way this endpoint was misleading: silently truthful about the
   * rows it returned and silently wrong about how many there are.
   */
  const [totals] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(attachments)
    .where(where);
  const total = Number(totals?.total ?? 0);

  const rows = await db
    .select()
    .from(attachments)
    .where(where)
    /*
     * Newest first, with the id as the tiebreak — a phone batch lands several
     * rows in the same second, and `created_at` alone leaves the database
     * free to return those in a different order per query. With an OFFSET that
     * stops being cosmetic: an unstable order means page 2 can repeat a row
     * from page 1 and drop another entirely.
     *
     * A version history reads the other way round — oldest first — because that
     * is the order the versions happened in, and v1 to v4 is how a person reads
     * a document's story.
     */
    .orderBy(
      ...(versionsOf
        ? [asc(attachments.versionNo), asc(attachments.id)]
        : [desc(attachments.createdAt), desc(attachments.id)]),
    )
    .limit(limit)
    .offset(offset);
  return Response.json({
    files: rows.map(attachmentPayload),
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pageCount: Math.max(Math.ceil(total / limit), 1),
  });
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
    const { actor, db } = scope;
    /*
     * `isOperator = authenticated || demoIdentityAllowed()` used to stand here
     * and decide everything below it. It is gone; see
     * `./upload-authority.ts` for what replaced it and why the ORDER in which a
     * token and a session are consulted is the whole of the fix.
     */
    const form = await request.formData();
    const file = form.get("file");
    /*
     * `"issue"` IS ALSO THE DEFAULT, so "the caller asked for issue" and "the
     * caller said nothing" have to stay distinguishable — see where a
     * replacement inherits its predecessor's kind below. Reading the raw form
     * entry is the only way to tell them apart once the `??` has run.
     */
    const suppliedKind = form.get("kind");
    const requestedKind = String(suppliedKind ?? "issue") as AttachmentKind;
    const kindWasChosen = suppliedKind !== null && allowedKinds.has(requestedKind);
    let kind = allowedKinds.has(requestedKind) ? requestedKind : "issue";
    /* Set when the file column overrules the request — the rule at `kindForColumnKey` below. */
    let kindFromColumn = false;
    const boardColumnId = String(form.get("columnId") ?? "")
      .trim()
      .slice(0, 100);
    const uploadToken = String(form.get("uploadToken") ?? "").trim();
    /*
     * W07-07 — WHAT THIS DOCUMENT BELONGS TO.
     *
     * `requestId` was mandatory, which is exactly why a contractor's insurance
     * certificate had nowhere to go: it is a fact about the contractor, not
     * evidence about a work order, and the route answered 400 because there was
     * no job id to give. It is now one of four canonical anchors and at least one
     * is required — nothing floats free, and nothing has to be invented to
     * satisfy a column.
     */
    const anchors = readAnchors({
      requestId: form.get("requestId"),
      siteId: form.get("siteId"),
      unitId: form.get("unitId"),
      contractorId: form.get("contractorId"),
    });
    const requestId = anchors.requestId;
    /*
     * W07-03 — the document this one supersedes, if any. A replacement is a NEW
     * row in the same lineage, never a rewrite of the old bytes: `GET` serves
     * objects `immutable` precisely because no id's bytes ever change.
     */
    const replacesId = String(form.get("replaces") ?? "").trim().slice(0, 120);
    let orgId = scope.orgId;

    if (!(file instanceof File)) {
      return Response.json({ error: "A file is required." }, { status: 400 });
    }
    /*
     * THE ANCHOR RULE IS ABOUT THE DOCUMENT, NOT ABOUT THE REQUEST.
     *
     * This ran unconditionally and answered 400 on the SUPPLIED anchors alone —
     * 216 lines before `planVersion` below had looked at the predecessor at all.
     * So a new version of a document already filed against a site and a job was
     * refused for having no anchors, while the insert further down inherits them
     * correctly and always did. Measured: a document showing "Site: Highcross
     * Leicester" and "Work order: MN-1058" answered "A document must be filed
     * against a work order, a site, a unit or a contractor." to "Upload new
     * version", because the replacement form does not re-send relationships
     * nobody asked it to change.
     *
     * An ORIGINAL is decided here, exactly as before and as early as before: no
     * `replaces`, no parent, no further facts to wait for. A REPLACEMENT is
     * decided after `planVersion`, against supplied-or-inherited anchors —
     * `anchorRefusal` is called there too, so a parent that is itself unanchored
     * is still refused and nothing is invented to satisfy the rule.
     *
     * Deferring loses no safety: `planVersion` 404s a predecessor that does not
     * exist or belongs to another tenant, 409s an archived one and 409s one that
     * is not the current head, and every one of those runs before the R2 put.
     */
    if (!replacesId) {
      const missingAnchor = anchorRefusal(anchors);
      if (missingAnchor) return missingAnchor;
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
    /*
     * A FILE OF NO BYTES IS NOT A DOCUMENT, AND ON THIS BOARD IT IS A LIE.
     *
     * The multipart route has always refused this — `byteSize < 1` is one of
     * the four conditions behind its 415 (`multipart/route.ts:441-452`) — and
     * this route accepted it: measured, a 0-byte `W7QA-empty-cert.pdf` filed
     * against the PAT Test Certificate column of a Store Documentation row
     * answered 201 with `byteSize: 0`.
     *
     * The consequence is not cosmetic. The compliance register decides whether
     * a certificate is HELD by counting attachments on the slot's file column
     * and asking `fileCount > 0` (`app/lib/store-documentation-register.ts:215`),
     * and the file counts on `/api/board` went 7 to 8 for that column when the
     * empty file landed. So an empty upload turns a slot from "Missing" to
     * "Compliant" — or, on an undated slot, permanently to "Compliant", since
     * RAMS, the Fire Risk Assessment and the Drawing have no expiry to fall
     * back on. The register would then say the store holds a certificate that
     * consists of nothing at all, and the digest would stop chasing it.
     *
     * 400 rather than 413: too large and empty are different mistakes, and the
     * person who hit this needs to be told the file did not survive whatever
     * produced it, not that it was too big.
     */
    if (file.size < 1) {
      return Response.json(
        { error: "That file is empty. Choose a file with something in it." },
        { status: 400 },
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
      *
      * It is now resolved UNCONDITIONALLY rather than only for a caller with no
      * session. That is deliberate and is the load-bearing half of the W07-01
      * fix: a signed-in `client` who opens a public form link in the same
      * browser is exercising the LINK's grant, and skipping the token because a
      * session happens to exist would refuse them while an anonymous stranger
      * holding the identical link is allowed.
      */
    const tenant = await resolveUploadTenant(db, orgId, uploadToken);
    orgId = tenant.orgId;
    const scopedToken = tenant.token;

    /*
     * A job in the recycle bin does not accept new files. Its row survives a
     * delete — that is what makes restoring it possible — so without this
     * filter an upload would attach evidence to a job nobody can see, and the
     * file would appear out of nowhere if the job were later restored.
     * "Not found" rather than a specific refusal: as far as this route is
     * concerned a binned job is not there.
     *
     * The lookup is skipped entirely when no job was named — a contractor's
     * insurance certificate has no work order, and W07-07 no longer pretends it
     * must. Every use of `workOrder` below is therefore optional-chained.
     */
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
      return Response.json({ error: "Work order not found." }, { status: 404 });
    }

    /*
     * The other three anchors, checked against THIS tenant before anything is
     * written. The database will not do it — there is no foreign key on
     * `site_id` or `unit_id` in the deployed DDL whatever `db/schema.ts`
     * declares — so this is the only thing standing between a typo and a
     * document filed against a row that does not exist. Before the R2 put, not
     * merely before the insert, or a refusal would leave orphaned bytes.
     */
    const badAnchor = await anchorReferencesRefusal(db, orgId, anchors);
    if (badAnchor) return badAnchor;

    if (boardColumnId && workOrder) {
      // The column must belong to the board this work order is placed on —
      // not to "maintenance" as a literal, which refused every Store
      // Documentation certificate. See `boardKeyForRequest`.
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
        return Response.json(
          { error: "The file column no longer exists." },
          { status: 404 },
        );
      }
      /*
       * THE COLUMN DECIDES THE KIND — AND THIS WAS `kind = "general"`.
       *
       * Unconditionally. The rule was written for a file column an admin added,
       * where "general evidence" is exactly right, and then applied to the two
       * columns that mean something. Two consequences, both measured:
       *
       *  · The issue slot on the contractor's page could never be used. The
       *    page sends `kind=issue` together with the issue column's id, this
       *    line rewrote the kind to "general", and the grant check below —
       *    which runs AFTER — compared "general" against a link granted
       *    `issue` and answered 403. The identical request without a column id
       *    answered 201. The link was not too narrow; the coercion was.
       *
       *  · A photograph the uploader called a fault photograph was STORED as
       *    general evidence in the fault column, so `kind` and
       *    `board_column_id` disagreed about the same row — which is one of
       *    the two ways the counters and the table came apart in the first
       *    place.
       *
       * `kindForColumnKey` is the same mapping `scripts/repair-attachment-kinds`
       * had to reconstruct to undo that damage: the two picture columns keep
       * their meaning, every other file column is general. The grant is still
       * checked, and now it is checked against what will actually be written.
       */
      kind = kindForColumnKey(column.key);
      kindFromColumn = true;
    }

    /*
     * W07-01 — MAY YOU, not merely who are you.
     *
     * Three pages of `!isOperator` branches stood here: the contractor link's
     * job binding and allowed-kinds check, `recordTokenUse`, the public token's
     * hash and expiry, and the "issue evidence only" rule. Every one of them was
     * skipped for any caller with a session, whatever that session could
     * actually do — so the one thing the block never checked was permission.
     *
     * `resolveUploadAuthority` is that same set of rules with a capability floor
     * underneath and one change of order: a presented token answers first, a
     * session's capability answers only when no token was presented. It is
     * called AFTER the column has coerced the kind, because the grant must be
     * checked against what will actually be written — checking the requested
     * kind is what made the contractor page's issue slot answer 403 for a
     * request its link plainly permitted.
     */
    const authority = await resolveUploadAuthority({
      request,
      scope,
      orgId,
      workOrder: workOrder ?? null,
      storedKind: kind,
      uploadToken,
      jobToken: scopedToken,
    });
    if (authority.denied) return authority.denied;

    /*
     * W07-03 — a replacement is planned before any bytes move.
     *
     * Read separately from the write so a missing, archived or already-superseded
     * predecessor is refused cleanly. Doing it after the R2 put would mean the
     * UNIQUE index on `coalesce(root_document_id, id) WHERE is_current` rejects
     * the insert once the object is already stored: an orphan in the bucket and a
     * 503 for something that is really a 409.
     *
     * Only the capability path may replace. A contractor link and a public form
     * token are grants to ADD evidence to a job, not to supersede a document
     * somebody else filed — and a token holder cannot see the register well
     * enough to know what they would be standing down.
     */
    let version: Awaited<ReturnType<typeof planVersion>> | null = null;
    if (replacesId) {
      if (authority.via !== "capability") {
        return Response.json(
          { error: "This link cannot replace an existing document." },
          { status: 403 },
        );
      }
      version = await planVersion(db, orgId, replacesId);
      if (!version.ok) return version.denied;
    }

    /*
     * The anchors this row will actually be stored with — the second half of the
     * check skipped above for a replacement.
     *
     * A new version inherits its parent's filing, so the rule is satisfied by
     * what is supplied OR what is carried. Refused here, still before the R2
     * put, so a replacement of an unanchored parent leaves no orphaned bytes.
     */
    const filedAgainst = effectiveAnchors(
      anchors,
      version?.ok ? version.plan.carried : null,
    );
    if (replacesId) {
      const missingAnchor = anchorRefusal(filedAgainst);
      if (missingAnchor) return missingAnchor;
    }

    /*
     * A NEW VERSION KEEPS THE DOCUMENT'S KIND, for the same reason it keeps its
     * title and its expiry: it is the same document.
     *
     * `planVersion` has always computed `carried.kind`, and no insert on either
     * upload route ever read it — so `kind` fell to its `"issue"` default and a
     * workspace document silently became issue evidence the moment somebody
     * replaced it. Measured: a `general` document filed against a site came back
     * `issue` after "Upload new version", and the drawer's Type flipped from
     * "Workspace document" to "Issue evidence". Latent until now, because the
     * portal could not complete a replacement at all; the anchor fix above is
     * what makes it reachable, so it is fixed in the same pass.
     *
     * PRECEDENCE, and it is the existing precedence rather than a new one: an
     * explicitly requested kind still wins, and the file column still overrules
     * both — "THE COLUMN DECIDES THE KIND" above is unchanged, and a version
     * filed into the fault-picture column is fault evidence whatever its parent
     * was. The predecessor is consulted only where the request said nothing and
     * no column spoke, which is exactly the case that was defaulting.
     */
    if (version?.ok && !kindWasChosen && !kindFromColumn) {
      kind = carriedKind(version.plan.carried.kind, allowedKinds, kind);
    }

    const { env } = await import("cloudflare:workers");
    const runtimeEnv = env as unknown as { BUCKET?: R2Bucket };
    if (!runtimeEnv.BUCKET) {
      return Response.json(
        { error: "File storage is unavailable." },
        { status: 503 },
      );
    }

    /*
     * W07-02 — the document's own identity, supplied at upload time.
     *
     * Optional throughout: an evidence photograph from a phone has no title and
     * needs none, and requiring one would break every existing caller. A
     * replacement inherits its predecessor's metadata (`version.plan.carried`)
     * and anything sent here overrides that — so re-uploading an expired
     * certificate with a new date is one request, and re-uploading it with no
     * fields at all keeps the title and type it already had rather than blanking
     * them.
     */
    const fields = documentFieldUpdates({
      ...(form.has("title") ? { title: form.get("title") } : {}),
      ...(form.has("documentType")
        ? { documentType: form.get("documentType") }
        : {}),
      ...(form.has("description")
        ? { description: form.get("description") }
        : {}),
      ...(form.has("expiryDate") ? { expiryDate: form.get("expiryDate") } : {}),
    });
    // A malformed expiry is answered here, before anything is stored. The
    // Postgres CHECK on `expiry_date` would otherwise turn it into a 503.
    if (!fields.ok) {
      return Response.json({ error: fields.error }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const cleanName = safeFileName(file.name) || `upload-${id}`;
    /*
     * The object key names what the document is filed against.
     *
     * `requestId` used to be interpolated unconditionally and was mandatory, so
     * it was always present. Now that a document may have no job, the segment
     * falls back to whichever anchor it does have — a key reading
     * `.../maintenance/undefined/general/...` would be unreadable in the bucket
     * and would collide across every jobless document, and `object_key` carries
     * a UNIQUE constraint, so the second such upload would fail on a name.
     *
     * Derived from `filedAgainst`, not from the supplied anchors: a new version
     * that inherits its parent's job would otherwise be stored under `unfiled`
     * while the row it creates names that job, and the key is the only thing a
     * person reading the bucket has to go on. Same order as `anchorSegment` in
     * `./documents.ts`, which is where the rule now lives — the multipart route
     * re-derives the prefix from it to prove a resumed upload is writing where
     * its `start` said it would, and two spellings of one rule is how those two
     * halves drift apart.
     */
    const key = `${orgId}/maintenance/${anchorSegment(filedAgainst)}/${kind}/${id}-${cleanName}`;
    await runtimeEnv.BUCKET.put(key, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
        contentDisposition: `inline; filename="${cleanName}"`,
      },
      customMetadata: {
        // The job the ROW will name, so the object and the row agree: a version
        // that inherits its parent's job would otherwise carry an empty one.
        requestId: filedAgainst.requestId,
        kind,
        ...(boardColumnId ? { boardColumnId } : {}),
        uploadedBy: actor?.email ?? "public-form",
        originalName: file.name,
      },
    });

    /*
     * The predecessor stands down BEFORE the successor is inserted.
     *
     * The database permits exactly one `is_current` row per lineage, so the other
     * order is rejected outright — and being rejected is the constraint doing its
     * job, not something to design around. The instant in which a lineage has no
     * current version is the safe direction to fail: a missing document reads as
     * an open finding, two current versions read as a doubled count that nobody
     * notices. `restorePredecessor` closes the window if the insert then fails.
     */
    if (version?.ok) {
      await standDownPredecessor(db, orgId, version.predecessor.id);
    }

    try {
      const [created] = await db
        .insert(attachments)
        .values({
          id,
          organisationId: orgId,
          /*
           * The anchors, and the precedence that matters: AN EXPLICIT `siteId`
           * WINS OVER THE JOB'S. Both upload routes wrote `workOrder.siteId`
           * unconditionally, which is why all 19 pre-migration rows carry a site
           * identical to their job's and why the column looked derived. It is
           * not: a document can concern a different site from the job that
           * surfaced it, and a document with no job has only this.
           */
          requestId: requestId || version?.plan.carried.requestId || null,
          siteId: resolveSiteId(
            anchors.siteId,
            workOrder?.siteId ?? version?.plan.carried.siteId,
          ),
          /*
           * Written for real, not declared and left null. A column with a reader
           * and no writer is the most misleading shape a schema can have — it
           * reads as a feature that exists and answers every question with
           * "nothing recorded".
           */
          unitId: anchors.unitId || version?.plan.carried.unitId || null,
          contractorId:
            anchors.contractorId || version?.plan.carried.contractorId || null,
          kind,
          boardColumnId:
            boardColumnId || version?.plan.carried.boardColumnId || null,
          objectKey: key,
          originalName: file.name,
          contentType: file.type || "application/octet-stream",
          byteSize: file.size,
          // W07-02 metadata: the predecessor's values, then this request's.
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
            fields.values.expiryDate ?? version?.plan.carried.expiryDate ?? null,
          // W07-03 lineage. Absent `replaces`, a document is version 1 of itself:
          // `root_document_id` stays NULL and resolves as `coalesce(root, id)`.
          rootDocumentId: version?.ok ? version.plan.rootDocumentId : null,
          versionNo: version?.ok ? version.plan.versionNo : 1,
          isCurrent: true,
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
          /*
           * Keyed on the GRANT, not on `!isOperator`. The two expressions happen
           * to agree today and would stop agreeing the moment a signed-in client
           * used a contractor link — the review queue would then silently skip
           * exactly the upload it exists to catch. See `pendingReview`.
           */
          pending: pendingReview(authority.via),
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

      /*
       * The job's own timeline. Skipped where there is no job — a contractor's
       * insurance certificate has no work order to appear on — which is why the
       * audit event below is written unconditionally rather than beside it.
       */
      if (requestId) {
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
      }

      /*
       * W07-12 — THE AUDIT VIEWER'S STREAM, which documents never reached.
       *
       * `activity_log` above and `audit_events` here are deliberately separate
       * stores answering different readers: the first is the job's timeline for
       * the people working it, the second is the system trail for whoever has to
       * answer a question months later. Documents wrote only the first, so
       * `/api/audit` — 1171 rows — contained not one document event, and the
       * question "who put this certificate here" had no answer on the screen
       * built to answer it. ADDED beside, never moved.
       *
       * `recordAudit` never throws, so this cannot fail an upload that has
       * already succeeded.
       */
      await recordAudit({
        db,
        // Never null: a NULL-organisation event is invisible to every reader who
        // is not a super admin, which would be a log nobody can read.
        organisationId: orgId,
        actor: auditActor(scope),
        action: version?.ok ? "document.version_added" : "document.uploaded",
        entityType: "document",
        entityId: id,
        summary: version?.ok
          ? `Replaced ${version.predecessor.originalName} with ${file.name} (version ${version.plan.versionNo}).`
          : `Uploaded ${file.name}.`,
        detail: {
          fileId: id,
          fileName: file.name,
          contentType: file.type,
          byteSize: file.size,
          kind,
          boardColumnId: boardColumnId || null,
          requestId: requestId || null,
          siteId: anchors.siteId || workOrder?.siteId || null,
          unitId: anchors.unitId || null,
          contractorId: anchors.contractorId || null,
          // How this upload was authorised. The single most useful fact when
          // reading the log after the event: a job link, a public form, or a
          // person holding `board.edit`.
          via: authority.via,
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
      await runtimeEnv.BUCKET.delete(key);
      /*
       * Put the previous version back at the head of its lineage.
       *
       * The insert has failed, so the successor does not exist — and the
       * predecessor was already stood down to make room for it. Left alone, the
       * lineage would have NO current version and the document would vanish from
       * every register, as though a failed upload had deleted it.
       */
      if (version?.ok) {
        await restorePredecessor(db, orgId, version.predecessor.id);
      }
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
