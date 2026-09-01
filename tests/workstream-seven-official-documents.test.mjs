/**
 * W07-02 edit, W07-03 version, W07-05 archive, W07-11 filter, W07-12 audit.
 *
 * WHAT WAS MISSING, and it was the storage as much as the verbs. `attachments`
 * held bytes, a filename, a job and a column. There was no title, no type, no
 * description, no expiry, no version lineage and no archived flag — so:
 *
 *  · W07-02 had no PATCH on either file route (the only other write verb,
 *    `PUT /api/files/[id]`, stores a WebP thumbnail) AND nowhere to put the data;
 *  · W07-03 had no lineage of any kind, so "replace" meant delete-and-reupload
 *    and the predecessor was destroyed;
 *  · W07-05 had removal and no archive, so every removal was permanent;
 *  · W07-11 had no offset, no cursor and a `limit` capped at 100, so the 101st
 *    document was unreachable and a caller totalling what it received got
 *    `min(real, 100)` with no way to know the number was a ceiling;
 *  · W07-12 wrote only `activity_log`, so `portal.audit_events` — 1171 rows —
 *    held not one document event and the Audit viewer could not answer the
 *    question it exists to answer.
 *
 * THE ONE THAT WOULD HAVE BITTEN QUIETLY. Versioning a table whose rows are
 * COUNTED re-breaks the counters this codebase already fixed once. A certificate
 * replaced twice is one document with three rows: without the current+unarchived
 * predicate the board's photo strip triples, and the compliance register — which
 * decides a slot is HELD by asking `fileCount > 0` — keeps a slot "Compliant" on
 * the strength of a superseded certificate that was replaced precisely because
 * it expired.
 *
 * Two halves, as elsewhere: source assertions for the decisions, then the real
 * thing against a running dev server, skipped when nothing answers.
 *
 * NOTE ON TEST DATA. The live half signs in as the seeded owner, uploads tiny
 * `W7OFF-`-prefixed text files, versions and archives them, and deletes every
 * one in the teardown. It never touches MN-1049.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_OWNER_PASSWORD ?? "Sunnamusk-Owner-2026";
const RESERVED = new Set(["MN-1049"]);

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ------------------------------------------------------------------ */
/* 1. Source: the columns exist in BOTH places that matter             */
/* ------------------------------------------------------------------ */

const NEW_COLUMNS = [
  ["title", "title"],
  ["documentType", "document_type"],
  ["description", "description"],
  ["expiryDate", "expiry_date"],
  ["metadataUpdatedAt", "metadata_updated_at"],
  ["metadataUpdatedBy", "metadata_updated_by"],
  ["contractorId", "contractor_id"],
  ["archivedAt", "archived_at"],
  ["archivedBy", "archived_by"],
  ["rootDocumentId", "root_document_id"],
  ["versionNo", "version_no"],
  ["isCurrent", "is_current"],
];

test("every new document column is declared on the attachments table", async () => {
  const schema = await source("db/schema.ts");
  const table = schema.slice(
    schema.indexOf("export const attachments = sqliteTable"),
    schema.indexOf("export const complianceDocuments"),
  );
  assert.ok(table.length > 0, "the attachments table must be findable");
  for (const [field, column] of NEW_COLUMNS) {
    assert.match(
      table,
      new RegExp(`${field}:\\s*(text|integer)\\("${column}"`),
      `db/schema.ts does not declare ${field} ("${column}") on attachments`,
    );
  }
});

test("every new column is also reconciled on boot, or the migration is inert", async () => {
  /*
   * `db/schema.ts` describes the shape; `db/init.ts` is what actually brings a
   * live database up to it, in both dialects. A column declared only in the
   * schema file is a column that does not exist anywhere it is read.
   */
  const init = codeOnly(await source("db/init.ts"));
  for (const [, column] of NEW_COLUMNS) {
    assert.match(
      init,
      new RegExp(`\\["attachments",\\s*"${column}",`),
      `db/init.ts never adds ${column}, so a fresh database will not have it`,
    );
  }
});

test("the two timestamptz columns are declared as text, the proven dual-build shape", async () => {
  const schema = await source("db/schema.ts");
  const table = schema.slice(
    schema.indexOf("export const attachments = sqliteTable"),
    schema.indexOf("export const complianceDocuments"),
  );
  for (const column of ["metadata_updated_at", "archived_at"]) {
    assert.match(
      table,
      new RegExp(`text\\("${column}"\\)`),
      `${column} must be text here, exactly as reviewedAt is — this file compiles for the SQLite build as well`,
    );
  }
});

test("is_current is registered with the dialect translator", async () => {
  /*
   * It is a real Postgres boolean and a 0/1 integer in SQLite, and this list is
   * the only thing that rewrites the comparison. Without the entry every version
   * write is rejected with "column is_current is of type boolean but expression
   * is of type integer" — surfacing as a 503 on upload, not as a schema error.
   */
  const translator = await source("db/sqlite-to-postgres.ts");
  assert.match(translator, /attachments:\s*\["pending",\s*"is_current"\]/);
});

/* ------------------------------------------------------------------ */
/* 2. Source: W07-02 PATCH semantics                                   */
/* ------------------------------------------------------------------ */

test("W07-02 a PATCH exists and is capability-guarded", async () => {
  const code = await source("app/api/files/[id]/route.ts");
  assert.match(code, /export async function PATCH\(/);
  const patch = code.slice(code.indexOf("export async function PATCH("));
  assert.match(patch, /scopedDbWithCapability\(request, "board\.edit"\)/);
});

test("W07-02 the PATCH may not touch bytes, identity, anchors or lineage", async () => {
  const code = await source("app/api/files/[id]/route.ts");
  const patch = codeOnly(code.slice(code.indexOf("export async function PATCH(")));
  /*
   * `values` is the object handed to `.set()`. Nothing outside the document's own
   * fields plus the archive pair and the metadata stamps may ever appear in it —
   * editing a description must not be able to move a document to another
   * tenant's site or re-point it at another job.
   */
  for (const forbidden of [
    "objectKey",
    "originalName",
    "organisationId",
    "uploadedByEmail",
    "requestId",
    "rootDocumentId",
    "versionNo",
    "isCurrent",
    "byteSize",
    "contentType",
  ]) {
    assert.doesNotMatch(
      patch,
      new RegExp(`values\\.${forbidden}\\s*=`),
      `the metadata PATCH must never write ${forbidden}`,
    );
  }
});

test("W07-02 field updates are SPARSE, so an edit cannot blank what it did not name", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  const fn = shared.slice(shared.indexOf("export function documentFieldUpdates"));
  /*
   * `"x" in body` rather than a truthiness read: absent means unchanged and
   * explicit null means clear. A complete object spread into `.set()` would
   * rewrite every field on every edit, so renaming a certificate would erase its
   * expiry date — and an undated certificate reads as permanently compliant.
   */
  for (const field of ["title", "documentType", "description", "expiryDate"]) {
    assert.match(
      fn,
      new RegExp(`"${field}" in body`),
      `${field} must be read by presence, not by truthiness`,
    );
  }
});

test("W07-02 a malformed expiry is refused in code, before the CHECK constraint", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  assert.match(shared, /export function expiryValue/);
  assert.match(shared, /dateOnlyValue\(/, "must normalise through the shared normaliser");
  assert.match(
    shared,
    /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/,
    "must re-check the shape the normaliser produced, since it also accepts a full ISO timestamp",
  );
  assert.match(
    shared,
    /getUTCFullYear\(\) !== year/,
    "a well-shaped string is not a calendar date — 2027-02-31 satisfies the CHECK and does not exist",
  );
  for (const path of [
    "app/api/files/route.ts",
    "app/api/files/multipart/route.ts",
    "app/api/files/[id]/route.ts",
  ]) {
    assert.match(
      codeOnly(await source(path)),
      /documentFieldUpdates\(/,
      `${path} does not validate the expiry, so a typo becomes a database error and a 503`,
    );
  }
});

test("W07-10 the payload serves status, expiry, owner and site", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  const payload = shared.slice(
    shared.indexOf("export function attachmentPayload"),
    shared.indexOf("function trimmed("),
  );
  for (const field of [
    "siteId",
    "unitId",
    "contractorId",
    "uploadedByEmail",
    "title",
    "documentType",
    "expiryDate",
    "archivedAt",
    "versionNo",
    "isCurrent",
  ]) {
    assert.match(
      payload,
      new RegExp(`${field}:`),
      `the payload omits ${field}, which the register cannot derive from anything else it is given`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 3. Source: W07-03 versioning                                        */
/* ------------------------------------------------------------------ */

test("W07-03 the predecessor is stood down before the successor is inserted", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  assert.match(shared, /export async function standDownPredecessor/);
  assert.match(shared, /export async function restorePredecessor/);
  for (const path of [
    "app/api/files/route.ts",
    "app/api/files/multipart/route.ts",
  ]) {
    const code = codeOnly(await source(path));
    const down = code.indexOf("standDownPredecessor(");
    const insert = code.indexOf(".insert(attachments)");
    assert.ok(down > 0, `${path} never clears the predecessor's head flag`);
    assert.ok(
      down < insert,
      `${path} inserts before standing the predecessor down — the UNIQUE index permits one head per lineage, so the other order is rejected by the database`,
    );
    assert.match(
      code,
      /restorePredecessor\(/,
      `${path} would leave a lineage with NO current version if the insert failed, so the document would appear deleted by a failed upload`,
    );
  }
});

test("W07-03 the predecessor's bytes are never deleted by a replacement", async () => {
  for (const path of [
    "app/api/files/route.ts",
    "app/api/files/multipart/route.ts",
  ]) {
    const code = codeOnly(await source(path));
    assert.doesNotMatch(
      code,
      /delete\(version\.predecessor\.objectKey\)/,
      `${path} destroys the version it supersedes, which is the delete-and-reupload behaviour versioning exists to replace`,
    );
    assert.doesNotMatch(
      code,
      /delete\(attachments\)/,
      `${path} must not delete an attachments row at all — that is the DELETE handler's job`,
    );
  }
});

test("W07-03 the version number is max+1 over the lineage, not predecessor+1", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  const plan = shared.slice(shared.indexOf("export async function planVersion"));
  assert.match(plan, /COALESCE\(MAX\(\$\{attachments\.versionNo\}\), 0\)/);
  assert.match(
    plan,
    /rootDocumentId = predecessor\.rootDocumentId \?\? predecessor\.id/,
    "version 1 is self-rooted, which is what let the column be added without back-filling",
  );
});

test("W07-03 replacing a superseded or archived version is refused, not forked", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  const plan = shared.slice(shared.indexOf("export async function planVersion"));
  assert.match(plan, /if \(predecessor\.archivedAt\)/);
  assert.match(plan, /if \(!predecessor\.isCurrent\)/);
  assert.match(plan, /status: 409/, "a fork is a conflict, not a not-found and not an outage");
});

test("W07-03 only the capability path may replace a document", async () => {
  for (const path of [
    "app/api/files/route.ts",
    "app/api/files/multipart/route.ts",
  ]) {
    assert.match(
      codeOnly(await source(path)),
      /via !== "capability"/,
      `${path} lets a token holder supersede a document somebody else filed`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* 4. Source: the counters must not count versions                     */
/* ------------------------------------------------------------------ */

test("W07-03 x counters: only current, unarchived rows are counted", async () => {
  const code = codeOnly(await source("app/lib/attachment-counts.ts"));
  assert.match(
    code,
    /eq\(attachments\.isCurrent, true\)/,
    "the reconciler must exclude superseded versions or a 3-version certificate reads as 3 files",
  );
  assert.match(
    code,
    /isNull\(attachments\.archivedAt\)/,
    "an archived document must leave the counters exactly as a deleted one would",
  );
  const reconciler = code.slice(code.indexOf("export async function reconcileAttachmentCounts"));
  /*
   * Applied to ALL FOUR counters, not some. A predicate on the total but not on
   * the per-kind buckets would make them stop summing, which is precisely the
   * contradiction this module exists to end.
   */
  const uses = reconciler.match(/\$\{live\}/g) ?? [];
  assert.ok(
    uses.length >= 3,
    `the live predicate reaches only ${uses.length} of the reconciler's subqueries`,
  );
});

test("the live predicate is built with drizzle helpers, not a raw boolean literal", async () => {
  const code = codeOnly(await source("app/lib/attachment-counts.ts"));
  assert.doesNotMatch(
    code,
    /is_current\s*=\s*true/,
    "a literal cannot be rewritten by db/sqlite-to-postgres.ts and would break one of the two dialects",
  );
});

/* ------------------------------------------------------------------ */
/* 4b. Source: the invariant exists on BOTH backends                   */
/* ------------------------------------------------------------------ */

test("W07-03 the one-current-head invariant is created on D1, not only on Postgres", async () => {
  /*
   * The Workstream 7 Postgres migration created both indexes; `db/init.ts` — the
   * authority for the D1/SQLite schema — added the three columns and created
   * neither. So the invariant existed on one backend of two, and the one it was
   * missing from is what local development and every Cloudflare deployment run
   * on: three concurrent replaces of the same head all answered 201 and left
   * three rows at `is_current = 1`, and the file list showed one certificate
   * three times.
   */
  const init = await source("db/init.ts");
  assert.match(
    init,
    /CREATE UNIQUE INDEX IF NOT EXISTS attachments_current_version_idx/,
    "nothing stops a second current version on D1",
  );
  assert.match(
    init,
    /CREATE UNIQUE INDEX IF NOT EXISTS attachments_root_version_idx/,
    "nothing stops two rows claiming to be the same version of one document",
  );
  const from = init.indexOf("async function ensureDocumentVersionInvariant");
  const guard = init.slice(from, init.indexOf("\nasync function ", from + 1));
  assert.match(
    guard,
    /WHERE is_current = 1/,
    "the partial predicate must be `= 1`, not a bare column: `is_current` is INTEGER on D1 and boolean on Postgres, and db/sqlite-to-postgres.ts can only rewrite a comparison it can see",
  );
  assert.match(
    guard,
    /COALESCE\(root_document_id, id\)/,
    "version 1 is self-rooted, so the lineage key is the coalesce",
  );
});

test("W07-03 duplicate heads are repaired BEFORE the unique index is created", async () => {
  /*
   * A unique index cannot be built over data that already violates it, and this
   * file runs on the boot path of every request — so creating it first would
   * throw on every request and take the whole application down. That is the same
   * failure mode `addColumn` exists to prevent for ALTER.
   */
  const init = await source("db/init.ts");
  /*
   * Bounded to the function, not to the end of the file: `db/init.ts` is 2,500
   * lines of DDL and everything after this guard would otherwise be swept in,
   * which made the "no batch()" assertion below fail on somebody else's batch.
   */
  const from = init.indexOf("async function ensureDocumentVersionInvariant");
  const guard = init.slice(from, init.indexOf("\nasync function ", from + 1));
  assert.ok(guard.length > 500, "the version guard must be findable");
  const repair = guard.indexOf("UPDATE attachments SET is_current = 0");
  const create = guard.indexOf("CREATE UNIQUE INDEX");
  assert.ok(repair > 0, "there is no repair for a database that already raced");
  assert.ok(
    repair < create,
    "the index is created before the duplicates are repaired, which throws on every boot",
  );
  assert.match(
    guard,
    /ORDER BY version_no DESC, id DESC/,
    "the surviving head must be chosen deterministically, or a repair picks a different row on every boot",
  );
  /*
   * And neither statement may take the application down. `batch()` fails as a
   * unit, so one index that could not be created would discard the other.
   */
  assert.doesNotMatch(guard, /\.batch\(/, "the two indexes must not share a batch");
  const catches = guard.match(/catch \(error\)/g) ?? [];
  assert.ok(
    catches.length >= 2,
    "the repair and the index creation must each survive their own failure",
  );
});

test("the board's file cells count what the counters count", async () => {
  /*
   * The board's photo strip does NOT come from `/api/files`. It comes from
   * `/api/board`'s own scans of `attachments`, and versioning filtered the file
   * list and the counters and left those scans out — so a certificate replaced
   * twice drew three thumbnails while the counter beside it said one, and an
   * archived certificate stayed visible and openable on the board after it had
   * left every other screen.
   */
  const code = codeOnly(await source("app/api/board/route.ts"));
  const uses = code.match(/liveAttachmentRows\(\)/g) ?? [];
  assert.ok(
    uses.length >= 2,
    `only ${uses.length} of the board's file-cell scans apply the live-document rule`,
  );
  assert.match(
    code,
    /liveAttachmentRows,/,
    "the predicate must be imported, not restated — a fourth reader must not be able to disagree with the other three",
  );
});

test("the live-document rule has exactly ONE definition", async () => {
  const shared = codeOnly(await source("app/lib/attachment-counts.ts"));
  assert.match(shared, /export const liveAttachmentRows/);
  for (const path of ["app/api/files/documents.ts", "app/api/board/route.ts"]) {
    assert.doesNotMatch(
      codeOnly(await source(path)),
      /const liveAttachmentRows\s*=/,
      `${path} declares its own copy of the live-document rule`,
    );
  }
});

test("destroying a column still destroys EVERY version filed under it", async () => {
  /*
   * The one place the rule must NOT be applied. `deleteFilesForColumn` answers
   * "what must be destroyed when the column itself is destroyed", and the answer
   * is everything: filtering here would strand superseded and archived rows
   * pointing at a column that no longer exists, and their R2 objects would never
   * be deleted by anything — an invisible row and a permanent storage leak.
   */
  const code = await source("app/api/board/route.ts");
  const start = code.indexOf("async function deleteFilesForColumn");
  const fn = code.slice(start, start + 1800);
  assert.doesNotMatch(
    fn,
    /liveAttachmentRows\(\)/,
    "a column delete that skips superseded rows leaks both the rows and their bytes",
  );
  assert.match(
    code,
    /DELIBERATELY NOT FILTERED/,
    "the exception must say why, or the next person will 'fix' it",
  );
});

/* ------------------------------------------------------------------ */
/* 5. Source: W07-05 archive, and W07-11 filters                       */
/* ------------------------------------------------------------------ */

test("W07-05 archive is soft, reversible, and hidden from the default list", async () => {
  const patch = codeOnly(
    (await source("app/api/files/[id]/route.ts")).slice(
      (await source("app/api/files/[id]/route.ts")).indexOf("export async function PATCH("),
    ),
  );
  assert.match(patch, /values\.archivedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(patch, /values\.archivedBy = actor\.email/);
  assert.match(patch, /values\.archivedAt = null/, "restore must be possible");
  const list = codeOnly(await source("app/api/files/route.ts"));
  assert.match(list, /liveDocumentFilter\(\)/, "the default list must exclude archived rows");
});

test("W07-11 the list filters, paginates and reports a real total", async () => {
  const code = codeOnly(await source("app/api/files/route.ts"));
  for (const parameter of [
    "siteId",
    "unitId",
    "contractorId",
    "documentType",
    "expiryFrom",
    "expiryTo",
    "archived",
  ]) {
    assert.match(
      code,
      new RegExp(`search\\.get\\("${parameter}"\\)`),
      `the list does not accept ${parameter}`,
    );
  }
  assert.match(code, /search\.get\("q"\)/, "no free-text search");
  assert.match(code, /search\.get\("offset"\)/, "no offset — the 101st document is unreachable");
  assert.match(code, /search\.get\("page"\)/);
  assert.match(code, /\.offset\(offset\)/);
  assert.match(code, /COUNT\(\*\)/, "no server-side total, so the caller can only report the page size");
  assert.match(code, /pageCount:/);
});

test("W07-11 an expiry range never matches a document with no expiry", async () => {
  const code = codeOnly(await source("app/api/files/route.ts"));
  assert.match(
    code,
    /isNotNull\(attachments\.expiryDate\), gte\(attachments\.expiryDate, expiryFrom\)/,
    "'expiring soon' must not answer with undated certificates",
  );
  assert.match(
    code,
    /isNotNull\(attachments\.expiryDate\), lte\(attachments\.expiryDate, expiryTo\)/,
  );
});

/* ------------------------------------------------------------------ */
/* 6. Source: W07-12 audit                                             */
/* ------------------------------------------------------------------ */

const DOCUMENT_ACTIONS = [
  "document.uploaded",
  "document.version_added",
  "document.metadata_updated",
  "document.archived",
  "document.restored",
  "document.deleted",
];

test("W07-12 every document mutation writes the canonical audit stream", async () => {
  const files = [
    "app/api/files/route.ts",
    "app/api/files/multipart/route.ts",
    "app/api/files/[id]/route.ts",
  ];
  const all = (await Promise.all(files.map((path) => source(path)))).join("\n");
  for (const action of DOCUMENT_ACTIONS) {
    assert.match(all, new RegExp(`"${action}"`), `no route ever writes ${action}`);
  }
  for (const path of files) {
    const code = codeOnly(await source(path));
    assert.match(code, /recordAudit\(\{/, `${path} writes no audit event`);
    assert.match(
      code,
      /organisationId: orgId/,
      `${path} may be writing a NULL-organisation event, which is invisible to every non-super-admin reader`,
    );
    assert.match(code, /actor: auditActor\(/, `${path} does not record who did it`);
    assert.match(code, /request,/, `${path} does not pass the request, so ip and user-agent are lost`);
  }
});

test("W07-12 entityType is 'document' and only 'document'", async () => {
  /*
   * One value, or document history splits across two filter entries in the
   * viewer and neither is complete. `entityType` is filtered by exact equality.
   */
  for (const path of [
    "app/api/files/route.ts",
    "app/api/files/multipart/route.ts",
    "app/api/files/[id]/route.ts",
  ]) {
    const code = await source(path);
    const types = [...code.matchAll(/entityType:\s*"([^"]+)"/g)].map((m) => m[1]);
    const auditTypes = types.filter((value) => value !== "maintenance_request");
    assert.deepEqual(
      [...new Set(auditTypes)],
      ["document"],
      `${path} uses ${JSON.stringify([...new Set(auditTypes)])} for audit events`,
    );
  }
});

test("W07-12 the activity_log writes are ADDED to, never replaced", async () => {
  /*
   * The two stores answer different readers by design: activity_log is the job's
   * timeline for the people working it, audit_events is the system trail.
   */
  for (const path of [
    "app/api/files/route.ts",
    "app/api/files/multipart/route.ts",
    "app/api/files/[id]/route.ts",
  ]) {
    assert.match(
      codeOnly(await source(path)),
      /insert\(activityLog\)/,
      `${path} lost its activity_log write, so the job timeline stops recording documents`,
    );
  }
});

test("W07-12 the download path is NOT audited", async () => {
  const code = await source("app/api/files/[id]/route.ts");
  assert.doesNotMatch(
    code,
    /"document\.downloaded"/,
    "every board thumbnail resolves through GET, so auditing it would drown the table",
  );
  const get = code.slice(
    code.indexOf("export async function GET("),
    code.indexOf("export async function DELETE("),
  );
  assert.doesNotMatch(get, /recordAudit\(/, "the GET handler must write no audit event");
});

test("W07-12 a document with no job still leaves a trace when destroyed", async () => {
  const code = await source("app/api/files/[id]/route.ts");
  const del = code.slice(
    code.indexOf("export async function DELETE("),
    code.indexOf("export async function PATCH("),
  );
  const branch = del.indexOf("if (record.requestId)");
  const audit = del.indexOf("recordAudit({");
  assert.ok(branch > 0 && audit > 0);
  /*
   * The activity_log write is inside `if (record.requestId)` because it writes to
   * a JOB's timeline. The audit event must be OUTSIDE it, or an attachment with
   * no job is permanently destroyed with no record in either stream — and W07-07
   * makes jobless documents the common case for exactly the documents most worth
   * accounting for.
   */
  const closing = del.indexOf("\n  }", branch);
  assert.ok(
    audit > closing,
    "the audit event is nested inside the job branch, so a jobless document is destroyed silently",
  );
  assert.match(del, /permanent: true/);
});

test("a deleted document releases any compliance slot pointing at it", async () => {
  const shared = codeOnly(await source("app/api/files/documents.ts"));
  assert.match(shared, /export async function releaseComplianceLinks/);
  assert.match(
    shared,
    /set\(\{ attachmentId: null/,
    "the slot is nulled, not deleted — the store still needs the certificate, it just no longer holds one",
  );
  const del = codeOnly(await source("app/api/files/[id]/route.ts"));
  const release = del.indexOf("releaseComplianceLinks(");
  const drop = del.indexOf("db.delete(attachments)");
  assert.ok(release > 0, "nothing releases the compliance back-reference");
  assert.ok(
    release < drop,
    "release before the row goes, or a failure strands the pointer",
  );
});

/* ------------------------------------------------------------------ */
/* 7. Live                                                             */
/* ------------------------------------------------------------------ */

/**
 * A request, retried while the database says "busy".
 *
 * The dev server runs one Miniflare D1, and a 5xx from it is a LOCK, not an
 * answer: measured, `create_item` returned 503 five times and then 201 with no
 * change to the request. Every assertion below is about a route's DECISION —
 * 403 or 201, 404 or 400 — and a decision cannot be read off a reply that says
 * the workspace was too busy to make one. Without this the suite fails
 * intermittently and blames the code under test for contention with whatever
 * else is running.
 *
 * Bounded, and only on 5xx: a 4xx is an answer and is returned immediately, so
 * this can never turn a refusal into a pass by retrying until something else
 * happens.
 */
const BUSY_ATTEMPTS = 5;
async function sendRetrying(url, init) {
  let response;
  for (let attempt = 0; attempt < BUSY_ATTEMPTS; attempt += 1) {
    response = await fetch(url, init);
    if (response.status < 500) return response;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return response;
}

/**
 * Whether a dev server is answering, decided ONCE.
 *
 * Cached because every live test below asks, and the probe is not free: the
 * board endpoint assembles a whole board and took over four seconds on a cold
 * Miniflare, so a 4s timeout reported "no dev server" against a server that was
 * plainly running and skipped every live assertion in the file. A generous
 * timeout and one memoised answer, rather than a cheaper endpoint, because this
 * is the same reachability check the rest of the suite uses.
 */
let serverUp = null;
async function serverIsUp() {
  if (serverUp !== null) return serverUp;
  try {
    await fetch(`${BASE_URL}/api/board?compact=1`, {
      signal: AbortSignal.timeout(30000),
    });
    /*
     * ANY reply means the server is up, INCLUDING a 5xx.
     *
     * This used to require `status < 500`, and that is a different question: a
     * 503 from this endpoint is the local D1 saying it is busy, not the server
     * saying it is absent. Under load — several agents on one Miniflare — the
     * probe therefore reported "no dev server" and every live assertion in the
     * file skipped, silently, while the server was plainly answering. Only a
     * network error or the timeout below means nothing is there.
     *
     * Plain `fetch` rather than `sendRetrying`: retrying a 30-second probe five
     * times would spend two and a half minutes deciding something one reply
     * already settled.
     */
    serverUp = true;
  } catch {
    serverUp = false;
  }
  return serverUp;
}
function sessionTokenFrom(response) {
  const cookie = (response.headers.getSetCookie?.() ?? []).find((value) =>
    value.startsWith("maintsupp_session="),
  );
  return cookie ? cookie.slice("maintsupp_session=".length).split(";")[0] : null;
}
async function signInAsOwner() {
  const response = await sendRetrying(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  return sessionTokenFrom(response);
}
async function asOwner(session, path, init = {}) {
  const send = (token) =>
    sendRetrying(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Cookie: `maintsupp_session=${token}` },
    });
  let response = await send(session);
  if (response.status === 401) {
    const fresh = await signInAsOwner();
    if (fresh) response = await send(fresh);
  }
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
function upload(name, body, fields) {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "text/plain" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

const created = new Set();

test("live: a document can be edited, versioned and archived without losing anything", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const workspace = await asOwner(session, "/api/workspace");
  const contractor = (workspace.body.workspace?.contractors ?? [])[0];
  if (!contractor) {
    t.skip("no contractor to anchor a document to");
    return;
  }
  const anchor = { kind: "general", contractorId: contractor.id };

  /* W07-02 — created with its own identity. */
  const first = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-doc-v1.txt", "version one", {
      ...anchor,
      title: "W7OFF certificate",
      documentType: "W7OFF Type",
      expiryDate: "2027-01-01",
    }),
  });
  assert.equal(first.status, 201, JSON.stringify(first.body).slice(0, 200));
  const v1 = first.body.file;
  created.add(v1.id);
  assert.equal(v1.title, "W7OFF certificate");
  assert.equal(v1.expiryDate, "2027-01-01");

  /* W07-02 — an edit changes only what it names. */
  const edited = await asOwner(session, `/api/files/${v1.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "W7OFF renewed cover" }),
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body).slice(0, 200));
  assert.equal(edited.body.file.description, "W7OFF renewed cover");
  assert.equal(
    edited.body.file.title,
    "W7OFF certificate",
    "an omitted field must be unchanged, not blanked",
  );
  assert.equal(edited.body.file.expiryDate, "2027-01-01");
  assert.ok(edited.body.file.metadataUpdatedBy, "the editor must be recorded");

  const cleared = await asOwner(session, `/api/files/${v1.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: null }),
  });
  assert.equal(cleared.body.file.description, null, "explicit null must clear");

  for (const bad of ["31/02/2027", "2027-02-31", "tomorrow"]) {
    const refused = await asOwner(session, `/api/files/${v1.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiryDate: bad }),
    });
    assert.equal(
      refused.status,
      400,
      `"${bad}" must be a controlled 400, not a database error surfacing as a 503`,
    );
  }

  /* W07-03 — a replacement is a new version, and the old one survives. */
  const second = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-doc-v2.txt", "version two", {
      ...anchor,
      replaces: v1.id,
      expiryDate: "2028-01-01",
    }),
  });
  assert.equal(second.status, 201, JSON.stringify(second.body).slice(0, 200));
  const v2 = second.body.file;
  created.add(v2.id);
  assert.equal(v2.versionNo, 2);
  assert.equal(v2.rootDocumentId, v1.id, "version 1 is the lineage root");
  assert.equal(v2.isCurrent, true);
  assert.equal(
    v2.title,
    "W7OFF certificate",
    "a new version of a document is the same document — its title must carry forward",
  );
  assert.equal(v2.expiryDate, "2028-01-01", "a supplied field overrides the carried one");

  const oldBytes = await sendRetrying(`${BASE_URL}/api/files/${v1.id}?download=1`, {
    headers: { Cookie: `maintsupp_session=${session}` },
  });
  assert.equal(oldBytes.status, 200, "the superseded version's bytes must survive");
  assert.equal(await oldBytes.text(), "version one");

  /*
   * The default list shows ONE of these two, not both.
   *
   * Scoped to THIS lineage rather than to everything filed against the
   * contractor: a shared workspace may already hold other documents for them,
   * and asserting on the contractor's whole total makes this test fail for
   * somebody else's fixture while saying "a certificate replaced once is two
   * documents", which is a false accusation against working code. The claim
   * being made is about the pair, so the pair is what is counted.
   */
  const live = await asOwner(session, `/api/files?contractorId=${contractor.id}&limit=100`);
  const lineage = (live.body.files ?? []).filter(
    (file) => file.id === v1.id || file.id === v2.id,
  );
  assert.deepEqual(
    lineage.map((file) => file.id),
    [v2.id],
    "a certificate replaced once is one document, not two — this is what triples a photo strip and keeps a compliance slot 'Compliant' on a superseded certificate",
  );

  /* Its history is reachable, oldest first. */
  const history = await asOwner(session, `/api/files?versionsOf=${v1.id}`);
  assert.equal(history.body.total, 2);
  assert.deepEqual(
    history.body.files.map((file) => file.versionNo),
    [1, 2],
    "a version history reads in the order the versions happened",
  );

  const forked = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-doc-fork.txt", "x", { ...anchor, replaces: v1.id }),
  });
  assert.equal(forked.status, 409, "replacing a superseded version must be refused");

  /* W07-05 — archive hides it without destroying it. */
  const archived = await asOwner(session, `/api/files/${v2.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(archived.status, 200);
  assert.ok(archived.body.file.archivedAt);
  assert.ok(archived.body.file.archivedBy);

  const hidden = await asOwner(
    session,
    `/api/files?contractorId=${contractor.id}&limit=100`,
  );
  assert.ok(
    !(hidden.body.files ?? []).some((file) => file.id === v2.id),
    "an archived document must leave the register",
  );

  const found = await asOwner(
    session,
    `/api/files?contractorId=${contractor.id}&archived=true&limit=100`,
  );
  assert.ok(
    found.body.files.some((file) => file.id === v2.id),
    "the archive must still be reachable, or archiving is indistinguishable from deleting",
  );

  const restored = await asOwner(session, `/api/files/${v2.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  });
  assert.equal(restored.body.file.archivedAt, null);
  const stillThere = await sendRetrying(`${BASE_URL}/api/files/${v2.id}?download=1`, {
    headers: { Cookie: `maintsupp_session=${session}` },
  });
  assert.equal(await stillThere.text(), "version two", "archiving must never touch bytes");
});

test("live: the list paginates and tells the truth about how many there are", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  /*
   * PAGES OVER ITS OWN TWO DOCUMENTS, not over the workspace.
   *
   * This used to read the unfiltered list, which every other live test in this
   * suite is concurrently adding to and deleting from — `node --test` runs files
   * in parallel — so page 2 could shift under it between the two requests and
   * return the row page 1 had already given. That is a race in the test, and it
   * reports as "an offset must actually move", which is a false accusation
   * against working pagination. Filtering to a contractor this test populates
   * makes the set it pages over one nothing else touches.
   */
  const workspace = await asOwner(session, "/api/workspace");
  const contractor = (workspace.body.workspace?.contractors ?? []).at(-1);
  if (!contractor) {
    t.skip("no contractor to file paging fixtures against");
    return;
  }
  const scope = `contractorId=${contractor.id}`;
  for (const name of ["W7OFF-page-a.txt", "W7OFF-page-b.txt"]) {
    const made = await asOwner(session, "/api/files", {
      method: "POST",
      body: upload(name, name, { kind: "general", contractorId: contractor.id }),
    });
    assert.equal(made.status, 201, JSON.stringify(made.body).slice(0, 160));
    created.add(made.body.file.id);
  }

  const first = await asOwner(session, `/api/files?${scope}&limit=1&offset=0`);
  const second = await asOwner(session, `/api/files?${scope}&limit=1&offset=1`);
  assert.equal(first.body.files.length, 1);
  assert.equal(second.body.files.length, 1);
  assert.notEqual(
    first.body.files[0].id,
    second.body.files[0].id,
    "an offset must actually move — without one the 101st document is unreachable",
  );
  assert.equal(
    first.body.total,
    second.body.total,
    "the total is the total, not the page size",
  );
  assert.ok(
    first.body.total >= 2 && first.body.total > first.body.files.length,
    `the total must exceed the page: total=${first.body.total}, page=${first.body.files.length}`,
  );
  assert.equal(first.body.pageCount, first.body.total, "one row per page");
});

test("live: the audit viewer can answer for a document", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  /*
   * `action=document` without a dot matches the whole family — that is the
   * viewer's own rule, and it is why one consistent prefix matters.
   */
  const audit = await asOwner(session, "/api/audit?action=document&pageSize=100");
  assert.equal(audit.status, 200);
  if (!audit.body.total) {
    t.skip("no document events recorded yet on this database");
    return;
  }
  const events = audit.body.events ?? [];
  assert.ok(
    events.every((event) => event.entityType === "document"),
    `document history split across ${JSON.stringify([...new Set(events.map((e) => e.entityType))])}`,
  );
  assert.ok(
    events.every((event) => event.organisationId),
    "a NULL-organisation event is invisible to every reader who is not a super admin",
  );
  assert.ok(events.every((event) => event.actorEmail), "every event must name an actor");
  assert.ok(events.every((event) => event.summary), "every event must have a readable summary");
  const actions = new Set(events.map((event) => event.action));
  assert.ok(
    actions.has("document.uploaded"),
    `the upload verb is missing: ${JSON.stringify([...actions])}`,
  );
  assert.ok(
    !actions.has("document.downloaded"),
    "the download path must not be audited — every thumbnail resolves through it",
  );
});

/**
 * Removes a board row this file created, bin entry and all.
 *
 * `delete_items` is a soft delete and can fail with a 503 that is not
 * contention: job ids are minted from a count of LIVE rows, so a fresh row can
 * be handed an id the recycle bin is still holding from an older fixture, and
 * binning it then violates `recycle_bin_entity_idx`. When that happens the stale
 * entry is purged instead, which removes the row either way.
 */
async function removeBoardRow(session, id) {
  const binned = await asOwner(session, "/api/board?board=store-documentation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete_items", requestIds: [id] }),
  });
  const trash = await asOwner(session, "/api/trash");
  const entry = (trash.body.bin?.entries ?? []).find((row) => row.entityId === id);
  if (entry) {
    await asOwner(session, `/api/trash?id=${entry.id}`, { method: "DELETE" });
  } else if (binned.status !== 200) {
    console.error(`[test] could not remove board row ${id} (${binned.status})`);
  }
}

test("live: a replaced and an archived certificate read correctly ON THE BOARD", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const board = await asOwner(session, "/api/board?board=store-documentation");
  const column = (board.body.columns ?? []).find(
    (item) => item.type === "files" && (item.columnKey ?? item.key) === "rams",
  );
  const group = (board.body.groups ?? []).find(
    (row) => row.boardId === "store-documentation",
  );
  if (!column || !group) {
    t.skip("the Store Documentation board has no RAMS column or no group");
    return;
  }
  const made = await asOwner(session, "/api/board?board=store-documentation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create_item", groupId: group.id }),
  });
  const row = made.body.request;
  if (!row) {
    t.skip(`could not create a Store Documentation row (${made.status})`);
    return;
  }

  /** The cell's own count and preview, read the way the board serves them. */
  const cell = async () => {
    const current = await asOwner(session, "/api/board?board=store-documentation");
    const entry = Object.values(current.body.fileCounts ?? {}).find(
      (item) => item && item.requestId === row.id && item.columnId === column.id,
    );
    return { count: entry ? entry.count : 0, preview: entry?.preview ?? [] };
  };

  const versions = [];
  const names = ["W7OFF-cell-v1.txt", "W7OFF-cell-v2.txt", "W7OFF-cell-v3.txt"];
  for (const [index, name] of names.entries()) {
    const uploaded = await asOwner(session, "/api/files", {
      method: "POST",
      body: upload(name, name, {
        requestId: row.id,
        kind: "general",
        columnId: column.id,
        ...(index === 0
          ? { title: "W7OFF board cert" }
          : { replaces: versions[index - 1] }),
      }),
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body).slice(0, 200));
    versions.push(uploaded.body.file.id);
    created.add(uploaded.body.file.id);
  }

  /*
   * THREE VERSIONS, ONE CERTIFICATE. Measured before the fix, on MN-1050: the
   * cell went 1, 2, 3 while the counter beside it stayed at 1 — so the number on
   * the cell and the number behind it disagreed, which is the exact promise
   * `/api/board`'s own docblock records having made.
   */
  const replaced = await cell();
  assert.equal(
    replaced.count,
    1,
    "a certificate replaced twice is ONE document — the cell must not triple",
  );
  assert.equal(
    replaced.preview.length,
    1,
    "and the preview must not draw the superseded versions as extra thumbnails",
  );
  const listed = await asOwner(
    session,
    `/api/files?requestId=${row.id}&columnId=${encodeURIComponent(column.id)}`,
  );
  assert.equal(listed.body.total, 1, "/api/files must agree with the cell");
  const withCounts = await asOwner(session, "/api/board?board=store-documentation");
  const counted = (withCounts.body.requests ?? []).find((item) => item.id === row.id);
  assert.equal(
    counted?.attachmentCount,
    1,
    "the counter and the cell must be the same number, which is the whole point",
  );

  /* ARCHIVING must remove it from the BOARD, not merely from /api/files. */
  const archived = await asOwner(session, `/api/files/${versions[2]}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(archived.status, 200);
  const empty = await cell();
  assert.equal(
    empty.count,
    0,
    "an archived certificate must leave the board cell, not stay visible and openable on it",
  );
  assert.equal(empty.preview.length, 0);
  const afterArchive = await asOwner(session, "/api/board?board=store-documentation");
  const recounted = (afterArchive.body.requests ?? []).find((item) => item.id === row.id);
  assert.equal(recounted?.attachmentCount, 0, "the counter must agree again");

  await removeBoardRow(session, row.id);
});

test("live: concurrent replaces of one head produce exactly one winner", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in as the seeded owner");
    return;
  }
  const workspace = await asOwner(session, "/api/workspace");
  const contractor = (workspace.body.workspace?.contractors ?? [])[0];
  if (!contractor) {
    t.skip("no contractor to anchor the race fixture to");
    return;
  }

  const first = await asOwner(session, "/api/files", {
    method: "POST",
    body: upload("W7OFF-race-head.txt", "head", {
      kind: "general",
      contractorId: contractor.id,
      title: "W7OFF race",
    }),
  });
  assert.equal(first.status, 201, JSON.stringify(first.body).slice(0, 200));
  const head = first.body.file.id;
  created.add(head);

  /*
   * THE RACE. `standDownPredecessor` and the insert are two statements with no
   * transaction around them, so nothing in the CODE makes them atomic. What
   * makes exactly one of these win is the DATABASE: a unique index over
   * (organisation, lineage) WHERE is_current permits one head, so the losers are
   * refused. Before that index existed on D1, all three answered 201 and the
   * lineage ended with three heads.
   *
   * A loser may be refused as 409 (its read already saw the predecessor stood
   * down) or as 503 (its insert hit the index). Both are correct refusals; what
   * must never happen is two winners. Sent with plain `fetch` rather than the
   * retrying helper on purpose — retrying a deliberate race would defeat it.
   */
  const racers = await Promise.all(
    [1, 2, 3].map((n) =>
      fetch(`${BASE_URL}/api/files`, {
        method: "POST",
        headers: { Cookie: `maintsupp_session=${session}` },
        body: upload(`W7OFF-race-${n}.txt`, `race ${n}`, {
          kind: "general",
          contractorId: contractor.id,
          replaces: head,
        }),
      }).then(async (response) => ({
        status: response.status,
        body: await response.json().catch(() => ({})),
      })),
    ),
  );
  for (const racer of racers) {
    if (racer.body.file?.id) created.add(racer.body.file.id);
  }
  const winners = racers.filter((racer) => racer.status === 201);
  assert.equal(
    winners.length,
    1,
    `expected exactly one winner, got ${winners.length}: ${JSON.stringify(racers.map((r) => r.status))}`,
  );

  const history = await asOwner(session, `/api/files?versionsOf=${head}&limit=100`);
  const heads = (history.body.files ?? []).filter((file) => file.isCurrent);
  assert.equal(
    heads.length,
    1,
    `the lineage must have ONE current version, found ${heads.length}`,
  );
  const numbers = (history.body.files ?? []).map((file) => file.versionNo);
  assert.equal(
    new Set(numbers).size,
    numbers.length,
    `two rows claim the same version number: ${JSON.stringify(numbers)}`,
  );
});

test("teardown: every document this file created is removed", async (t) => {
  if (!created.size) return;
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const session = await signInAsOwner();
  if (!session) {
    t.skip("could not sign in to clean up");
    return;
  }
  for (const id of created) {
    await asOwner(session, `/api/files/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  /*
   * Scoped to the ids THIS file created, not to every W7OFF-named document in
   * the workspace. A shared prefix is how residue is found by hand; asserting on
   * it here would make this teardown fail because a sibling suite, or an
   * abandoned manual probe, left something behind — a true statement about the
   * database and a false one about this file, reported against the wrong code.
   */
  const remaining = await asOwner(session, "/api/files?q=W7OFF&limit=100&archived=all");
  const mine = (remaining.body.files ?? []).filter((file) => created.has(file.id));
  assert.deepEqual(
    mine.map((file) => file.originalName),
    [],
    "this file left QA residue behind",
  );
});
