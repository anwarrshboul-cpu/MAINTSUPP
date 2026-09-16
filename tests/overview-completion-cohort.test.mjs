/**
 * COMPLETION RATE IS A SHARE OF ONE COHORT.
 *
 * It was not. `completionRate` was `completed ÷ (completed + open)`, and those
 * are two different populations: the numerator counted jobs CLOSED inside the
 * page range, the denominator added open work as it stands today, all time. So
 * the figure moved when the reader moved the date picker and the estate had not
 * changed at all — measured on the audited estate, a one-day window read 0%, a
 * twelve-month window 5%, a future window 0% — and the card drew the two as a
 * two-slice donut, which asserts they are parts of one whole.
 *
 * The cohort is now: jobs RAISED between `range.from` and `range.to`, split by
 * whether they are closed today. Both halves are the same jobs, so the donut's
 * claim is true and the rate is a share of a denominator the card can print.
 *
 * These tests run `buildJobIntel` itself rather than re-implementing it, and
 * the live one compares the rendered figure against the drill-downs the card
 * actually links to.
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

const { buildJobIntel } = await import("../app/lib/overview-intel.ts");
const { normalisePriority } = await import("../app/lib/job-metrics.ts");

/** The smallest valid input, with the cohort under test. */
function intelWith({ raised, closed, open = 0, completed = 0 }) {
  return buildJobIntel({
    today: "2026-09-16",
    range: { from: "2026-01-01", to: "2026-09-16" },
    open,
    overdue: 0,
    completed,
    cohort: { raised, closed },
    statusSlices: [],
    prioritySlices: [],
    categoryRows: [],
    tierRows: [],
    engineerRows: [],
    priorityRows: [],
    aging: { count: 0, oldestDay: null },
    breach: { pool: 0, count: 0 },
    closures: [],
    normalisePriority,
  });
}

/* ── The four cohorts the brief names ─────────────────────────────────────── */

test("no jobs raised in the range reads as unanswerable, never 0%", () => {
  const intel = intelWith({ raised: 0, closed: 0, open: 88 });
  assert.equal(intel.completionRate, null, "a share of no jobs is not 0%");
  assert.deepEqual(intel.completion, { raised: 0, closed: 0, open: 0 });
  /* The trap this replaces: 88 jobs open all-time used to drag the old formula
     to 0% for an empty range, which reads as "nothing is getting done". */
});

test("a cohort with nothing closed is 0%, which is a different statement", () => {
  const intel = intelWith({ raised: 12, closed: 0 });
  assert.equal(intel.completionRate, 0);
  assert.deepEqual(intel.completion, { raised: 12, closed: 0, open: 12 });
});

test("a cohort entirely closed is 100%", () => {
  const intel = intelWith({ raised: 9, closed: 9 });
  assert.equal(intel.completionRate, 100);
  assert.deepEqual(intel.completion, { raised: 9, closed: 9, open: 0 });
});

test("a mixed cohort is the share of itself", () => {
  const intel = intelWith({ raised: 40, closed: 10 });
  assert.equal(intel.completionRate, 25);
  assert.deepEqual(intel.completion, { raised: 40, closed: 10, open: 30 });
});

/* ── The property that makes the donut honest ─────────────────────────────── */

test("the two halves always sum to the cohort, and the rate always states it", () => {
  for (const raised of [0, 1, 7, 91, 5000]) {
    for (const closed of [0, 1, Math.floor(raised / 3), raised]) {
      const intel = intelWith({ raised, closed: Math.min(closed, raised) });
      const { completion: c } = intel;
      assert.equal(c.closed + c.open, c.raised, `${closed} of ${raised} must sum to the cohort`);
      if (c.raised === 0) assert.equal(intel.completionRate, null);
      else {
        assert.ok(
          intel.completionRate >= 0 && intel.completionRate <= 100,
          `rate ${intel.completionRate} out of range for ${closed}/${raised}`,
        );
        assert.ok(Number.isFinite(intel.completionRate), "never NaN or Infinity");
      }
    }
  }
});

test("a closed count larger than its cohort cannot produce a rate above 100%", () => {
  /* The two halves come off separate aggregates. A dashboard showing 140% is
     worse than one showing a clamped figure, so the builder clamps. */
  const intel = intelWith({ raised: 10, closed: 14 });
  assert.equal(intel.completionRate, 100);
  assert.equal(intel.completion.closed, 10);
  assert.equal(intel.completion.open, 0);
});

/* ── The two date-boundary cases the brief calls out ──────────────────────── */

test("the cohort follows the RAISED date, so completion and the Completed tile differ", () => {
  /*
   * A job raised BEFORE the range and completed INSIDE it belongs to the
   * Completed tile and not to the cohort; a job raised INSIDE the range and
   * completed later belongs to the cohort and not to the tile. The two tiles
   * are deliberately different questions, and the card says so.
   *
   * Expressed here as the contract the server must satisfy: `completed` is
   * carried straight through, `completion` is carried straight through, and
   * neither is derived from the other.
   */
  const intel = intelWith({ raised: 4, closed: 1, completed: 9 });
  assert.equal(intel.completed, 9, "the Completed tile keeps its own count");
  assert.equal(intel.completion.raised, 4, "the cohort is the jobs raised in range");
  assert.equal(intel.completionRate, 25, "and the rate is a share of the cohort only");
  assert.notEqual(
    intel.completionRate,
    Math.round((9 / (9 + 0)) * 100),
    "the rate must not be computed from the Completed tile",
  );
});

test("open work outside the cohort cannot move the rate", () => {
  /* The defect, stated as a test: the same cohort with wildly different
     all-time open counts must produce the same rate. */
  const a = intelWith({ raised: 20, closed: 5, open: 0 });
  const b = intelWith({ raised: 20, closed: 5, open: 4000 });
  assert.equal(a.completionRate, b.completionRate);
  assert.equal(a.completionRate, 25);
});

/* ── Against the live estate ──────────────────────────────────────────────── */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const headers = {
  "x-maintsupp-identity": "admin@sunnamusk-uk.test.maintsupp.com",
  Accept: "application/json",
};

async function serverIsUp() {
  try {
    /* Generous, and deliberately so: this endpoint runs a dozen aggregates and
       measured 1.9-3.1s warm, so a four-second probe skips the test it is
       supposed to gate roughly half the time. */
    const response = await fetch(`${BASE}/api/overview/metrics`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body?.intel?.completion);
  } catch {
    return false;
  }
}

test("LIVE the rate is coherent for every range, and answers null where it cannot", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server answering with intel");
    return;
  }
  const ranges = [
    "from=2025-10-01&to=2026-09-16",
    "from=2026-09-16&to=2026-09-16",
    "from=2027-01-01&to=2027-01-31",
    "from=2000-01-01&to=2026-09-16",
  ];
  for (const search of ranges) {
    const body = await (await fetch(`${BASE}/api/overview/metrics?${search}`, { headers })).json();
    const c = body.intel.completion;
    assert.equal(c.closed + c.open, c.raised, `${search}: the halves must sum to the cohort`);
    if (c.raised === 0) {
      assert.equal(body.intel.completionRate, null, `${search}: an empty cohort is not 0%`);
    } else {
      assert.equal(
        body.intel.completionRate,
        Math.round((c.closed / c.raised) * 100),
        `${search}: the rate must be the cohort's own share`,
      );
    }
    assert.deepEqual(body.reconciliation, [], `${search}: the payload must reconcile`);
  }
});

test("LIVE both halves of the donut open exactly the jobs they counted", async (t) => {
  if (!(await serverIsUp())) {
    t.skip("no development server answering with intel");
    return;
  }
  const { readDrillFilter } = await import("../app/(app)/portal/board-drill-filter.ts");
  const source = await fs.promises.readFile(`${root}app/(app)/portal/ops/oi-dash.tsx`, "utf8");
  const ts = (await import("typescript")).default;
  const from = "export type OiPair = readonly [string, string];";
  const start = source.indexOf(from);
  assert.ok(start >= 0, "the drill section still starts where the suite slices it");
  const output = ts.transpileModule(source.slice(start), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const jobs = await import(`data:text/javascript,${encodeURIComponent(output)}`);

  const rows = [];
  for (let offset = 0, round = 0; round < 20; round += 1) {
    const response = await fetch(`${BASE}/api/maintenance?limit=1000&offset=${offset}`, { headers });
    const body = await response.json();
    rows.push(...(body.requests ?? []));
    if (!body.hasMore || typeof body.nextOffset !== "number") break;
    offset = body.nextOffset;
  }
  assert.ok(rows.length > 0, "the estate has jobs to filter");

  const search = "from=2025-10-01&to=2026-09-16";
  const body = await (await fetch(`${BASE}/api/overview/metrics?${search}`, { headers })).json();
  const { intel, range } = body;

  const opened = (pairs) => {
    const query = new URLSearchParams(pairs.map(([k, v]) => [k, v])).toString();
    const filter = readDrillFilter(new URLSearchParams(query), new Date(), { population: rows });
    return rows.filter((row) => filter.matches(row)).length;
  };

  assert.equal(
    opened(jobs.oiCohortPairs("closed", range)),
    intel.completion.closed,
    "the Closed slice must open exactly the closed half of the cohort",
  );
  assert.equal(
    opened(jobs.oiCohortPairs("open", range)),
    intel.completion.open,
    "the Still open slice must open exactly the open half of the cohort",
  );
});
