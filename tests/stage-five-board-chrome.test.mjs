import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("stage 5 migration is additive and registered", async () => {
  const sql = await read("drizzle/0010_stage_five_board_views.sql");
  const body = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .toUpperCase();
  for (const destructive of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE"]) {
    assert.ok(!body.includes(destructive), `Migration contains ${destructive}.`);
  }

  const journal = JSON.parse(await read("drizzle/meta/_journal.json"));
  const entry = journal.entries.find((e) => e.tag === "0010_stage_five_board_views");
  assert.ok(entry, "migration 0010 must appear in the journal");
  assert.equal(entry.idx, 10);
});

test("board view indexes are organisation-scoped", async () => {
  const sql = await read("drizzle/0010_stage_five_board_views.sql");
  const unique = sql.match(/CREATE UNIQUE INDEX[^;]+/g) ?? [];
  assert.ok(unique.length > 0, "a unique index on view keys is expected");
  for (const statement of unique) {
    assert.match(
      statement,
      /organisation_id/,
      `A unique index is not organisation-scoped:\n${statement}`,
    );
    assert.ok(
      !statement.includes("client_id"),
      `A unique index still keys off client_id:\n${statement}`,
    );
  }
});

test("seeded tabs mirror the source board minus the dead ones", async () => {
  const source = await read("app/api/board/views/route.ts");
  for (const key of ["main", "form", "fix-tracker", "calendar", "chart", "gallery", "reports"]) {
    assert.match(source, new RegExp(`key: "${key}"`), `the ${key} tab should be seeded`);
  }
  // Results folds into the table; Form Response Viewer folds into the item panel.
  assert.ok(!/key: "results"/.test(source), "Results should not be a separate tab");
  assert.ok(
    !/form-response-viewer/.test(source),
    "Form Response Viewer should not be a separate tab",
  );
});

test("unbuilt view types are labelled rather than hidden", async () => {
  const api = await read("app/api/board/views/route.ts");
  assert.match(api, /built: true/);
  assert.match(api, /built: false/);

  const chrome = await read("app/(app)/portal/board-chrome.tsx");
  assert.match(chrome, /is-unbuilt/, "an unbuilt tab must be visually distinct");
  assert.match(
    chrome,
    /is not built yet/,
    "selecting an unbuilt view must say so rather than showing an empty pane",
  );
});

test("view seeding is idempotent and never resurrects a deleted tab", async () => {
  const source = await read("app/api/board/views/route.ts");
  const seed = source.slice(source.indexOf("async function seedViews"));
  assert.match(
    seed.slice(0, 900),
    /COUNT\(\*\)/,
    "seeding must check for existing views before inserting",
  );
  assert.match(seed.slice(0, 1600), /onConflictDoNothing/);
});

test("the main table view cannot be deleted", async () => {
  const source = await read("app/api/board/views/route.ts");
  const del = source.slice(source.indexOf("export async function DELETE"));
  assert.match(del, /existing\.system/);
  assert.match(del, /status: 409|409\)/);
});

test("only one view can be the default", async () => {
  const source = await read("app/api/board/views/route.ts");
  assert.match(
    source,
    /\.set\(\{ isDefault: false \}\)/,
    "setting a default must clear the previous one",
  );
});

test("the views route is organisation-scoped and degrades gracefully", async () => {
  const source = await read("app/api/board/views/route.ts");
  assert.match(source, /scopedDb\(request\)/);
  assert.match(source, /status: 503/);
  assert.doesNotMatch(source, /"sunnamusk-uk"/);
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    assert.match(source, new RegExp(`export async function ${method}\\b`));
  }
});

test("board chrome is wired into the live board", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /import BoardChrome from "\.\/board-chrome"/);
  assert.match(board, /<BoardChrome/);
  assert.match(board, /<\/BoardChrome>/, "the wrapper must be closed");

  // The existing toolbar becomes row 3 rather than being replaced.
  const open = board.indexOf("<BoardChrome");
  const toolbar = board.indexOf('className="live-board-toolbar"');
  const close = board.indexOf("</BoardChrome>");
  assert.ok(open < toolbar && toolbar < close, "the toolbar must sit inside the chrome");
});

test("chrome rows are sticky and collapsible", async () => {
  const css = await read("app/brand-overrides.css");
  const chrome = css.slice(css.indexOf(".board-chrome {"));
  assert.match(chrome.slice(0, 400), /position: sticky/);

  const component = await read("app/(app)/portal/board-chrome.tsx");
  assert.match(component, /aria-expanded=\{!collapsed\}/);
});

test("chrome meets the mobile standard", async () => {
  const css = await read("app/brand-overrides.css");
  const chrome = css.slice(css.indexOf("Board chrome (Stage 5"));

  // Inputs at 16px or above, or iOS zooms on focus and does not zoom back.
  const inputRule = chrome.slice(chrome.indexOf(".board-views__tab input"));
  assert.match(inputRule.slice(0, 300), /font-size: 16px/);

  // Tabs must scroll horizontally rather than wrap on a phone.
  assert.match(chrome, /overflow-x: auto/);

  // Only the agreed breakpoints.
  const queries = chrome.match(/@media \([^)]*width: (\d+)px\)/g) ?? [];
  for (const query of queries) {
    const width = Number(query.match(/(\d+)px/)[1]);
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${query} is outside the agreed breakpoints`,
    );
  }
});

test("no fixed tenant identifier in the stage 5 files", async () => {
  for (const file of ["app/api/board/views/route.ts", "app/(app)/portal/board-chrome.tsx"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /"sunnamusk-uk"/);
    assert.doesNotMatch(source, /\bCLIENT_ID\b\s*=/);
  }
});
