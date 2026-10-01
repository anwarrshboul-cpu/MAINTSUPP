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
