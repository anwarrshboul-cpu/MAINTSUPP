/**
 * WORKSTREAM 7, official checklist — the document register's data and filters.
 *
 * W07-10  the register displays status, expiry, owner and site
 * W07-11  structured filters compose with the search, and the totals and the
 *         export honour the filtered set
 * W07-13  removing a document updates the connected views
 *
 * WHAT WAS WRONG, AND WHY THESE ARE THE ASSERTIONS.
 *
 * The register drew a Status column fed by a constant. `loadDocuments` in
 * portal-app.tsx wrote `status: "Current"` into every row it built from
 * `/api/files`, so all thirty-seven rows on a local workspace read "Current",
 * the distinct set of that column was exactly `["Current"]`, and the "Require
 * attention" tile — which counted `status === "Expiring soon"` — was pinned to
 * zero by construction. `FileRecord.status` was a three-word literal union
 * whose other two members were reachable only from `mock-data.ts`.
 *
 * `uploadedByEmail` was served by the API all along and dropped by the client.
 * `site` was guessed by matching the attachment's job and reading that job's
 * free-text `location` with a `?? "Shared workspace"` fallback — and `??` is
 * nullish coalescing, so a job with an empty location produced a BLANK cell,
 * measured on six of thirty-seven rows. Expiry did not exist at all.
 *
 * The filters did not exist either: `.workspace-toolbar` held a search box and
 * a view toggle and nothing else. And the tiles counted the pre-search set
 * while the table and the CSV used the post-search one, so searching took the
 * table from 37 rows to 2 while every tile carried on saying 37.
 *
 * The model is exercised as CODE rather than matched as text: `documentStatus`
 * decides what a compliance register claims about a certificate, and a regex
 * over the source cannot tell whether it decides correctly.
 *
 * Reads normalise CRLF first — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const asModule = (js) =>
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

/*
 * The register's model imports the SHARED expiry classifier, which is the whole
 * point of it, so the import chain is transpiled with it rather than stubbed.
 * A stub would let this suite pass while the register and the Compliance
 * Tracker disagreed about the same certificate — the exact failure the shared
 * classifier exists to prevent.
 */
const formatDateUrl = asModule(transpile(await read("app/lib/format-date.ts")));
const expiryUrl = asModule(
  transpile(
    (await read("app/lib/expiry-status.ts")).replace(
      /from "\.\/format-date"/,
      `from "${formatDateUrl}"`,
    ),
  ),
);
const register = await import(
  asModule(
    transpile(
      (await read("app/(app)/portal/views/document-register.ts")).replace(
        /from "\.\.\/\.\.\/\.\.\/lib\/expiry-status"/,
        `from "${expiryUrl}"`,
      ),
    ),
  )
);

const TODAY = new Date("2026-09-01T12:00:00.000Z");
const doc = (over = {}) => ({
  id: "a",
  name: "EICR.pdf",
  title: null,
  kind: "Workspace document",
  documentType: null,
  description: null,
  site: "Aldgate",
  siteId: "site-1",
  requestId: null,
  uploadedAt: "2026-08-01",
  uploadedByEmail: "owner@maintsupp.com",
  size: "1 KB",
  expiryDate: null,
  archivedAt: null,
  archivedBy: null,
  rootDocumentId: "a",
  versionNo: 1,
  isCurrent: true,
  ...over,
});

/* ── W07-10 ───────────────────────────────────────────────────────────────── */

test("W07-10: status is derived from the expiry date, never stored", async () => {
  const types = await read("app/lib/types.ts");
  /*
   * Comments stripped before matching. The interface's own docblock explains
   * what the union WAS and quotes it, which is exactly the kind of prose an
   * assertion about declarations must not read — the note is the record of the
   * fix, not a relapse.
   */
  const record = types
    .slice(
      types.indexOf("export interface FileRecord {"),
      types.indexOf("}", types.indexOf("export interface FileRecord {")),
    )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  // The literal union is gone, and so is any other stored status field.
  assert.doesNotMatch(
    record,
    /"Current"\s*\|\s*"Expiring soon"/,
    "the three-word literal union is what made the column a constant",
  );
  assert.doesNotMatch(
    record,
    /^\s*status[?]?:/m,
    "a document's status is a function of its expiry and archive state",
  );

  // And the loader no longer writes one.
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const mapping = portal.slice(
    portal.indexOf("const liveFiles: FileRecord[] = payload.files.map"),
    portal.indexOf("setDocuments(liveFiles)"),
  );
  assert.ok(mapping.length > 0, "loadDocuments mapping not found");
  assert.doesNotMatch(
    mapping,
    /status:\s*"Current"/,
    "this literal is the fabrication the whole criterion is about",
  );
});

test("W07-10: the four required fields reach the record and the row", async () => {
  const types = await read("app/lib/types.ts");
  const record = types.slice(
    types.indexOf("export interface FileRecord {"),
    types.indexOf("}", types.indexOf("export interface FileRecord {")),
  );
  for (const field of ["expiryDate", "uploadedByEmail", "siteId", "archivedAt"]) {
    assert.match(record, new RegExp(`\\b${field}:`), `FileRecord must carry ${field}`);
  }

  const portal = await read("app/(app)/portal/portal-app.tsx");
  const mapping = portal.slice(
    portal.indexOf("const liveFiles: FileRecord[] = payload.files.map"),
    portal.indexOf("setDocuments(liveFiles)"),
  );
  // `uploadedByEmail` was served from the first commit and never read.
  assert.match(mapping, /uploadedByEmail: file\.uploadedByEmail/);
  assert.match(mapping, /expiryDate: file\.expiryDate/);
  assert.match(mapping, /siteId: file\.siteId/);

  // The table shows all four. Owner and Expiry are new columns; Site and
  // Status were there and were unreliable.
  const view = portal.slice(
    portal.indexOf("function DocumentsView({"),
    portal.indexOf("function WhatsAppGlyph("),
  );
  assert.ok(view.length > 0, "DocumentsView not found");
  for (const header of ["<th>Owner</th>", "<th>Expiry</th>", "<th>Site</th>", "<th>Status</th>"]) {
    assert.ok(view.includes(header), `the register must show ${header}`);
  }
});

test("W07-10: the verdict is the shared classifier's, and archived outranks it", () => {
  const { documentStatus } = register;

  // Expired, due-soon and valid all come from expiry-status.ts's own windows.
  assert.equal(documentStatus(doc({ expiryDate: "2026-08-01" }), TODAY).state, "expired");
  assert.equal(documentStatus(doc({ expiryDate: "2026-10-01" }), TODAY).state, "due-soon");
  assert.equal(documentStatus(doc({ expiryDate: "2028-01-01" }), TODAY).state, "valid");

  /*
   * An archived certificate that is ALSO out of date is archived. Reporting it
   * as "Expired" would put a document that was deliberately withdrawn back into
   * the compliance count it was removed from.
   */
  const withdrawn = doc({ expiryDate: "2026-08-01", archivedAt: "2026-08-20" });
  assert.equal(documentStatus(withdrawn, TODAY).state, "archived");
  assert.equal(documentStatus(withdrawn, TODAY).label, "Archived");
});

test("W07-10: a document with no expiry says so, and is not called compliant", () => {
  const { documentStatus, documentStateClass } = register;
  const photo = documentStatus(doc({ expiryDate: null }), TODAY);

  assert.equal(photo.state, "not-recorded");
  assert.equal(photo.date, null, "there is no date, so none may be reported");
  assert.equal(photo.daysRemaining, null);
  // Not "Valid", not "Current" — most rows here are photographs that cannot
  // expire, and a green chip on one claims a compliance check nobody made.
  assert.equal(photo.label, "No expiry set");
  assert.notEqual(documentStateClass(photo.state), documentStateClass("valid"));
});

test("W07-10: a blank site is named, not left empty", () => {
  const { documentSiteLabel } = register;
  // The `??` bug: an empty-string location slipped past the fallback and drew
  // an empty cell on six of thirty-seven rows.
  assert.equal(documentSiteLabel({ site: "", siteId: null }), "Not linked to a site");
  assert.equal(documentSiteLabel({ site: "   ", siteId: null }), "Not linked to a site");
  assert.equal(documentSiteLabel({ site: "Aldgate", siteId: "s1" }), "Aldgate");
});

test("W07-10: the site name is resolved after the job list lands, not at fetch time", async () => {
  /*
   * Baking the site name in during `loadDocuments` was a race: that request and
   * the one that loads the jobs are in flight together, and the lookup never
   * ran again because the effect had `[]` deps. Whichever request lost gave
   * every document the fallback label permanently.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /const documentsWithSites = useMemo/);
  const memo = portal.slice(
    portal.indexOf("const documentsWithSites = useMemo"),
    portal.indexOf("}, [documents, requests, workspace]);"),
  );
  assert.ok(memo.length > 0, "the memo must depend on documents, requests and workspace");
  assert.match(memo, /nameOf\(file\.siteId\)/, "the site id is the authoritative key");
  assert.match(
    memo,
    /job\?\.location\?\.trim\(\)/,
    "the job's location is a fallback and must be checked for content, not for null",
  );
  assert.match(portal, /files=\{documentsWithSites\}/);
});

/* ── W07-11 ───────────────────────────────────────────────────────────────── */

test("W07-11: five structured filters exist, labelled, over the real fields", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const view = portal.slice(
    portal.indexOf("function DocumentsView({"),
    portal.indexOf("function WhatsAppGlyph("),
  );
  for (const id of [
    "document-type-filter",
    "document-status-filter",
    "document-expiry-filter",
    "document-site-filter",
    "document-owner-filter",
  ]) {
    assert.match(view, new RegExp(`id="${id}"`), `${id} must exist`);
    // Every select needs a name a screen reader can read.
    assert.match(
      view,
      new RegExp(`htmlFor="${id}" className="visually-hidden"`),
      `${id} must be labelled`,
    );
  }
});

test("W07-11: filter options are derived from the rows, never declared", () => {
  const { documentFilterOptions } = register;
  const options = documentFilterOptions(
    [
      doc({ id: "1", documentType: "PAT", site: "Aldgate", uploadedByEmail: "a@x" }),
      doc({ id: "2", documentType: "EICR", site: "Bluewater", uploadedByEmail: "b@x" }),
      doc({ id: "3", documentType: "PAT", site: "Aldgate", uploadedByEmail: "a@x" }),
    ],
    TODAY,
  );
  assert.deepEqual(options.documentTypes, ["EICR", "PAT"]);
  assert.deepEqual(options.sites, ["Aldgate", "Bluewater"]);
  assert.deepEqual(options.owners, ["a@x", "b@x"]);

  /*
   * The whole point. A filter that offers a value the workspace does not hold
   * answers an empty register, and the reader cannot tell that from a broken
   * one. None of these rows has an expiry, so only the "no expiry" bucket is
   * offered — not all four.
   */
  assert.deepEqual(
    options.expiry.map((bucket) => bucket.value),
    ["none"],
  );
  assert.deepEqual(
    options.statuses.map((entry) => entry.value),
    ["not-recorded"],
  );
});

test("W07-11: the due-soon window is printed from the constant that decides it", async () => {
  const expiry = await import(expiryUrl);
  const { EXPIRY_FILTERS } = register;
  const bucket = EXPIRY_FILTERS.find((entry) => entry.value === "due-soon");
  // Not 30, not a second copy of 60 — the label is built from the constant.
  assert.equal(bucket.label, `Due within ${expiry.EXPIRY_DUE_SOON_DAYS} days`);
});

test("W07-11: the filters AND together and compose with the search", () => {
  const { matchesDocumentFilters, matchesDocumentSearch, emptyDocumentFilters } = register;
  const row = doc({
    documentType: "PAT",
    site: "Aldgate",
    uploadedByEmail: "a@x",
    expiryDate: "2028-01-01",
  });

  assert.equal(matchesDocumentFilters(row, emptyDocumentFilters, TODAY), true);
  assert.equal(
    matchesDocumentFilters(row, { ...emptyDocumentFilters, documentType: "PAT" }, TODAY),
    true,
  );
  // Each filter narrows what the last left: one mismatch is enough to exclude.
  assert.equal(
    matchesDocumentFilters(
      row,
      { ...emptyDocumentFilters, documentType: "PAT", site: "Bluewater" },
      TODAY,
    ),
    false,
  );
  assert.equal(
    matchesDocumentFilters(row, { ...emptyDocumentFilters, expiry: "expired" }, TODAY),
    false,
  );
  assert.equal(
    matchesDocumentFilters(row, { ...emptyDocumentFilters, expiry: "valid" }, TODAY),
    true,
  );

  // The search is a separate stage, over the fields a person would type.
  assert.equal(matchesDocumentSearch(row, ""), true);
  assert.equal(matchesDocumentSearch(row, "aldgate"), true);
  assert.equal(matchesDocumentSearch(row, "a@x"), true, "the owner is searchable");
  assert.equal(matchesDocumentSearch(row, "PAT"), true, "the type is searchable");
  assert.equal(matchesDocumentSearch(doc({ title: "Kitchen EICR" }), "kitchen"), true);
  assert.equal(matchesDocumentSearch(row, "nothing-like-this"), false);
});

test("W07-11: the totals and the export read the filtered set, not the range", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const view = portal.slice(
    portal.indexOf("function DocumentsView({"),
    portal.indexOf("function WhatsAppGlyph("),
  );

  /*
   * One chain: range -> CURRENT VERSION -> archive gate -> the five selects ->
   * the search, and nothing below it reads a halfway stage.
   *
   * The archive gate is a stage rather than a sixth filter because "archived"
   * means withdrawn: those rows are fetched (so archiving can be undone) but
   * are out of the register, and out of the tiles, until somebody selects
   * "Archived" in the Status filter.
   *
   * The current-version stage is here for the same reason and was added after
   * this test first shipped. The loader asks for `archived=all`, and that
   * switch drops BOTH halves of the server's live predicate — `is_current` as
   * well as `archived_at`. So without this stage every superseded version
   * returned as a row of its own and a certificate replaced twice was three
   * documents in the table and three in the tiles: measured 38 rows against 35
   * live documents. It sits BEFORE the archive gate because a superseded version
   * is not something the archive view should offer to restore either.
   */
  assert.match(view, /const current = inRange\.filter\(\(file\) => file\.isCurrent !== false\)/);
  assert.match(view, /const visible = showingArchive\s*\n?\s*\? current\s*\n?\s*: current\.filter\(\(file\) => !file\.archivedAt\)/);
  assert.match(view, /const matching = visible\.filter/);
  assert.match(view, /const filtered = matching\.filter/);

  /*
   * The measured defect: the tiles counted `inRange` while the table and CSV
   * used `filtered`, so searching took the table from 37 rows to 2 with every
   * tile still saying 37.
   */
  const tiles = view.slice(
    view.indexOf('<section className="document-stat-grid">'),
    view.indexOf('<section className="panel documents-panel">'),
  );
  assert.ok(tiles.length > 0, "the stat grid was not found");
  assert.doesNotMatch(tiles, /\binRange\b/, "a tile above a filtered table must count the filtered set");
  assert.match(tiles, /\{filtered\.length\}/);
  assert.match(tiles, /filtered\.filter\(/);

  // The export takes the same set, and the same clock the chips were drawn with.
  assert.match(view, /downloadFileRegister\(filtered, today\)/);
});

test("W07-11: the export carries the new fields and still leaks no storage urls", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const columns = portal.slice(
    portal.indexOf("const columns: (keyof FileRecord)[] = ["),
    portal.indexOf("];", portal.indexOf("const columns: (keyof FileRecord)[] = [")),
  );
  assert.ok(columns.length > 0, "the export column list was not found");
  for (const field of ["expiryDate", "uploadedByEmail", "siteId", "title", "documentType"]) {
    assert.ok(columns.includes(field), `${field} is on screen and must be exported`);
  }
  // `inlineUrl` is the capability for the bytes; it must never reach a CSV.
  for (const field of ["inlineUrl", "downloadUrl", "contentType"]) {
    assert.ok(!columns.includes(field), `${field} must not be exported to CSV`);
  }
  // Status is derived, so it is appended rather than read off the record — and
  // it must be the same function the chips use.
  const exporter = portal.slice(
    portal.indexOf("function downloadFileRegister("),
    portal.indexOf("export default function PortalApp("),
  );
  assert.match(exporter, /documentStatus\(file, now\)\.label/);
});

test("W07-11: an empty register says WHICH constraint emptied it", () => {
  const { emptyRegisterReason, emptyDocumentFilters } = register;
  const base = {
    windowRecognised: true,
    windowReason: "",
    windowLabel: "Last 12 months",
    inRangeCount: 10,
    afterFiltersCount: 10,
    filters: emptyDocumentFilters,
    query: "widget",
  };

  // The range, a filter and the search are fixed by three different controls,
  // so naming the wrong one sends somebody to the wrong place.
  assert.match(
    emptyRegisterReason({ ...base, inRangeCount: 0 }),
    /No documents were uploaded in Last 12 months\./,
  );
  assert.match(
    emptyRegisterReason({
      ...base,
      afterFiltersCount: 0,
      filters: { ...emptyDocumentFilters, site: "Aldgate" },
    }),
    /matches the filter\. Clear a filter/,
  );
  assert.match(
    emptyRegisterReason({
      ...base,
      afterFiltersCount: 0,
      filters: { ...emptyDocumentFilters, site: "Aldgate", status: "valid" },
    }),
    /matches all 2 filters/,
  );
  assert.match(emptyRegisterReason(base), /matches "widget"/);
  // An unrecognised window explains itself rather than claiming an empty estate.
  assert.equal(
    emptyRegisterReason({ ...base, windowRecognised: false, windowReason: "half-typed range" }),
    "half-typed range",
  );
});

/* ── W07-13 ───────────────────────────────────────────────────────────────── */

test("W07-13: the register can be reloaded, and is, after a document changes", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");

  /*
   * This was a `useEffect` with `[]` deps and no way to run again, so deleting
   * a file from the board's evidence strip left it listed here — with a live
   * `inlineUrl` — and counted in both tiles until a full page reload.
   */
  assert.match(portal, /const loadDocuments = useCallback\(async \(\) => \{/);
  assert.match(
    portal,
    /window\.addEventListener\("maintsupp:refresh-board", loadDocuments\)/,
    "the event every other file surface already dispatches",
  );
  assert.match(
    portal,
    /window\.removeEventListener\("maintsupp:refresh-board", loadDocuments\)/,
  );
  assert.match(portal, /onChanged=\{\(\) => void loadDocuments\(\)\}/);

  // And the drawer's own verbs tell the rest of the app, not just this list.
  const drawer = portal.slice(
    portal.indexOf("function FileDetailDrawer("),
    portal.indexOf("interface CreateRequestDraft"),
  );
  const notifications = drawer.match(
    /window\.dispatchEvent\(new Event\("maintsupp:refresh-board"\)\)/g,
  );
  assert.ok(
    notifications && notifications.length >= 4,
    `edit, new version, archive and delete must each announce the change; found ${
      notifications?.length ?? 0
    }`,
  );
});
