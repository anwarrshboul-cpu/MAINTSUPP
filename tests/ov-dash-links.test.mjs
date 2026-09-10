/**
 * §6 and §9.4 — every meter links to its section, with the right filter.
 *
 * ── WHAT "THE RIGHT FILTER" IS MEASURED AGAINST, AND WHY NOT THE DOM ──────
 *
 * The obvious test is to open each link and count the rows the board draws.
 * That was tried and it is the wrong instrument, for a reason worth writing
 * down because it will tempt the next person too.
 *
 * Measured on the development estate: `/api/maintenance` returns 123 rows;
 * `readDrillFilter("family=open")` keeps exactly 98 of them, which is exactly
 * what `loadOverviewMetrics` counts as open — the two agree to the row. The
 * BOARD then draws 82 of those 98. The missing 16 are all `Pending Approval`
 * sitting at `site-unassigned` with no group, and they are still missing after
 * scrolling to the bottom, so it is not virtualisation: `live-board.tsx` does
 * not draw a row whose group it cannot place. That is a pre-existing board
 * behaviour with nothing to do with this block, and a test that asserted the
 * DOM count would fail on it every run while the contract underneath was
 * perfect.
 *
 * So this asserts the CONTRACT: the set of rows a link's filter selects is the
 * set of rows the figure counted. That is the property §6 actually needs — the
 * list opens on the cohort the reader tapped — and it is the property that
 * would break silently if a link ever sent the display label where the source
 * label belongs.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const BASE = "http://localhost:5173";
const IDENTITY = "admin@sunnamusk-uk.test.maintsupp.com";
const headers = { "x-maintsupp-identity": IDENTITY, Accept: "application/json" };

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/overview/metrics`, {
      headers,
      signal: AbortSignal.timeout(4000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");

/** How many of the board's own rows a query string selects. */
function selects(rows, query) {
  const filter = readDrillFilter(new URLSearchParams(query), new Date());
  return rows.filter((row) => filter.matches(row)).length;
}

test("every drill selects exactly the rows its figure counted", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const metrics = await (await fetch(`${BASE}/api/overview/metrics`, { headers })).json();
  const rows = (await (await fetch(`${BASE}/api/maintenance?limit=1000`, { headers })).json())
    .requests ?? [];
  assert.ok(rows.length > 0, "the estate has rows to filter");

  const pipe = (labels) => labels.filter(Boolean).join("|");
  const cases = [
    ["Open jobs", "family=open", metrics.openJobs],
    ["Overdue", "family=open&overdue=1", metrics.kpis.find((k) => k.key === "overdue").value],
    ...metrics.jobsByStatus.map((slice) => [
      `status ${slice.label}`,
      `family=open&status=${encodeURIComponent(pipe(slice.labels))}`,
      slice.value,
    ]),
    ...metrics.priority.map((slice) => [
      `priority ${slice.label}`,
      `family=open&priority=${encodeURIComponent(pipe(slice.labels))}`,
      slice.value,
    ]),
    ...metrics.categories.map((slice) => [
      `category ${slice.label}`,
      `family=open&label=${encodeURIComponent(pipe(slice.labels))}`,
      slice.value,
    ]),
  ];

  for (const [name, query, expected] of cases) {
    assert.equal(
      selects(rows, query),
      expected,
      `${name}: the drill selects ${selects(rows, query)} where the figure says ${expected}`,
    );
  }
});

test("a grouped bucket carries every label it stands for", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  /*
   * The trap this closes: this estate has a category literally named "Other"
   * AND a grouped remainder. A link that sent the display word would open one
   * of them and claim to be both. Each slice therefore carries the SOURCE
   * labels it folded together, and the drill sends the list.
   */
  const metrics = await (await fetch(`${BASE}/api/overview/metrics`, { headers })).json();
  const other = metrics.categories.find((slice) => slice.label === "Other");
  if (!other) {
    t.skip("this estate has no grouped category bucket");
    return;
  }
  assert.ok(other.labels.length >= 1);
  if (other.labels.length > 1) {
    assert.ok(
      other.labels.includes("Other"),
      "the real category is inside the bucket that took its name",
    );
  }

  const rows = (await (await fetch(`${BASE}/api/maintenance?limit=1000`, { headers })).json())
    .requests ?? [];
  assert.equal(
    selects(rows, `family=open&label=${encodeURIComponent(other.labels.join("|"))}`),
    other.value,
    "and sending the whole list opens exactly the ring",
  );
});

test("every §6 destination is a real route the block links to", async () => {
  const block = await read("app/(app)/portal/ops/ov-dash.tsx");

  /* The routes, as the shell names them. */
  for (const route of [
    "/dashboard/jobs",
    "/dashboard/units",
    "/dashboard/compliance",
    "/dashboard/reports",
  ]) {
    assert.ok(block.includes(route), `the block links to ${route}`);
  }

  /*
   * Overdue and the SLA gauge open the OVERDUE list, not the open list.
   *
   * They opened `family=open` — the honest superset — until `board-drill-filter`
   * learned an `overdue` dimension, because a parameter the board cannot read
   * would draw a chip claiming a filter that never happened. It reads one now,
   * so the list is the figure rather than a superset of it.
   */
  assert.match(
    block,
    /OVERDUE_ONLY: Readonly<Record<string, string>> = \{ family: "open", overdue: "1" \}/,
    "overdue is sent as a dimension the board actually reads",
  );

  /* And the point-in-time drills deliberately carry no window. */
  assert.match(
    block,
    /OPEN_ONLY: Readonly<Record<string, string>> = \{ family: "open" \}/,
    "open drills carry no period, because openScope carries no date bound",
  );
});

test("the portfolio travels with a drill, as sites the board can read", async (t) => {
  const block = await read("app/(app)/portal/ops/ov-dash.tsx");
  /*
   * §6: "Links always carry the current portfolio and date range." A portfolio
   * is a `site_groups` row and the board's filter speaks `site=`, so sending
   * the group id would narrow nothing — the reader taps a figure counted over
   * two stores and opens the whole estate.
   */
  assert.match(block, /next\.set\("site", portfolioSites\)/, "a drill carries the portfolio's sites");

  if (!(await serverIsUp())) {
    t.skip("no development server for the payload half");
    return;
  }
  const metrics = await (await fetch(`${BASE}/api/overview/metrics`, { headers })).json();
  assert.ok(Array.isArray(metrics.portfolio.siteIds), "the payload supplies them");
  assert.deepEqual(metrics.portfolio.siteIds, [], "and sends none for All portfolios");

  if (metrics.portfolios.length > 0) {
    const scoped = await (
      await fetch(`${BASE}/api/overview/metrics?portfolio=${encodeURIComponent(metrics.portfolios[0].id)}`, { headers })
    ).json();
    assert.equal(scoped.portfolio.id, metrics.portfolios[0].id);
    assert.ok(
      Array.isArray(scoped.portfolio.siteIds),
      "a chosen portfolio names the sites it is made of",
    );
  }
});

test("the block draws no table and no text list", async () => {
  /*
   * §1: the two crossed-out panels are replaced by VISUAL widgets. A table
   * creeping back in is the easiest way to lose that, and it would not look
   * like a regression to anybody reading a diff.
   */
  const block = await read("app/(app)/portal/ops/ov-dash.tsx");
  const code = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  for (const tag of ["<table", "<thead", "<tbody", "<tr", "<td", "<th "]) {
    assert.ok(!code.includes(tag), `the block renders no ${tag}> element`);
  }
});
