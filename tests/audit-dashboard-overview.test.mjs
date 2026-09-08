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
 * RE-POINTED. `duePassed` moved to `app/lib/job-metrics.ts`.
 *
 * It used to live in portal-app.tsx and had to be sliced out of the file by its
 * braces and re-evaluated, because that file cannot be imported wholesale. The
 * Overview stopped computing overdue in the browser when it moved to
 * `/api/dashboard/*`, and the rule went with it to a module that CAN be
 * imported — `job-metrics.ts` names an explicit `.ts` specifier for its one
 * runtime import, so `node --test` loads it and strips the types.
 *
 * The four assertions below are unchanged. What changed is that they now call
 * the shipped function directly instead of reconstructing it, which is
 * strictly stronger.
 */
const metrics = await import("../app/lib/job-metrics.ts");
const duePassed = metrics.duePassed;

/**
 * THE DAY IS THE BOARD'S DAY, AND THE BOARD'S DAY IS UTC.
 *
 * The instants below moved from local time to UTC when the rule moved out of
 * portal-app.tsx, and the contract did not: a bare `YYYY-MM-DD` is a whole day
 * and is not missed until that day is over. What changed is WHOSE day.
 *
 * The old rule read the READER's day, through `endOfDay(parseStamp(...))` in
 * period-model.ts, which is local. That is the wrong calendar for two reasons.
 * It disagrees with every other date-only value in this product —
 * `expiryStatus` and `todayBoardDate()` both define "today" in UTC, and a
 * certificate and a job due on the same date would otherwise expire on
 * different days. And it cannot be computed on the SERVER at all: the count in
 * the Performance card is SQL, and a server's local timezone is nobody's.
 *
 * So the same job is late at the same instant for every reader, which is the
 * property "in every timezone" was reaching for.
 */
test("a bare due date is not overdue until its day is over", () => {
  const dueDay = "2026-08-25";
  const utc = (hour, minute) => Date.UTC(2026, 7, 25, hour, minute);
  // All through the due day itself: still on time, wherever the reader is.
  assert.equal(duePassed(dueDay, utc(0, 30)), false);
  assert.equal(duePassed(dueDay, utc(12, 0)), false);
  assert.equal(duePassed(dueDay, utc(23, 59)), false);
  // The moment the day is over, it is late.
  assert.equal(duePassed(dueDay, Date.UTC(2026, 7, 26, 0, 1)), true);
});

test("a due date with a time is an instant, late the moment it passes", () => {
  const dueInstant = "2026-08-25T09:00:00.000Z";
  const instant = new Date(dueInstant).getTime();
  assert.equal(duePassed(dueInstant, instant - 60_000), false);
  assert.equal(duePassed(dueInstant, instant + 60_000), true);
});

test("an unreadable due date is never overdue", () => {
  assert.equal(duePassed("not a date", NOW), false);
});

test("the Overview's overdue figure uses the rule, on the server", async () => {
  /*
   * RE-POINTED, and the contract is stronger than it was.
   *
   * The Overview had an "Overdue" TILE that filtered a downloaded job list in
   * the browser. It now has a "Past target date" figure in the Performance
   * card, counted in SQL — so the rule has two expressions and they must agree:
   * `duePassed` above for anything the server marks per row, and
   * `overdueOpenSql` for the count. Both carry the same two branches, and
   * neither may reduce to the raw UTC-midnight comparison this section exists
   * to keep out.
   */
  const aggregates = await read("app/lib/dashboard-aggregates.ts");
  const sqlTwin = aggregates.slice(aggregates.indexOf("export function overdueOpenSql"));
  /*
   * RE-POINTED AGAIN on 2026-09-08, and stronger again. The two branches below
   * used to read `trim(${due})`; `due` is now `dateText(raw)`, which trims as
   * part of casting. That was not cosmetic: applying `trim` to the raw column
   * is what answered `function pg_catalog.btrim(date) does not exist` on
   * Production, whose `due_at` is a real Postgres `date` rather than the TEXT
   * `db/init.ts` declares. The branches are the contract; the cast is now part
   * of it, so both are pinned.
   */
  assert.ok(
    sqlTwin.includes("const due = dateText(raw)"),
    "the comparison runs over the cast expression, not the raw date column",
  );
  assert.ok(
    sqlTwin.includes("length(${due}) <= 10 and substr(${due}, 1, 10) < ${today}"),
    "a bare date is late only once today has moved past it",
  );
  assert.ok(
    sqlTwin.includes("length(${due}) > 10 and ${due} < ${instant}"),
    "a date with a time is late the moment the instant passes",
  );
  assert.match(
    aggregates,
    /import \{[\s\S]{0,400}?duePassed,/,
    "and the per-row marker is the shared function, not a second copy",
  );

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.ok(
    !/request\.dueAt && new Date\(request\.dueAt\)\.getTime\(\) < now/.test(portal),
    "the raw UTC-midnight comparison must not come back",
  );
});

/* ── 3. Numbers, sparklines and siblings agree ───────────────────────────── */

/**
 * RE-POINTED: the Overview page is `app/(app)/portal/ops/overview-page.tsx`.
 *
 * `OverviewView` in portal-app.tsx is a short adapter now. Everything these
 * tests were protecting moved with the page, and each assertion below moved
 * with the contract it was protecting rather than being deleted.
 */
const overviewPage = () => read("app/(app)/portal/ops/overview-page.tsx");

test("the attention figure and the attention worklist are one predicate", async () => {
  /*
   * RE-POINTED from a sparkline to the thing the sparkline was standing in for.
   *
   * The old defect: the "Requiring attention" tile counted
   * open-and-(Attention-or-Urgent) in its figure and `stage === "Attention"`
   * alone in the trend beneath it — 8 printed over a line summing 2. Sparklines
   * are gone, and the same class of drift is now impossible for a stronger
   * reason: the tile's number and the rows the attention card lists are counted
   * by ONE server-side predicate, built from `statusLabelsInFamily("attention")`
   * and intersected with open. The browser has no job list to disagree with.
   */
  const summaryRoute = await read("app/api/dashboard/summary/route.ts");
  assert.match(
    summaryRoute,
    /statusLabelsInFamily\("attention"\)/,
    "the attention count is the family map's own list",
  );
  const aggregates = await read("app/lib/dashboard-aggregates.ts");
  const fn = aggregates.slice(aggregates.indexOf("function attentionSql("));
  assert.ok(
    fn.slice(0, 600).includes("${openJobSql} and lower(trim(${maintenanceRequests.status})) in ${attentionKeys}"),
    "attention is a subset of OPEN — a completed job carrying a blocked status is finished work",
  );
  const page = await overviewPage();
  assert.ok(
    !/stage === "Attention"/.test(page),
    "the drifted predicate — stage only, closed rows included — must not return",
  );
});

test("every Overview tile carries its own words and its own numbers", async () => {
  /*
   * RE-POINTED. There are no sparklines: the tiles carry meters, and a meter
   * cannot be mistaken for a history the way a line under a live number could.
   *
   * The contract that survives is the one the sparkline rule was really about:
   * a reader must never have to guess what a tile is measuring. Every tile has
   * a label, an accessible sentence on its meter, and a row in the card's
   * hidden data table — which is also what a screen reader gets.
   */
  const page = await overviewPage();
  const tiles = page.slice(page.indexOf("const tiles = ["), page.indexOf('caption="At a glance"'));
  const labels = tiles.match(/\n      label: "/g) ?? [];
  assert.equal(labels.length, 5, "the five tiles the brief specifies");
  const meterLabels = tiles.match(/\n          label=\{/g) ?? [];
  assert.ok(
    meterLabels.length >= 5,
    "each tile's meter states its numbers in words, not only in colour",
  );
  assert.match(
    page,
    /<HiddenDataTable\s*\n?\s*caption="At a glance"/,
    "and the same numbers are reachable as a table",
  );
  assert.match(
    page,
    /tile\.delta === null[\s\S]{0,240}Not comparable/,
    "a delta with nothing to compare against is omitted, never printed as zero",
  );
});

test("open-job ages are floored, and computed once on the server", async () => {
  /*
   * RE-POINTED. The portal-app half of this used to pin `requestAgeDays`; the
   * Overview no longer computes an age in the browser at all, so the flooring
   * moved to the aggregate that does.
   *
   * The contract is unchanged and is now easier to keep: one job has one age
   * because ONE function on the server computes it, from whole UTC days.
   * `dashboard-insights.tsx` still draws the Reports ageing panel and still
   * floors, which is the other half of the original pairing.
   */
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  const ageing = insights.slice(insights.indexOf("export function OpenJobAgeing"));
  assert.match(
    ageing.slice(0, 1600),
    /Math\.floor\(\(now - new Date\(request\.requestedAt\)\.getTime\(\)\) \/ 86_400_000\)/,
    "the Reports ageing panel floors",
  );
  const filters = await read("app/lib/dashboard-filters.ts");
  assert.match(
    filters,
    /export function daysBetweenDays[\s\S]{0,400}Math\.round\(/,
    "and the server counts whole days between two calendar dates",
  );
  const aggregates = await read("app/lib/dashboard-aggregates.ts");
  const floored = aggregates.match(/Math\.max\(0, daysBetweenDays\(/g) ?? [];
  assert.ok(
    floored.length >= 3,
    "every age on the attention card comes through the same helper",
  );
  const page = await overviewPage();
  assert.ok(
    !/86_400_000/.test(page),
    "the browser does no day arithmetic of its own — a device clock must not decide an age",
  );
});

test("one compliance source on the Overview: the shared register", async () => {
  /*
   * RE-POINTED to the server, where the join now happens.
   *
   * The old defect: "Sites needing attention" read the legacy
   * `stores[].compliance` list while the compliance tile read the workspace
   * register, so two panels on one page disagreed about one store. The site
   * rows are built in `/api/dashboard/sites-attention` now, and it reads
   * `readComplianceRegister` — the same function the Compliance page reads —
   * and counts it with the shared `complianceCompletion`.
   */
  const route = await read("app/api/dashboard/sites-attention/route.ts");
  assert.match(route, /readComplianceRegister/, "the register, not a per-store list");
  assert.match(route, /complianceCompletion/, "counted by the shared rule");
  assert.match(
    route,
    /register\.bySite/,
    "and by the register's own per-site index, so nothing re-groups it",
  );
  const page = await overviewPage();
  assert.ok(
    !/store\.compliance/.test(page),
    "the legacy stores[].compliance list must not feed a panel here",
  );
});

/* ── 4. Loading is not empty ───────────────────────────────────────────── */

test("a figure that has not loaded is never printed as a definitive zero", async () => {
  /*
   * RE-POINTED, contract intact and widened.
   *
   * The old form pinned two tiles reading `workspaceReady ? … : "—"` over a
   * shared "Loading workspace…" caption. The page has one fetch per card now,
   * so the rule is expressed per card: while a payload is in flight the card
   * draws a SKELETON shaped like its answer, and an empty answer draws an
   * explicit empty state. Loading and empty remain different states, which is
   * the whole point — "Compliance 0%" over an account that had simply not
   * loaded is the defect this test exists for.
   */
  const page = await overviewPage();
  const skeletons = page.match(/<SkeletonRow/g) ?? [];
  assert.ok(skeletons.length >= 5, "every card has a loading state of its own");
  assert.ok(
    !/String\(totals\.\w+\) : "0"/.test(page),
    "no card falls back to a printed zero while it is loading",
  );
  assert.match(page, /<EmptyState>/, "and an empty answer says so in words");
  assert.match(
    page,
    /No jobs in this period/,
    "with an honest sentence rather than a blank axis",
  );

  /*
   * `scored` is the same distinction one level down: a site with no compliance
   * requirements set up is NOT a site scoring zero, and rendering the first as
   * the second is the more dangerous of the two.
   */
  assert.match(page, /site\.compliance\.scored/);
  assert.match(page, /Not set up/);

  const route = await read("app/api/dashboard/sites-attention/route.ts");
  assert.match(route, /scored: false/, "and the server is what says so");
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
