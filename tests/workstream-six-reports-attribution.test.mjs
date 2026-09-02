import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import ts from "typescript";

/**
 * W06-12 — contractor costs on Reports and the Dashboard are attributed to a
 * CONTRACTOR, not to a piece of text that happens to be their name today.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `ContractorScorecard` — the only contractor panel this product had, rendered
 * once on the Reports page — keyed a contractor's jobs, average close time and
 * spend on the name typed on the job and never read `contractorId` at all:
 *
 *     const name = (request.contractor ?? "").trim();
 *     if (!name) continue;
 *
 * That is the exact line commit `9c53bd9` removed from the Contractors
 * register. It survived here because the rule was written out by hand in each
 * place that needed it and nobody knew this copy existed: a grep of `tests/`
 * for `ContractorScorecard` returned nothing at all before this file.
 * Reproduced on the running product during the W5/W6 audit — the register
 * showed a renamed contractor holding GBP 250 of work while the scorecard
 * printed that GBP 250 against a name that appears on NO register row.
 *
 * Three failures come out of that one line, and each has its own test below:
 *
 *   1. a RENAME splits one contractor's history in two, the old name keeping
 *      the old jobs for ever;
 *   2. two contractors who share a name MERGE into one row — the double count
 *      `rosterPerName` (portal-app.tsx) and `contractorsPerName`
 *      (app/api/workspace/route.ts) were both written to refuse, and which once
 *      printed a single GBP 999 job as GBP 1,998;
 *   3. a job linked by `contractor_id` whose text was cleared is DROPPED — it
 *      has an owner and the panel cannot see it.
 *
 * And a fourth property that is not a failure but a decision: an ambiguous name
 * with no id is attributed to NOBODY. A register that cannot say which
 * contractor a name means cannot say whose job it was, and inventing an answer
 * inflates money somebody bills from.
 *
 * ── How this suite is written ──────────────────────────────────────────────
 *
 * The rule now lives once, in `app/lib/contractor-attribution.ts`, which is a
 * pure module with no React and no database in it — so the four regressions are
 * tested by RUNNING it rather than by matching source text. It is transpiled to
 * a data: URL exactly as tests/audit-csv-engb.test.mjs does for
 * `app/lib/csv.ts`; `import type` is elided by the transpiler, so the module
 * loads with no dependencies.
 *
 * The surfaces themselves are TSX inside a 9,400-line file, so their thin
 * summing layers are replayed here on top of the imported rule and each replay
 * is pinned to the real source in "the replays above are still what the screens
 * compute". That is the same arrangement the sibling scope suite uses, and for
 * the same reason: a measurement proves the surfaces agree today, a shared
 * definition is what stops them drifting apart again.
 *
 * The last test talks to a RUNNING SERVER and skips cleanly when none answers.
 * It is here because the whole defect is about what survives a WRITE — a rename
 * through the real API, against real rows, read back through /api/maintenance.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(root + file, "utf8")).replace(/\r\n/g, "\n");

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const asModule = (js) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

const {
  attributeContractorWork,
  contractorJobCost,
  contractorSpendBasisNote,
  CONTRACTOR_SPEND_BASIS,
} = await import(asModule(transpile(await read("app/lib/contractor-attribution.ts"))));

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const PREFIX = "ZZQA-W6-REPORTS";

/**
 * A maintenance row with only the fields attribution and cost look at.
 *
 * `cost` is POUNDS here, not pence, because `maintenance_requests.cost` is a
 * `real` holding monday's "Cost of Works" number — the one place in this
 * product where money is not an integer of pence. The rate columns beside it on
 * `contractors` ARE pence, and the two must never be added together; see the
 * agreed-rates test below.
 */
const job = (over) => ({
  parentId: null,
  archived: false,
  contractor: null,
  contractorId: null,
  cost: null,
  requestedAt: "2026-06-01",
  completedAt: null,
  priority: "Medium",
  stage: "Incoming",
  status: "Open",
  ...over,
});

/* ── The screens' own summing, replayed over the shared rule ───────────────── */

/**
 * `ContractorCostPanel`'s summary, which is what the Dashboard prints.
 *
 * Everything load-bearing here is the imported `attributeContractorWork`; what
 * is copied is the four lines of addition on top of it, and those are pinned to
 * the real source below.
 */
function dashboardPanel(requests, roster) {
  const attribution = attributeContractorWork(requests, roster);
  const ranked = [...attribution.byRoster, ...attribution.unregistered]
    .map((row) => ({ name: row.name, registered: row.registered, spend: contractorJobCost(row.jobs) }))
    .filter((row) => row.spend > 0)
    .sort((left, right) => right.spend - left.spend);
  return {
    rows: ranked,
    attributed: ranked.reduce((sum, row) => sum + row.spend, 0),
    linked: attribution.byRoster.reduce((sum, row) => sum + contractorJobCost(row.jobs), 0),
    unplaced: contractorJobCost(
      attribution.unattributed.filter(
        (request) => Boolean(request.contractorId) || Boolean((request.contractor ?? "").trim()),
      ),
    ),
    total: contractorJobCost(requests),
  };
}

/** `ContractorsView`'s "Tracked spend" tile: the sum of the per-row figures. */
function contractorsPageTracked(requests, roster) {
  const attribution = attributeContractorWork(requests, roster);
  return roster.reduce(
    (sum, _contractor, index) => sum + contractorJobCost(attribution.byRoster[index].jobs),
    0,
  );
}

/**
 * WHAT THE PANEL USED TO DO, kept so each regression can show the difference.
 *
 * Byte for byte the reducer that shipped, so a test does not merely assert the
 * new answer is right — it asserts the old answer was the wrong one that was
 * actually being printed.
 */
function nameKeyedSpend(requests) {
  const byContractor = new Map();
  for (const request of requests) {
    const name = (request.contractor ?? "").trim();
    if (!name) continue;
    byContractor.set(name, (byContractor.get(name) ?? 0) + (request.cost ?? 0));
  }
  return byContractor;
}

/* ── The four regressions ──────────────────────────────────────────────────── */

test("W06-12: a rename keeps a contractor's historical spend on that contractor", () => {
  /*
   * The job's TEXT is deliberately left on the old name, because that is what
   * the database does: `contractor` is the historical record of who was named
   * on the job and a rename does not rewrite it. Only `contractor_id` follows
   * the contractor, which is exactly why it has to be what the panel reads.
   */
  const jobs = [
    job({ id: "j1", contractor: `${PREFIX}-Alpha`, contractorId: "c1", cost: 250 }),
    job({ id: "j2", contractor: `${PREFIX}-Alpha`, contractorId: "c1", cost: 15 }),
  ];

  const before = dashboardPanel(jobs, [{ id: "c1", name: `${PREFIX}-Alpha` }]);
  const after_ = dashboardPanel(jobs, [{ id: "c1", name: `${PREFIX}-Alpha Renamed` }]);

  assert.equal(before.attributed, 265, "the spend before the rename");
  assert.equal(after_.attributed, 265, "and every penny of it after");
  assert.equal(after_.rows.length, 1, "one contractor, not one per name they have held");
  assert.equal(after_.rows[0].name, `${PREFIX}-Alpha Renamed`, "under the name they have now");
  assert.equal(after_.unplaced, 0, "and nothing is stranded on the old name");

  /*
   * The defect, stated as a measurement. The name-keyed reducer files the same
   * GBP 265 under a name that appears on no register row, so the register and
   * the panel print two different owners for one job — which is precisely what
   * was found on the running product.
   */
  const old = nameKeyedSpend(jobs);
  assert.equal(old.get(`${PREFIX}-Alpha`), 265, "the shipped reducer kept it on the OLD name");
  assert.equal(old.get(`${PREFIX}-Alpha Renamed`), undefined, "and showed the contractor nothing");
});

test("W06-12: two contractors with one name are never merged into one row", () => {
  /*
   * Nothing in the schema stops the pair: there is no unique index on
   * `contractors.name`. The workspace API refuses a duplicate on create and on
   * rename today, which narrows how a pair APPEARS — it does not remove the
   * pairs an import produced, and a tally that would double-count them is a
   * defect whether or not the front door is bolted.
   */
  const roster = [
    { id: "c1", name: `${PREFIX}-Twin` },
    { id: "c2", name: `${PREFIX}-Twin` },
  ];
  const jobs = [
    job({ id: "j1", contractor: `${PREFIX}-Twin`, contractorId: "c1", cost: 100 }),
    job({ id: "j2", contractor: `${PREFIX}-Twin`, contractorId: "c2", cost: 200 }),
  ];

  const panel = dashboardPanel(jobs, roster);
  assert.equal(panel.rows.length, 2, "two contractors are two rows, however they are named");
  assert.deepEqual(
    panel.rows.map((row) => row.spend).sort((a, b) => a - b),
    [100, 200],
    "each holds only their own work",
  );
  assert.equal(panel.attributed, 300, "and the total is the sum of the jobs, counted once");

  // The old reducer collapsed both into one row of GBP 300 under one name, so
  // the screen showed a single contractor who had done twice the work.
  const old = nameKeyedSpend(jobs);
  assert.equal(old.size, 1, "the shipped reducer saw one contractor");
  assert.equal(old.get(`${PREFIX}-Twin`), 300, "holding both firms' money");
});

test("W06-12: a job linked by id with blank contractor text is still attributed", () => {
  /*
   * `if (!name) continue` — the second half of the shipped line. A job whose
   * text was cleared, or which was linked by the boot backfill and never had
   * text, HAS an owner: `contractor_id` names it. Dropping it silently removes
   * real money from a spend column that reads as a total.
   */
  const roster = [{ id: "c1", name: `${PREFIX}-Linked` }];
  for (const blank of [null, "", "   "]) {
    const jobs = [job({ id: "j1", contractor: blank, contractorId: "c1", cost: 265 })];
    const panel = dashboardPanel(jobs, roster);
    assert.equal(panel.attributed, 265, `attributed with contractor text ${JSON.stringify(blank)}`);
    assert.equal(panel.rows[0].name, `${PREFIX}-Linked`, "under the register's name for the id");
    assert.equal(nameKeyedSpend(jobs).size, 0, "the shipped reducer dropped it entirely");
  }
});

test("W06-12: an ambiguous name with no id is attributed to nobody, not to a guess", () => {
  /*
   * The same answer `resolveContractorLink` gives on the write path: two
   * matches link nothing. An under-count is visible and fixable — the operator
   * links the job, or renames one of the pair — while a double count silently
   * inflates a figure somebody bills from.
   */
  const roster = [
    { id: "c1", name: `${PREFIX}-Twin` },
    { id: "c2", name: `${PREFIX}-Twin` },
  ];
  const jobs = [job({ id: "j1", contractor: `${PREFIX}-Twin`, contractorId: null, cost: 999 })];

  const attribution = attributeContractorWork(jobs, roster);
  assert.deepEqual(
    attribution.byRoster.map((row) => row.jobs.length),
    [0, 0],
    "neither of the two carries it",
  );
  assert.equal(attribution.unregistered.length, 0, "and it is not a third, invented contractor");
  assert.equal(attribution.unattributed.length, 1, "it is held out, not thrown away");

  const panel = dashboardPanel(jobs, roster);
  assert.equal(panel.attributed, 0, "no contractor is credited with it");
  assert.equal(panel.unplaced, 999, "and the panel says so rather than hiding it");
  assert.equal(panel.total, 999, "the money is still in the estate's total");
});

/* ── The totals add up, and agree between screens ──────────────────────────── */

test("W06-12: every job lands in exactly one bucket, so a total is a total", () => {
  const roster = [
    { id: "c1", name: `${PREFIX}-Alpha` },
    { id: "c2", name: `${PREFIX}-Beta` },
    { id: "c3", name: `${PREFIX}-Twin` },
    { id: "c4", name: `${PREFIX}-Twin` },
  ];
  const jobs = [
    job({ id: "j1", contractor: `${PREFIX}-Alpha`, contractorId: "c1", cost: 250 }),
    job({ id: "j2", contractor: `${PREFIX}-Alpha Was`, contractorId: "c1", cost: 15 }),
    job({ id: "j3", contractor: `${PREFIX}-Beta`, contractorId: null, cost: 400 }),
    job({ id: "j4", contractor: `${PREFIX}-Unregistered`, contractorId: null, cost: 30 }),
    job({ id: "j5", contractor: `${PREFIX}-Twin`, contractorId: null, cost: 999 }),
    job({ id: "j6", contractor: null, contractorId: "gone", cost: 60 }),
    job({ id: "j7", contractor: null, contractorId: null, cost: 5 }),
    job({ id: "j8", contractor: `${PREFIX}-Alpha`, contractorId: "c1", cost: null }),
  ];

  const attribution = attributeContractorWork(jobs, roster);
  const placed = [...attribution.byRoster, ...attribution.unregistered].flatMap((row) => row.jobs);
  assert.equal(
    placed.length + attribution.unattributed.length,
    jobs.length,
    "the partition covers every row",
  );
  assert.equal(new Set(placed).size, placed.length, "and places none of them twice");

  const panel = dashboardPanel(jobs, roster);
  assert.equal(panel.total, 1759, "every costed job in the window");
  assert.equal(panel.attributed, 695, "250 + 15 + 400 + 30, with an uncosted job adding nothing");
  assert.equal(panel.linked, 665, "of which 250 + 15 + 400 is behind a register record");
  assert.equal(panel.unplaced, 1059, "the ambiguous 999 and the dangling id's 60");
  assert.equal(
    panel.attributed + panel.unplaced + 5,
    panel.total,
    "attributed + unplaced + the job nobody was named on IS the whole",
  );
});

test("W06-12: all-time contractor spend reconciles exactly across Reports, the Dashboard and the register", () => {
  /*
   * "All records" is the only window in which these screens are asking the same
   * question. Reports and the Dashboard scope by
   * `withinAnalyticsPeriod(request.requestedAt, …)`; the Contractors register
   * scopes by `stampWithinPeriod(request.completedAt ?? request.requestedAt,
   * …)`, because that page asks what a contractor DID in a window and a job
   * raised in June and finished in August is August's work to them. Over "All
   * records" neither window excludes anything, so the two bases select the same
   * rows and the figures must be identical to the penny.
   *
   * The fixture deliberately contains a job whose two dates fall in different
   * months — the "same GBP 265 in July on one screen and August on the other"
   * case from the audit. It must not change the all-time answer.
   */
  const roster = [
    { id: "c1", name: `${PREFIX}-Alpha` },
    { id: "c2", name: `${PREFIX}-Beta` },
  ];
  const jobs = [
    job({ id: "j1", contractorId: "c1", contractor: `${PREFIX}-Alpha`, cost: 265,
      requestedAt: "2026-07-28", completedAt: "2026-08-03" }),
    job({ id: "j2", contractorId: "c2", contractor: null, cost: 40,
      requestedAt: "2026-08-11", completedAt: null }),
    job({ id: "j3", contractorId: null, contractor: `${PREFIX}-Beta`, cost: 12,
      requestedAt: "2026-05-02", completedAt: "2026-05-09" }),
  ];

  const dashboard = dashboardPanel(jobs, roster);
  const register = contractorsPageTracked(jobs, roster);

  assert.equal(register, 317, "the register's Tracked spend tile over All records");
  assert.equal(
    dashboard.linked,
    register,
    "and the panels' registered-contractor spend is the same number, not a near one",
  );
  assert.equal(dashboard.attributed, register, "with no unregistered name in this fixture to differ by");

  /*
   * The one difference between the two figures, made explicit so nobody reads
   * it as a disagreement: a name on a job that no register row carries is spend
   * the PANELS show — they rank whoever did the work — and the register tile
   * does not, because that tile sums a register. Adding the unregistered rows
   * to the register's number reconciles them exactly.
   */
  const withStranger = [...jobs, job({ id: "j4", contractor: `${PREFIX}-Nobody`, cost: 7 })];
  const strangerPanel = dashboardPanel(withStranger, roster);
  assert.equal(strangerPanel.linked, contractorsPageTracked(withStranger, roster), "linked still ties");
  assert.equal(strangerPanel.attributed, 324, "and the panel adds the unlinked firm's work");
});

/* ── Agreed rates are not spend ────────────────────────────────────────────── */

test("W06-12: an agreed day, call-out or hourly rate never enters a spend total", async () => {
  /*
   * The contractor register now carries `day_rate_pence`, `call_out_cost_pence`,
   * `hourly_rate_pence` and `other_cost_pence`. Those are agreed TERMS. Without
   * days worked, hours worked or call-outs used, adding them into a dashboard
   * figure does not summarise cost — it invents it, in the wrong unit as well,
   * since job cost is pounds and the rates are pence.
   *
   * The guarantee is structural, and this test is what proves the structure
   * holds: the roster entries below carry every rate column, at values that
   * would be unmissable if any of them leaked, and every figure is unchanged.
   */
  const bare = [{ id: "c1", name: `${PREFIX}-Rated` }];
  const rated = [{
    id: "c1",
    name: `${PREFIX}-Rated`,
    dayRatePence: 45_000,
    callOutCostPence: 9_000,
    hourlyRatePence: 6_500,
    otherCostPence: 12_345,
    otherCostLabel: "Standby",
  }];
  const jobs = [
    job({ id: "j1", contractorId: "c1", cost: 250 }),
    // Costed by nobody. The agreed rate must NOT be substituted for it.
    job({ id: "j2", contractorId: "c1", cost: null }),
  ];

  assert.deepEqual(dashboardPanel(jobs, rated), dashboardPanel(jobs, bare), "the rates change nothing");
  assert.equal(dashboardPanel(jobs, rated).attributed, 250, "one costed job at GBP 250, and no rate");
  assert.equal(contractorsPageTracked(jobs, rated), 250, "the register tile agrees");

  // And no reporting surface so much as mentions a rate column in its arithmetic.
  for (const path of [
    "app/lib/contractor-attribution.ts",
    "app/(app)/portal/dashboard-insights.tsx",
  ]) {
    const source = (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(
      source,
      /dayRatePence|callOutCostPence|hourlyRatePence|otherCostPence/,
      `${path} computes spend from job cost alone`,
    );
  }
});

/* ── The screens ───────────────────────────────────────────────────────────── */

test("W06-12: the name-keyed reducer is gone from the Reports scorecard", async () => {
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  const start = insights.indexOf("export function ContractorScorecard(");
  assert.ok(start > 0, "ContractorScorecard was found");
  const panel = insights.slice(start, insights.indexOf("/* ── Contractor cost, for the Dashboard"));
  assert.ok(panel.length > 0 && panel.length < 20_000, "the panel was sliced, not the whole file");

  assert.doesNotMatch(
    panel.replace(/\/\*[\s\S]*?\*\//g, ""),
    /const name = \(request\.contractor \?\? ""\)\.trim\(\);/,
    "the line that keyed spend on name text is not here any more",
  );
  assert.match(
    panel,
    /attributeContractorWork\(requests, contractors\)/,
    "the scorecard goes through the one shared attribution rule",
  );
  assert.match(
    panel,
    /key=\{row\.key\}/,
    "and its rows are keyed by the register id, not by the name",
  );
  assert.match(panel, /Actual spend/, "the column says what kind of money it is");
});

test("W06-12: the Dashboard has a contractor cost panel of its own", async () => {
  const app = await read("app/(app)/portal/portal-app.tsx");

  /*
   * The Dashboard half of "Reports and Dashboard" was unmet outright: the only
   * contractor panel in the product was rendered once, inside the widget list
   * guarded by `surface="reports"`. This asserts the OVERVIEW list, sliced from
   * its own `surface="overview"` marker, so a panel on Reports alone can never
   * satisfy it again.
   */
  const overview = app.indexOf('surface="overview"');
  assert.ok(overview > 0, "the Overview widget list was found");
  const list = app.slice(overview, app.indexOf("export function LegacyMaintenanceView"));
  assert.match(list, /key: "contractor-spend"/, "Overview declares a contractor spend widget");
  assert.match(list, /<ContractorCostPanel/, "and renders the panel");
  assert.match(
    list,
    /contractors=\{registeredContractors\}/,
    "with the register, without which an id means nothing",
  );
  assert.match(
    list,
    /requests=\{scopedRequests\}/,
    "over the same rows every other figure on the page uses",
  );

  // Reports keeps both: the scorecard by volume, and the same cost panel.
  const reports = app.indexOf('surface="reports"');
  assert.ok(reports > 0, "the Reports widget list was found");
  const reportsList = app.slice(reports, reports + 6_000);
  assert.match(reportsList, /<ContractorScorecard[\s\S]{0,200}contractors=\{registeredContractors\}/,
    "the scorecard is given the register too");
  assert.match(reportsList, /key: "contractor-spend"/, "and Reports carries the cost panel as well");
});

test("W06-12: the replays above are still what the screens compute", async () => {
  /*
   * The guard on this whole file. `dashboardPanel` and `contractorsPageTracked`
   * above are copies of four lines of addition each, and a copy that stops
   * matching the screen it stands for asserts nothing.
   */
  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  const app = await read("app/(app)/portal/portal-app.tsx");

  const cost = insights.slice(insights.indexOf("export function ContractorCostPanel("));
  assert.match(cost, /attributeContractorWork\(requests, contractors\)/);
  assert.match(cost, /\.filter\(\(row\) => row\.spend > 0\)/, "only contractors with recorded cost");
  assert.match(
    cost,
    /const attributed = ranked\.reduce\(\(sum, row\) => sum \+ row\.spend, 0\);/,
    "attributed is the sum of the ranked rows",
  );
  assert.match(
    cost,
    /linked: attribution\.byRoster\.reduce\(\(sum, row\) => sum \+ contractorJobCost\(row\.jobs\), 0\)/,
    "linked is the registered half of it",
  );
  assert.match(cost, /total: contractorJobCost\(requests\)/, "and total is every costed job in scope");

  const view = app.slice(app.indexOf("function ContractorsView("));
  assert.match(
    view,
    /const attribution = attributeContractorWork\(scopedRequests, roster\);/,
    "the register page uses the shared rule",
  );
  assert.match(
    view,
    /const theirs = attribution\.byRoster\[index\]\.jobs;/,
    "index-aligned with the roster, so a contractor with no work keeps their row",
  );
  assert.match(
    view,
    /spend: theirs\.reduce\(\(sum, request\) => sum \+ \(request\.cost \?\? 0\), 0\)/,
    "and its spend is recorded job cost, unchanged",
  );
});

/* ── One date basis, and it is stated where a reader will see it ───────────── */

test("W06-12: contractor spend names its operational date basis on the screen", async () => {
  /*
   * NOT a claim that a cost date exists. There is none — `cost` carries no date
   * of its own, the `invoice` column beside it is free text, and the `invoices`
   * table has never been read or written by any code here. The sibling test
   * "contractor spend has no cost date, and the code says so"
   * (tests/workstream-six-contractor-scope.test.mjs) pins that fact in the
   * source. This one adds the half that source comments cannot do: the reader
   * is told, on the panel, which operational date decided the window and that
   * the figure is recorded job cost rather than money that moved.
   *
   * ONE BASIS FOR THE EQUIVALENT METRICS. Reports and the Dashboard both scope
   * by `requestedAt`, which is what every other analytics figure on those two
   * pages already uses — so the contractor panel cannot print a different total
   * for the same window as the spend tiles beside it. The Contractors register
   * keeps `completedAt ?? requestedAt` on purpose: its spend shares a window
   * with its own "completed 38", and moving one without the other would make a
   * single row measure two periods at once. The two agree exactly over "All
   * records", which the reconciliation test above asserts.
   */
  assert.deepEqual(
    CONTRACTOR_SPEND_BASIS,
    { requested: "raised", completed: "completed" },
    "the two operational bases are named in one place",
  );
  const note = contractorSpendBasisNote(CONTRACTOR_SPEND_BASIS.requested);
  assert.match(note, /Recorded job cost/, "the note says what kind of money this is");
  assert.match(note, /Not invoiced or paid amounts/, "and what it is not");
  assert.match(note, /never an agreed rate/, "including that an agreed rate is not spend");
  assert.match(note, /the work was raised in/, "and which date decided the period");

  const insights = await read("app/(app)/portal/dashboard-insights.tsx");
  const uses = insights.match(
    /contractorSpendBasisNote\(CONTRACTOR_SPEND_BASIS\.requested\)/g,
  ) ?? [];
  assert.equal(uses.length, 2, "both the scorecard and the cost panel print it");

  const app = await read("app/(app)/portal/portal-app.tsx");
  // Reports and Overview build their rows on the same basis, so the panel and
  // the tiles above it cannot mean two different windows.
  assert.equal(
    (app.match(/withinAnalyticsPeriod\(request\.requestedAt, period, now\)/g) ?? []).length,
    2,
    "Reports and Overview both scope by when the work was raised",
  );
  // And the register's own tile now says which basis it is on, out loud.
  assert.match(
    app,
    /Recorded job cost on work completed in this period\. Not invoiced or paid amounts, and never an agreed day, call-out or hourly rate\./,
    "the Tracked spend tile states its basis where a reader can see it",
  );
});

/* ── End to end, against the running product ───────────────────────────────── */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: "owner@maintsupp.com", password: "Sunnamusk-Owner-2026" };
const RUN = `${PREFIX}-${crypto.randomUUID().slice(0, 8)}`;

/** Every primary key this file created, so cleanup never has to guess. */
const created = { contractors: [], jobs: [] };

let cookie = "";

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function signIn() {
  let response;
  try {
    response = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(OWNER),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  cookie = (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(";")[0]).join("; ");
  return Boolean(cookie);
}

test("W06-12: a rename on the running product does not move GBP 265 off the contractor", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");

  const workspace = (await call("GET", "/api/workspace")).json?.workspace;
  const site = workspace?.stores?.[0];
  if (!site) return t.skip("the workspace payload carries no site to raise a job against");

  const made = await call("POST", "/api/workspace", {
    entity: "contractor",
    data: { name: `${RUN} Alpha`, availability: "Available", active: true },
  });
  assert.ok(made.status < 300, `the fixture contractor was created: ${JSON.stringify(made.json)}`);
  const contractorId = made.json.id;
  created.contractors.push(contractorId);

  const raised = await call("POST", "/api/maintenance", {
    location: site.name,
    requester: RUN,
    contact: "zzqa@example.com",
    description: `${RUN} W06-12 attribution fixture, safe to delete.`,
    category: "Electrical",
    priority: "Medium",
  });
  assert.equal(raised.status, 201, `the fixture job was raised: ${JSON.stringify(raised.json)}`);
  const jobId = raised.json.request.id;
  created.jobs.push(jobId);

  /*
   * Through the real write path, which is what makes this an end-to-end trace:
   * `contractorLinkValues` resolves the text to a `contractor_id` on the way in.
   * If it did not, the assertion below would fail on the id rather than on the
   * arithmetic, and that would be the finding.
   */
  const assigned = await call("PATCH", "/api/maintenance", {
    id: jobId,
    fields: { contractor: `${RUN} Alpha`, cost: 265 },
  });
  assert.equal(assigned.status, 200, `the job was assigned: ${JSON.stringify(assigned.json)}`);

  const before = ((await call("GET", "/api/maintenance")).json?.requests ?? [])
    .find((row) => row.id === jobId);
  assert.equal(before.contractorId, contractorId, "the write path linked the job by reference");
  assert.equal(before.cost, 265, "and recorded the cost of works");

  // The rename. The job's own `contractor` text is not rewritten by it.
  const renamed = await call("PATCH", "/api/workspace", {
    entity: "contractor",
    id: contractorId,
    data: { name: `${RUN} Alpha Renamed` },
  });
  assert.equal(renamed.status, 200, `the contractor was renamed: ${JSON.stringify(renamed.json)}`);

  const rows = (await call("GET", "/api/maintenance")).json?.requests ?? [];
  const after_ = rows.find((row) => row.id === jobId);
  assert.equal(after_.contractor, `${RUN} Alpha`, "the job still records the name it was given");
  assert.equal(after_.contractorId, contractorId, "and still points at the contractor");

  const roster = ((await call("GET", "/api/workspace")).json?.workspace?.contractors ?? [])
    .map((entry) => ({ id: entry.id, name: entry.name }));
  const mine = roster.find((entry) => entry.id === contractorId);
  assert.equal(mine.name, `${RUN} Alpha Renamed`, "the register carries the new name");

  /*
   * THE TRACE. The real payload, the real roster, the panel's own arithmetic.
   * The GBP 265 is on the renamed contractor and on nobody else, and the old
   * name — which is still written on the job — is not a row at all.
   */
  const live = rows.filter((row) => !row.parentId && !row.archived);
  const panel = dashboardPanel(live, roster);
  const row = panel.rows.find((entry) => entry.name === `${RUN} Alpha Renamed`);
  assert.ok(row, "the renamed contractor is on the panel");
  assert.equal(row.spend, 265, "holding the GBP 265 the register shows against them");
  assert.equal(
    panel.rows.some((entry) => entry.name === `${RUN} Alpha`),
    false,
    "and the name they used to have is not a second contractor",
  );

  // What shipped, over the same live rows: the money under a name no register
  // row carries. This is the audit's reproduction, asserted.
  const old = nameKeyedSpend(live);
  assert.equal(old.get(`${RUN} Alpha`), 265, "the shipped reducer stranded it on the old name");
  assert.equal(old.get(`${RUN} Alpha Renamed`), undefined, "and credited the contractor nothing");
});

/* ── Cleanup, by primary key ───────────────────────────────────────────────── */

/**
 * BY EXACT ID, NEVER BY A SUBSTRING.
 *
 * A `LIKE 'ZZQA-%'` sweep has repeatedly eaten another suite's fixtures in this
 * repository — every HTTP-backed test file writes to one miniflare SQLite file,
 * and files run in parallel. This deletes the rows this run created and nothing
 * else, then asserts they are gone.
 */
after(async () => {
  if (!created.contractors.length && !created.jobs.length) return;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find(
      (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
    );
  } catch {
    return;
  }
  if (!file) return;

  let db;
  try {
    db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
  } catch (error) {
    console.warn(`fixture cleanup could not open the development database: ${error.message}`);
    return;
  }
  try {
    db.exec("PRAGMA busy_timeout = 15000");
    /*
     * One transaction, and THREE ATTEMPTS AT IT.
     *
     * Every HTTP-backed suite in this repository writes to one miniflare SQLite
     * file through one dev server, and `node --test` runs test FILES in
     * parallel. A cleanup that loses that race gets "database is locked", and
     * the first version of this hook logged the warning and left a contractor
     * and a job behind — measured, on the run that added the retry. Residue is
     * not a tolerable outcome here: the next run's register would contain a
     * contractor this one created, and a later suite sweeping by prefix would
     * be the thing that finally removed it, which is exactly the sweep this
     * file refuses to perform.
     */
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const id of created.jobs) {
            db.prepare("DELETE FROM activity_log WHERE entity_id = ?").run(id);
            db.prepare("DELETE FROM maintenance_requests WHERE id = ?").run(id);
          }
          for (const id of created.contractors) {
            db.prepare("DELETE FROM activity_log WHERE entity_id = ?").run(id);
            db.prepare("DELETE FROM contractors WHERE id = ?").run(id);
          }
          db.exec("COMMIT");
          lastError = null;
          break;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    if (lastError) throw lastError;

    for (const id of created.jobs) {
      assert.equal(
        db.prepare("SELECT count(*) n FROM maintenance_requests WHERE id = ?").get(id).n,
        0,
        `job ${id} is gone`,
      );
    }
    for (const id of created.contractors) {
      assert.equal(
        db.prepare("SELECT count(*) n FROM contractors WHERE id = ?").get(id).n,
        0,
        `contractor ${id} is gone`,
      );
    }
  } catch (error) {
    /*
     * A FAILURE, not a warning.
     *
     * This was `console.warn`, and a run whose cleanup lost the write race
     * printed the warning into scrollback nobody reads and left a contractor
     * and a costed job in the development register. Residue from a suite that
     * creates register rows is the thing this repository has been bitten by
     * most often, so it is reported the way a defect is reported.
     */
    assert.fail(`fixture cleanup left rows behind: ${error.message}`);
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});
