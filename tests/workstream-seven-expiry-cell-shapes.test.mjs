/**
 * Workstream 7 — a monday expiry cell arrives in two shapes and both are dates.
 *
 * WHAT WAS WRONG
 *
 * monday writes a date column either as the bare `2026-08-29` or as the JSON
 * object `{"date":"2026-08-29","time":"","icon":""}`. On the imported Store
 * Documentation board the JSON shape is the MAJORITY — four of five expiry
 * cells on the staging copy. The server register normalised it
 * (`store-documentation-register.ts` runs every expiry through
 * `dateOnlyValue(...) || null`); the client model did not, and handed the raw
 * string to two readers that fail differently and silently:
 *
 *   - The Compliance Tracker's STATUS stayed right, which is exactly why this
 *     hid for so long: `readVerdict` goes through `expiryStatus`, which calls
 *     `dateOnlyValue` itself. But `daysUntil` does `new Date(raw)` on the JSON
 *     string, gets Invalid Date, and returns null. So the cell printed no date
 *     and no "12 days overdue", and `worstDays` — the tie-break that decides
 *     which store is in the most trouble — silently skipped the row.
 *   - The renewal Calendar dropped the entry ALTOGETHER. `parseIsoDay` anchors
 *     `^(\d{4})-(\d{2})-(\d{2})`, a JSON string does not match, and
 *     `buildEntries` does `continue`. That is the same symptom the calendar's
 *     own file header records — an empty month with the data sitting unread in
 *     the payload — arriving a second time from a different cause. This file
 *     exists so there is not a third.
 *
 * WHAT IS ASSERTED
 *
 * The two shapes must be INDISTINGUISHABLE downstream. Every assertion below
 * builds the same store twice, once from each shape, and requires the two to
 * agree — rather than checking one shape against a hardcoded expectation,
 * which is a check that passes the day somebody normalises both to the wrong
 * thing.
 *
 * The shipped modules are called for real, transpiled and imported the way
 * `workstream-four-calendar-model.test.mjs` does it, because a
 * re-implementation of the join would agree with itself while the screen was
 * still wrong. The calendar's own `ISO_DATE` is READ OUT OF THE SHIPPED FILE
 * and applied here, so this test is coupled to the regex the calendar actually
 * uses rather than to a copy of it that could drift.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

/*
 * A data: URL cannot resolve a relative specifier, so each runtime dependency
 * becomes its own data: URL and is substituted into its importer. The model has
 * exactly two runtime imports — the board spec and `dateOnlyValue`; everything
 * else it names is `import type` and is erased.
 */
const formatDateUrl = asModule(transpile(await read("app/lib/format-date.ts")));

const expiryUrl = asModule(
  transpile(await read("app/lib/expiry-status.ts")).replace(
    /from ["']\.\/format-date["']/g,
    `from "${formatDateUrl}"`,
  ),
);

const specUrl = asModule(transpile(await read("db/monday-board-spec.ts")));

const MODEL = "app/(app)/portal/views/store-documentation-model.ts";
const modelSource = await read(MODEL);

const model = await import(
  asModule(
    transpile(modelSource)
      .replace(/from ["']\.\.\/\.\.\/\.\.\/\.\.\/db\/monday-board-spec["']/g, `from "${specUrl}"`)
      .replace(/from ["']\.\.\/\.\.\/\.\.\/lib\/expiry-status["']/g, `from "${expiryUrl}"`),
  )
);

const spec = await import(specUrl);

/* ── The payload ─────────────────────────────────────────────────────────── */

/*
 * Column ids are per-organisation seeds — `seed-<org>-store-documentation-<key>`
 * — and `cells` is keyed by id, never by key. Building the fixture that way
 * round is deliberate: a model that read `cells` by KEY would find nothing on
 * the real board, and would pass a fixture that keyed them by key.
 */
const columnId = (key) => `seed-org_000000000000000000000001-store-documentation-${key}`;

const COLUMNS = [
  "name",
  "storeAddress",
  ...new Set(
    spec.storeDocumentationCertificates.flatMap((slot) =>
      slot.expiryColumn ? [slot.fileColumn, slot.expiryColumn] : [slot.fileColumn],
    ),
  ),
].map((key) => ({ id: columnId(key), key }));

const GROUPS = [
  { id: "g-current", name: "Current stores", position: 0 },
  { id: "g-closed", name: "Closed", position: 2 },
];

/** The same store, with its PAT expiry written in whichever shape is asked for. */
function payloadWithPat(patCell, extra = {}) {
  return {
    requests: [{ id: "sd-001", title: "Touchwood - Solihull" }],
    items: [{ requestId: "sd-001", groupId: "g-current", position: 0 }],
    groups: GROUPS,
    columns: COLUMNS,
    cells: [
      { requestId: "sd-001", columnId: columnId("patExpiry"), value: patCell },
      ...(extra.cells ?? []),
    ],
    fileCounts: extra.fileCounts ?? [],
    notRequired: extra.notRequired ?? [],
  };
}

const BARE = "2026-11-06";
const JSON_SHAPE = '{"date":"2026-11-06","time":"","icon":""}';

const patOf = (stores) =>
  stores[0].compliance.find((item) => item.kind === "PAT Test");

/* ── 1. The join produces the same date from either shape ────────────────── */

test("a JSON-shaped expiry cell and a bare one produce the same expiry", () => {
  const bare = model.buildComplianceStores(payloadWithPat(BARE));
  const wrapped = model.buildComplianceStores(payloadWithPat(JSON_SHAPE));

  assert.equal(patOf(bare).expiry, BARE, "the bare shape must survive untouched");
  assert.equal(
    patOf(wrapped).expiry,
    patOf(bare).expiry,
    "the JSON shape is the majority on the imported board and must read identically",
  );

  // Not merely equal — a plain ISO day, which is what every consumer parses.
  assert.match(patOf(wrapped).expiry, /^\d{4}-\d{2}-\d{2}$/);
});

test("the whole compliance record matches, not just the date", () => {
  const bare = model.buildComplianceStores(payloadWithPat(BARE));
  const wrapped = model.buildComplianceStores(payloadWithPat(JSON_SHAPE));
  assert.deepEqual(
    wrapped,
    bare,
    "one shape must not produce a different state, file count or lifecycle from the other",
  );
});

/* ── 2. `daysAway` is derivable, which is what printed nothing before ────── */

test("the tracker can measure days from either shape", () => {
  /*
   * `daysUntil` in store-compliance-tracker.tsx is `new Date(iso)` guarded by
   * `Number.isNaN(target.getTime())`. That guard is what returned null on the
   * JSON string, which is why the cell showed no date and `worstDays` skipped
   * the row. This asserts the value the tracker is handed can actually be
   * measured — the same operation, on the model's output.
   */
  for (const shape of [BARE, JSON_SHAPE]) {
    const stores = model.buildComplianceStores(payloadWithPat(shape));
    const parsed = new Date(patOf(stores).expiry);
    assert.ok(
      !Number.isNaN(parsed.getTime()),
      `the tracker cannot count days from ${shape}`,
    );
  }
});

/* ── 3. The calendar's own regex, applied to the model's own output ──────── */

test("the calendar's ISO_DATE matches what the model puts in item.cells", async () => {
  const calendarSource = await read("app/(app)/portal/views/store-expiry-calendar.tsx");
  const declared = /const ISO_DATE = \/(.+?)\/;/.exec(calendarSource);
  assert.ok(declared, "store-expiry-calendar.tsx no longer declares ISO_DATE");
  const isoDate = new RegExp(declared[1]);

  // The calendar reads `item.cells[columnId]` off `buildStoreBoardItems` — a
  // different path from the tracker's, through the same `cellsByRequest`.
  for (const shape of [BARE, JSON_SHAPE]) {
    const [item] = model.buildStoreBoardItems(payloadWithPat(shape));
    const cell = item.cells[columnId("patExpiry")];
    assert.ok(
      isoDate.test(cell ?? ""),
      `the calendar drops this entry: ISO_DATE does not match ${JSON.stringify(cell)} built from ${shape}`,
    );
  }
});

test("both shapes reach the calendar as the same board item", () => {
  const [bare] = model.buildStoreBoardItems(payloadWithPat(BARE));
  const [wrapped] = model.buildStoreBoardItems(payloadWithPat(JSON_SHAPE));
  assert.deepEqual(wrapped, bare);
});

/* ── 4. Normalisation is confined to the expiry columns ──────────────────── */

test("a text cell is not put through the date normaliser", () => {
  /*
   * `dateOnlyValue` answers "" for anything it cannot read as a date, and
   * `cellsByRequest` drops "". Running every cell through it would empty the
   * Store Address column — 31 addresses — which is a worse bug than the one
   * being fixed, so the normalisation has to be keyed to the nine expiry
   * columns and nothing else.
   */
  const address = "Touchwood Shopping Centre, Solihull B91 3GJ";
  const payload = payloadWithPat(BARE, {
    cells: [{ requestId: "sd-001", columnId: columnId("storeAddress"), value: address }],
  });
  const cells = model.cellsByRequest(payload);
  assert.equal(
    cells.get("sd-001")[columnId("storeAddress")],
    address,
    "the address must arrive exactly as the board sent it",
  );
});

test("an unreadable date is no date, not a held certificate", () => {
  /*
   * The reason the call site uses `|| null` rather than the bare
   * `dateOnlyValue`: `holdingState(fileCount, expiry)` reads `expiry !== null`
   * as "we hold this certificate", so an empty string would turn "nobody
   * recorded a date" into "Compliant" with no file and no date behind it.
   */
  const stores = model.buildComplianceStores(payloadWithPat("not a date at all"));
  const pat = patOf(stores);
  assert.equal(pat.expiry, null, "an unparseable cell is not an expiry date");
  assert.equal(
    pat.state,
    "Missing",
    "no file and no readable date is Missing, not Compliant",
  );
});

test("a cleared date stays cleared", () => {
  const stores = model.buildComplianceStores(payloadWithPat(""));
  assert.equal(patOf(stores).expiry, null);
});

/* ── 5. The source keeps the normaliser rather than restating it ─────────── */

test("the model normalises through the shared helper, not a local regex", () => {
  assert.match(
    modelSource,
    /import \{ dateOnlyValue \} from "\.\.\/\.\.\/\.\.\/lib\/expiry-status"/,
    "the client must use the same normaliser as store-documentation-register.ts",
  );
  // `|| null` is load-bearing — see the test above.
  assert.match(modelSource, /dateOnlyValue\(rawExpiry\) \|\| null/);
});
