import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("every monday filter operator is implemented", async () => {
  const source = await read("app/(app)/portal/views/view-model.ts");
  const operators = [
    "any_of", "not_any_of", "is_empty", "is_not_empty", "contains",
    "not_contains", "starts_with", "ends_with", "greater_than", "lower_than",
    "between", "within_the_last", "within_the_next",
  ];
  for (const operator of operators) {
    assert.match(source, new RegExp(`case "${operator}":`), `${operator} must be evaluated`);
    assert.match(source, new RegExp(`key: "${operator}"`), `${operator} must be selectable`);
  }
});

test("an unknown filter operator fails closed", async () => {
  const source = await read("app/(app)/portal/views/view-model.ts");
  const fallback = source.slice(source.indexOf("default:"), source.indexOf("default:") + 60);
  assert.match(
    fallback,
    /return false/,
    "an unrecognised operator must match nothing, not everything",
  );
});

test("empty values sort last regardless of direction", async () => {
  const source = await read("app/(app)/portal/views/view-model.ts");
  const sort = source.slice(source.indexOf("export function applySort"));
  assert.match(
    sort.slice(0, 1400),
    /if \(left === "" && right !== ""\) return 1/,
    "a blank is missing data, not the smallest value",
  );
});

test("multi-column sort breaks ties with later rules", async () => {
  const source = await read("app/(app)/portal/views/view-model.ts");
  const sort = source.slice(source.indexOf("export function applySort"));
  assert.match(sort.slice(0, 1600), /for \(const rule of sort\)/);
  assert.match(sort.slice(0, 1600), /if \(comparison !== 0\) return/);
});

test("money is formatted from pounds in GBP, not divided", async () => {
  const source = await read("app/(app)/portal/views/view-model.ts");
  assert.match(source, /currency: "GBP"/);

  /*
   * This test used to assert `pence / 100` with the message "values are stored
   * in pence". That belief was wrong, and asserting it is what kept the bug
   * alive: every cost in the board's alternative views rendered at one
   * hundredth of its value.
   *
   * Checked against both ends rather than reasoned about.
   * `maintenance_requests.cost` is `real("cost")`, and the live database holds
   * 7954.82 for the job whose monday "Cost of Works" cell also reads 7954.82 —
   * so the number is pounds, with pence after the decimal point. The 81 costed
   * jobs total £42,540.14, which matches monday exactly and would have read
   * £425.40 under the old code.
   *
   * `cost_pence` does exist on that table and IS pence, which is where the
   * confusion came from — but these views never read it.
   */
  assert.doesNotMatch(
    source,
    /pence \/ 100/,
    "cost is pounds; dividing renders every figure at one hundredth",
  );
  assert.match(source, /format\(pounds\)/);
});

test("dates are rendered in UK order", async () => {
  const source = await read("app/(app)/portal/views/view-model.ts");

  /*
   * This used to slice the first 400 characters off `formatDate` and look for
   * `"en-GB"` and `day: "2-digit"` inside them, which only held while the
   * `Intl.DateTimeFormat` was constructed inline on every call. It is now a
   * module constant — hoisted so a date-only value can take a branch that never
   * touches `Date` at all, because `new Date("2026-11-24")` is midnight UTC and
   * rendered Aldgate's PAT expiry as 23/11/2026 for any viewer west of
   * Greenwich. The old assertion failed on a strictly better formatter.
   *
   * So both halves are checked where they actually live: the shared formatter
   * is still en-GB with a two-digit day, and the date-only branch still emits
   * day before month. Either one flipped to US order fails this.
   */
  assert.match(source, /new Intl\.DateTimeFormat\(\s*"en-GB"/);
  assert.match(source, /day: "2-digit"/);

  const formatter = source.slice(source.indexOf("export function formatDate"));
  assert.match(
    formatter.slice(0, 400),
    /\$\{day\}\/\$\{month\}\/\$\{year\}/,
    "a YYYY-MM-DD value must render day-first without going through Date",
  );
});

test("the calendar week starts on Monday", async () => {
  const source = await read("app/(app)/portal/views/board-views.tsx");
  assert.match(source, /\["Mon", "Tue"/, "the UK working week starts on Monday");
  assert.match(
    source,
    /\(first\.getUTCDay\(\) \+ 6\) % 7/,
    "the leading blank count must be Monday-based",
  );
});

test("the calendar says which date field it is showing", async () => {
  const source = await read("app/(app)/portal/views/board-views.tsx");
  assert.match(
    source,
    /Items without that date are not/,
    "an item with no date silently vanishing must be explained",
  );
});

test("all five renderers exist and are wired to the chrome", async () => {
  const views = await read("app/(app)/portal/views/board-views.tsx");
  for (const component of ["KanbanView", "CalendarView", "GalleryView", "ReportsView"]) {
    assert.match(views, new RegExp(`export function ${component}`));
  }
  const chart = await read("app/(app)/portal/views/chart-and-filters.tsx");
  assert.match(chart, /export function ChartView/);
  assert.match(chart, /export function FilterBuilder/);

  const chrome = await read("app/(app)/portal/board-view-pane.tsx");
  for (const type of ["kanban", "calendar", "chart", "gallery", "reports"]) {
    assert.match(
      chrome,
      new RegExp(`activeView\\.type === "${type}"`),
      `the ${type} tab must render its pane`,
    );
  }
});

test("view types report their real build state", async () => {
  const api = await read("app/api/board/views/route.ts");
  const built = api.slice(api.indexOf("export const VIEW_TYPES"));
  for (const type of ["kanban", "calendar", "chart", "gallery", "reports"]) {
    assert.match(
      built,
      new RegExp(`key: "${type}"[^}]*built: true`),
      `${type} is implemented and must report built: true`,
    );
  }
  // Timeline is genuinely not built and must still say so.
  assert.match(built, /key: "timeline"[^}]*built: false/);
});

test("the board passes its filtered items into the views", async () => {
  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /items=\{scopedRequests/, "views must see the same filtered set as the table");
  assert.match(board, /palette=\{viewPalette\}/, "chips must match the table's colours");
});

test("view renderers meet the mobile standard", async () => {
  const css = await read("app/brand-overrides.css");
  const section = css.slice(css.indexOf("Board view renderers (Stage 6"));

  // Selects and inputs at 16px or iOS zooms on focus and will not zoom back.
  assert.match(section, /font-size: 16px/);

  // Kanban must scroll sideways rather than crush its columns.
  const kanban = section.slice(section.indexOf(".kanban {"));
  assert.match(kanban.slice(0, 300), /overflow-x: auto/);

  const queries = section.match(/@media \([^)]*width: (\d+)px\)/g) ?? [];
  for (const query of queries) {
    const width = Number(query.match(/(\d+)px/)[1]);
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${query} is outside the agreed breakpoints`,
    );
  }
});

test("no fixed tenant identifier in the stage 6 files", async () => {
  for (const file of [
    "app/(app)/portal/views/view-model.ts",
    "app/(app)/portal/views/board-views.tsx",
    "app/(app)/portal/views/chart-and-filters.tsx",
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /"sunnamusk-uk"/);
    assert.doesNotMatch(source, /\bCLIENT_ID\b\s*=/);
  }
});

test("the Form tab renders the monday form, not an empty pane", async () => {
  // The pane had no branch for `type === "form"` and its placeholder branch
  // explicitly excluded form views, so selecting the Form tab switched to a
  // pane that rendered nothing at all. The branches moved out of
  // `board-chrome.tsx` into `board-view-pane.tsx` when the pane became a
  // section of its own; this reads the same code in its new home.
  const pane = await read("app/(app)/portal/board-view-pane.tsx");
  assert.match(pane, /activeView\.type === "form" && <FormView/);
  assert.ok(
    !/!activeView\.built && activeView\.type !== "form"/.test(pane),
    "the form view must no longer be excluded from the rendered pane",
  );

  // Every view type the tab strip can seed must have somewhere to render.
  for (const type of ["kanban", "calendar", "chart", "gallery", "reports", "form"]) {
    assert.match(
      pane,
      new RegExp(`activeView\\.type === "${type}"`),
      `${type} views must be rendered`,
    );
  }
});

test("the form asks monday's questions, in monday's order", async () => {
  const spec = await read("db/monday-board-spec.ts");
  const form = spec.slice(spec.indexOf("export const maintenanceFormSpec"));

  assert.match(form, /title: "Maintenance Request"/);
  assert.match(form, /description: "Please fill up 1 form for each repair requested"/);

  // Only question entries — every one carries a `label`. Matching `key:` alone
  // would also pick up the `showIf` rule's `key: "engineer"`.
  const keys = [...form.matchAll(/key: "([A-Za-z]+)",\s*\n?\s*label:/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(keys, [
    "storeLocation",
    "requester",
    "number",
    "requested",
    "engineer",
    "handymanRequired",
    "description",
    "issuePictures",
    "priority",
  ]);

  // Monday's single conditional rule (8874e83b…): the handyman follow-up shows
  // only when Engineer Required is answered "Handyman".
  assert.match(form, /showIf: \{ key: "engineer", equals: "Handyman" \}/);

  const view = await read("app/(app)/portal/views/board-views.tsx");
  assert.match(view, /const showHandyman = engineer === "Handyman";/);
  // Photographs are mandatory on monday, and the form says so.
  assert.match(view, /if \(!files\.length\)/);
});

test("no code writes a status or priority the board cannot render", async () => {
  // Six statuses ("Triage in progress", "Contractor assigned", "Visit booked",
  // "In progress", "Waiting for decision", "Completed") and a "High" priority
  // existed only in this codebase. A job moved between stages was written a
  // chip the board had no option row for.
  const retired = [
    "Triage in progress",
    "Contractor assigned",
    "Visit booked",
    "Waiting for decision",
  ];
  const files = [
    "app/api/board/route.ts",
    "app/api/maintenance/route.ts",
    "app/lib/mock-data.ts",
    "db/schema.ts",
    "db/init.ts",
  ];
  for (const file of files) {
    const source = await read(file);
    // Strip comments — the retired names are named there on purpose.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    for (const status of retired) {
      assert.ok(
        !code.includes(`"${status}"`) && !code.includes(`'${status}'`),
        `${file} still writes the retired status "${status}"`,
      );
    }
  }
});
