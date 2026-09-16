/**
 * THE OVERVIEW POLISH BATCH — the behaviours, not the source text.
 *
 * Each block below names the finding it pins and states what was wrong, so a
 * future reader can tell whether a failure here is a regression or a deliberate
 * change of mind. Everything that can be executed is executed; the two fixes
 * that are purely CSS or purely a React render are verified in the browser and
 * are not faked with a string match here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));

const stub = pathToFileURL(`${root}tests/fixtures/cloudflare-workers-stub.mjs`).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: stub, shortCircuit: true };
    if (spec.startsWith(".") && ctx.parentURL?.endsWith(".ts")) {
      const base = new URL(spec, ctx.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`, `${base.href}.tsx`]) {
        if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

const { refuseBadRange } = await import("../app/lib/range-params.ts");
const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");

/*
 * The chart maths lives in a `.tsx`, which Node cannot load. Sliced and
 * transpiled on its own exactly as `tests/donut-min-segment.test.mjs` does — the
 * same two markers, so both suites move together if the section is renamed.
 */
const ts = (await import("typescript")).default;
const chartsSource = await fs.promises.readFile(
  `${root}app/(app)/portal/ops/ov-dash-charts.tsx`,
  "utf8",
);
const mathsStart = chartsSource.indexOf("/* ── Pure maths");
assert.ok(mathsStart >= 0, "the pure-maths slice still starts where the suite expects");
const mathsEnd = chartsSource.indexOf("/* ── Environment hooks", mathsStart);
assert.ok(mathsEnd > mathsStart, "and still ends there");
const { ovPercentOrNull, ovPercent, ovFraction, ovShares } = await import(
  `data:text/javascript,${encodeURIComponent(
    ts.transpileModule(chartsSource.slice(mathsStart, mathsEnd), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )}`
);

/* ── B8 — an impossible date is the caller's mistake, not an outage ───────── */

const url = (search) => new URL(`https://example.test/api/overview/metrics${search}`);

test("a date that is a shape but not a day is refused, on both blocks' parameters", () => {
  for (const bad of ["2026-13-01", "2026-02-30", "2026-00-10", "2026-09-31", "banana", "2026-9-1"]) {
    for (const key of ["from", "to"]) {
      const refusal = refuseBadRange(url(`?${key}=${encodeURIComponent(bad)}`));
      assert.ok(refusal, `${key}=${bad} must be refused`);
      assert.equal(refusal.status, 400, `${key}=${bad} is a 4xx, never a 5xx`);
    }
  }
});

test("a real day, an absent parameter and an empty one all pass", () => {
  assert.equal(refuseBadRange(url("?from=2026-09-16&to=2026-09-16")), null);
  assert.equal(refuseBadRange(url("")), null, "absent means the default window");
  assert.equal(refuseBadRange(url("?from=&to=")), null, "blank means the same");
  assert.equal(refuseBadRange(url("?portfolio=whatever")), null, "other parameters are not ours");
  /* A leap day that exists, and one that does not. */
  assert.equal(refuseBadRange(url("?to=2028-02-29")), null, "2028 is a leap year");
  assert.ok(refuseBadRange(url("?to=2026-02-29")), "2026 is not");
});

test("the refusal says which parameter, and carries no internals", async () => {
  const body = await refuseBadRange(url("?to=2026-13-01")).json();
  assert.match(body.error, /"to"/);
  assert.doesNotMatch(body.error, /select |from |sql|drizzle/i, "no statement text in a client error");
});

/* ── B15 — zero denominator is not a measured zero ────────────────────────── */

test("a share of nothing is null, and a measured zero is still zero", () => {
  assert.equal(ovPercentOrNull(0, 0), null, "nothing to take a share of");
  assert.equal(ovPercentOrNull(5, 0), null);
  assert.equal(ovPercentOrNull(0, 90), 0, "none of ninety IS an answer, and it is 0%");
  assert.equal(ovPercentOrNull(45, 90), 50);
  assert.equal(ovPercentOrNull(1, Number.NaN), null);
});

test("geometry keeps answering 0, because an arc cannot be drawn from null", () => {
  /* The split is by purpose: `ovFraction` sweeps the arcs and sizes the bars. */
  assert.equal(ovFraction(5, 0), 0);
  assert.equal(ovPercent(5, 0), 0);
});

/* ── B20 — the parts of one shape add up to the whole ─────────────────────── */

test("a set of shares sums to 100, where rounding each alone did not", () => {
  /* The measured live split that produced 99: 61/12/12/2/1/1 of 89. */
  const values = [61, 12, 12, 2, 1, 1];
  const naive = values.reduce((sum, value) => sum + ovPercent(value, 89), 0);
  assert.equal(naive, 99, "the defect this replaces");
  assert.equal(ovShares(values, 89).reduce((a, b) => a + b, 0), 100);
});

test("it holds for every set worth worrying about", () => {
  const sets = [
    [64, 20, 1, 1, 1, 1],
    [1, 1, 1],
    [54, 10, 7, 4, 1, 1, 12],
    [1, 2, 3, 4, 5, 6, 7],
    [100],
    [33, 33, 34],
  ];
  for (const values of sets) {
    const total = values.reduce((a, b) => a + b, 0);
    const shares = ovShares(values, total);
    assert.equal(shares.reduce((a, b) => a + b, 0), 100, JSON.stringify(values));
    assert.equal(shares.length, values.length);
    for (const share of shares) assert.ok(share >= 0 && share <= 100);
  }
});

test("a zero slice is never handed a point to make the sum work", () => {
  const shares = ovShares([0, 1, 99], 100);
  assert.equal(shares[0], 0, "a category with nothing in it must stay at nothing");
  assert.equal(shares.reduce((a, b) => a + b, 0), 100);
});

test("an impossible denominator gives every slice nothing, not NaN", () => {
  assert.deepEqual(ovShares([1, 2], 0), [0, 0]);
  assert.deepEqual(ovShares([1, 2], Number.NaN), [0, 0]);
});

/* ── B23 and the chip vocabulary ──────────────────────────────────────────── */

const chipsOf = (search) => {
  const filter = readDrillFilter(new URLSearchParams(search), new Date("2026-09-16T12:00:00Z"), {});
  return Object.fromEntries(filter.chips.map((chip) => [chip.key, chip.value]));
};

test("B23 the period chip names the last day the window includes, not the one after", () => {
  const chips = chipsOf("measure=requested&period=custom&from=2025-10-01&to=2026-09-16");
  assert.equal(
    chips.period,
    "2025-10-01 to 2026-09-16",
    "a drill carrying to=2026-09-16 announced itself as 2026-09-17",
  );
});

test("B23 a single-day window reads as that one day", () => {
  const chips = chipsOf("measure=requested&period=custom&from=2026-09-16&to=2026-09-16");
  assert.equal(chips.period, "2026-09-16 to 2026-09-16");
});

test("the priority chip says what the ring that opened it said", () => {
  assert.equal(chipsOf("family=open&priority=urgent").priority, "High");
  assert.equal(chipsOf("family=open&priority=medium").priority, "Medium");
  assert.equal(chipsOf("family=open&priority=low").priority, "Low");
  /* An unknown value is shown as written rather than swallowed. */
  assert.equal(chipsOf("family=open&priority=weird").priority, "weird");
});

test("a query-parameter name does not reach a user-facing chip", () => {
  const filter = readDrillFilter(
    new URLSearchParams("family=open&meter=Pending+Approval&status=Pending+Approval"),
    new Date(),
    {},
  );
  const meter = filter.chips.find((chip) => chip.key === "meter");
  assert.equal(meter.label, "Status", '"Meter" is the parameter, not a word for a reader');
  assert.equal(meter.value, "Pending Approval");
});

test("B18 the internal sentinels are not printed at a reader", () => {
  const label = chipsOf("family=open&label=__not_recorded__%7C%5Bobject+Object%5D").label;
  assert.doesNotMatch(label, /__not_recorded__/, "the board's own filter value is not a word");
  assert.doesNotMatch(label, /\[object/i, "nor is a stringified object");
  assert.equal(label, "Unassigned", "the name the card that opened it used");

  const engineer = chipsOf("family=open&engineer=__not_recorded__%7C%5Bobject+Object%5D").engineer;
  assert.equal(engineer, "Not recorded", "the engineer bar calls that bucket this");

  assert.equal(chipsOf("family=open&tier=__not_recorded__").tier, "No tier");
});

test("humanising the chip did not change which jobs the drill opens", () => {
  /* The two sentinels still travel in the query; only the words changed. */
  const population = [
    { id: "a", status: "Pending Approval", stage: "Incoming", category: "", archived: false, parentId: null },
    { id: "b", status: "Pending Approval", stage: "Incoming", category: "[object Object]", archived: false, parentId: null },
    { id: "c", status: "Pending Approval", stage: "Incoming", category: "Electrical", archived: false, parentId: null },
  ];
  const filter = readDrillFilter(
    new URLSearchParams("family=open&label=__not_recorded__%7C%5Bobject+Object%5D"),
    new Date(),
    { population },
  );
  const opened = population.filter((row) => filter.matches(row)).map((row) => row.id);
  assert.deepEqual(opened, ["a", "b"], "both sentinel spellings still match; Electrical does not");
});

/* ── Against the live estate ──────────────────────────────────────────────── */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const headers = {
  "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com",
  Accept: "application/json",
};

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/overview/metrics`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test("LIVE B8 both blocks refuse an impossible date with the same 4xx", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  for (const bad of ["to=2026-13-01", "from=2026-02-30", "to=banana"]) {
    for (const path of ["/api/overview/metrics", "/api/reports/metrics"]) {
      const response = await fetch(`${BASE}${path}?${bad}`, { headers });
      assert.equal(response.status, 400, `${path}?${bad} must be a 400`);
      /* The defect this replaces: the Reports block answered 503, which says
         the server failed when the request was simply wrong. */
      assert.notEqual(response.status, 503);
    }
  }
  /* And a real day still answers. */
  for (const path of ["/api/overview/metrics", "/api/reports/metrics"]) {
    const ok = await fetch(`${BASE}${path}?from=2025-10-01&to=2026-09-16`, { headers });
    assert.equal(ok.status, 200, `${path} must still answer a real range`);
  }
});

test("LIVE B22 only a month the range cuts short is marked partial", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const mid = await (
    await fetch(`${BASE}/api/reports/metrics?from=2025-10-01&to=2026-09-16&trendRange=6m`, { headers })
  ).json();
  const points = mid.trend.points;
  assert.ok(points.length > 1, "the trend has columns to check");
  for (const point of points.slice(0, -1)) {
    assert.equal(point.partial, false, `${point.month} is a whole month and must not be flagged`);
  }
  assert.equal(points.at(-1).partial, true, "the anchor month ends mid-month here");

  /* A range that ends ON a month end has no partial column at all. */
  const whole = await (
    await fetch(`${BASE}/api/reports/metrics?from=2025-10-01&to=2026-08-31&trendRange=6m`, { headers })
  ).json();
  assert.ok(
    whole.trend.points.every((point) => point.partial === false),
    "nothing is partial when the range ends where the month does",
  );
});

test("LIVE B25 an authenticated JSON answer is not cacheable by a shared cache", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  for (const path of [
    "/api/overview/metrics",
    "/api/reports/metrics",
    "/api/compliance/metrics",
  ]) {
    const response = await fetch(`${BASE}${path}`, { headers });
    const cache = response.headers.get("cache-control") ?? "";
    assert.match(cache, /no-store/, `${path} must not be stored`);
    assert.match(cache, /private/, `${path} is one tenant's answer`);
    assert.match(
      response.headers.get("vary") ?? "",
      /cookie/i,
      `${path} varies by the session cookie, which is the only thing that identifies the caller`,
    );
  }
});

test("LIVE B21 the spend trend reports twelve whole calendar months", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server");
    return;
  }
  const body = await (
    await fetch(`${BASE}/api/overview/metrics?from=2025-10-01&to=2026-09-16`, { headers })
  ).json();
  const months = body.spend.map((row) => row.month);
  assert.equal(months.length, 12);
  assert.equal(months.at(-1), "2026-09", "the last column is the range's own month");
  /* Consecutive, with no month skipped or repeated — the window and the columns
     are built from one list, so a leap day cannot pull them apart. */
  for (let index = 1; index < months.length; index += 1) {
    const previous = new Date(`${months[index - 1]}-01T00:00:00Z`);
    previous.setUTCMonth(previous.getUTCMonth() + 1);
    assert.equal(months[index], previous.toISOString().slice(0, 7), "months run consecutively");
  }
  assert.deepEqual(body.reconciliation, []);
});

/* ── The regression the browser caught, and the invariants behind it ───────── */

test("B19's normalisation waits for a payload that answers the CURRENT query", async () => {
  /*
   * A SOURCE PIN, deliberately, because this repository has no React renderer
   * and the behaviour is an effect reading two pieces of hook state.
   *
   * What it protects, and what went wrong: `useOpsQuery` keeps the PREVIOUS
   * payload on screen while the next is in flight, so for ~40ms after a
   * portfolio is chosen `overview.data` is still the unfiltered read — whose
   * echoed `portfolio.id` is `"all"`. The first version of this effect read
   * that stale echo as "your selection was not honoured" and deleted the
   * parameter, so choosing ANY portfolio from "All portfolios" snapped straight
   * back to "All portfolios". Measured 4/4 in a browser, by menu and by
   * keyboard; six wasted requests per attempt.
   *
   * `stale` already carries exactly the missing fact. If this assertion fails,
   * check that the effect still refuses to act on a payload fetched for a
   * different query before changing it.
   */
  const source = await fs.promises.readFile(`${root}app/(app)/portal/ops/oi-dash.tsx`, "utf8");
  const start = source.indexOf("const echoedPortfolioId");
  assert.ok(start >= 0, "the stale-portfolio normalisation is still here");
  const block = source.slice(start, source.indexOf("}, [portfolio", start));
  assert.match(block, /if \(overview\.stale\) return;/, "it must not act on the previous filter's payload");
  assert.match(
    block,
    /if \(echoedPortfolioId !== "all"\) return;/,
    "and only when the server fell back to every site",
  );
});

test("useOpsQuery reports a retained payload as stale, which is what makes that guard work", async () => {
  /*
   * The other half of the same contract, in the module that owns it: `stale` is
   * keyed on the BASE (path + search), not on the nonce, so a poll or a Retry
   * does NOT read as stale while a filter change does.
   */
  const source = await fs.promises.readFile(
    `${root}app/(app)/portal/ops/ops-url-state.ts`,
    "utf8",
  );
  assert.match(
    source,
    /stale: enabled && result != null && result\.base !== base,/,
    "stale is true exactly when the payload on screen answers a different query",
  );
  assert.match(source, /data: result\?\.data \?\? null,/, "and the payload is still retained");
});

test("a ring with nothing in it does not report a share of nothing", async () => {
  /* FAIL-3: `RingMeter` composes its own accessible name and was still printing
     "0 of 0, 0%" on the Recurrence card for an empty range. */
  const source = await fs.promises.readFile(
    `${root}app/(app)/portal/ops/ov-dash-charts.tsx`,
    "utf8",
  );
  assert.match(source, /const percent = ovPercentOrNull\(safeValue, safeTotal\);/);
  assert.match(
    source,
    /\$\{percent === null \? "" : `, \$\{percent\}%`\}/,
    "the share is omitted when there is nothing to take a share of",
  );
  /* The geometry must keep using the fraction, or the ring stops drawing. */
  assert.match(source, /useOvSweep\(\[ovFraction\(safeValue, safeTotal\)\]\)/);
});
