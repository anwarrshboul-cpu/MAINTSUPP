/**
 * QA UI polish — small defects found in a full QA pass of the portal, each
 * pinned where its fix lives. Pure modules are exercised; component wiring is
 * pinned by source text, as the rest of this suite does.
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

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.Preserve,
    },
  }).outputText;
}
const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

const PORTAL = "app/(app)/portal/portal-app.tsx";

/* ── 3. Activity history names the fields that changed ──────────────────── */

/* `columnKeyForField` stubbed with the slice of SYSTEM_FIELD_BY_KEY the
   fixtures use: request-fields.ts pulls in money and title modules. */
const requestFieldsStub = asModule(`
  const MAP = { priority: "priority", dueAt: "dueDate", title: "name" };
  export function columnKeyForField(field) { return MAP[field] ?? null; }
`);
const activity = await import(
  asModule(
    transpile(await read("app/lib/activity-fields.ts")).replace(
      /from ["']\.\/request-fields["']/g,
      `from "${requestFieldsStub}"`,
    ),
  )
);

test("3: a fields_changed row names the fields, not 'the request details'", () => {
  assert.equal(
    activity.fieldsChangedSentence({ priority: "Urgent", dueAt: "2026-10-01" }),
    "updated Priority and Due date.",
  );
  assert.equal(
    activity.fieldsChangedSentence({ priority: "Low", siteId: "s1", cost: 4 }),
    "updated Priority, Site and Cost.",
  );
  assert.equal(
    activity.fieldsChangedSentence({ dueAt: "x" }, (key) => (key === "dueDate" ? "Deadline" : null)),
    "updated Deadline.",
    "a column renamed on this board is called by its own title",
  );
  assert.equal(activity.fieldsChangedSentence(undefined), "updated the request details.");
  assert.equal(activity.fieldsChangedSentence({}), "updated the request details.");
});

test("3: the drawer's activity feed uses it, with the board's column titles", async () => {
  const source = await read(PORTAL);
  assert.match(source, /return fieldsChangedSentence\(entry\.detail\.fields, columnTitle\);/);
  assert.match(
    source,
    /activityDescription\(entry, \(key\) =>\s*boardSnapshot\?\.columns\.find\(\(col\) => col\.key === key\)\?\.column\.title\)/,
  );
});

/* ── 4. Planned task: units follow the site, and a new task is created ─── */

const MANAGER = "app/(app)/portal/workspace-data-manager.tsx";
const unitOptions = await import(
  asModule(transpile(await read("app/(app)/portal/planned-unit-options.ts")))
);

test("4: Linked unit offers only the chosen site's units, told apart by serial", () => {
  const units = [
    { id: "u-aaa1", siteId: "s1", siteName: "Aldgate", name: "Boiler", serialNumber: "B-1", model: null, manufacturer: null },
    { id: "u-aaa2", siteId: "s1", siteName: "Aldgate", name: "Boiler", serialNumber: null, model: "Vitodens", manufacturer: null },
    { id: "u-bbb1", siteId: "s2", siteName: "Bank", name: "Boiler", serialNumber: "B-9", model: null, manufacturer: null },
    { id: "u-aaa3", siteId: "s1", siteName: "Aldgate", name: "Shutter", serialNumber: null, model: null, manufacturer: null },
  ];
  assert.deepEqual(unitOptions.plannedUnitOptions(units, "s1"), [
    { value: "", label: "No linked unit" },
    { value: "u-aaa1", label: "Boiler — S/N B-1" },
    { value: "u-aaa2", label: "Boiler — Vitodens" },
    { value: "u-aaa3", label: "Shutter" },
  ]);
  const kept = unitOptions.plannedUnitOptions(units, "s1", "u-bbb1");
  assert.deepEqual(
    kept.at(-1),
    { value: "u-bbb1", label: "Boiler (at Bank)" },
    "a link the record already holds stays visible, named with its own site",
  );
});

test("4: the form wires it in, and a new record's button says Create", async () => {
  const source = await read(MANAGER);
  assert.match(source, /const unitOptions = plannedUnitOptions\(workspace\.units, formSiteId, formUnitId\);/);
  assert.match(source, /typeof form\?\.siteId === "string" \? form\.siteId : null,/);
  assert.match(source, /editorId \? "Save changes" : tab === "planned" \? "Create task" :/);
});

/* ── 6. A refusal toast is not drawn as a success ──────────────────────── */

const tone = await import(asModule(transpile(await read("app/lib/toast-tone.ts"))));

test("6: failure wording gets the error tone; successes keep theirs", () => {
  for (const failure of [
    "You do not have permission to change this date.",
    "The record could not be archived.",
    "The board must keep at least one group.",
    "There is no item above this one to become its parent.",
    "Upload failed.",
  ]) {
    assert.equal(tone.toastToneFor(failure), "error", failure);
  }
  for (const success of [
    "Comment added.",
    "Record archived. Its history remains available.",
    "MN-1001 moved to Booked.",
    "Theme saved.",
    "Link to MN-1001 copied.",
  ]) {
    assert.equal(tone.toastToneFor(success), "success", success);
  }
  assert.equal(tone.toastToneFor("Saved.", "error"), "error", "an explicit tone wins");
});

test("6: the portal toast draws its tone, and its failure paths say error", async () => {
  const source = await read(PORTAL);
  assert.match(source, /setToastState\(message \? \{ message, tone: toastToneFor\(message, tone\) \} : null\);/);
  assert.match(source, /className=\{`toast\$\{toastState\.tone === "error" \? " toast--error" : ""\}`\}/);
  assert.match(source, /role=\{toastState\.tone === "error" \? "alert" : "status"\}/);
  assert.match(source, /<Icon name=\{toastState\.tone === "error" \? "alert" : "check"\} size=\{17\} \/>/);
  assert.match(source, /import "\.\/toast-tone\.css";/);
  // Every catch-path toast in the shell passes the tone outright.
  assert.doesNotMatch(source, /setToast\((error|caught) instanceof Error \? \1\.message : "[^"]*"\)/);
  const css = await read("app/(app)/portal/toast-tone.css");
  assert.match(css, /\.toast\.toast--error > span \{[^}]*var\(--red-100\)/);
});

/* ── 7. One word for the top priority: Urgent ──────────────────────────── */

test("7: every priority display map calls the top band Urgent, never High", async () => {
  for (const file of [
    "app/(app)/portal/dashboard-meters.ts",
    "app/lib/overview-metrics.ts",
    "app/(app)/portal/ops/overview-performance.tsx",
  ]) {
    const source = await read(file);
    assert.match(source, /^ {2}urgent: "Urgent",$/m, file);
    assert.doesNotMatch(source, /^ {2}urgent: "High",$/m, file);
  }
  const drill = await read("app/(app)/portal/board-drill-filter.ts");
  assert.match(drill, /value: "Urgent or Tier 1, due within 48h"/);
  const oi = await read("app/(app)/portal/ops/oi-dash.tsx");
  assert.doesNotMatch(oi, /High priority or Tier 1/);
});

/* ── 8. A CSV with an unclosed quote is reported as one ────────────────── */

const csv = await import(asModule(transpile(await read("app/lib/csv.ts"))));

test("8: an unclosed quote is found, with the line it opened on", () => {
  assert.equal(
    csv.unbalancedQuoteLine('name,address_line1\nAldgate,1 High St\nBank,"2 Low St\nCity,3 Mid St\n'),
    3,
  );
  assert.equal(
    csv.unbalancedQuoteLine('name,address_line1\n"Aldgate","1 High St,\nLondon"\n"Say ""hi""",x\n'),
    null,
    "a multi-line quoted field and escaped quotes are balanced",
  );
  assert.equal(csv.unbalancedQuoteLine("﻿name\nA\n"), null);
});

test("8: the site import refuses such a file by line, before any row is judged", async () => {
  const route = await read("app/api/sites/csv/route.ts");
  const guard = route.indexOf("const quoteLine = unbalancedQuoteLine(csv);");
  assert.ok(guard > 0, "the importer checks quotes");
  assert.ok(guard < route.indexOf("const records = parseCsvObjects(csv);"), "before parsing rows");
  assert.match(route, /`Line \$\{quoteLine\} has an unbalanced quote \(\"\)/);
});

/* ── 5. Jobs board: named row controls, a no-results state, phone gutter ── */

const LIVE_BOARD = "app/(app)/portal/live-board.tsx";

test("5: row action and select controls are named by the job, not its raw id", async () => {
  const board = await read(LIVE_BOARD);
  assert.match(board, /const rowName = boardItemName\(request\);/);
  assert.match(board, /aria-label=\{"Actions for " \+ rowName\}/);
  assert.match(board, /aria-label=\{"Select " \+ rowName\}/);
  assert.match(board, /label=\{"Actions for " \+ rowName\}/);
  assert.doesNotMatch(board, /"(Actions for|Select) " \+ request\.id/);
  const drawerMenu = await read("app/(app)/portal/overlay/item-actions.tsx");
  assert.doesNotMatch(drawerMenu, /Actions for \$\{request\.id\}/);
  assert.match(drawerMenu, /Actions for \$\{boardItemName\(request\)\}/);
});

test("5: a search that matches nothing says so and offers Clear search", async () => {
  const board = await read(LIVE_BOARD);
  assert.match(
    board,
    /<BoardSearchEmpty query=\{query\} matches=\{visibleRows\.length\} noun=\{isMaintenanceBoard \? "jobs" : identity\.itemNoun\} onClear=\{\(\) => setQuery\(""\)\} \/>/,
  );
  const empty = await read("app/(app)/portal/board-search-empty.tsx");
  assert.match(empty, /if \(!searched \|\| matches > 0\) return null;/);
  assert.match(empty, /No \{noun\} match &ldquo;\{searched\}&rdquo;/);
  assert.match(empty, /Clear search/);
  assert.match(empty, /role="status"/);
});

test("5: Store Documentation's heading, raise button and tabs keep a 16px phone gutter", async () => {
  const css = await read("app/(app)/portal/views/store-documentation-board.css");
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"), css.indexOf("@media (min-width: 761px)"));
  assert.match(phone, /\.store-documentation__title \{\s*padding-inline: 16px;/);
  assert.match(
    phone,
    /\.store-documentation__actions,\s*\.store-documentation:has\(\.live-board-page\) \.store-documentation__tabs \{\s*margin-inline: 16px;/,
  );
});
