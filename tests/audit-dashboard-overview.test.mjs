/**
 * Audit S2 — the Dashboard Overview reconciles against its own data.
 *
 * Three families of defect are pinned here, all found by computing every
 * Overview figure independently from /api/maintenance and /api/workspace and
 * comparing the results with the rendered DOM:
 *
 * 1. MERGED AXIS LABELS. `periodColumns` merges weekly buckets into at most
 *    six columns, and the merged label used to read
 *    `${first.label}–${last.label}` — the last MEMBER'S START, not the span's
 *    end. On "Last 90 days" the first column read "27 May–8 Jun" while
 *    holding rows through 14 Jun, and the next began "15 Jun": six days of
 *    real, counted work sat under a label that excludes them.
 *
 * 2. THE OVERDUE RULE. `new Date(dueAt) < now` reads a bare "2026-08-25" as
 *    UTC midnight, so a job was flagged overdue DURING the day it was due, at
 *    an hour that depended on the reader's timezone. A bare date means the
 *    whole day; a stamp with a time is an instant.
 *
 * 3. NUMBERS AND THEIR SPARKLINES / SIBLINGS AGREEING. The "Requiring
 *    attention" card counted open-and-(Attention-or-Urgent) in its figure and
 *    `stage === "Attention"` alone in its sparkline (8 over a line summing 2);
 *    the ageing panel rounded ages while the attention table floored them
 *    (61 days and 60 days for the same job on one screen); and the "Sites
 *    needing attention" panel read the legacy `stores[].compliance` list while
 *    the compliance tile read the workspace register.
 *
 * Every read here normalises CRLF first: this suite runs on a Windows
 * checkout where `git` writes CRLF, and the older extraction-style tests fail
 * on that alone — a lesson this file does not repeat.
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
    },
  }).outputText;
}

const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

const metersUrl = asModule(
  transpile(await read("app/(app)/portal/dashboard-meters.ts")),
);
const period = await import(
  asModule(
    transpile(await read("app/(app)/portal/period-model.ts")).replace(
      /from ["']\.\/dashboard-meters["']/g,
      `from "${metersUrl}"`,
    ),
  )
);

const DAY = 86_400_000;
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

/* ── 1. Merged column labels name the span they cover ────────────────────── */

// The DOM case, frozen: 25 Aug 2026, half past midnight local.
const NOW = at(2026, 8, 25, 0, 30);

test("a merged weekly column is labelled to its last covered day", () => {
  const columns = period.periodColumns("90", NOW, [], 6);
  assert.equal(columns.length, 5, "fourteen weekly buckets merge into five");
  // Covered: 27 May (window start) through 14 Jun (end of the week of 8 Jun).
  assert.equal(columns[0].label, "27 May–14 Jun");
  // NOT the old "27 May–8 Jun", which excluded six days the column counts.
  assert.equal(columns[1].label, "15 Jun–5 Jul");
});

test("adjacent merged columns leave no phantom gap on the axis", () => {
  const columns = period.periodColumns("90", NOW, [], 6);
  for (let index = 1; index < columns.length; index += 1) {
    // The buckets themselves were always continuous…
    assert.equal(
      columns[index].start,
      columns[index - 1].end,
      "columns must tile the window",
    );
    // …and now the words agree: each label ends the day before the next
    // begins, so no date on the axis appears to belong to no column.
    const endOfLabel = period.parseStamp(
      `2026-${String(new Date(columns[index - 1].end - 1).getMonth() + 1).padStart(2, "0")}-${String(new Date(columns[index - 1].end - 1).getDate()).padStart(2, "0")}`,
    );
    const startOfNext = period.startOfDay(columns[index].start);
    assert.ok(
      startOfNext - endOfLabel <= DAY,
      `label gap between "${columns[index - 1].label}" and "${columns[index].label}"`,
    );
  }
});

test("every row in the period lands in exactly one merged column", () => {
  const columns = period.periodColumns("90", NOW, [], 6);
  // One stamp per day across the window — including 9–14 Jun, the days the
  // old label seemed to orphan — plus both exact edges.
  const { start, end } = period.resolveBounds("90", NOW, []);
  const stamps = [start, end];
  for (let day = start; day <= end; day += DAY) stamps.push(day);
  for (const stamp of stamps) {
    const hits = columns.filter(
      (column) => stamp >= column.start && stamp < column.end,
    ).length;
    const placed = period.bucketFor(columns, stamp);
    assert.ok(placed >= 0, `stamp ${new Date(stamp).toISOString()} lost`);
    assert.ok(hits <= 1, "no stamp may be claimed by two columns");
  }
});

test("month-sized merges keep month names — a month already names its span", () => {
  const buckets = period.periodBuckets("all", NOW, [at(2015, 9, 2), NOW]);
  assert.ok(buckets.length <= 36);
  const merged = buckets.find((bucket) => bucket.label.includes("–"));
  assert.ok(merged, "an eleven-year span must merge");
  assert.match(
    merged.label,
    /^[A-Z][a-z]{2} \d{2}–[A-Z][a-z]{2} \d{2}$/,
    "merged month labels stay month–month, never month–day-of-month",
  );
});

/* ── 2. The overdue rule ─────────────────────────────────────────────────── */

/**
 * `duePassed` lives in portal-app.tsx, which cannot be imported wholesale
 * (JSX, client hooks). It is a pure function, so it is extracted by its
 * braces and evaluated with the two period-model helpers it closes over —
 * real shipped code, not a re-implementation.
 */
async function loadDuePassed() {
  const source = await read("app/(app)/portal/portal-app.tsx");
  const start = source.indexOf("function duePassed(");
  assert.ok(start > 0, "duePassed has moved; fix this test");
  const body = source.slice(start);
  const end = body.indexOf("\n}\n");
  assert.ok(end > 0, "duePassed must end with a brace at column zero");
  const fn = body
    .slice(0, end + 3)
    .replace("(dueAt: string, now: number)", "(dueAt, now)");
  return new Function(
    "endOfDay",
    "parseStamp",
    `${fn}; return duePassed;`,
  )(period.endOfDay, period.parseStamp);
}

test("a bare due date is not overdue until its day is over", async () => {
  const duePassed = await loadDuePassed();
  const dueDay = "2026-08-25";
  // All through the due day itself: still on time, in every timezone.
  assert.equal(duePassed(dueDay, at(2026, 8, 25, 0, 30)), false);
  assert.equal(duePassed(dueDay, at(2026, 8, 25, 12, 0)), false);
  assert.equal(duePassed(dueDay, at(2026, 8, 25, 23, 59)), false);
  // The moment the day is over, it is late.
  assert.equal(duePassed(dueDay, at(2026, 8, 26, 0, 1)), true);
});

test("a due date with a time is an instant, late the moment it passes", async () => {
  const duePassed = await loadDuePassed();
  const dueInstant = "2026-08-25T09:00:00.000Z";
  const instant = new Date(dueInstant).getTime();
  assert.equal(duePassed(dueInstant, instant - 60_000), false);
  assert.equal(duePassed(dueInstant, instant + 60_000), true);
});

test("an unreadable due date is never overdue", async () => {
  const duePassed = await loadDuePassed();
  assert.equal(duePassed("not a date", NOW), false);
});

test("the Overview's overdue tile uses the rule", async () => {
  const source = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    source,
    /request\.dueAt && duePassed\(request\.dueAt, now\)/,
    "the overdue filter must go through duePassed",
  );
  assert.ok(
    !/request\.dueAt && new Date\(request\.dueAt\)\.getTime\(\) < now/.test(source),
    "the raw UTC-midnight comparison must not come back",
  );
});

/* ── 3. Numbers, sparklines and siblings agree ───────────────────────────── */

/** The OverviewView component only — same slice the stage-19 tests use. */
async function overviewSource() {
  const source = await read("app/(app)/portal/portal-app.tsx");
  const start = source.indexOf("function OverviewView({");
  const end = source.indexOf("\nexport function LegacyMaintenanceView", start);
  assert.ok(start > 0 && end > start);
  return source.slice(start, end);
}

test("the Requiring attention card's sparkline plots the card's own rows", async () => {
  const overview = await overviewSource();
  assert.match(
    overview,
    /label="Requiring attention"[^/]*trend=\{periodTrend\(attention, \(\) => true, period, now\)\}/,
    "the trend must be built from the same rows as the number above it",
  );
  assert.ok(
    !/periodTrend\(scopedRequests, \(request\) => request\.stage === "Attention"/.test(
      overview,
    ),
    "the drifted predicate — stage only, closed rows included — must not return",
  );
});

test("every Overview tile says what its sparkline plots", async () => {
  const overview = await overviewSource();
  const cards = overview.match(/<AnalyticsMetricCard /g) ?? [];
  const labelled = overview.match(/trendLabel="/g) ?? [];
  assert.equal(cards.length, 6, "the six tiles");
  assert.equal(
    labelled.length,
    6,
    "a sparkline under a live number reads as that number's history; each must carry its own sentence saying what it actually is",
  );
});

test("open-job ages are floored everywhere, so one job has one age", async () => {
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  const ageing = insights.slice(insights.indexOf("export function OpenJobAgeing"));
  assert.match(
    ageing.slice(0, 1600),
    /Math\.floor\(\(now - new Date\(request\.requestedAt\)\.getTime\(\)\) \/ 86_400_000\)/,
    "the ageing panel must floor, as requestAgeDays in portal-app.tsx does",
  );
  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /Math\.floor\(\(now - new Date\(request\.requestedAt\)\.getTime\(\)\) \/ 86_400_000\)/,
    "requestAgeDays floors — the two lists sit on the same page",
  );
});

test("one compliance source on the Overview: the workspace register", async () => {
  const overview = await overviewSource();
  assert.match(
    overview,
    /<SiteAttention[^>]*\n?\s*requests=\{scopedRequests\}\n?\s*compliance=\{complianceItems\}/,
    "Sites needing attention must read the register the tile reads",
  );
  assert.ok(
    !/store\.compliance\.map/.test(overview),
    "the legacy stores[].compliance list must no longer feed a panel here",
  );
});

/* ── 4. Loading is not empty ─────────────────────────────────────────────── */

test("workspace figures say Loading, not a definitive empty claim, before the fetch lands", async () => {
  const overview = await overviewSource();
  // The two workspace-fed tiles show a dash and say they are loading.
  assert.match(overview, /workspaceReady \? String\(activeUnitCount\) : "—"/);
  assert.match(overview, /workspaceReady \? `\$\{compliancePercent\}%` : "—"/);
  const loadingCaptions = overview.match(/"Loading workspace…"/g) ?? [];
  assert.ok(loadingCaptions.length >= 2, "both tiles need the loading caption");
  // The honest empty captions survive for the truly-empty account.
  assert.ok(overview.includes("Add units to the register"));
  assert.ok(overview.includes("No requirements recorded yet"));
  /*
   * And the two panels are told when they are still loading.
   *
   * Workstream 8 widened this. Both draw their bars from `requests`, which
   * arrives on a SEPARATE fetch from the workspace — so waiting only on
   * `workspaceReady` still let them announce that a site had spent nothing
   * against its budget while the jobs were in flight. Pinned in the stronger
   * form so it cannot quietly narrow back to one fetch.
   */
  assert.match(overview, /<SiteAttention[\s\S]{0,400}loading=\{!workspaceReady \|\| loading\}/);
  assert.match(overview, /<SpendAgainstBudget[\s\S]{0,400}loading=\{!workspaceReady \|\| loading\}/);
  assert.match(overview, /const loading = !jobsReady;/, "and the jobs fetch has a name");

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /workspaceReady=\{workspace !== null\}/,
    "the shell must say whether /api/workspace has answered",
  );

  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  assert.match(
    insights,
    /loading \? \(\s*<div className="insight-empty" aria-busy="true">/,
    "InsightPanel must draw a loading state distinct from its empty state",
  );
});

/* ── 5. The by-priority split cannot be captioned with wreckage ──────────── */

test("a stringified object is not a priority", async () => {
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  const start = insights.indexOf("function priorityLabel(");
  assert.ok(start > 0, "priorityLabel must exist — 22 imported rows carry '[object Object]' as their priority");
  const body = insights.slice(start);
  const fn = body
    .slice(0, body.indexOf("\n}\n") + 3)
    .replace("(value: unknown): string", "(value)");
  const priorityLabel = new Function(`${fn}; return priorityLabel;`)();
  assert.equal(priorityLabel("[object Object]"), "Priority not recorded");
  assert.equal(priorityLabel("undefined"), "Priority not recorded");
  assert.equal(priorityLabel(null), "Priority not recorded");
  assert.equal(priorityLabel(" Medium "), "Medium");
  const sla = insights.slice(insights.indexOf("export function SlaPerformance"));
  assert.match(
    sla.slice(0, 2600),
    /priorityLabel\(request\.priority\)/,
    "the split must go through the guard",
  );
});
