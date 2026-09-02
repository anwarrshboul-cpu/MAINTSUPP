/**
 * A DOCUMENT, as opposed to a file that happens to hang off a cell.
 *
 * Workstream 7 asked the register to say what each stored file IS — its title,
 * its type, when it expires, who it belongs to, which version it is — and none
 * of that had anywhere to live. `attachments` held bytes, a filename, a job and
 * a column, and every criterion that needed more than that (W07-02, 03, 05, 07,
 * 10, 11) was unbuildable rather than merely unbuilt.
 *
 * This module is the shared half: the field rules, the anchor rule, the payload
 * shape and the version write. All three file routes call it, because all three
 * have to agree — and the two upload routes have already drifted once on this
 * exact surface (`pending`/`submitted_via` written by one and not the other, so
 * every contractor photograph over ~900 KB skipped the review queue).
 */

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  attachments,
  complianceDocuments,
  contractors,
  sites,
  units,
} from "../../../db/schema";
import { dateOnlyValue } from "../../lib/expiry-status";
import { chunkIds } from "../../lib/sql-batching";
import type { ScopedDatabase } from "../../lib/tenant-db";

type Db = ScopedDatabase["db"];
type AttachmentRow = typeof attachments.$inferSelect;

/** Longest a stored string may be, per column. Truncated, never rejected. */
export const FIELD_LIMITS = {
  title: 200,
  documentType: 80,
  description: 2000,
  anchorId: 120,
} as const;

/* ── The payload ──────────────────────────────────────────────────────────── */

/**
 * One document, as every screen receives it.
 *
 * The old shape omitted three columns that were being written all along — a
 * recurring failure mode in this file's history: `uploadedByEmail` was written
 * from the first commit and "simply never served", so the viewer's "Added by …"
 * line had nothing to read. W07-10 needs status, expiry, owner and site, so all
 * four are here, and `siteId` in particular is not derivable by the client from
 * anything else it is given.
 *
 * The multipart route's copy of this function was missing `uploadedByEmail`
 * outright, so which fields a caller received depended on how big their file
 * was. One function, three callers.
 */
export function attachmentPayload(row: AttachmentRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    kind: row.kind,
    boardColumnId: row.boardColumnId,
    originalName: row.originalName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    uploadedByEmail: row.uploadedByEmail,
    // W07-07 anchors. Served explicitly because a document with no job has no
    // other way to say what it belongs to.
    siteId: row.siteId,
    unitId: row.unitId,
    contractorId: row.contractorId,
    // W07-02 / W07-10 metadata.
    title: row.title,
    documentType: row.documentType,
    description: row.description,
    expiryDate: row.expiryDate,
    metadataUpdatedAt: row.metadataUpdatedAt,
    metadataUpdatedBy: row.metadataUpdatedBy,
    // W07-05 archive state, and W07-03 lineage.
    archivedAt: row.archivedAt,
    archivedBy: row.archivedBy,
    /*
     * `rootDocumentId` is served RESOLVED rather than raw. Version 1 stores
     * NULL — that is what let the column be added without back-filling 19 rows —
     * and a client that had to know about the null would reimplement the
     * coalesce, probably differently. The lineage id is `coalesce(root, id)`
     * everywhere, including in the two UNIQUE indexes, so it is served that way.
     */
    rootDocumentId: row.rootDocumentId ?? row.id,
    versionNo: row.versionNo,
    isCurrent: row.isCurrent,
    inlineUrl: `/api/files/${row.id}`,
    downloadUrl: `/api/files/${row.id}?download=1`,
  };
}

/* ── Field rules ──────────────────────────────────────────────────────────── */

function trimmed(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * An expiry date, or a refusal.
 *
 * `expiry_date` carries a CHECK constraint on the Postgres side —
 * `~ '^\d{4}-\d{2}-\d{2}$'` — so a malformed value is not a bad row, it is a
 * DATABASE ERROR: the insert throws, the route's catch-all turns it into a 503,
 * and the caller is told the workspace is unavailable when what actually
 * happened is that they typed a date wrong. Validating here means the answer is
 * a 400 that names the problem, and the constraint is never reached.
 *
 * `dateOnlyValue` is the normaliser the compliance screens and the board grid
 * both use, so a date accepted here means the same thing as a date in a board
 * date cell — down to the malformed cases. It returns "" for anything it cannot
 * read, which is why an empty result on a non-empty input is a refusal rather
 * than a silent clear: silently storing NULL for "31/02/2027" would tell the
 * register the certificate has no expiry, and an undated certificate reads as
 * permanently compliant.
 */
export function expiryValue(
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "An expiry date must be text in YYYY-MM-DD form." };
  }
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const normalised = dateOnlyValue(text);
  if (!normalised) {
    return {
      ok: false,
      error: "That expiry date is not a real date. Use YYYY-MM-DD.",
    };
  }
  /*
   * Normalising is not enough on its own: `dateOnlyValue` accepts a full ISO
   * timestamp and returns its date half, which is right for reading a board
   * cell. Re-checking the shape it produced is what guarantees the value going
   * to the column satisfies the CHECK, whatever shape arrived.
   */
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalised)) {
    return { ok: false, error: "That expiry date is not in YYYY-MM-DD form." };
  }
  /*
   * A calendar date, not merely a well-shaped string. "2027-02-31" matches the
   * regex and satisfies the CHECK, and would sit in the register as a date that
   * does not exist — sorting between the 30th and March, and never arriving.
   */
  const [year, month, day] = normalised.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return { ok: false, error: "That expiry date is not a real calendar date." };
  }
  return { ok: true, value: normalised };
}

/**
 * The metadata fields a caller supplied, in PATCH semantics.
 *
 * Absent key means unchanged, and that is the whole reason this returns a sparse
 * object rather than a full row: spreading a complete object into `.set()` would
 * rewrite every field on every edit, so renaming a document would erase its
 * expiry date. Explicit `null` clears; explicit text sets.
 */
export function documentFieldUpdates(
  body: Record<string, unknown>,
): { ok: true; values: Partial<AttachmentRow> } | { ok: false; error: string } {
  const values: Partial<AttachmentRow> = {};

  if ("title" in body) {
    values.title = body.title === null ? null : trimmed(body.title, FIELD_LIMITS.title) || null;
  }
  if ("documentType" in body) {
    values.documentType =
      body.documentType === null
        ? null
        : trimmed(body.documentType, FIELD_LIMITS.documentType) || null;
  }
  if ("description" in body) {
    values.description =
      body.description === null
        ? null
        : trimmed(body.description, FIELD_LIMITS.description) || null;
  }
  if ("expiryDate" in body) {
    const expiry = expiryValue(body.expiryDate);
    if (!expiry.ok) return { ok: false, error: expiry.error };
    values.expiryDate = expiry.value;
  }
  return { ok: true, values };
}

/**
 * The subset of a row a before/after audit table should show.
 *
 * `contractorId` is here and the other three anchors are not, and the asymmetry
 * is the point: W05-09 / W06-10 made the CONTRACTOR anchor editable after
 * upload — see the PATCH in `app/api/files/[id]/route.ts` — so it is a field
 * that moves and an audit table that could not show it moving would be missing
 * the only structural change this route can make. `requestId`, `siteId` and
 * `unitId` are still write-once at upload, so there is nothing for a before and
 * an after to differ by.
 */
export function documentFieldSnapshot(row: AttachmentRow) {
  return {
    title: row.title,
    documentType: row.documentType,
    description: row.description,
    expiryDate: row.expiryDate,
    archivedAt: row.archivedAt,
    contractorId: row.contractorId,
  };
}

/* ── Anchors (W07-07) ─────────────────────────────────────────────────────── */

export type Anchors = {
  requestId: string;
  siteId: string;
  unitId: string;
  contractorId: string;
};

export function readAnchors(source: {
  requestId?: unknown;
  siteId?: unknown;
  unitId?: unknown;
  contractorId?: unknown;
}): Anchors {
  return {
    requestId: trimmed(source.requestId, FIELD_LIMITS.anchorId),
    siteId: trimmed(source.siteId, FIELD_LIMITS.anchorId),
    unitId: trimmed(source.unitId, FIELD_LIMITS.anchorId),
    contractorId: trimmed(source.contractorId, FIELD_LIMITS.anchorId),
  };
}

/**
 * EVERY DOCUMENT MUST BELONG TO SOMETHING.
 *
 * `POST /api/files` used to require a `requestId`, which is why a contractor's
 * public liability certificate had no home: it is a fact about the contractor,
 * not evidence about a work order, so there was no id to give and the upload was
 * answered 400. That is what made W07-07 a CONFLICT rather than a gap — the
 * criterion asks for links to Site, Job, Compliance, Asset and Contractor, and
 * the route accepted exactly one of them and insisted on it.
 *
 * The mandatory job becomes an optional job plus this rule: at least one of the
 * four canonical anchors. Nothing floats free, and nothing has to be invented to
 * satisfy a column — which is the failure mode the sentinel `site-unassigned`
 * caused elsewhere in this codebase: an id referencing no row in any table, in
 * any tenant, that had to be exempted by hand from cross-organisation checks and
 * read as a real site to everything that did not know it by name.
 */
export function anchorRefusal(anchors: Anchors): Response | null {
  if (
    anchors.requestId ||
    anchors.siteId ||
    anchors.unitId ||
    anchors.contractorId
  ) {
    return null;
  }
  return Response.json(
    {
      error:
        "A document must be filed against a work order, a site, a unit or a contractor.",
    },
    { status: 400 },
  );
}

/**
 * WHAT A REPLACEMENT IS FILED AGAINST — supplied, or inherited from its parent.
 *
 * `anchorRefusal` above answers a question about a DOCUMENT, and both upload
 * routes were asking it about a REQUEST. For a new version those are not the
 * same thing: a new version belongs to a logical document that is already filed
 * somewhere, so the anchors it will be stored with are the ones sent PLUS the
 * ones carried forward from the predecessor. Both routes already wrote the row
 * that way — `requestId || version.plan.carried.requestId`, `resolveSiteId(...)`
 * and so on at the insert — and then refused the request long before
 * `planVersion` had been called, so the refusal was decided on half the facts.
 *
 * Measured symptom: a document visibly showing "Site: Highcross Leicester" and
 * "Work order: MN-1058" answered 400 "A document must be filed against a work
 * order, a site, a unit or a contractor." to "Upload new version", because the
 * replacement form does not re-send relationships nobody asked it to change.
 *
 * This is the SAME precedence the inserts use — anything supplied wins, the
 * predecessor's value is the floor — expressed once so the check and the write
 * cannot disagree. Note what it deliberately does NOT do: it invents nothing. If
 * the predecessor is itself unanchored, every field here stays empty and
 * `anchorRefusal` still refuses. Inheritance is not a way past the rule, it is
 * the rest of the evidence the rule is entitled to.
 *
 * `carried` is nullable so the caller can pass the plan for a replacement and
 * `null` for an original without branching: an original has no parent, so the
 * effective anchors ARE the supplied ones and the rule is unchanged.
 */
/**
 * THE KIND A NEW VERSION KEEPS, narrowed rather than cast.
 *
 * `attachments.kind` is a `text` column, so a predecessor's kind arrives typed
 * `string` while the insert wants an `AttachmentKind`. A blind cast would let a
 * legacy row — the monday import wrote kinds this product no longer offers —
 * put an unrecognised value into a new row that a person just created, which is
 * a worse outcome than the fallback: the old row stays exactly as it is and
 * only the NEW row is held to the current vocabulary.
 *
 * `allowed` is passed in because each route owns its own set; the rule is
 * shared, the vocabulary is the caller's.
 */
export function carriedKind<K extends string>(
  carried: string | null | undefined,
  allowed: ReadonlySet<K>,
  fallback: K,
): K {
  return carried && allowed.has(carried as K) ? (carried as K) : fallback;
}

export function effectiveAnchors(
  anchors: Anchors,
  carried: AnchorSource | null | undefined,
): Anchors {
  if (!carried) return anchors;
  return {
    requestId: anchors.requestId || carried.requestId || "",
    siteId: anchors.siteId || carried.siteId || "",
    unitId: anchors.unitId || carried.unitId || "",
    contractorId: anchors.contractorId || carried.contractorId || "",
  };
}

/** Anything that can tell `effectiveAnchors` where a predecessor is filed. */
export type AnchorSource = Pick<
  AttachmentRow,
  "requestId" | "siteId" | "unitId" | "contractorId"
>;

/**
 * THE ANCHORS THE OBJECT KEY IS NAMED AFTER — for the multipart route, which
 * has to name the key before it knows anything else.
 *
 * `POST /api/files` can compute this inline: it has the whole request, calls
 * `planVersion`, and mints the key afterwards. The multipart route cannot.
 * `start` reserves a key, each PUT part re-derives the same prefix through
 * `validUploadKey` to prove a resumed upload is writing where it said it would,
 * and only `complete` — three or four requests later — creates a row. So a
 * replacement's key was minted from the SUPPLIED anchors alone and a >900 KB new
 * version of a document filed against MN-1058 was stored under
 * `.../maintenance/unfiled/...` while the row it created named MN-1058.
 * Measured, before this existed:
 *
 *   row: req=MN-1136 site=store-aldgate
 *   key: org_…/maintenance/unfiled/general/69f4a903-…-v2.txt
 *
 * WHY THIS DOES NOT REFUSE, AND THAT IS THE POINT. An id that names no row in
 * this tenant is answered by returning the supplied anchors unchanged — the same
 * key an unanchored upload would get — rather than 404. `start` and the part
 * handler therefore learn NOTHING about which ids exist in another workspace,
 * which a 404-versus-something-else would tell them. The real refusals are
 * unchanged and still come from `planVersion` at `complete`: 404 for a
 * predecessor that is missing or another tenant's, 409 for archived, 409 for a
 * version that is not the current head. A wrong `replaces` therefore costs the
 * caller an upload and then the truthful error, and buys them no information.
 *
 * WHAT IT READS, AND THE ONE THING THAT CAN NOW MOVE UNDER IT. It reads
 * `request_id`, `site_id`, `unit_id` and `contractor_id`. Three of those four
 * are still write-once at upload. `contractor_id` is not, as of W05-09 /
 * W06-10: `PATCH /api/files/[id]` can now file a document against a contractor
 * or unfile it, alongside the title, type, description, expiry and archive
 * flag it already wrote.
 *
 * That is a bounded, visible race rather than a silent one, and `anchorSegment`
 * is why. The key names `request_id` first and only falls through to
 * `contractor_id` when there is no job — so a multipart replacement of a
 * job-anchored document is unaffected however its contractor is edited, and the
 * exposed case is narrow: somebody re-files a JOBLESS document against a
 * different contractor while a >900 KB new version of that same document is
 * mid-upload. The parts then disagree with the prefix `start` minted and
 * `validUploadKey` refuses them, which costs that upload and stores nothing
 * wrong. The alternative — reading the anchor once and trusting it — would
 * write bytes under a key the row does not name, which is the failure this
 * function was added to end.
 *
 * Otherwise unchanged, and deliberately WITHOUT `planVersion`'s liveness
 * conditions: if the predecessor is archived or superseded mid-upload the parts
 * must keep agreeing with the key `start` minted, and `complete` is where that
 * is refused.
 */
export async function anchorsForKey(
  db: Db,
  orgId: string,
  anchors: Anchors,
  replacesId: string,
): Promise<Anchors> {
  if (!replacesId) return anchors;
  const [predecessor] = await db
    .select({
      requestId: attachments.requestId,
      siteId: attachments.siteId,
      unitId: attachments.unitId,
      contractorId: attachments.contractorId,
    })
    .from(attachments)
    .where(
      and(eq(attachments.id, replacesId), eq(attachments.organisationId, orgId)),
    )
    .limit(1);
  return effectiveAnchors(anchors, predecessor ?? null);
}

/**
 * Every supplied anchor names a row IN THIS TENANT, or the upload is refused.
 *
 * Checked in code rather than left to the database, and deliberately so. The
 * deployed Postgres DDL has NO foreign key on `request_id`, `site_id` or
 * `unit_id` — `db/schema.ts` declares `.references()` on `requestId` and the
 * database does not enforce it, which is the existing deferred-FK convention
 * here. So reading the schema file gives the wrong answer about what is actually
 * caught, and a bad id would simply be stored. Only `contractor_id` and
 * `root_document_id` carry real FKs, both composite with `organisation_id`.
 *
 * `unit_id` has no FK on purpose — `units` is empty, and a constraint would
 * reject the very first asset link — so this function is the ONLY thing standing
 * between a typo and a document filed against a unit that does not exist.
 *
 * Cross-tenant is the case that matters most: every lookup below is scoped by
 * `organisation_id`, so an id belonging to another workspace is answered "not
 * found" rather than accepted, and the refusal happens BEFORE any mutation —
 * before the R2 put, not just before the insert, or a refused upload would leave
 * orphaned bytes in the bucket.
 */
export async function anchorReferencesRefusal(
  db: Db,
  orgId: string,
  anchors: Anchors,
): Promise<Response | null> {
  /*
   * Spelled out per table rather than parameterised over one: drizzle's
   * `.from()` does not take a union of table types, and three explicit selects
   * read more honestly than a cast that hides which table is being asked. This
   * mirrors `referenceRefusal` in the workspace route, which is the same rule
   * for the same reason — copied rather than imported because that one is a
   * private function inside a route module.
   */
  if (anchors.siteId) {
    const [row] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, anchors.siteId), eq(sites.organisationId, orgId)))
      .limit(1);
    if (!row) return Response.json({ error: "Site not found." }, { status: 404 });
  }
  if (anchors.unitId) {
    const [row] = await db
      .select({ id: units.id })
      .from(units)
      .where(and(eq(units.id, anchors.unitId), eq(units.organisationId, orgId)))
      .limit(1);
    if (!row) return Response.json({ error: "Unit not found." }, { status: 404 });
  }
  if (anchors.contractorId) {
    const [row] = await db
      .select({ id: contractors.id })
      .from(contractors)
      .where(
        and(
          eq(contractors.id, anchors.contractorId),
          eq(contractors.organisationId, orgId),
        ),
      )
      .limit(1);
    if (!row) {
      return Response.json({ error: "Contractor not found." }, { status: 404 });
    }
  }
  return null;
}

/**
 * The site a document is filed under.
 *
 * AN EXPLICIT `siteId` WINS OVER THE JOB'S. Both upload routes used to write
 * `siteId: workOrder.siteId` unconditionally, which is why all 19 existing rows
 * carry a site identical to their job's and why the column looked like a
 * derived field rather than a real one. It is not derived: a document can be
 * about a different site from the job that surfaced it, and a document with no
 * job at all has only this.
 *
 * The job's site remains the fallback, so nothing that relied on the inheritance
 * changes.
 */
export function resolveSiteId(
  explicitSiteId: string,
  workOrderSiteId: string | null | undefined,
): string | null {
  return explicitSiteId || workOrderSiteId || null;
}

/**
 * The path segment naming what an object is filed against.
 *
 * The R2 key used to interpolate `requestId` unconditionally, which was safe
 * only because a job was mandatory. Now that a document may have none, the
 * segment falls back to whichever anchor it does have — a key reading
 * `.../maintenance/undefined/general/...` would be unreadable in the bucket, and
 * every jobless document would share the same segment, which matters because
 * `object_key` carries a UNIQUE constraint.
 *
 * Shared with the multipart route's `validUploadKey`, which re-derives the same
 * prefix to prove a resumed upload is writing where its `start` said it would.
 * Two different rules there would mean a jobless multipart upload could begin
 * and never complete.
 */
export function anchorSegment(anchors: Anchors): string {
  return (
    anchors.requestId ||
    anchors.contractorId ||
    anchors.siteId ||
    anchors.unitId ||
    "unfiled"
  );
}

/* ── The live-document predicate (W07-03, W07-05) ─────────────────────────── */

/**
 * WHAT COUNTS AS "THE DOCUMENTS THIS THING HAS".
 *
 * The current version of each lineage, not archived. This one predicate is the
 * difference between a working register and a lying one: a certificate replaced
 * twice is ONE document with three rows, and anything that counts rows without
 * this reads it as three. The board's photo strip would triple, and the
 * compliance register — which decides whether a slot is HELD by asking
 * `fileCount > 0` — would keep a slot "Compliant" on the strength of a
 * superseded certificate that had been replaced precisely because it expired.
 *
 * `isCurrent` is stored rather than derived from `max(version_no)` because the
 * database enforces it: a UNIQUE index on `coalesce(root_document_id, id)` WHERE
 * `is_current` guarantees exactly one head per lineage, which no computed
 * expression could. Version 1 is `is_current = true` and self-rooted, so every
 * row that existed before versioning satisfies this without being touched.
 */
export function liveDocumentFilter() {
  return and(eq(attachments.isCurrent, true), isNull(attachments.archivedAt));
}

/* ── The version write (W07-03) ───────────────────────────────────────────── */

export type VersionPlan = {
  rootDocumentId: string;
  versionNo: number;
  /** Metadata carried forward from the predecessor, so a version keeps its identity. */
  carried: Pick<
    AttachmentRow,
    | "title"
    | "documentType"
    | "description"
    | "expiryDate"
    | "siteId"
    | "unitId"
    | "contractorId"
    | "requestId"
    | "boardColumnId"
    | "kind"
  >;
};

/**
 * Where a replacement belongs in its lineage, and what it inherits.
 *
 * Read separately from the write because the caller must refuse — cleanly, before
 * touching R2 — when the predecessor is missing, in another tenant, archived, or
 * is not the current head. Replacing a superseded version would fork the lineage,
 * and the UNIQUE index would reject the insert AFTER the bytes had been stored,
 * leaving an orphan object in the bucket and a 503 for something that is really a
 * 409.
 */
export async function planVersion(
  db: Db,
  orgId: string,
  replacesId: string,
): Promise<
  { ok: true; plan: VersionPlan; predecessor: AttachmentRow } | { ok: false; denied: Response }
> {
  const [predecessor] = await db
    .select()
    .from(attachments)
    .where(
      and(eq(attachments.id, replacesId), eq(attachments.organisationId, orgId)),
    )
    .limit(1);
  if (!predecessor) {
    return {
      ok: false,
      denied: Response.json(
        { error: "The document being replaced no longer exists." },
        { status: 404 },
      ),
    };
  }
  if (predecessor.archivedAt) {
    return {
      ok: false,
      denied: Response.json(
        { error: "That document is archived. Restore it before replacing it." },
        { status: 409 },
      ),
    };
  }
  if (!predecessor.isCurrent) {
    return {
      ok: false,
      denied: Response.json(
        {
          error:
            "That is not the current version of this document. Replace the current version instead.",
        },
        { status: 409 },
      ),
    };
  }

  const rootDocumentId = predecessor.rootDocumentId ?? predecessor.id;
  /*
   * `max + 1` over the lineage rather than `predecessor.version_no + 1`.
   *
   * They differ exactly when something has gone wrong — a fork, a partially
   * applied write — and in that case the higher number is the safe one: the
   * UNIQUE index on (lineage, version_no) would reject a repeat, and being
   * rejected is better than reusing a number that already means another file.
   */
  const [tip] = await db
    .select({ highest: sql<number>`COALESCE(MAX(${attachments.versionNo}), 0)` })
    .from(attachments)
    .where(
      and(
        eq(attachments.organisationId, orgId),
        or(
          eq(attachments.rootDocumentId, rootDocumentId),
          eq(attachments.id, rootDocumentId),
        ),
      ),
    );

  return {
    ok: true,
    predecessor,
    plan: {
      rootDocumentId,
      versionNo: Number(tip?.highest ?? predecessor.versionNo) + 1,
      /*
       * A new version of a document is the SAME document. Carrying the title,
       * type, description, expiry and anchors forward is what makes that true —
       * otherwise replacing a PAT certificate would silently blank its expiry
       * date, and the register would go from "expires in March" to "no expiry
       * recorded", which reads as permanently compliant.
       *
       * The caller may still override any of these from the request; this is the
       * floor, not the final answer.
       */
      carried: {
        title: predecessor.title,
        documentType: predecessor.documentType,
        description: predecessor.description,
        expiryDate: predecessor.expiryDate,
        siteId: predecessor.siteId,
        unitId: predecessor.unitId,
        contractorId: predecessor.contractorId,
        requestId: predecessor.requestId,
        boardColumnId: predecessor.boardColumnId,
        kind: predecessor.kind,
      },
    },
  };
}

/**
 * Stands the predecessor down as the current head.
 *
 * MUST run before the successor's insert, not after. The UNIQUE index on
 * `coalesce(root_document_id, id) WHERE is_current` permits exactly one head, so
 * inserting first is rejected by the database — which is the constraint doing its
 * job, and not something to work around by dropping it. The narrow window in
 * which a lineage has NO current version is the safe direction to fail: a missing
 * document surfaces as an open finding, whereas two current versions surface as a
 * doubled count that nobody notices.
 */
export async function standDownPredecessor(
  db: Db,
  orgId: string,
  predecessorId: string,
) {
  await db
    .update(attachments)
    .set({ isCurrent: false })
    .where(
      and(
        eq(attachments.id, predecessorId),
        eq(attachments.organisationId, orgId),
      ),
    );
}

/**
 * Puts the predecessor back as the head, after a failed successor write.
 *
 * The insert can still fail for reasons no check anticipated, and a lineage left
 * with no current version at all would vanish from every register — the document
 * would appear to have been deleted by an upload that failed. Called from the
 * same catch that deletes the orphaned R2 object.
 */
export async function restorePredecessor(
  db: Db,
  orgId: string,
  predecessorId: string,
) {
  try {
    await db
      .update(attachments)
      .set({ isCurrent: true })
      .where(
        and(
          eq(attachments.id, predecessorId),
          eq(attachments.organisationId, orgId),
        ),
      );
  } catch (error) {
    // Loud, but never fatal: the caller is already reporting a failure, and
    // throwing here would replace its message with this one.
    console.error("[documents] could not restore the previous version's head", {
      predecessorId,
      error,
    });
  }
}

/* ── Compliance back-reference ────────────────────────────────────────────── */

/**
 * Releases any compliance slot pointing at a document about to be destroyed.
 *
 * `compliance_documents.attachment_id` is declared with `.references()` in
 * `db/schema.ts` and HAS NO FOREIGN KEY in the deployed Postgres DDL, so nothing
 * cascades and nothing refuses — a deleted document simply leaves the compliance
 * row pointing at an id that no longer resolves. Today the pointer is never set
 * (the only two assignments in the repo are literal `null`), so the dangling
 * state is unreachable; once documents can be filed against a compliance slot it
 * becomes reachable, and a register whose certificate link 404s is worse than one
 * that admits the slot is empty.
 *
 * Nulled rather than deleted: the SLOT still exists and is still required — the
 * store still needs a PAT certificate — it simply no longer holds one. Deleting
 * the row would remove the obligation along with the evidence.
 *
 * This deliberately does NOT touch the board-derived link, which works through
 * `board_column_id` and is a different, working mechanism: those file cells are
 * resolved by counting attachments on the column, so removing a row is already
 * all that is needed there.
 */
export async function releaseComplianceLinks(
  db: Db,
  orgId: string,
  attachmentIds: string | readonly string[],
) {
  /*
   * ONE DOCUMENT OR A WHOLE LINEAGE, because W07-06 destroys a lineage.
   *
   * Destroying the head of a versioned document destroys every version of it,
   * and a compliance slot may point at ANY of them — a slot filled from version
   * 2 keeps naming version 2 after version 3 supersedes it, because nothing
   * re-points it. Releasing only the id the caller named would therefore leave
   * exactly the dangling pointer this function exists to prevent.
   */
  const ids = typeof attachmentIds === "string" ? [attachmentIds] : [...attachmentIds];
  if (!ids.length) return;
  // Chunked for the same reason every other IN list here is: D1 binds one
  // variable per element and rejects the statement past its limit.
  for (const chunk of chunkIds(ids)) {
    await db
      .update(complianceDocuments)
      .set({ attachmentId: null, updatedAt: new Date().toISOString() })
      .where(
        and(
          inArray(complianceDocuments.attachmentId, chunk),
          eq(complianceDocuments.organisationId, orgId),
        ),
      );
  }
}
