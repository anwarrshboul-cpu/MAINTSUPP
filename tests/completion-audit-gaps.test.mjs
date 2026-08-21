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
  assert.match(
    route,
    /record\.sort === "asc" \|\| record\.sort === "desc" \? record\.sort : undefined/,
    "and survive the settings round trip, with anything else dropped",
  );

  const board = await read("app/(app)/portal/live-board.tsx");
  assert.match(board, /settings: \{ \.\.\.column\.settings, sort: direction \}/, "written on sort");
  assert.match(board, /allBoardColumns\.find\(\(entry\) => entry\.column\.settings\.sort\)/, "read back on load");
  assert.match(board, /const \{ sort: _dropped, \.\.\.rest \} = stale\.column\.settings/, "and the previous holder is cleared");
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
  assert.match(portal, /if \(!withinPeriod\(request\.dueAt\)\) continue;/, "Planned filters what it draws");

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
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /type CalendarEvent = \{/, "one shape for both sources");
  assert.match(portal, /kind: "job" \| "compliance";/);
  assert.match(portal, /for \(const record of complianceRecords\) \{/, "renewals are placed on the grid");
  assert.match(portal, /title: `\$\{record\.kind\} renewal`/);
  assert.match(portal, /onOpenCompliance\(event\.recordId \?\? null\)/, "and clicking one opens the certificate");

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
   */
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  assert.match(insights, /export function SpendTrend\(/);
  assert.match(insights, /periodSpendSeries\(requests, period, now\)/, "the same series Overview plots");
  assert.match(
    insights,
    /!series\.some\(\(point\) => point\.value > 0\)/,
    "no spend is an empty state, not a line pinned to the axis",
  );

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /key: "spend-trend"/, "and it is a Reports widget");
  assert.match(portal, /<SpendTrend requests=\{scopedRequests\} period=\{period\} now=\{now\} \/>/);
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
