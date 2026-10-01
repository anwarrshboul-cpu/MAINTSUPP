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
