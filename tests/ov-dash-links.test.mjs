/**
 * §6 and §9.4 — every meter links to its section, with the right filter.
 *
 * ── WHAT "THE RIGHT FILTER" IS MEASURED AGAINST, AND WHY NOT THE DOM ──────
 *
 * The obvious test is to open each link and count the rows the board draws.
 * That was tried and it is the wrong instrument, for a reason worth writing
 * down because it will tempt the next person too.
 *
 * Measured on the development estate when this was written: `/api/maintenance`
 * returned 123 rows, `readDrillFilter("family=open")` kept 98, which was
 * exactly what `loadOverviewMetrics` counted as open — and the BOARD drew 82.
 * The missing 16 were all `Pending Approval` at `site-unassigned`, and this
 * header first put that down to rows the board "cannot place in a group".
 *
 * CORRECTED 2026-09-11, after tracing it: the 16 were Store Documentation
 * register rows — request rows placed on the `store-documentation` board, which
 * the Jobs board narrows away on purpose because a store is not a job. The
 * figure and the drill were BOTH wrong, and agreed with each other: every
 * aggregate counted every live request whichever board it lived on. The fix is
 * the population (`jobsBoardCondition` / `isOnJobsBoard`, pinned in
 * `tests/jobs-board-population.test.mjs`), and the estate now reads 82 open,
 * drilled 82, drawn 82. A separate, genuine render drop — a placement naming a
 * binned or foreign group — is fixed there too.
 *
 * The DOM is still the wrong instrument for THIS file: the board defers rows
 * and virtualises groups with `content-visibility`, so counting drawn rows
 * measures the viewport rather than the contract.
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

test("the destination pages read the filters the block sends them", async () => {
  /*
   * §6: "If a destination page does not yet read these filters from the URL,
   * add that filtering to that page so the numbers it shows match the number
   * clicked." Three pages did not, and each needed a different answer.
   */

  /*
   * SITES — the one that mattered most. "Requiring attention" counts DISTINCT
   * SITES with at least one open job that is high or medium priority, or
   * overdue, so no jobs filter can reproduce it: a link to the unfiltered
   * register showed 128 rows under a figure of 7. The register now takes a
   * `sites=` list, and measured after the change it shows exactly 7.
   *
   * `sites` PLURAL is deliberate: `site` is already the site DETAIL deep link
   * in `sites-manager.tsx`, and a pipe-joined list handed to that would ask
   * for a site whose id is "a|b|c" and open nothing.
   */
  const sitesList = await read("app/(app)/portal/ops/sites-list.tsx");
  assert.match(sitesList, /params\.getAll\("sites"\)/, "the register reads a sites list");
  assert.match(
    sitesList,
    /if \(onlySites\.size && !onlySites\.has\(site\.id\)\) return false;/,
    "and filters on it",
  );
  assert.match(sitesList, /key: "sites",/, "with a chip, so the narrowing is visible and undoable");

  const manager = await read("app/(app)/portal/sites/sites-manager.tsx");
  assert.match(
    manager,
    /const SITE_PARAM = "site";/,
    "the single-site detail deep link is left exactly as it was",
  );

  /*
   * UNITS — one site, because that is what its control is. The brief's
   * instruction was to consume supported filters "without inventing semantics
   * that do not exist", and this screen's filter is a single-site select. A
   * caller that cannot name one site sends nothing.
   */
  const units = await read("app/(app)/portal/assets/assets-manager.tsx");
  assert.match(units, /new URLSearchParams\(window\.location\.search\)\.get\("site"\)/);
  assert.match(units, /wanted\.includes\("\|"\) \? "" : wanted\.trim\(\)/, "a list is not one site");

  /*
   * REPORTS — a month, in the period model's own token (`month:YYYY-MM`).
   * `reportPeriod` rather than `period` because the ops pages carry a `period`
   * of their own under the same `/dashboard` prefix, and a collision would let
   * one screen's window silently become another's.
   */
  const picker = await read("app/(app)/portal/period-picker.tsx");
  assert.match(picker, /\.get\("reportPeriod"\)/, "Reports reads a range from the address bar");
  assert.match(picker, /if \(wanted && isValid\(wanted\)\) return wanted;/, "and validates it");
  assert.doesNotMatch(
    picker,
    /localStorage\.setItem\(key, wanted\)/,
    "a link is a visit, not a preference — it is not written back to storage",
  );

  const block = await read("app/(app)/portal/ops/ov-dash.tsx");
  assert.match(block, /reportPeriod=month:\$\{month\}#overview/, "and the spend point sends one");
  assert.match(block, /ROUTE\.sites, \{ sites: pipe\(data\?\.attentionSiteIds \?\? \[\]\) \}/);
});

test("the attention figure and the ids it links to are the same set", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const metrics = await (await fetch(`${BASE}/api/overview/metrics`, { headers })).json();
  const kpi = metrics.kpis.find((entry) => entry.key === "attention");
  assert.equal(
    kpi.value,
    metrics.attentionSiteIds.length,
    "the tile's number IS the length of the list it opens",
  );
  assert.equal(
    new Set(metrics.attentionSiteIds).size,
    metrics.attentionSiteIds.length,
    "and the ids are distinct, because the figure counts distinct sites",
  );
});
