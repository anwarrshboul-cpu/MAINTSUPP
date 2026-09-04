import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * The six gaps a full completion audit against the brief turned up.
 *
 * Each one passed a code reading and failed against the running preview, which
 * is why they are pinned here rather than trusted: five of the six were
 * features that existed at the API or schema level with nothing wired to them.
 */

test("hiding a column is saved, not kept in browser state", async () => {
  /*
   * `maintenance_board_columns.visible` has been on the table since Stage 1 and
   * nothing read or wrote it. Hiding lived in a `useState<Set<string>>`, so an
   * operator who hid ten certificate columns to read the other two got all
   * twelve back on the next reload — while the column WIDTH beside it persisted.
   */
  const types = await read("app/lib/types.ts");
  assert.match(types, /visible: boolean;/, "the column payload must carry it");

  const route = await read("app/api/board/route.ts");
  assert.match(route, /visible: row\.visible !== false/, "the API must return it");
  assert.match(
    route,
    /if \(typeof payload\.visible === "boolean"\) \{\s*values\.visible = payload\.visible;/,
    "update_column must write it",
  );

  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /const visibilityKeyFor = \(entry: BoardDisplayColumn\) =>/, "one definition of the key");
  assert.match(board, /\.filter\(\(entry\) => entry\.column\.visible === false\)/, "seeded from the server");
  assert.match(board, /const setColumnVisible = async/, "and written back on change");
  assert.doesNotMatch(
    board,
    /setHiddenColumns\(\s*\(current\) =>\s*new Set\(current\)\.add\(visibilityKey\),\s*\)/,
    "the old fire-and-forget local-only toggle must be gone",
  );
});

test("the chosen sort is remembered", async () => {
  /*
   * Sorting was `useState` and nothing else, so it lasted until the next reload
   * while the column width and visibility beside it did not.
   */
  const types = await read("app/lib/types.ts");
  assert.match(types, /sort\?: "asc" \| "desc";/, "the setting must exist on the column");

  const route = await read("app/api/board/route.ts");
  /*
   * The property is that only the two directions survive the round trip. The
   * expression moved into `cleanViewSettings` in Batch 1A — the sort is no
   * longer the only view state a column carries, so the three type branches
   * of `cleanSettings` share one cleaner — and gained the `as const`
   * narrowing that wider return type needs. Matched on the two comparisons
   * rather than on one whole line, so the next legitimate reshaping does not
   * fail this either.
   */
  assert.match(route, /record\.sort === "asc"/);
  assert.match(route, /record\.sort === "desc"/);
  assert.match(
    route,
    /: undefined;/,
    "anything that is not one of the two directions must be dropped",
  );

  /*
   * The board's sort became an ORDERED LIST in Batch 1A, so the three
   * single-column mechanics this used to pin are now one function each in
   * board-sort.ts: `sortSettingsFor` decides what a column stores,
   * `readSortRules` reads them all back, and a column dropped from the sort has
   * both `sort` and `sortPriority` removed rather than the one being cleared by
   * hand. The property is unchanged — a chosen sort survives a reload — and is
   * asserted at each of the three points it passes through.
   */
  const board = await read("app/(app)/portal/live-board.tsx");
  const sort = await read("app/(app)/portal/board-sort.ts");
  assert.match(board, /updateCustomColumn\(entry\.column, \{ settings \}\)/, "written on sort");
  assert.match(board, /sortSettingsFor\(/, "through the one function that decides what a column stores");
  assert.match(board, /setSortRules\(readSortRules\(allBoardColumns\)\)/, "read back on load");
  assert.match(
    sort,
    /const \{ sort: _sort, sortPriority: _priority, \.\.\.rest \}/,
    "and a column dropped from the sort keeps neither half of it",
  );
});

test("every analytics page owns a date range with presets and a custom span", async () => {
  /*
   * Two of the seven had the full picker. Compliance and the jobs board had a
   * preset-only select, and Planned, Contractors and Documents had nothing at
   * all — so "this quarter" was a question three pages could not be asked.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const board = await read("app/(app)/portal/live-board.tsx");

  const pickers = [...portal.matchAll(/<PeriodPicker/g)].length;
  assert.ok(pickers >= 5, `Overview, Reports, Planned, Contractors and Documents each need one — found ${pickers}`);
  assert.match(board, /<PeriodPicker/, "and the jobs board needs one too");

  /* Each of the three that had nothing must FILTER, not just display. */
  assert.match(portal, /const inRange = files\.filter\(withinPeriod\)/, "Documents filters its register");
  assert.match(portal, /const scopedRequests = requests\.filter\(inWindow\)/, "Contractors recomputes from the window");
  /*
   * Planned still filters — the filtering moved with the calendar into
   * `calendar-surface.tsx`, which the board's Calendar view tab mounts too.
   * The page keeps the PeriodPicker (counted above) and hands its window down.
   */
  const surface = await read("app/(app)/portal/calendar-surface.tsx");
  assert.match(surface, /if \(!withinPeriod\(request\.dueAt\)\) continue;/, "Planned filters what it draws");
  assert.match(portal, /periodWindow=\{/, "and the page supplies the window");

  /* Compliance keeps its expiry-horizon semantics but gains a custom span. */
  assert.match(portal, /\{ value: "custom", label: "Between two dates…" \}/);
  assert.match(portal, /aria-label="Expiring from"/);
  assert.match(portal, /aria-label="Expiring until"/);
});

test("the calendar draws the compliance renewals its own heading promises", async () => {
  /*
   * The page has always said "booked visits, response deadlines and compliance
   * renewals in one schedule" and drew only the first two: `eventMap` was built
   * from `requests` alone, so every certificate expiry was invisible here.
   */
  /*
   * WORKSTREAM 4 moved the SHAPE, not the property.
   *
   * The event type, the day arithmetic, the overdue rule and the filters are
   * now in `calendar-model.ts`, which is pure and has a test suite of its own —
   * `portal-app.tsx` keeps the wiring. Every assertion below still proves what
   * it always proved: one shape for both sources, renewals placed on the grid,
   * and a click on one opening the certificate behind it. Only the address
   * changed. (Same move, same fix, as the note at stage-twentythree-sections
   * line 302.)
   *
   * ACCEPTANCE CORRECTION 1 moved it once more, and for a reason worth
   * recording: the owner went looking for the calendar on the BOARD'S Calendar
   * view tab and found a different component with none of this on it. The panel
   * both hosts mount is `calendar-surface.tsx`, so the click handler lives
   * there now while the page still supplies the register.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const model = await read("app/(app)/portal/calendar-model.ts");
  const surface = await read("app/(app)/portal/calendar-surface.tsx");
  assert.match(model, /export type CalendarEvent = \{/, "one shape for both sources");
  assert.match(model, /kind: CalendarEntity;/);
  assert.match(model, /export type CalendarEntity = "job" \| "compliance";/);
  assert.match(model, /for \(const record of complianceRecords\) \{/, "renewals are placed on the grid");
  assert.match(model, /title: `\$\{record\.kind\} renewal`/);
  assert.match(surface, /onOpenCompliance\(event\.recordId \?\? null\)/, "and clicking one opens the certificate");
  // And the page still hands the register to the grid in the first place.
  assert.match(portal, /complianceRecords: WorkspaceSnapshot\["compliance"\]/);
  assert.match(portal, /complianceRecords=\{complianceRecords\}/, "down into the panel");

  const css = await read("app/globals.css");
  assert.match(css, /\.calendar-event--renewal \{/, "a renewal reads differently from a job");
  assert.match(
    css.slice(css.indexOf(".calendar-event--renewal")),
    /var\(--purple-600\)[\s\S]{0,80}var\(--purple-100\)/,
    "theme tokens, not a hard-coded pale ground — both are defined in light and dark",
  );
});

test("the contractor register holds what a coordinator needs off it", async () => {
  /*
   * The row had a company name, an email and a phone number. Who to ask for,
   * where they are, what was agreed and what they charge all lived in somebody's
   * head — and the brief asks for all four.
   */
  const schema = await read("db/schema.ts");
  for (const column of ["contactName", "address", "notes", "dayRatePence"]) {
    assert.match(schema, new RegExp(`${column}:`), `contractors.${column} must exist`);
  }

  const init = await read("db/init.ts");
  for (const column of ["contact_name", "address", "notes", "day_rate_pence"]) {
    assert.match(
      init,
      new RegExp(`\\["contractors", "${column}"`),
      `${column} needs a guarded ALTER so existing databases gain it`,
    );
  }

  const api = await read("app/api/workspace/route.ts");
  assert.match(api, /contactName: contractor\.contactName/, "read");
  assert.match(api, /contactName: optionalText\(data\.contactName, 140\)/, "and written");
  assert.match(api, /function ratePence/, "pounds in, pence stored");
  assert.match(
    api,
    /if \(value === null \|\| value === undefined \|\| value === ""\) return null;/,
    "an empty rate box is not a rate of zero",
  );

  const form = await read("app/(app)/portal/workspace-data-manager.tsx");
  assert.match(form, /key: "contactName", label: "Contact person"/);
  assert.match(form, /key: "dayRate", label: "Day rate \(£\)"/);
  assert.match(form, /selected\.dayRate = typeof pence === "number" \? String\(pence \/ 100\) : ""/,
    "the rate must round-trip, or opening a contractor would wipe it");
});

test("Reports can answer the question a spend report is opened for", async () => {
  /*
   * Reports carried five panels and none of them was spend over time — the
   * chart existed only on Overview, so "is this quarter worse than the last"
   * could be answered on the dashboard but not on the report.
   *
   * RE-POINTED 2026-09-04. The fix for that gap was a `SpendTrend` widget, and
   * it overshot: the page then drew spend over time TWICE — the
   * `analytics-report-trend` panel and the widget beneath it, same rows, same
   * period, same title. The owner screenshotted the pair.
   *
   * So the contract is unchanged and now has two halves. Reports must still
   * show spend over time, with its honest empty state — and must show it ONCE.
   * The surviving chart is the panel, which is where it was before the widget
   * was added.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const reports = portal.slice(
    portal.indexOf("function ReportsView("),
    portal.indexOf("function TeamView("),
  );
  assert.ok(reports.length > 0, "ReportsView must still exist");

  assert.match(
    reports,
    /<h2>Spend trend<\/h2>/,
    "Reports must still chart spend over time",
  );
  /*
   * Counted over the RENDERED source only. The comments explaining why the
   * duplicate was removed naturally say "Spend trend" several times, and a pin
   * that counts prose would go red for describing its own subject.
   */
  const rendered = reports
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.equal(
    (rendered.match(/Spend trend/g) ?? []).length,
    1,
    "and exactly once — two identical charts make a reader invent a difference",
  );
  assert.match(
    reports,
    /spendTrend\.some\(\(point\) => point\.value > 0\)/,
    "no spend is an empty state, not a line pinned to the axis",
  );

  /*
   * The duplicate slot now carries job volume — the one candidate that is
   * absent from the product AND makes the chart above it more informative.
   * "Reactive vs planned" was rejected as the replacement because it is
   * already a widget on this same page, so it would have moved the
   * duplication rather than removed it. Pinned so it cannot come back.
   */
  assert.match(portal, /key: "job-volume-trend"/);
  assert.ok(
    !/key: "spend-trend"/.test(portal),
    "the duplicate spend widget must not return",
  );
  /*
   * Within THIS surface's list. Overview and Reports each draw their own
   * `DashboardWidgets` and legitimately share several keys — spend-budget,
   * contractor-spend and reactive-planned are on both pages — so a check over
   * the whole file would fail on a duplication that is not one. What must not
   * happen is the same panel twice on one page, which is the defect this test
   * now exists to prevent.
   */
  const widgetKeys = [...reports.matchAll(/key: "([a-z-]+)",\n\s*label:/g)].map((m) => m[1]);
  assert.ok(widgetKeys.length >= 5, `expected the Reports widget list, got ${widgetKeys.join(", ")}`);
  assert.equal(
    new Set(widgetKeys).size,
    widgetKeys.length,
    `Reports widget keys must be unique, got ${widgetKeys.join(", ")}`,
  );

  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  assert.match(insights, /export function JobVolumeTrend\(/);
  assert.match(
    insights,
    /periodVolumeSeries\(requests, period, now\)/,
    "volume must share the spend chart's bucketing, or the two lines are not comparable",
  );
  /*
   * Workstream 8 added `loading`: a panel drew "Nothing in this period" against
   * a named window during the first fetch — a finding about the portfolio, made
   * before the portfolio had been read. Pinned with the prop so it cannot be
   * dropped again.
   */
  assert.match(
    portal,
    /<JobVolumeTrend requests=\{scopedRequests\} period=\{period\} now=\{now\} loading=\{loading\} \/>/,
  );
  /*
   * And it must not claim a history nobody records. No status history exists in
   * this product, so "open jobs over time" cannot be drawn honestly; this
   * counts jobs by the date they were RAISED and says so.
   */
  assert.match(insights, /jobs by the date they were raised/i);
});

test("the desktop date cell shows a calendar, not just the browser's own picker", async () => {
  /*
   * The editor was a native `<input type="date">` and two buttons, so picking a
   * date meant whatever picker the browser happens to ship — a different
   * control in every one, and nothing like the grid monday shows.
   */
  const cell = await read("app/(app)/portal/cells/expiry-cell.tsx");
  assert.match(cell, /<span className="expiry-cell__calendar">/);
  assert.match(cell, /<MobileBoardCalendar[\s\S]{0,220}selectedStart=\{draftDate\}/, "the SAME calendar the phone sheet uses");
  assert.match(cell, /<input\s+className="expiry-cell__input"/, "typing a known date stays faster than clicking to it");

  const css = await read("app/(app)/portal/cells/expiry-cell.css");
  assert.match(
    css,
    /\.expiry-cell__calendar \{[\s\S]{0,120}position: absolute;/,
    "out of the flow — the board is table-layout:fixed on a 40px row and an inline grid would shove every row below it down",
  );
});

test("a system column cannot be shadowed by a board cell", async () => {
  /*
   * THE BUG THIS PINS. Contractor, Status, Priority and the rest are columns on
   * `maintenance_requests`; the board draws them from the request and every
   * other screen — the contractor register, the scorecard, exports, the
   * calendar — reads the same field.
   *
   * `update_cell` had no `system` check, so writing one stored a row in
   * `maintenance_board_cells` that shadowed the field without setting it.
   * Assigning a contractor that way left `request.contractor` null: the board
   * showed a name and the register went on saying nobody was assigned. Proven
   * against the preview — `update_cell` answered 200 and the job's contractor
   * was still null afterwards.
   *
   * Nothing in the UI does this (`saveCustomCell` is for custom columns, as its
   * name says), which is exactly why the route had to be the one to refuse.
   */
  const route = await read("app/api/board/route.ts");
  const cellAction = route.slice(route.indexOf('if (action === "update_cell")'));
  const guard = cellAction.slice(0, cellAction.indexOf("const [cell]"));
  assert.match(guard, /if \(column\.system\) \{/, "the route must refuse a system column");
  assert.match(
    guard,
    /PATCH \/api\/maintenance with \{ id, fields \}/,
    "and name the endpoint that does set the field, or the refusal is a dead end",
  );
  assert.ok(
    guard.indexOf("if (column.system)") < guard.indexOf("maintenanceBoardCells"),
    "the refusal must come before anything is written",
  );

  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /onSaveCustom=\{\(column, value\) =>\s*saveCustomCell\(request, column, value\)/,
    "the only caller stays the custom-column path");
});
