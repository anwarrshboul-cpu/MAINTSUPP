import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const CAPTURE = "db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md";
const ROUTE = "app/api/board/views/route.ts";
const CHROME = "app/(app)/portal/board-chrome.tsx";
// The chrome is the three sticky rows; the pane it opens below them is where a
// view type actually renders. They split when the pane stopped being drawn over
// the grid and became a section of its own.
const PANE = "app/(app)/portal/board-view-pane.tsx";
const TAB_GLYPH = "app/(app)/portal/board-tab-glyph.tsx";
const VIEWS = "app/(app)/portal/views/parity-views.tsx";
const VIEWS_CSS = "app/(app)/portal/views/parity-views.css";

/**
 * monday's own tab order, read out of the live capture rather than retyped
 * here. The capture is the ground truth for board 1139774521; a test that
 * repeated the list would only prove this file agrees with itself.
 */
async function mondayTabOrder() {
  const capture = await read(CAPTURE);
  const table = capture.slice(
    capture.indexOf("## Views, in monday's own tab order"),
    capture.indexOf("The form is titled"),
  );
  return [...table.matchAll(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|/gm)].map((match) =>
    match[1].replace(/\s*\(pinned\)$/, ""),
  );
}

/** The seeded tabs, in the order the route declares them. */
async function seededViews() {
  const source = await read(ROUTE);
  const block = source.slice(
    source.indexOf("const SEED_VIEWS: SeedView[]"),
    source.indexOf("const SEED_KEYS"),
  );
  return [...block.matchAll(/\{\s*key: "([^"]+)",\s*name: "([^"]+)",\s*type: "([^"]+)"/g)].map(
    ([, key, name, type]) => ({ key, name, type }),
  );
}

test("the seeded tabs are monday's eleven, in monday's tab order", async () => {
  const expected = await mondayTabOrder();
  const seeded = await seededViews();

  assert.equal(expected.length, 11, "the capture records eleven views");
  assert.deepEqual(
    seeded.map((view) => view.name),
    expected,
    "the tab strip must seed monday's views in monday's order",
  );
});

test("the four views Stage 5 folded away are back, and Reports takes monday's name", async () => {
  const seeded = await seededViews();
  const byName = new Map(seeded.map((view) => [view.name, view]));

  for (const name of ["Results", "Form Response Viewer", "Table", "Build Vibe view"]) {
    assert.ok(byName.has(name), `${name} must be a seeded tab`);
  }

  // monday calls it "Board Reports". Stage 5 shortened it to "Reports".
  assert.ok(byName.has("Board Reports"), "Reports must take monday's own name");
  assert.ok(!byName.has("Reports"), "the shortened name must be gone");

  // monday's second table view is deliberately group-free — that is the whole
  // difference from Main table, so it cannot share the grouped table's type.
  assert.equal(byName.get("Main table").type, "table");
  assert.equal(byName.get("Table").type, "flat-table");
});

test("the pinned form and the two monday apps carry their own glyph", async () => {
  const source = await read(ROUTE);
  const block = source.slice(
    source.indexOf("const SEED_VIEWS: SeedView[]"),
    source.indexOf("const SEED_KEYS"),
  );

  // Form is pinned on monday and sorts first because of it.
  assert.match(block, /name: "Form",[^}]*glyph: "pin"/);
  // Fix Tracker (app 22247989) and Build Vibe view (app 15528052) are apps.
  assert.match(block, /name: "Fix Tracker",[^}]*glyph: "app"/);
  assert.match(block, /name: "Build Vibe view",[^}]*glyph: "app"/);
  // Nothing else is decorated — the capture names only those three.
  assert.equal((block.match(/glyph: "/g) ?? []).length, 3);

  /*
   * `board-tab-glyph.tsx`, not `board-chrome.tsx` — Stage 23. The glyphs moved
   * out when the chrome hit its 500-line limit; what they are and when they
   * are drawn is unchanged, so the assertions follow them rather than relax.
   */
  const glyphs = await read(TAB_GLYPH);
  assert.match(glyphs, /export function TabGlyph/, "something must draw the two glyphs");
  assert.match(glyphs, /aria-label="Pinned view"/);
  assert.match(glyphs, /aria-label="monday app"/);
  // An app tab gets the app glyph INSTEAD of a view icon, as monday draws it.
  assert.match(glyphs, /if \(!glyph\) return <Icon name=\{iconFor\(view\.icon\)\}/);
  // And the chrome still uses it, or the file above would be dead code.
  const chrome = await read(CHROME);
  assert.match(chrome, /import \{ iconFor, TabGlyph \} from "\.\/board-tab-glyph"/);
});

test("every seeded view type has somewhere to render", async () => {
  const seeded = await seededViews();
  const pane = await read(PANE);
  for (const view of seeded) {
    if (view.type === "table") continue; // the grid below the chrome is the table
    assert.match(
      pane,
      new RegExp(`activeView\\.type === "${view.type}"`),
      `${view.name} (${view.type}) must render a pane`,
    );
  }
});

test("the new view types report themselves built, so no tab says 'soon'", async () => {
  const source = await read(ROUTE);
  const types = source.slice(source.indexOf("export const VIEW_TYPES"), source.indexOf("type SeedView"));
  for (const type of ["form-results", "form-responses", "flat-table", "vibe"]) {
    assert.match(
      types,
      new RegExp(`key: "${type}"[^}]*built: true`),
      `${type} is implemented and must report built: true`,
    );
  }
});

test("no new panel is a 'coming soon' stub", async () => {
  const views = await read(VIEWS);
  for (const excuse of ["coming soon", "Coming soon", "not built yet", "Placeholder", "TODO"]) {
    assert.ok(!views.includes(excuse), `a panel still says "${excuse}"`);
  }
  for (const component of [
    "FormResultsView",
    "FormResponsesView",
    "FlatTableView",
    "BuildVibeView",
  ]) {
    assert.match(views, new RegExp(`export function ${component}`));
  }
});

test("every new panel has an empty state that says what will fill it", async () => {
  const views = await read(VIEWS);
  // One `view-empty` per panel that can legitimately have nothing to show.
  assert.equal((views.match(/className="view-empty"/g) ?? []).length, 3);
  assert.match(views, /No responses to <strong>\{maintenanceFormSpec\.title\}<\/strong> yet/);
  assert.match(views, /appears here as its own card, newest first/);
  assert.match(views, /No items match the current filters/);
});

test("the form panels count real submissions and nothing else", async () => {
  const views = await read(VIEWS);
  // A response is a row that arrived through the form. Both provenances count:
  // a row raised in MAINTSUPP, and an imported monday row whose Name is
  // WorkForms' own "Incoming form answer". Jobs typed onto the board are
  // "Manual" and counting them would overstate the response rate.
  assert.match(views, /item\.source === "Portal form"/);
  assert.match(views, /FORM_ANSWER = \/incoming form answer\/i/);
  assert.match(
    views,
    /cannot be traced back to a response and is left out/,
    "the panel must say which rows it could not count",
  );
  assert.match(views, /function newestFirst/, "monday's viewer opens newest first");

  // Questions come from the captured form spec, in the form's own order, so a
  // question added to the form is not silently missing from Results.
  assert.match(views, /maintenanceFormSpec\.questions\.map/);

  // The conditional Handyman answer is read back out of where the form put it.
  assert.match(views, /Handyman required:/);
});

test("the flat table is group-free and carries every monday column", async () => {
  const views = await read(VIEWS);
  const flat = views.slice(views.indexOf("const FLAT_COLUMNS"));

  // All 25, minus MAINTSUPP's own move-to-group control, which a table with no
  // groups has nothing to do with.
  assert.match(flat, /columnLabels\.filter\(\(column\) => column\.key !== "move"\)/);
  assert.ok(
    !/groupBy\(/.test(flat.slice(0, flat.indexOf("BuildVibeView"))),
    "the flat table must not group its rows — that is the whole difference from Main table",
  );

  // Sorting reuses the main table's own comparator so two tables cannot order
  // the same column differently.
  assert.match(flat, /systemColumnSortValue\(/);
  assert.match(flat, /aria-sort=/, "a sortable heading must announce its state");
});

test("the Vibe tab says what it is instead of faking an app builder", async () => {
  const views = await read(VIEWS);
  const vibe = views.slice(views.indexOf("export function BuildVibeView"));
  assert.match(vibe, /monday app/);
  assert.match(vibe, /15528052/, "the panel must name the app it stands in for");
  assert.match(vibe, /not a board view/);
});

test("the parity upgrade runs once and never resurrects a deleted tab", async () => {
  const source = await read(ROUTE);
  const upgrade = source.slice(source.indexOf("async function upgradeToMondayViews"));

  // The marker lives on `main`, the one view DELETE refuses to remove, so it
  // cannot be lost by an admin tidying their tab strip.
  assert.match(upgrade.slice(0, 900), /readSettings\(main\.settings\)\.seed === PARITY_STAMP/);
  assert.match(upgrade, /onConflictDoNothing/);

  // An admin's own rename survives; only Stage 5's exact name is corrected.
  assert.match(upgrade, /existing\.name === "Reports"/);
});

test("the tab set belongs to the maintenance board alone", async () => {
  const source = await read(ROUTE);
  const seed = source.slice(source.indexOf("async function seedViews"));
  assert.match(
    seed.slice(0, 400),
    /if \(boardKey !== DEFAULT_BOARD_KEY\) return;/,
    "Fix Tracker and the Maintenance Request form cannot render on another board",
  );

  // Store Documentation keeps its own three tabs, declared in its own component.
  const store = await read("app/(app)/portal/views/store-documentation-board.tsx");
  const tabs = [...store.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["Main table", "Compliance Tracker", "Calendar"]);
});

test("the whole tab strip is reachable, not five tabs behind a menu", async () => {
  const chrome = await read(CHROME);
  assert.match(
    chrome,
    /const visibleTabs = views;/,
    "monday shows all eleven tabs and scrolls the strip",
  );
});

test("the parity panels meet the mobile standard", async () => {
  const css = await read(VIEWS_CSS);

  // 25 columns fit no screen. The table scrolls inside its own box so the page
  // body never scrolls sideways.
  const scroll = css.slice(css.indexOf(".flat-table__scroll"));
  assert.match(scroll.slice(0, 260), /overflow-x: auto/);

  // Tap targets.
  assert.match(css, /min-height: 44px/);

  // Only the agreed breakpoints.
  const queries = css.match(/@media \([^)]*width: (\d+)px\)/g) ?? [];
  for (const query of queries) {
    const width = Number(query.match(/(\d+)px/)[1]);
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${query} is outside the agreed breakpoints`,
    );
  }
});

test("the parity panels restyle nothing that already existed", async () => {
  const css = await read(VIEWS_CSS);
  const selectors = [...css.matchAll(/^\s*\.([a-z0-9_-]+)/gm)].map((match) => match[1]);
  const allowed = new Set([
    "board-views__glyph",
    "board-views__tab",
    "form-results",
    "form-results__answer",
    "form-results__bar",
    "form-results__bars",
    "form-results__count",
    "form-results__free",
    "form-results__head",
    "form-results__note",
    "form-results__question",
    "form-results__questions",
    "form-results__scope",
    "form-results__tail",
    "form-results__totals",
    "form-responses",
    "form-responses__card",
    "form-responses__count",
    "form-responses__files",
    "form-responses__list",
    "form-responses__long",
    "form-responses__more",
    "flat-table",
    "flat-table__hint",
    "flat-table__scroll",
    "vibe-view",
    "vibe-view__badge",
    "vibe-view__figures",
    "vibe-view__foot",
    "vibe-view__head",
  ]);
  for (const selector of selectors) {
    assert.ok(allowed.has(selector), `.${selector} is outside the new panels`);
  }

  // Colours are MAINTSUPP tokens, so the panels follow the theme rather than
  // pinning their own palette.
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "a raw hex colour has crept in");
});

test("no fixed tenant identifier in the stage 19 files", async () => {
  for (const file of [ROUTE, CHROME, VIEWS]) {
    const source = await read(file);
    assert.doesNotMatch(source, /"sunnamusk-uk"/);
    assert.doesNotMatch(source, /\bCLIENT_ID\b\s*=/);
  }
});
