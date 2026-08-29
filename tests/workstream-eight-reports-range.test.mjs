/**
 * Workstream 8 — live Reports, and a date range that belongs to its page.
 *
 * The range vocabulary itself was built in Stage 23 and is pinned by
 * `stage-twentythree-period.test.mjs`: seventeen exact calendar edges, leap
 * day, backwards ranges, both stored stamp forms, adjacent periods never both
 * claiming a row. None of that is repeated here. This file pins what the audit
 * found still wrong underneath it, and it falls into three groups.
 *
 * 1. TIME THAT ONLY BREAKS TWICE A YEAR. `resolvePeriod` stepped a day with
 *    `- DAY_MS`, which is a day only where every day is 24 hours long. The
 *    suite ran one fixed `NOW` in July, in the machine's own zone, so a whole
 *    class of defect was invisible: "Yesterday" returned a 59-minute window
 *    over the wrong date after a spring-forward, "Last week" dropped a Sunday,
 *    and a daily chart grew a 32nd bar in a 31-day month. Those assertions run
 *    in a child process with TZ pinned, because that is the only way to see
 *    them — the same device `workstream-four-calendar-model.test.mjs` uses.
 *
 * 2. ROWS THAT ARE NOT WORK ORDERS. A subitem is a full row of
 *    `maintenance_requests` whose parent is another row, and an archived row
 *    is one somebody took off the board. The jobs board has always filtered
 *    both; the reporting screens counted them, so a job split into three
 *    visits was four work orders and its parts cost was added to its parent's.
 *
 * 3. CLAIMS MADE BEFORE THE DATA ARRIVES. `requests` starts as an empty array,
 *    so every empty-state sentence on Reports was printed during the first
 *    load: "Nothing in this period", "no work orders were raised", "there is
 *    nothing to rank". Overview learned this distinction for its workspace
 *    tiles in Stage 19 and the wording there still governs — loading and empty
 *    are different states, and a dashboard must not present one as the other.
 *
 * WHY SOME OF THIS IS A SOURCE ASSERTION
 *
 * `period-model.ts` is pure TypeScript and is CALLED here, as it is in Stage
 * 23's suite. The surfaces live in `portal-app.tsx`, a 4,700-line "use client"
 * component whose import graph does not transpile from `node --test`; the same
 * decision, for the same reason, as every other UI suite in this directory.
 * What is checked there is what a reviewer would check by reading.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const readSync = (file) => readFileSync(path.join(root, file), "utf8");

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

const PORTAL = "app/(app)/portal/portal-app.tsx";
const PICKER = "app/(app)/portal/period-picker.tsx";
const SURFACE = "app/(app)/portal/calendar-surface.tsx";
const CSS = "app/brand-overrides.css";

/** The body of one component in portal-app.tsx, up to the next top-level one. */
function componentBody(source, name) {
  const from = source.indexOf(`function ${name}(`);
  assert.ok(from > 0, `${name} is not in ${PORTAL}`);
  const rest = source.slice(from);
  const to = rest.indexOf("\nfunction ");
  return to > 0 ? rest.slice(0, to) : rest;
}

/*
 * Real files in a temp directory rather than a data: URL on the command line:
 * the transpiled model is far past the length Windows accepts as a `node -e`
 * argument. Same modules, resolved as siblings.
 */
function runInZones(probeSource) {
  const dir = mkdtempSync(path.join(tmpdir(), "ws8-period-"));
  writeFileSync(
    path.join(dir, "dashboard-meters.mjs"),
    transpile(readSync("app/(app)/portal/dashboard-meters.ts")),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "period-model.mjs"),
    transpile(readSync("app/(app)/portal/period-model.ts")).replace(
      /from ["']\.\/dashboard-meters["']/g,
      'from "./dashboard-meters.mjs"',
    ),
    "utf8",
  );
  const probe = path.join(dir, "probe.mjs");
  writeFileSync(probe, probeSource, "utf8");
  const run = (timeZone) =>
    JSON.parse(
      execFileSync(process.execPath, [probe], {
        env: { ...process.env, TZ: timeZone },
        encoding: "utf8",
      }),
    );
  return {
    UTC: run("UTC"),
    London: run("Europe/London"),
    LosAngeles: run("America/Los_Angeles"),
    Auckland: run("Pacific/Auckland"),
  };
}

/* ── 1. A day is a calendar day, in every zone ───────────────────────────── */

test("a named day is that whole day, on both sides of a clock change", () => {
  /*
   * 8 March 2026 is the US spring-forward. A reader on the 9th asking for
   * "Yesterday" wants the 8th — all of it. Stepping back 86,400,000ms from
   * local midnight on the 9th lands at 23:00 on the 7th, so the window was
   * 59 minutes long, over the wrong date, and the caption read "7 Mar 2026"
   * with complete confidence. Every job raised on the 8th was dropped.
   */
  const out = runInZones(`
    import * as period from "./period-model.mjs";
    const now = new Date(2026, 2, 9, 12, 0, 0).getTime();
    const y = period.resolvePeriod("yesterday", now);
    const early = new Date(2026, 2, 8, 0, 30, 0).getTime();
    const late = new Date(2026, 2, 8, 23, 30, 0).getTime();
    const w = period.resolvePeriod("week-1", now);
    const sunday = new Date(2026, 2, 8, 15, 0, 0).getTime();
    process.stdout.write(JSON.stringify({
      label: y.label,
      startHour: new Date(y.start).getHours(),
      endHour: new Date(y.end).getHours(),
      spanHours: Math.round((y.end - y.start) / 3600000),
      earlyIn: early >= y.start && early <= y.end,
      lateIn: late >= y.start && late <= y.end,
      weekStartDate: new Date(w.start).getDate(),
      weekEndDate: new Date(w.end).getDate(),
      sundayIn: sunday >= w.start && sunday <= w.end,
    }));
  `);

  for (const [zone, seen] of Object.entries(out)) {
    assert.equal(seen.label, "8 Mar 2026", `${zone} named the wrong day`);
    assert.equal(seen.startHour, 0, `${zone} did not start Yesterday at midnight`);
    assert.equal(seen.endHour, 23, `${zone} did not end Yesterday at 23:59`);
    /*
     * A day is as long as the clock made it. 8 March 2026 is 23 hours in Los
     * Angeles and 24 everywhere else here, and getting 23 there is the proof
     * that the window follows the calendar rather than a multiple of
     * 86,400,000 — the old arithmetic produced a 24-hour span that therefore
     * had to start an hour early, on the previous date.
     */
    assert.ok(
      seen.spanHours >= 23 && seen.spanHours <= 25,
      `${zone} made Yesterday ${seen.spanHours}h long`,
    );
    assert.ok(seen.earlyIn, `${zone} lost a job raised at 00:30 on the 8th`);
    assert.ok(seen.lateIn, `${zone} lost a job raised at 23:30 on the 8th`);

    // "Last week" is Monday 2 March to Sunday 8 March, and the 8th is the day
    // the transition falls on — the one most easily lost.
    assert.equal(seen.weekStartDate, 2, `${zone} started Last week on the wrong date`);
    assert.equal(seen.weekEndDate, 8, `${zone} ended Last week on the wrong date`);
    assert.ok(seen.sundayIn, `${zone} dropped Sunday out of Last week`);
  }

  /*
   * And the transition is genuinely being felt, rather than the zones all
   * quietly resolving to the same offsets — which would make every assertion
   * above pass without proving anything.
   */
  assert.equal(
    out.LosAngeles.spanHours,
    23,
    "8 March is a 23-hour day in Los Angeles; the probe is not seeing the clock change",
  );
  assert.equal(out.UTC.spanHours, 24, "UTC has no transition on 8 March");
});

test("a month of daily buckets has one bucket per day, at midnight", () => {
  /*
   * October in London and November in Los Angeles both contain a transition.
   * Stepping the bucket edge by DAY_MS gave October a 32nd bar and November
   * only 30 of the 31 it needed, and after the transition every edge sat at
   * 01:00 or 23:00 — so a job stamped in the first hour of a day was drawn
   * under the day before it.
   */
  const out = runInZones(`
    import * as period from "./period-model.mjs";
    const now = new Date(2026, 2, 9, 12, 0, 0).getTime();
    const report = {};
    for (const token of ["month:2026-10", "month:2026-11", "month:2026-03"]) {
      const buckets = period.periodBuckets(token, now, []);
      report[token] = {
        count: buckets.length,
        offMidnight: buckets.filter((b) => new Date(b.start).getHours() !== 0).length,
      };
    }
    process.stdout.write(JSON.stringify(report));
  `);

  const expected = { "month:2026-10": 31, "month:2026-11": 30, "month:2026-03": 31 };
  for (const [zone, seen] of Object.entries(out)) {
    for (const [token, days] of Object.entries(expected)) {
      assert.equal(
        seen[token].count,
        days,
        `${zone} drew ${seen[token].count} bars for the ${days} days of ${token}`,
      );
      assert.equal(
        seen[token].offMidnight,
        0,
        `${zone} put ${seen[token].offMidnight} ${token} buckets off midnight`,
      );
    }
  }
});

/* ── 2. A bucket is not a bin for everything else ────────────────────────── */

test("a row outside the period is in none of its buckets", () => {
  /*
   * `bucketFor` sweeps a row past the final edge into the last bucket, which
   * is deliberate and stays — a to-date period ends at midnight tonight and a
   * job logged this afternoon belongs on the last bar. It had no upper bound,
   * so a row dated next December was drawn on 31 July, and `periodTrend`
   * clamped at BOTH ends, guaranteeing an out-of-window row a bar somewhere.
   * Both are exported for the insight panels, so neither can rely on a caller
   * having scoped first.
   */
  const now = new Date(2026, 6, 20, 12, 0, 0).getTime();
  const rows = [
    { requestedAt: "2026-07-15", cost: 100 }, // in
    { requestedAt: "2026-12-25", cost: 999 }, // far future
    { requestedAt: "2020-01-05", cost: 555 }, // far past
  ];

  const series = period.periodSpendSeries(rows, "month:2026-07", now);
  assert.equal(
    series.reduce((sum, point) => sum + point.value, 0),
    100,
    "spend from outside the period was drawn inside it",
  );

  const counts = period.periodTrend(rows, () => true, "month:2026-07", now);
  assert.equal(
    counts.reduce((sum, n) => sum + n, 0),
    1,
    "the sparkline counted rows from outside its own period",
  );

  /*
   * The in-period row is still drawn, in exactly one bucket. Asserted on the
   * values rather than the label, because `periodBuckets` thins axis labels
   * for legibility — a bucket can carry a value and no caption, which is a
   * property `stage-twentythree-period.test.mjs` pins in its own right.
   */
  const carrying = series.filter((point) => point.value !== 0);
  assert.equal(carrying.length, 1, "the in-period row was lost, or spread");
  assert.equal(carrying[0].value, 100);
});

test("all records still means all records", () => {
  // The guard above must not close the open ends of "all", which is the one
  // window that legitimately has none.
  const now = new Date(2026, 6, 20, 12, 0, 0).getTime();
  const rows = [
    { requestedAt: "2020-01-05", cost: 10 },
    { requestedAt: "2026-07-15", cost: 20 },
  ];
  assert.equal(
    period
      .periodSpendSeries(rows, "all", now)
      .reduce((sum, point) => sum + point.value, 0),
    30,
    "an open-ended window dropped a row",
  );
});

/* ── 3. Rows that are not work orders ────────────────────────────────────── */

test("subitems and archived rows are not counted as work orders", async () => {
  const source = await read(PORTAL);

  assert.match(
    source,
    /function countsAsWorkOrder\(request: MaintenanceRequest\) \{\s*return !request\.parentId && !request\.archived;/,
    "one definition of what the reporting screens count",
  );

  /*
   * Both analytics surfaces apply it, and apply the SAME one rather than
   * restating the condition — which is how the board and the dashboards came
   * to disagree about a job in the first place.
   */
  for (const name of ["OverviewView", "ReportsView", "ContractorsView"]) {
    assert.match(
      componentBody(source, name),
      /countsAsWorkOrder\(request\)/,
      `${name} still counts subitems and archived rows`,
    );
  }

  // And the column has to reach the browser for any of that to work.
  assert.match(
    await read("app/lib/types.ts"),
    /archived\?: boolean;/,
    "the client type cannot see `archived`",
  );
});

test("the board's own rule is the one being followed", async () => {
  // Not a new invention: this is the filter live-board.tsx has always applied,
  // and the comment beside it records what happens without it.
  assert.match(
    await read("app/(app)/portal/live-board.tsx"),
    /!request\.parentId/,
    "the board stopped filtering subitems",
  );
});

/* ── 4. One classifier, not three restatements ───────────────────────────── */

test("the Reports spend split is classified in exactly one place", async () => {
  const body = componentBody(await read(PORTAL), "ReportsView");

  for (const bucket of ["reactive", "planned", "projects"]) {
    assert.match(
      body,
      new RegExp(`classifySpend\\(request\\) === "${bucket}"`),
      `the ${bucket} sparkline does not use the shared classifier`,
    );
  }

  /*
   * The three inline predicates that used to be here disagreed with the
   * classifier they sat beside. `classifySpend` tests compliance-or-tier-4
   * FIRST, so a £5,000 compliance job is "planned" — but `cost >= 1000` drew
   * it under Projects as well, and neither line matched the figure above it.
   */
  assert.doesNotMatch(
    body,
    /request\.tier < 4 && \(request\.cost \?\? 0\) < 1000/,
    "the reactive sparkline is restating the classifier again",
  );
  assert.doesNotMatch(
    body,
    /\(request\) => \(request\.cost \?\? 0\) >= 1000/,
    "the projects sparkline is restating the classifier again",
  );
});

test("every Reports tile says what its sparkline plots", async () => {
  /*
   * The figure is money and the line is a count of jobs. Overview names that
   * distinction on every card; Reports named it on none, so a sparkline under
   * a pound sign read as pounds.
   */
  const body = componentBody(await read(PORTAL), "ReportsView");
  assert.ok(
    (body.match(/trendLabel="/g) ?? []).length >= 4,
    "the Reports tiles do not say what their lines count",
  );
});

/* ── 5. Loading is not empty ─────────────────────────────────────────────── */

test("Reports waits for its rows before reporting that there are none", async () => {
  const source = await read(PORTAL);

  // The signal exists, comes from the jobs fetch, and reaches both surfaces.
  assert.equal(
    (source.match(/jobsReady=\{dataMode === "live"\}/g) ?? []).length,
    2,
    "Overview and Reports both need the jobs signal",
  );

  const body = componentBody(source, "ReportsView");
  assert.match(body, /jobsReady: boolean;/, "ReportsView cannot see the signal");
  assert.match(body, /const loading = !jobsReady;/);

  /*
   * Every sentence on this screen that asserts the portfolio is empty has to
   * sit behind that flag. Before this they all printed during the first load.
   */
  assert.match(body, /loading[\s\S]{0,40}\?[\s\S]{0,40}LOADING_NOTE/, "the panels still claim emptiness while loading");
  assert.match(body, /loading=\{loading\}/, "the caption still claims emptiness while loading");
  assert.match(
    body,
    /detail=\{loading \? LOADING_NOTE :/,
    "the headline tile still reads 'Nothing in this period' while loading",
  );
});

test("the caption tells the reader it is still counting", async () => {
  const picker = await read(PICKER);
  assert.match(picker, /loading = false,/, "PeriodCaption cannot be told it is loading");
  assert.match(picker, /Counting \$\{noun\}…/, "PeriodCaption does not say it is counting");
  // And the honest sentence for a genuinely empty window is still there.
  assert.match(picker, /Nothing in this period — no \$\{noun\} were raised/);
});

test("Overview's job tiles wait too", async () => {
  /*
   * `workspaceReady` was added when "Active units 0" was found standing over
   * an account that had not loaded. The four tiles fed by the OTHER fetch had
   * the identical defect and were left printing a literal 0.
   */
  const body = componentBody(await read(PORTAL), "OverviewView");
  for (const label of ["Requiring attention", "Open jobs", "Overdue", "Completed"]) {
    const card = body.slice(body.indexOf(`label="${label}"`), body.indexOf(`label="${label}"`) + 400);
    assert.match(
      card,
      /value=\{jobsReady \?/,
      `the ${label} tile still prints a count before the rows arrive`,
    );
  }
});

/* ── 6. A range belongs to the page it was chosen on ─────────────────────── */

test("every analytical surface is keyed by its section", async () => {
  /*
   * Independence held by accident: switching surface unmounted the old one.
   * But a workspace section may declare ANY built-in surface, so two sidebar
   * destinations can resolve to one surface — and React then reconciles the
   * same instance, carrying the range from one page to the other.
   */
  const source = await read(PORTAL);
  for (const element of [
    "OverviewView",
    "ContractorsView",
    "ComplianceView",
    "CalendarView",
    "DocumentsView",
    "ReportsView",
  ]) {
    const at = source.indexOf(`<${element}`);
    assert.ok(at > 0, `${element} is not rendered`);
    assert.match(
      source.slice(at, at + 1200),
      /key=\{activeSection\}/,
      `<${element}> is not keyed by section, so its range can follow the reader`,
    );
  }
});

test("no surface persists its range anywhere shared", async () => {
  /*
   * The one storage key on these screens holds a sort direction, and it is
   * namespaced to the page that owns it. A period has never been written to
   * storage, a cookie or the URL, and this is what keeps it that way.
   */
  const source = await read(PORTAL);
  for (const call of source.match(/useStoredSortDirection\(\s*"([^"]+)"/g) ?? []) {
    assert.match(call, /"maintsupp:[a-z-]+:[a-z-]+"/, `${call} is not namespaced to one page`);
  }

  // A range in the URL would be shared by every page that read it.
  assert.doesNotMatch(source, /searchParams\.(get|set)\(\s*["']period["']/);

  // And the picker must not quietly acquire a key of its own.
  assert.doesNotMatch(
    await read(PICKER),
    /localStorage\.setItem\(\s*"maintsupp:period/,
    "the period is being written to shared storage",
  );
});

test("each surface still owns a separate period, and remembers it", async () => {
  /*
   * The owner's acceptance failure. Keying the surfaces by section stopped a
   * range leaking from one page to another — and, because a keyed surface
   * unmounts on the way out, also threw the range away: set Overview to Last
   * week, open Jobs, come back, and it read Last 90 days again.
   *
   * The key stays. Correctness here must not depend on a component happening
   * to remain mounted, so the range moved OUT of the component instead.
   */
  const portal = await read(PORTAL);
  const stored =
    portal.match(/const \[period, setPeriod\] = useStoredPeriod\(sectionKey, "[^"]+"\)/g) ?? [];
  assert.ok(
    stored.length >= 5,
    `expected a remembered period per analytical page, found ${stored.length}`,
  );
  // No analytical surface may keep its range in state that dies with it.
  assert.doesNotMatch(
    portal,
    /const \[period, setPeriod\] = useState\(/,
    "a page's range is back in state that its own unmount will discard",
  );
  // The jobs board is a range-enabled surface too, and the owner named it.
  assert.match(
    await read("app/(app)/portal/live-board.tsx"),
    /const \[analyticsPeriod, setAnalyticsPeriod\] = useStoredPeriod\(/,
    "the jobs board forgets its range",
  );
});

test("one key per section, and never one shared key", async () => {
  /*
   * The whole point. A single global key would restore the requirement's
   * forbidden case — set Overview to Last week, open Reports, find Reports on
   * Last week — with persistence added on top.
   */
  const picker = await read(PICKER);
  assert.match(picker, /const RANGE_NAMESPACE = "maintsupp:date-range:";/);
  assert.match(
    picker,
    /export function periodStorageKey\(sectionKey: string\)/,
    "the key has to be built from the section, not from a label",
  );
  // Built from the argument, not a constant: a key that ignored its input
  // would be one shared key wearing a per-section name.
  assert.match(picker, /\$\{RANGE_NAMESPACE\}\$\{safe \|\| "unknown"\}/);

  const portal = await read(PORTAL);
  // Every surface is handed the section it is, alongside the React key.
  for (const element of [
    "OverviewView",
    "ContractorsView",
    "ComplianceView",
    "CalendarView",
    "DocumentsView",
    "ReportsView",
  ]) {
    const at = portal.indexOf(`<${element}`);
    assert.match(
      portal.slice(at, at + 1400),
      /sectionKey=\{activeSection\}/,
      `<${element}> does not know which page it is`,
    );
  }
});

test("what is stored is the range itself, not the words on the screen", async () => {
  /*
   * The token IS the canonical representation — a preset is its own id, and a
   * custom span carries both dates — so restoring it restores the selection
   * exactly, including the month/year/date shapes. Storing the caption would
   * restore a sentence and lose the filter.
   */
  for (const token of [
    "90",
    "week-1",
    "12m",
    "all",
    "month:2026-07",
    "year:2026",
    "date:2026-08-17",
    "range:2026-08-01..2026-08-17",
  ]) {
    assert.ok(period.isPeriodToken(token), `${token} would not survive a round trip`);
  }

  // A custom range restores both ends, to the day.
  const parts = period.periodRangeParts("range:2026-08-01..2026-08-17");
  assert.deepEqual(parts, { from: "2026-08-01", to: "2026-08-17" });

  // And an unfinished one is kept rather than discarded: the reader picked
  // that first date, and the caption already explains what is missing.
  assert.ok(period.isPeriodToken("range:2026-08-01.."));
  assert.equal(period.resolvePeriod("range:2026-08-01..", Date.now()).recognised, false);
});

test("a malformed or retired stored value falls back to the page default", async () => {
  /*
   * localStorage is writable by anything on the origin and survives releases,
   * so what comes back is not ours. Two different things can be wrong with it
   * — junk, and a preset a later release stopped offering — and both have to
   * land on the page default without reaching the window maths.
   */
  for (const junk of [
    "",
    "   ",
    "<script>alert(1)</script>",
    "range:not-a-date",
    "month:2026-07; DROP TABLE",
    "definitely-not-a-period",
    "x".repeat(200),
    "range:" + "9".repeat(80),
  ]) {
    assert.equal(period.isPeriodToken(junk), false, `${junk.slice(0, 30)} was accepted`);
  }
  for (const notAString of [null, undefined, 42, {}, []]) {
    assert.equal(period.isPeriodToken(notAString), false);
  }

  // And the bad key is cleared rather than left to fail the same way forever.
  const picker = await read(PICKER);
  assert.match(picker, /window\.localStorage\.removeItem\(key\)/);
  // Nothing about a parse failure reaches the reader.
  assert.doesNotMatch(picker, /catch \(\w+\) \{[\s\S]{0,120}console\./);
});

test("reading is guarded, writing is trusted", async () => {
  /*
   * The trust boundary is the read. Validating on the way IN would freeze the
   * control mid-edit the first time somebody typed a five-digit year, so what
   * the picker emits is stored as given; what storage returns is checked.
   */
  const picker = await read(PICKER);
  const hook = picker.slice(picker.indexOf("export function useStoredPeriod"));
  const body = hook.slice(0, hook.indexOf("\n/* ── Sort direction"));
  assert.match(body, /if \(isValid\(saved\)\) return saved;/, "the read is checked");
  assert.match(body, /window\.localStorage\.setItem\(key, next\)/, "the write is not");
  // Blocked storage must not make the control inert.
  assert.match(body, /rangeMemory\.set\(key, next\)/);
  // Server and first client render agree; there is no effect-copied state.
  assert.match(body, /useSyncExternalStore\(subscribeToRange, read, readOnServer\)/);
});

test("compliance remembers its horizon and both custom dates together", async () => {
  /*
   * Its control is an expiry horizon, not the reporting picker, and it carries
   * three pieces of state. They are stored as ONE token so the horizon and the
   * dates cannot come back disagreeing with each other.
   */
  const portal = await read(PORTAL);
  assert.match(portal, /function isExpiryToken\(value: string\)/);
  assert.match(portal, /const expiryToken = \(window: string, from: string, to: string\)/);
  assert.match(portal, /useStoredPeriod\(\s*sectionKey \?/);
  assert.ok(portal.includes(":expiry"), "compliance needs its own sub-key");
  const view = componentBody(portal, "ComplianceView");
  assert.doesNotMatch(view, /const \[expiryFrom, setExpiryFrom\] = useState\(/);
  assert.doesNotMatch(view, /const \[expiryWindow, setExpiryWindow\] = useState\(/);
});

/* ── 7. The right clock, on every surface that filters ───────────────────── */

test("no reporting surface parses a stored date with Date.parse", async () => {
  /*
   * `Date.parse` reads a bare `2026-08-03` as UTC midnight and a
   * `2026-08-09 07:39:18` as local, while every bound is built from LOCAL
   * midnight. West of Greenwich that put a row outside its own month.
   * `parseStamp` and `stampWithinPeriod` know about both forms.
   */
  const source = await read(PORTAL);
  for (const name of ["DocumentsView", "ContractorsView"]) {
    const body = componentBody(source, name);
    assert.doesNotMatch(body, /Date\.parse\(/, `${name} still uses Date.parse`);
    assert.match(body, /stampWithinPeriod\(/, `${name} does not use the shared comparator`);
  }

  const surface = await read(SURFACE);
  assert.doesNotMatch(surface, /Date\.parse\(/, "the calendar still uses Date.parse");
  assert.match(surface, /parseStamp\(value\)/);
});

test("a half-typed custom range says so instead of emptying the page", async () => {
  /*
   * `resolvePeriod` always returns an object, so `if (!window) return true`
   * was dead code — and an unrecognised window left the bounds as NaN, so
   * every comparison was false and the register silently emptied.
   */
  const source = await read(PORTAL);
  assert.doesNotMatch(source, /if \(!window\) return true;/);
  assert.doesNotMatch(source, /if \(!periodWindow\) return true;/);

  const now = new Date(2026, 6, 20, 12, 0, 0).getTime();
  const unfinished = period.resolvePeriod("range:2026-01-01..", now);
  assert.equal(unfinished.recognised, false);
  assert.ok(unfinished.reason.length > 10, "an unfinished range must explain itself");
  assert.equal(period.stampWithinPeriod("2026-01-02", "range:2026-01-01..", now), false);
});

test("the two registers say why they are empty", async () => {
  const source = await read(PORTAL);
  const documents = componentBody(source, "DocumentsView");
  assert.match(documents, /!filtered\.length &&/, "Documents draws a header over nothing");
  assert.match(documents, /No documents were uploaded in \$\{window\.label\}/);
  assert.match(documents, /window\.reason/, "an unreadable window must say so");

  assert.match(
    componentBody(source, "ContractorsView"),
    /!contractors\.length &&/,
    "Contractors draws a header over nothing",
  );
});

test("the screens made of jobs get the failure state", async () => {
  /*
   * `WorkspaceUnavailable` was wired to Overview and Reports only. The
   * contractor roster falls back to one derived from `requests` and the
   * calendar takes them as a prop, so a failed jobs fetch drew a full roster
   * of zeroes and a schedule silently missing every job.
   */
  const source = await read(PORTAL);
  for (const surface of ["contractors", "calendar", "overview", "reports"]) {
    assert.match(
      source,
      new RegExp(`activeSurface === "${surface}" && dataMode === "unavailable"`),
      `${surface} has no controlled failure state`,
    );
  }
});

/* ── 8. Nothing on the screen is invented ────────────────────────────────── */

test("repeat activity measures a rate against its own window", async () => {
  const source = await read(PORTAL);
  assert.match(
    source,
    /function describeCadence\(orders: number, spanDays: number \| null\)/,
    "the cadence is not measured against a span",
  );
  assert.doesNotMatch(
    source,
    /item\.orders >= 4 \? "Weekly"/,
    "a raw count is being labelled as a rate again",
  );
  assert.match(source, /frequency: describeCadence\(item\.orders, cadenceSpanDays\)/);
});

test("the invented Activity column is gone", async () => {
  const source = await read(PORTAL);
  assert.doesNotMatch(
    source,
    /Investigate, repair and verify/,
    "an authored sentence is being presented as a measurement",
  );
  assert.doesNotMatch(componentBody(source, "ReportsView"), /<th>Activity<\/th>/);
});

/* ── 9. The controls can be seen and hit ─────────────────────────────────── */

test("the reporting controls have a focus ring and a real touch target", async () => {
  const css = await read(CSS);

  /*
   * The toolbar clears `outline` on every select and input so the controls
   * read as one chip. Nothing was ever put back for the keyboard, and the
   * `:focus-within` tint on the chip is a colour-only signal outside the
   * control's own box — a screenshot of the focused select was byte-identical
   * to the unfocused one.
   */
  assert.match(
    css,
    /\.analytics-toolbar select:focus-visible[\s\S]{0,260}outline: 2px solid/,
    "the period control still has no visible focus ring",
  );

  assert.match(
    css,
    /\.analytics-toolbar > label\.analytics-period--argument input \{[\s\S]{0,700}min-height: 40px;/,
    "the custom date inputs are still smaller than they look",
  );
});

test("the range's two halves stay in reading order, at an agreed breakpoint", async () => {
  const css = await read(CSS);
  const section = css.slice(css.indexOf("Board chrome (Stage 5"));
  for (const query of section.match(/@media \([^)]*width: (\d+)px\)/g) ?? []) {
    const width = Number(query.match(/(\d+)px/)[1]);
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${query} is outside the agreed breakpoints`,
    );
  }
  assert.match(
    css,
    /\.analytics-toolbar > label\.analytics-period--argument \{[\s\S]{0,200}grid-column: 1 \/ -1;/,
  );
});
