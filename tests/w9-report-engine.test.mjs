/**
 * Workstream 9 — the combined invoice + maintenance report ENGINE.
 *
 * WHAT IS TESTED HERE, AND WHY IT CAN BE
 *
 * Every module under `app/lib/reporting/` that decides a number is PURE: no
 * database handle, no React, no runtime import outside the same tree. That is
 * not a style preference, it is what makes this file possible — these are real
 * calls into the shipped code, not a re-implementation that could agree with
 * itself while the invoice is wrong.
 *
 * The modules are transpiled into a temporary directory that MIRRORS the real
 * one, so `./money`, `../site-state` and `../../(app)/portal/dashboard-meters`
 * resolve exactly as they do in the product. The alternative — the single
 * `data:` URL device the meter suites use — does not scale past two modules,
 * and rewriting ten specifiers by hand is how a test ends up importing a stub
 * of the thing it is meant to be checking.
 *
 * THE ONE INVARIANT ABOVE ALL OTHERS
 *
 * "ALL FORMAT TOTALS MUST MATCH." The design makes that structural — one
 * payload, four renderers, no database handle downstream — so what this file
 * checks is the layer beneath it: that the payload is internally consistent.
 * Lines sum to totals. Site rows sum to the portfolio figures. The job log
 * holds every job exactly once. The board's idea of "completed" and this
 * report's are the same idea.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

/* Every pure module the report is built from, plus the two shared modules it
   deliberately reuses rather than reimplementing. `dashboard-meters.ts` is in
   the list because `job-classification.ts` imports the board's own completed /
   awaiting-approval vocabulary from it — see the reconciliation test below. */
const MODULES = [
  "app/lib/reporting/contract.ts",
  "app/lib/reporting/money.ts",
  "app/lib/reporting/period.ts",
  "app/lib/reporting/job-classification.ts",
  "app/lib/reporting/sla.ts",
  "app/lib/reporting/invoice-compute.ts",
  "app/lib/reporting/data-quality.ts",
  "app/lib/reporting/narrative.ts",
  "app/lib/reporting/maintenance-compute.ts",
  "app/lib/reporting/blockers.ts",
  "app/lib/reporting/access.ts",
  "app/lib/billing/fee-resolution.ts",
  "app/lib/site-state.ts",
  "app/lib/priority-rules.ts",
  "app/(app)/portal/dashboard-meters.ts",
];

const stage = mkdtempSync(path.join(tmpdir(), "maintsupp-w9-"));

for (const file of MODULES) {
  const source = readFileSync(path.join(root, file), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  // Node's ESM resolver needs an extension on a relative specifier; TypeScript
  // deliberately emits them without one.
  const rewritten = outputText.replace(
    /from ["'](\.[^"']*?)["']/g,
    (_match, specifier) => `from "${specifier}.mjs"`,
  );
  const target = path.join(stage, file.replace(/\.ts$/, ".mjs"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, rewritten, "utf8");
}

const load = (file) =>
  import(pathToFileURL(path.join(stage, `${file}.mjs`)).href);

const contract = await load("app/lib/reporting/contract");
const money = await load("app/lib/reporting/money");
const period = await load("app/lib/reporting/period");
const classification = await load("app/lib/reporting/job-classification");
const sla = await load("app/lib/reporting/sla");
const invoice = await load("app/lib/reporting/invoice-compute");
const quality = await load("app/lib/reporting/data-quality");
const maintenance = await load("app/lib/reporting/maintenance-compute");
const blockers = await load("app/lib/reporting/blockers");
const access = await load("app/lib/reporting/access");
const fees = await load("app/lib/billing/fee-resolution");
const meters = await load("app/(app)/portal/dashboard-meters");

/* ------------------------------------------------------------- fixtures -- */

const MARCH = { start: "2026-03-01", end: "2026-03-31", label: "March 2026", partialMonth: false };

function config(overrides = {}) {
  return {
    currency: "GBP",
    defaultSiteFeePence: 12_000,
    vatEnabled: false,
    vatRateBasisPoints: 2000,
    vatNumber: null,
    paymentTermsDays: 30,
    paymentTermsNote: null,
    billingAddress: "1 Example Street",
    invoiceNumberPrefix: "MS",
    proRataEnabled: false,
    ...overrides,
  };
}

function site(id, overrides = {}) {
  return {
    id,
    name: `Site ${id}`,
    reference: id.toUpperCase(),
    status: "active",
    active: true,
    billable: true,
    billingActiveFrom: null,
    billingActiveTo: null,
    ...overrides,
  };
}

let jobSequence = 0;
function job(overrides = {}) {
  jobSequence += 1;
  return {
    id: `JOB-${jobSequence}`,
    reference: `MS-2026-${String(jobSequence).padStart(4, "0")}`,
    title: `Job ${jobSequence}`,
    description: "A description",
    siteId: "a",
    siteName: "Site a",
    recordedSiteName: "Site a",
    status: "Job Scheduled",
    stage: "Booked",
    priority: "Medium",
    tier: 2,
    classification: "Plumbing",
    jobType: "Plumbing",
    contractor: "Acme",
    contractorId: null,
    contractorRegisterName: null,
    assignee: null,
    requester: "Manager",
    requestedOn: "2026-03-02",
    targetOn: "2026-03-09",
    completedOn: null,
    costPence: null,
    costInvalid: false,
    approvedQuotePence: null,
    invoice: null,
    approvedBy: null,
    notes: null,
    blockedReason: null,
    nextUpdateOn: null,
    ...overrides,
  };
}

function header(overrides = {}) {
  return {
    invoiceId: null,
    invoiceNumber: null,
    status: "Draft",
    invoiceDate: "2026-04-01",
    dueAt: "2026-05-01",
    billingAddress: "1 Example Street",
    clientReference: null,
    purchaseOrder: null,
    internalReference: null,
    paymentTerms: "30 days",
    clientNote: null,
    internalNote: null,
    ...overrides,
  };
}

function buildInvoice(overrides = {}) {
  return invoice.computeInvoiceSection({
    period: MARCH,
    clientName: "Sunnamusk UK",
    config: config(),
    sites: [site("a"), site("b")],
    clientFees: [],
    siteOverrides: [],
    existingCharges: [],
    decisions: [],
    adjustments: [],
    header: header(),
    ...overrides,
  });
}

function buildReport(overrides = {}) {
  const section = overrides.invoiceSection ?? buildInvoice();
  const jobs = overrides.jobs ?? [];
  const sites = overrides.sites ?? [site("a"), site("b")];
  const holds = overrides.holds ?? [];
  const slaRules = overrides.slaRules ?? [];
  const dataQuality =
    overrides.dataQuality ??
    quality.computeDataQuality({
      period: overrides.period ?? MARCH,
      jobs,
      sites,
      holds,
      slaRules,
      invoiceLines: section.lines,
      existingCharges: [],
      vatEnabled: section.vatEnabled,
      vatNumber: section.vatNumber,
      vatRateBasisPoints: section.vatRateBasisPoints,
      defaultSiteFeePence: 12_000,
    });
  return maintenance.computeMaintenanceSection({
    period: overrides.period ?? MARCH,
    previousPeriod: overrides.previousPeriod ?? null,
    asOf: overrides.asOf ?? "2026-03-31",
    jobs,
    previousJobs: overrides.previousJobs ?? [],
    sites,
    holds,
    slaRules,
    invoiceTotals: section.totals,
    invoiceLines: section.lines,
    dataQuality,
    currency: "GBP",
  });
}

/* ----------------------------------------------------------------- money -- */

test("pounds become pence at one boundary, half away from zero", () => {
  // The three values a person checks by hand, and the one binary floats get
  // wrong: 1.005 * 100 is 100.49999999999999 and rounds DOWN without the fix.
  assert.equal(money.poundsToPence(12.34), 1234);
  assert.equal(money.poundsToPence(1.005), 101);
  assert.equal(money.poundsToPence(0), 0);
  // Missing and recorded-as-zero are different facts and stay different.
  assert.equal(money.poundsToPence(null), null);
  assert.equal(money.poundsToPence(undefined), null);
  assert.equal(money.poundsToPence(Number.NaN), null);
  assert.equal(money.poundsToPenceOrZero(null), 0);
  // Symmetric, so a credit and the charge it reverses round to one magnitude.
  assert.equal(money.roundPence(0.5), 1);
  assert.equal(money.roundPence(-0.5), -1);
});

test("VAT is basis points and a single fee is only single when it is", () => {
  assert.equal(money.vatOnPence(12_000, 2000), 2400);
  assert.equal(money.vatOnPence(12_000, 0), 0);
  assert.equal(money.singleValue([12_000, 12_000]), 12_000);
  assert.equal(money.singleValue([12_000, 14_000]), null);
  // An empty invoice has no fixed fee to state — claiming one would put a
  // confident number on a document with nothing on it.
  assert.equal(money.singleValue([]), null);
});

/* ---------------------------------------------------------------- period -- */

test("a stored stamp names one calendar day, in either shape", () => {
  assert.equal(period.dateOnly("2026-08-03"), "2026-08-03");
  assert.equal(period.dateOnly("2026-08-09 07:39:18"), "2026-08-09");
  assert.equal(period.dateOnly("2026-08-09T07:39:18.000Z"), "2026-08-09");
  assert.equal(period.dateOnly("2026-02-31"), null, "31 February is not a day");
  assert.equal(period.dateOnly(null), null);
  assert.equal(period.dateOnly("nonsense"), null);
});

test("a whole calendar month resolves to that month and is not partial", () => {
  const resolved = period.resolveReportPeriod({ preset: "last-month", todayIso: "2026-04-14" });
  assert.equal(resolved.ok, true);
  assert.deepEqual(
    { start: resolved.period.start, end: resolved.period.end, partialMonth: resolved.period.partialMonth },
    { start: "2026-03-01", end: "2026-03-31", partialMonth: false },
  );
  // The label is the month, not the preset: a filed invoice headed "Last month"
  // is unreadable the moment it is filed.
  assert.equal(resolved.period.label, "March 2026");
});

test("February in a leap year keeps its 29th", () => {
  const resolved = period.resolveReportPeriod({ preset: "this-month", todayIso: "2024-02-10" });
  assert.equal(resolved.period.end, "2024-02-29");
  assert.equal(resolved.period.partialMonth, false);
});

test("a custom range is Custom range, and a backwards one is refused", () => {
  const ok = period.resolveReportPeriod({
    preset: "custom",
    todayIso: "2026-04-01",
    start: "2026-03-05",
    end: "2026-03-20",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.period.label, "Custom range");
  assert.equal(ok.period.partialMonth, true, "not a whole calendar month");

  const backwards = period.resolveReportPeriod({
    preset: "custom",
    todayIso: "2026-04-01",
    start: "2026-03-20",
    end: "2026-03-05",
  });
  assert.equal(backwards.ok, false);
  assert.match(backwards.error, /after the end date/);
});

test("the comparable period is the month before, or the same length before", () => {
  const march = period.previousComparablePeriod(MARCH);
  assert.deepEqual([march.start, march.end], ["2026-02-01", "2026-02-28"]);

  const eleven = period.previousComparablePeriod({
    start: "2026-03-05",
    end: "2026-03-15",
    label: "Custom range",
    partialMonth: true,
  });
  // Eleven days compared with eleven days. Nothing is scaled to make a
  // fortnight look like a month.
  assert.deepEqual([eleven.start, eleven.end], ["2026-02-22", "2026-03-04"]);
});

test("working days are Monday to Friday and nothing else", () => {
  // 2026-03-02 is a Monday; 2026-03-06 the Friday of the same week.
  assert.equal(period.workingDaysInclusive("2026-03-02", "2026-03-06"), 5);
  assert.equal(period.workingDaysInclusive("2026-03-02", "2026-03-08"), 5, "the weekend adds nothing");
  assert.equal(period.workingDaysInclusive("2026-03-07", "2026-03-08"), 0, "a weekend alone is zero");
  assert.equal(period.workingDaysInclusive("2026-03-06", "2026-03-02"), 0, "backwards is zero, not negative");
});

/* -------------------------------------------------- reconciliation checks -- */

test("the report's idea of completed is the BOARD's idea of completed", () => {
  /*
   * The single most important assertion in this file. `isClosedRequest` is the
   * canonical definition in this product; if the report ever disagrees with it,
   * a client finds a job that is finished on one screen and open on another.
   * Every combination of stage and status, both ways.
   */
  const stages = ["Incoming", "Booked", "Attention", "Completed"];
  for (const stage of stages) {
    for (const status of meters.maintenanceStatusLabels) {
      const row = { stage, status, priority: "Medium", tier: 2 };
      assert.equal(
        classification.isCompletedJob(row),
        meters.isClosedRequest(row),
        `${stage} / ${status} disagrees with the board`,
      );
    }
  }
});

test("every one of the board's 23 status labels lands in exactly one group", () => {
  const groups = new Set(contract.JOB_LOG_GROUPS);
  for (const status of meters.maintenanceStatusLabels) {
    const group = classification.jobLogGroup({ stage: "Incoming", status, priority: "Medium", tier: 2 });
    assert.ok(groups.has(group), `${status} produced "${group}", which is not a job-log group`);
  }
  // The three the board itself calls "awaiting approval" are borrowed from it
  // rather than restated, so adding one there moves it here in the same edit.
  for (const status of meters.awaitingApprovalStatuses) {
    assert.equal(
      classification.jobLogGroup({ stage: "Incoming", status, priority: "Medium", tier: 2 }),
      "Awaiting Approval",
      status,
    );
  }
});

test("no board status means cancelled, so the Cancelled group is empty by construction", () => {
  // Documented, deliberate, and asserted so that adding a label to
  // CANCELLED_STATUSES is a visible decision rather than a quiet one.
  assert.deepEqual([...classification.CANCELLED_STATUSES], []);
  for (const status of meters.maintenanceStatusLabels) {
    assert.equal(classification.isCancelledJob({ status }), false, status);
  }
});

test("an unrecognised status falls back to the row's own lifecycle stage", () => {
  assert.equal(
    classification.jobLogGroup({ stage: "Attention", status: "Waiting on the council", priority: "Low", tier: 3 }),
    "On Hold",
  );
  assert.equal(classification.isKnownStatus("Waiting on the council"), false);
  assert.equal(classification.isKnownStatus("Job Completed"), true);
});

/* ------------------------------------------------------- fee resolution -- */

test("the fee hierarchy is override, then client fee, then organisation default", () => {
  const window = { start: "2026-03-01", end: "2026-03-31" };
  const override = { id: "ovr", siteId: "a", feePence: 20_000, effectiveFrom: null, effectiveTo: null, note: null };
  const clientFee = { id: "cli", siteId: null, feePence: 15_000, effectiveFrom: null, effectiveTo: null, note: null };

  assert.deepEqual(
    fees.resolveSiteFee({ overrides: [override], clientFees: [clientFee], defaultFeePence: 12_000, period: window })
      .resolved,
    { feePence: 20_000, source: "Site override", recordId: "ovr" },
  );
  assert.deepEqual(
    fees.resolveSiteFee({ overrides: [], clientFees: [clientFee], defaultFeePence: 12_000, period: window }).resolved,
    { feePence: 15_000, source: "Client fee", recordId: "cli" },
  );
  assert.deepEqual(
    fees.resolveSiteFee({ overrides: [], clientFees: [], defaultFeePence: 12_000, period: window }).resolved,
    { feePence: 12_000, source: "Organisation default", recordId: null },
  );
  // Nothing configured resolves to nothing — never to a fee of zero, which
  // would look like a decision somebody made.
  assert.equal(
    fees.resolveSiteFee({ overrides: [], clientFees: [], defaultFeePence: null, period: window }).resolved,
    null,
  );
});

test("an invoice for March prices at March's fee after April's rise", () => {
  const old = { id: "old", siteId: null, feePence: 12_000, effectiveFrom: "2025-01-01", effectiveTo: "2026-03-31", note: null };
  const risen = { id: "new", siteId: null, feePence: 14_000, effectiveFrom: "2026-04-01", effectiveTo: null, note: null };
  const march = fees.resolveSiteFee({
    overrides: [],
    clientFees: [old, risen],
    defaultFeePence: null,
    period: { start: "2026-03-01", end: "2026-03-31" },
  });
  assert.equal(march.resolved.feePence, 12_000);
  const april = fees.resolveSiteFee({
    overrides: [],
    clientFees: [old, risen],
    defaultFeePence: null,
    period: { start: "2026-04-01", end: "2026-04-30" },
  });
  assert.equal(april.resolved.feePence, 14_000);
});

test("a fee that changes INSIDE the period does not resolve, and says why", () => {
  const midMonth = { id: "mid", siteId: null, feePence: 13_000, effectiveFrom: "2026-03-14", effectiveTo: null, note: null };
  const result = fees.resolveSiteFee({
    overrides: [],
    clientFees: [midMonth],
    defaultFeePence: null,
    period: { start: "2026-03-01", end: "2026-03-31" },
  });
  assert.equal(result.resolved, null, "a partial cover is not a valid fee");
  assert.equal(result.partialCover.length, 1);
  assert.equal(result.partialCover[0].id, "mid");
});

/* --------------------------------------------------- billable selection -- */

test("multiple active sites are each a line and the totals sum to them", () => {
  const section = buildInvoice({ sites: [site("a"), site("b"), site("c")] });
  assert.equal(section.totals.totalSites, 3);
  assert.equal(section.totals.includedSites, 3);
  assert.equal(section.totals.subtotalPence, 36_000);
  assert.equal(section.totals.totalPence, 36_000);
  assert.equal(
    section.totals.subtotalPence,
    section.lines.filter((line) => line.included).reduce((sum, line) => sum + line.lineSubtotalPence, 0),
  );
  // Every site on the same fee, so the card is allowed to say "Fixed Fee".
  assert.equal(section.totals.singleFeePence, 12_000);
});

test("a site override makes the fee mixed, so there is no single fee to state", () => {
  const section = buildInvoice({
    sites: [site("a"), site("b")],
    siteOverrides: [
      { id: "ovr", siteId: "b", feePence: 20_000, effectiveFrom: null, effectiveTo: null, note: null },
    ],
  });
  const byId = Object.fromEntries(section.lines.map((line) => [line.siteId, line]));
  assert.equal(byId.a.feePence, 12_000);
  assert.equal(byId.a.feeSource, "Organisation default");
  assert.equal(byId.b.feePence, 20_000);
  assert.equal(byId.b.feeSource, "Site override");
  assert.equal(section.totals.singleFeePence, null, "mixed fees have no fixed fee");
  assert.equal(section.totals.averageFeePence, 16_000);
});

test("inactive, non-billable and out-of-window sites are excluded and SAID to be", () => {
  const section = buildInvoice({
    sites: [
      site("a"),
      site("closed", { status: "closed", active: false }),
      site("unbilled", { billable: false }),
      site("later", { billingActiveFrom: "2026-06-01" }),
      // 'other' is the register's word for a row it cannot vouch for. It is
      // deliberately not an active site — see `isActiveSiteStatus`.
      site("unverified", { status: "other" }),
    ],
  });
  const byId = Object.fromEntries(section.lines.map((line) => [line.siteId, line]));
  assert.equal(byId.a.included, true);
  for (const id of ["closed", "unbilled", "later", "unverified"]) {
    assert.equal(byId[id].included, false, id);
    assert.ok(byId[id].exclusionReason, `${id} must say why it is excluded`);
  }
  assert.equal(section.totals.includedSites, 1);
  assert.equal(section.totals.excludedSites, 4);
  // An excluded site is still a LINE. An operator cannot check a count they
  // cannot see.
  assert.equal(section.totals.totalSites, 5);
});

test("an international site is trading and IS billed", () => {
  const section = buildInvoice({ sites: [site("intl", { status: "international" })] });
  assert.equal(section.lines[0].included, true);
});

test("no billable sites at all is an empty, blocked invoice rather than a crash", () => {
  const section = buildInvoice({ sites: [] });
  assert.equal(section.totals.totalSites, 0);
  assert.equal(section.totals.includedSites, 0);
  assert.equal(section.totals.totalPence, 0);
  assert.equal(section.totals.singleFeePence, null);
  assert.equal(section.totals.averageFeePence, 0);
});

test("a site activated mid-period is charged in full and warned about", () => {
  const section = buildInvoice({
    sites: [site("a", { billingActiveFrom: "2026-03-14" })],
  });
  const line = section.lines[0];
  assert.equal(line.included, true);
  assert.equal(line.feePence, 12_000, "no pro rata unless the client has the rule");
  const codes = line.validation.map((entry) => entry.code);
  assert.ok(codes.includes(invoice.LINE_VALIDATION.sitePartialWindow));
  assert.equal(
    line.validation.find((entry) => entry.code === invoice.LINE_VALIDATION.sitePartialWindow).severity,
    "warning",
  );
});

test("a site deactivated mid-period is charged in full, or pro-rated when enabled", () => {
  const full = buildInvoice({ sites: [site("a", { billingActiveTo: "2026-03-15" })] });
  assert.equal(full.lines[0].feePence, 12_000);

  const prorated = buildInvoice({
    config: config({ proRataEnabled: true }),
    sites: [site("a", { billingActiveTo: "2026-03-15" })],
  });
  // 15 of March's 31 days. round(12000 * 15 / 31) = 5806.
  assert.equal(prorated.lines[0].feePence, 5806);
  assert.ok(
    prorated.lines[0].validation.some((entry) => entry.code === invoice.LINE_VALIDATION.proRated),
  );
});

test("a site with no resolvable fee is INCLUDED, charged nothing, and blocking", () => {
  const section = buildInvoice({ config: config({ defaultSiteFeePence: null }) });
  for (const line of section.lines) {
    assert.equal(line.included, true, "the site is not dropped — it would go silently unbilled");
    assert.equal(line.feePence, 0);
    assert.equal(line.feeSource, null);
    const blocking = line.validation.filter((entry) => entry.severity === "blocking");
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].code, invoice.LINE_VALIDATION.feeMissing);
  }
  // And the fixed-fee card must not say "£0.00 per site".
  assert.equal(section.totals.singleFeePence, null);
});

test("a site already charged for an overlapping period is refused", () => {
  const section = buildInvoice({
    existingCharges: [
      {
        siteId: "b",
        invoiceId: "other",
        invoiceNumber: "MS-00007",
        status: "Finalised",
        committed: true,
        periodStart: "2026-03-15",
        periodEnd: "2026-04-14",
      },
    ],
  });
  const byId = Object.fromEntries(section.lines.map((line) => [line.siteId, line]));
  assert.equal(byId.b.included, false);
  assert.match(byId.b.exclusionReason, /MS-00007/);
  assert.ok(
    byId.b.validation.some(
      (entry) => entry.code === invoice.LINE_VALIDATION.siteAlreadyCharged && entry.severity === "blocking",
    ),
  );
  // A charge for an adjacent, non-overlapping period is not a duplicate.
  const adjacent = buildInvoice({
    existingCharges: [
      {
        siteId: "b",
        invoiceId: "other",
        invoiceNumber: "MS-00008",
        status: "Finalised",
        committed: true,
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
      },
    ],
  });
  assert.equal(adjacent.lines.find((line) => line.siteId === "b").included, true);
});

test("an operator's exclusion is recorded on the line with who and why", () => {
  const section = buildInvoice({
    decisions: [
      { siteId: "b", included: false, reason: "Handed back to the landlord", byEmail: "ops@example.com", at: "2026-04-01T09:00:00.000Z" },
    ],
  });
  const line = section.lines.find((entry) => entry.siteId === "b");
  assert.equal(line.included, false);
  assert.equal(line.exclusionReason, "Handed back to the landlord");
  assert.equal(line.excludedByEmail, "ops@example.com");
  assert.equal(section.totals.includedSites, 1);
  assert.equal(section.totals.subtotalPence, 12_000);
});

/* ------------------------------------------------------------------ VAT -- */

test("VAT off adds nothing and is not merely a zero rate on the lines", () => {
  const section = buildInvoice({ config: config({ vatEnabled: false }) });
  assert.equal(section.vatEnabled, false);
  assert.equal(section.vatRateBasisPoints, 0);
  assert.equal(section.totals.vatPence, 0);
  assert.equal(section.totals.totalPence, section.totals.subtotalPence);
  for (const line of section.lines) assert.equal(line.lineVatPence, 0);
});

test("VAT on is rounded per line, so the lines sum to the printed total", () => {
  const section = buildInvoice({
    config: config({ vatEnabled: true, vatRateBasisPoints: 2000, vatNumber: "GB123456789" }),
    sites: [site("a"), site("b"), site("c")],
  });
  assert.equal(section.totals.subtotalPence, 36_000);
  assert.equal(section.totals.vatPence, 7_200);
  assert.equal(section.totals.totalPence, 43_200);
  assert.equal(
    section.totals.vatPence,
    section.lines.filter((line) => line.included).reduce((sum, line) => sum + line.lineVatPence, 0),
    "the VAT total is the sum of the line VAT figures",
  );
  assert.equal(
    section.totals.totalPence,
    section.lines.filter((line) => line.included).reduce((sum, line) => sum + line.lineTotalPence, 0),
  );
});

test("an adjustment adds and a credit subtracts, both from stored magnitudes", () => {
  const section = buildInvoice({
    adjustments: [
      { id: "adj", kind: "adjustment", amountPence: 5_000, reason: "Out of hours call-out", authorisedByEmail: "finance@example.com", createdAt: "2026-04-01T09:00:00.000Z" },
      { id: "cr", kind: "credit", amountPence: 2_000, reason: "Goodwill", authorisedByEmail: "finance@example.com", createdAt: "2026-04-01T09:05:00.000Z" },
    ],
  });
  assert.equal(section.totals.adjustmentPence, 5_000);
  assert.equal(section.totals.creditPence, 2_000);
  assert.equal(section.totals.totalPence, 24_000 + 5_000 - 2_000);
});

/* ------------------------------------------------------------------ SLA -- */

const PLUMBING_RULE = {
  id: "rule-1",
  classification: "Plumbing",
  targetWorkingDays: 5,
  active: true,
  version: 1,
  note: null,
};

test("a completed job inside its target is Within, outside it is Outside", () => {
  // 2026-03-02 Monday to 2026-03-06 Friday is five working days.
  const within = sla.computeSlaOutcome(
    job({ status: "Job Completed", stage: "Completed", requestedOn: "2026-03-02", completedOn: "2026-03-06" }),
    [],
    [PLUMBING_RULE],
  );
  assert.equal(within.result, "Within");
  assert.equal(within.elapsedWorkingDays, 5);
  assert.equal(within.adjustedWorkingDays, 5);
  assert.equal(within.targetWorkingDays, 5);

  const outside = sla.computeSlaOutcome(
    job({ status: "Job Completed", stage: "Completed", requestedOn: "2026-03-02", completedOn: "2026-03-11" }),
    [],
    [PLUMBING_RULE],
  );
  assert.equal(outside.result, "Outside");
  assert.equal(outside.elapsedWorkingDays, 8);
});

test("only APPROVED holds reduce the measured duration", () => {
  const finished = job({
    status: "Job Completed",
    stage: "Completed",
    requestedOn: "2026-03-02",
    completedOn: "2026-03-11",
  });
  const hold = {
    id: "h1",
    requestId: finished.id,
    startAt: "2026-03-04",
    endAt: "2026-03-06",
    reason: "Waiting for parts",
    category: "Parts",
    approved: false,
    approvedBy: null,
    approvedAt: null,
    note: null,
  };

  const unapproved = sla.computeSlaOutcome(finished, [hold], [PLUMBING_RULE]);
  assert.equal(unapproved.approvedHoldDays, 0);
  assert.equal(unapproved.result, "Outside", "an unapproved hold is not a discount");

  const approved = sla.computeSlaOutcome(
    finished,
    [{ ...hold, approved: true, approvedBy: "ops@example.com", approvedAt: "2026-03-07" }],
    [PLUMBING_RULE],
  );
  assert.equal(approved.approvedHoldDays, 3, "Wed, Thu, Fri");
  assert.equal(approved.adjustedWorkingDays, 5);
  assert.equal(approved.result, "Within");
});

test("two overlapping approved holds remove the same day once", () => {
  const finished = job({
    status: "Job Completed",
    stage: "Completed",
    requestedOn: "2026-03-02",
    completedOn: "2026-03-13",
  });
  const base = { requestId: finished.id, reason: null, category: null, approved: true, approvedBy: "a", approvedAt: null, note: null };
  const days = sla.approvedHoldDays(
    [
      { ...base, id: "h1", startAt: "2026-03-04", endAt: "2026-03-06" },
      { ...base, id: "h2", startAt: "2026-03-05", endAt: "2026-03-09" },
    ],
    "2026-03-02",
    "2026-03-13",
  );
  // 4th to 9th March inclusive is Wed Thu Fri Mon — four working days, not the
  // seven the two windows would give if they were summed independently.
  assert.equal(days, 4);
});

test("a hold outside the job's duration is clamped, never negative", () => {
  const finished = job({
    status: "Job Completed",
    stage: "Completed",
    requestedOn: "2026-03-09",
    completedOn: "2026-03-11",
  });
  const outcome = sla.computeSlaOutcome(
    finished,
    [
      {
        id: "h1",
        requestId: finished.id,
        startAt: "2026-01-01",
        endAt: "2026-12-31",
        reason: null,
        category: null,
        approved: true,
        approvedBy: "a",
        approvedAt: null,
        note: null,
      },
    ],
    [PLUMBING_RULE],
  );
  assert.equal(outcome.approvedHoldDays, 3, "clamped to the job's own three days");
  assert.equal(outcome.adjustedWorkingDays, 0, "never below zero");
});

test("every exclusion carries a reason, and none of them is a guess", () => {
  const cases = [
    [job({ status: "Job Scheduled" }), sla.SLA_EXCLUSION.noCompletionDate],
    [job({ status: "Job Completed", stage: "Completed", completedOn: null }), sla.SLA_EXCLUSION.completedWithoutDate],
    [job({ status: "Job Completed", stage: "Completed", requestedOn: null, completedOn: "2026-03-05" }), sla.SLA_EXCLUSION.noRequestDate],
    [job({ status: "Job Completed", stage: "Completed", classification: null, completedOn: "2026-03-05" }), sla.SLA_EXCLUSION.noClassification],
    [job({ status: "Job Completed", stage: "Completed", classification: "Roofing", completedOn: "2026-03-05" }), sla.SLA_EXCLUSION.noRule],
    [job({ status: "Major works", completedOn: "2026-03-05" }), sla.SLA_EXCLUSION.project],
    [job({ status: "Job Completed", stage: "Completed", requestedOn: "2026-03-10", completedOn: "2026-03-05" }), sla.SLA_EXCLUSION.invalidSequence],
  ];
  for (const [row, reason] of cases) {
    const outcome = sla.computeSlaOutcome(row, [], [PLUMBING_RULE]);
    assert.equal(outcome.result, "Excluded", reason);
    assert.equal(outcome.exclusionReason, reason);
    assert.equal(outcome.adjustedWorkingDays, null, "an excluded job has no measurement, not a zero");
  }
});

test("an authorised exclusion takes the job out even when everything else is present", () => {
  const finished = job({ status: "Job Completed", stage: "Completed", requestedOn: "2026-03-02", completedOn: "2026-03-04" });
  const outcome = sla.computeSlaOutcome(
    finished,
    [
      {
        id: "h1",
        requestId: finished.id,
        startAt: "2026-03-03",
        endAt: null,
        reason: "Agreed with the client",
        category: sla.AUTHORISED_EXCLUSION_CATEGORY,
        approved: true,
        approvedBy: "finance@example.com",
        approvedAt: "2026-03-03",
        note: null,
      },
    ],
    [PLUMBING_RULE],
  );
  assert.equal(outcome.result, "Excluded");
  assert.equal(outcome.exclusionReason, sla.SLA_EXCLUSION.authorised);
});

test("with nothing measurable the SLA percentage is null, not zero", () => {
  assert.equal(sla.slaPerformancePercent([]), null);
  assert.equal(sla.slaPerformancePercent([{ result: "Excluded" }]), null);
  assert.equal(sla.slaPerformancePercent([{ result: "Within" }, { result: "Outside" }]), 50);
});

/* --------------------------------------------------- maintenance section -- */

test("the job log holds every job exactly once, and the KPIs agree with it", () => {
  const jobs = [
    job({ status: "Job Completed", stage: "Completed", completedOn: "2026-03-05", costPence: 15_000 }),
    job({ status: "Job Scheduled" }),
    job({ status: "Waiting for parts" }),
    job({ status: "Pending Approval" }),
    job({ status: "Job In Progress", priority: "Urgent", tier: 1 }),
  ];
  const section = buildReport({ jobs });
  const logged = section.jobLog.flatMap((group) => group.rows.map((row) => row.requestId));
  assert.equal(logged.length, jobs.length);
  assert.equal(new Set(logged).size, jobs.length, "no job appears twice");

  assert.equal(section.kpis.jobsRecorded, 5);
  assert.equal(section.kpis.completedJobs, 1);
  assert.equal(section.kpis.openJobs, 4);
  assert.equal(section.kpis.criticalOpenJobs, 1);
  assert.equal(section.kpis.jobsOnHold, 1);
  assert.equal(section.kpis.completedMaintenanceSpendPence, 15_000);
  // The executive counts and the KPIs are two views of one set.
  assert.equal(section.executive.counts.totalJobs, section.kpis.jobsRecorded);
  assert.equal(section.executive.counts.completedJobs, section.kpis.completedJobs);
  assert.equal(section.executive.counts.openJobs, section.kpis.openJobs);
});

test("the site summary rows sum to the site summary totals", () => {
  const jobs = [
    job({ siteId: "a", status: "Job Completed", stage: "Completed", completedOn: "2026-03-05", costPence: 15_000 }),
    job({ siteId: "a", status: "Job Scheduled", approvedQuotePence: 4_000 }),
    job({ siteId: "b", status: "Waiting for parts", costPence: 2_500 }),
  ];
  const section = buildReport({ jobs });
  const sum = (key) => section.siteSummary.reduce((total, row) => total + row[key], 0);
  for (const key of [
    "jobsRaised",
    "completed",
    "open",
    "cancelled",
    "onHold",
    "pastTarget",
    "critical",
    "completedCostPence",
    "openQuotedCostPence",
    "fixedServiceFeePence",
  ]) {
    assert.equal(section.siteSummaryTotals[key], sum(key), key);
  }
  assert.equal(section.siteSummaryTotals.jobsRaised, 3);
  assert.equal(section.siteSummaryTotals.completedCostPence, 15_000);
  // The fee column sums to the invoice subtotal — the site rows and the
  // invoice are two presentations of one computation.
  assert.equal(section.siteSummaryTotals.fixedServiceFeePence, 24_000);
});

test("a job with no site is summarised under a named row, never dropped", () => {
  const section = buildReport({
    jobs: [job({ siteId: null, siteName: "", recordedSiteName: null, costPence: 900, status: "Job Completed", stage: "Completed", completedOn: "2026-03-04" })],
  });
  const row = section.siteSummary.find((entry) => entry.siteId === null);
  assert.ok(row, "the job must still be counted somewhere");
  assert.equal(row.siteName, maintenance.UNASSIGNED_SITE_NAME);
  assert.equal(row.completedCostPence, 900);
  assert.equal(section.siteSummaryTotals.completedCostPence, 900);
});

test("the service fee is reported beside the maintenance spend and never inside it", () => {
  const section = buildReport({
    jobs: [
      job({ status: "Job Completed", stage: "Completed", completedOn: "2026-03-05", costPence: 15_000 }),
      job({ status: "Job Scheduled", approvedQuotePence: 4_000 }),
      job({ status: "Major works", approvedQuotePence: 90_000 }),
    ],
  });
  assert.equal(section.spend.serviceFeePence, 24_000, "the invoice total");
  assert.equal(section.spend.completedMaintenancePence, 15_000);
  assert.equal(section.spend.openCommittedPence, 94_000, "the quote and the project");
  assert.equal(section.spend.projectPence, 90_000);
  // The five figures are separate. Nothing in the payload adds the fee to them.
  assert.notEqual(
    section.spend.completedMaintenancePence,
    section.spend.completedMaintenancePence + section.spend.serviceFeePence,
  );
});

test("open jobs past target are listed critical first, then furthest past, then oldest", () => {
  const late = job({ id: "LATE", requestedOn: "2026-03-02", status: "Job Scheduled" });
  const later = job({ id: "LATER", requestedOn: "2026-03-03", status: "Job Scheduled" });
  const criticalLate = job({ id: "CRIT", requestedOn: "2026-03-20", status: "Job Scheduled", priority: "Urgent", tier: 1 });
  const section = buildReport({
    jobs: [later, late, criticalLate],
    slaRules: [PLUMBING_RULE],
    asOf: "2026-03-31",
  });
  assert.equal(section.openPastTarget[0].requestId, "CRIT", "critical first, whatever its age");
  const rest = section.openPastTarget.slice(1).map((row) => row.requestId);
  assert.deepEqual(rest, ["LATE", "LATER"], "then the one that has been open longest");
  for (const row of section.openPastTarget) assert.ok(row.daysPastTarget > 0);
});

test("special projects are their own section and it is empty rather than blank", () => {
  const withNone = buildReport({ jobs: [job({ status: "Job Scheduled" })] });
  assert.deepEqual(withNone.specialProjects, []);

  const withOne = buildReport({
    jobs: [
      job({
        status: "Major works",
        stage: "Completed",
        approvedQuotePence: 90_000,
        costPence: 96_000,
        completedOn: "2026-03-20",
      }),
    ],
  });
  assert.equal(withOne.specialProjects.length, 1);
  const project = withOne.specialProjects[0];
  assert.equal(project.approvedQuotePence, 90_000);
  assert.equal(project.finalCostPence, 96_000);
  assert.equal(project.variancePence, 6_000);
  // A project with no approved quote has no variance — not a zero.
  const noQuote = buildReport({
    jobs: [job({ status: "Major works", stage: "Completed", costPence: 96_000, completedOn: "2026-03-20" })],
  });
  assert.equal(noQuote.specialProjects[0].approvedQuotePence, null);
  assert.equal(noQuote.specialProjects[0].variancePence, null);
});

test("the SLA appendix lists every active rule, including ones nothing matched", () => {
  const section = buildReport({
    jobs: [job({ classification: "Plumbing" })],
    slaRules: [
      PLUMBING_RULE,
      { id: "r2", classification: "Electrical", targetWorkingDays: 3, active: true, version: 2, note: "Agreed 2026" },
      { id: "r3", classification: "Retired", targetWorkingDays: 9, active: false, version: 1, note: null },
    ],
  });
  const listed = section.slaRules.map((rule) => rule.classification);
  assert.deepEqual(listed, ["Electrical", "Plumbing"]);
  assert.equal(section.slaRules.find((rule) => rule.classification === "Electrical").version, 2);
});

/* ------------------------------------------------------- executive prose -- */

test("an empty period gets a short honest summary, not a confident one", () => {
  const section = buildReport({ jobs: [] });
  const narrative = section.executive.narrative;
  assert.ok(narrative.length >= 2 && narrative.length <= 4, "short");
  assert.ok(narrative.some((line) => /No maintenance jobs were recorded/.test(line)));
  assert.ok(
    narrative.some((line) => /statement about what is in the system/.test(line)),
    "it must not be read as a quiet month",
  );
  for (const sentence of narrative) {
    assert.doesNotMatch(sentence, /stable|as expected|no issues|performing well/i);
  }
});

test("every sentence about SLA is derivable, and none is written when nothing is measurable", () => {
  const unmeasurable = buildReport({ jobs: [job({ status: "Job Scheduled" })] });
  assert.ok(
    unmeasurable.executive.narrative.some((line) => /No SLA performance figure is stated/.test(line)),
  );
  assert.equal(unmeasurable.executive.counts.slaPercent, null);

  const measurable = buildReport({
    jobs: [
      job({ status: "Job Completed", stage: "Completed", requestedOn: "2026-03-02", completedOn: "2026-03-04" }),
      job({ status: "Job Completed", stage: "Completed", requestedOn: "2026-03-02", completedOn: "2026-03-20" }),
    ],
    slaRules: [PLUMBING_RULE],
  });
  assert.equal(measurable.executive.counts.slaPercent, 50);
  const sentence = measurable.executive.narrative.find((line) => /within SLA/.test(line));
  assert.match(sentence, /50% within SLA/);
  assert.match(sentence, /1 met the target and 1 did not/);
});

/* ----------------------------------------------------------- data quality -- */

test("the data-quality section reports and never repairs", () => {
  const jobs = [
    job({ id: "NODATE", requestedOn: null }),
    job({ id: "DONE-NODATE", status: "Job Completed", stage: "Completed", completedOn: null }),
    job({ id: "OPEN-DATE", status: "Job Scheduled", completedOn: "2026-03-05" }),
    job({ id: "BACKWARDS", status: "Job Completed", stage: "Completed", requestedOn: "2026-03-10", completedOn: "2026-03-02" }),
    job({ id: "NOSITE", siteId: null, siteName: "", recordedSiteName: null }),
    job({ id: "NOCONTRACTOR", contractor: null, contractorId: null }),
    job({ id: "BADCOST", costInvalid: true }),
    job({ id: "NOCLASS", classification: null }),
    job({ id: "TIERWRONG", priority: "Urgent", tier: 3 }),
  ];
  const findings = quality.computeDataQuality({
    period: MARCH,
    jobs,
    sites: [site("a")],
    holds: [],
    slaRules: [PLUMBING_RULE],
    invoiceLines: buildInvoice({ sites: [site("a")] }).lines,
    existingCharges: [],
    vatEnabled: false,
    vatNumber: null,
    vatRateBasisPoints: 2000,
    defaultSiteFeePence: 12_000,
  });
  const codes = new Set(findings.map((finding) => finding.code));
  for (const expected of [
    quality.DQ.jobMissingRequestDate,
    quality.DQ.jobCompletedWithoutDate,
    quality.DQ.jobOpenWithCompletionDate,
    quality.DQ.jobInvalidDateSequence,
    quality.DQ.jobMissingSite,
    quality.DQ.jobMissingContractor,
    quality.DQ.jobInvalidCost,
    quality.DQ.jobNoClassification,
    quality.DQ.jobPriorityTierMismatch,
  ]) {
    assert.ok(codes.has(expected), `missing finding: ${expected}`);
  }
  // Every finding names a record and offers a link that exists in the product.
  for (const finding of findings) {
    assert.ok(finding.message.length > 0);
    assert.ok(["blocking", "warning", "info"].includes(finding.severity));
    if (finding.href) assert.match(finding.href, /^\/dashboard\//);
  }
});

test("an unapproved hold is a warning, and a hold outside the job is reported", () => {
  const held = job({ id: "HELD", requestedOn: "2026-03-09", completedOn: "2026-03-11", status: "Job Completed", stage: "Completed" });
  const findings = quality.computeDataQuality({
    period: MARCH,
    jobs: [held],
    sites: [site("a")],
    holds: [
      { id: "h1", requestId: "HELD", startAt: "2026-01-01", endAt: "2026-06-30", reason: null, category: null, approved: false, approvedBy: null, approvedAt: null, note: null },
    ],
    slaRules: [PLUMBING_RULE],
    invoiceLines: [],
    existingCharges: [],
    vatEnabled: false,
    vatNumber: null,
    vatRateBasisPoints: 2000,
    defaultSiteFeePence: 12_000,
  });
  const codes = findings.map((finding) => finding.code);
  assert.ok(codes.includes(quality.DQ.holdUnapproved));
  assert.ok(codes.includes(quality.DQ.holdOutsideJob));
});

test("duplicate references and possible duplicates are both surfaced", () => {
  const findings = quality.computeDataQuality({
    period: MARCH,
    jobs: [
      job({ id: "D1", reference: "MS-2026-0001", title: "Leaking tap", requestedOn: "2026-03-02" }),
      job({ id: "D2", reference: "MS-2026-0001", title: "Leaking tap", requestedOn: "2026-03-04" }),
    ],
    sites: [site("a")],
    holds: [],
    slaRules: [PLUMBING_RULE],
    invoiceLines: [],
    existingCharges: [],
    vatEnabled: false,
    vatNumber: null,
    vatRateBasisPoints: 2000,
    defaultSiteFeePence: 12_000,
  });
  const codes = findings.map((finding) => finding.code);
  assert.ok(codes.includes(quality.DQ.jobDuplicateReference));
  assert.ok(codes.includes(quality.DQ.jobPossibleDuplicate));
});

/* ---------------------------------------------------------------- blockers -- */

function payloadFor(section, maintenanceSection, overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-04-01T00:00:00.000Z",
    organisationId: "org-1",
    organisationName: "Sunnamusk UK",
    period: MARCH,
    previousPeriod: null,
    invoice: section,
    maintenance: maintenanceSection,
    ...overrides,
  };
}

test("finalisation is blocked when a site has no valid fee", () => {
  const section = buildInvoice({ config: config({ defaultSiteFeePence: null }) });
  const report = buildReport({ invoiceSection: section });
  const found = blockers.finalisationBlockers({
    payload: payloadFor(section, report),
    confirmedPartialPeriod: true,
    requireApproval: false,
  });
  assert.ok(found.some((blocker) => blocker.code === quality.DQ.siteNoFee));
});

test("finalisation is blocked on a duplicate site charge, even after re-including it", () => {
  const section = buildInvoice({
    existingCharges: [
      { siteId: "b", invoiceId: "other", invoiceNumber: "MS-00007", status: "Finalised", committed: true, periodStart: "2026-03-01", periodEnd: "2026-03-31" },
    ],
  });
  const report = buildReport({ invoiceSection: section });
  const found = blockers.finalisationBlockers({
    payload: payloadFor(section, report),
    confirmedPartialPeriod: true,
    requireApproval: false,
  });
  assert.ok(found.some((blocker) => blocker.code === quality.DQ.siteDuplicateCharge));
});

test("a partial period must be confirmed, and confirming clears only that blocker", () => {
  const custom = { start: "2026-03-05", end: "2026-03-20", label: "Custom range", partialMonth: true };
  const section = buildInvoice({ period: custom });
  const report = buildReport({ invoiceSection: section, period: custom });
  const payload = payloadFor(section, report, { period: custom });

  const unconfirmed = blockers.finalisationBlockers({ payload, confirmedPartialPeriod: false, requireApproval: false });
  assert.ok(unconfirmed.some((blocker) => blocker.code === blockers.BLOCKER.partialPeriodUnconfirmed));

  const confirmed = blockers.finalisationBlockers({ payload, confirmedPartialPeriod: true, requireApproval: false });
  assert.ok(!confirmed.some((blocker) => blocker.code === blockers.BLOCKER.partialPeriodUnconfirmed));
});

test("finalisation is blocked with no billable sites, and with incomplete VAT", () => {
  const empty = buildInvoice({ sites: [] });
  const emptyReport = buildReport({ invoiceSection: empty, sites: [] });
  const noSites = blockers.finalisationBlockers({
    payload: payloadFor(empty, emptyReport),
    confirmedPartialPeriod: true,
    requireApproval: false,
  });
  assert.ok(noSites.some((blocker) => blocker.code === blockers.BLOCKER.noBillableSites));

  const vat = buildInvoice({ config: config({ vatEnabled: true, vatNumber: null }) });
  const vatReport = buildReport({ invoiceSection: vat });
  const vatBlockers = blockers.finalisationBlockers({
    payload: payloadFor(vat, vatReport),
    confirmedPartialPeriod: true,
    requireApproval: false,
  });
  assert.ok(vatBlockers.some((blocker) => blocker.code === blockers.BLOCKER.vatIncomplete));
});

test("a clean invoice has no blockers, and approval is one of them when required", () => {
  const section = buildInvoice({ header: header({ status: "Approved" }) });
  const report = buildReport({ invoiceSection: section });
  const payload = payloadFor(section, report);
  assert.deepEqual(
    blockers.finalisationBlockers({ payload, confirmedPartialPeriod: false, requireApproval: true }),
    [],
  );
  const asDraft = payloadFor(buildInvoice(), report);
  assert.ok(
    blockers
      .finalisationBlockers({ payload: asDraft, confirmedPartialPeriod: false, requireApproval: true })
      .some((blocker) => blocker.code === blockers.BLOCKER.notApproved),
  );
});

test("warnings never appear in the blockers — that is the Draft distinction", () => {
  const section = buildInvoice({ header: header({ status: "Approved" }) });
  const report = buildReport({
    invoiceSection: section,
    jobs: [job({ id: "W", status: "Job Completed", stage: "Completed", completedOn: null })],
  });
  const payload = payloadFor(section, report);
  const warnings = blockers.draftWarnings(payload);
  assert.ok(warnings.length > 0, "the fixture has a warning to find");
  const found = blockers.finalisationBlockers({ payload, confirmedPartialPeriod: false, requireApproval: true });
  for (const warning of warnings) {
    assert.ok(
      !found.some((blocker) => blocker.code === warning.code),
      `${warning.code} is a warning and must not block finalisation`,
    );
  }
});

/* ------------------------------------------------------------ permissions -- */

test("the report operations map onto capabilities that already exist", () => {
  // No new capability, no parallel role system. Every value here must be a key
  // in the shipped catalogue, which this asserts by name.
  const known = new Set([
    "board.view",
    "board.edit",
    "sites.edit",
    "data.import",
    "data.export",
    "data.delete",
    "users.view",
    "users.invite",
    "users.edit",
    "users.deactivate",
    "teams.manage",
    "roles.edit",
    "audit.read",
    "settings.edit",
    "clients.view_all",
    "billing.manage",
  ]);
  for (const [operation, capability] of Object.entries(access.REPORT_CAPABILITIES)) {
    assert.ok(known.has(capability), `${operation} requires "${capability}", which is not a capability`);
  }
  // The four intents, as the owner described them.
  assert.equal(access.REPORT_CAPABILITIES["settings.write"], "settings.edit");
  assert.equal(access.REPORT_CAPABILITIES["document.finalise"], "settings.edit");
  assert.equal(access.REPORT_CAPABILITIES["report.preview"], "board.edit");
  assert.equal(access.REPORT_CAPABILITIES["document.list"], "board.view");
  assert.equal(access.REPORT_CAPABILITIES["document.export"], "data.export");
});

test("a viewer sees finalised documents and nothing else", () => {
  assert.deepEqual(access.visibleStatusesFor(false), ["Finalised"]);
  assert.ok(access.visibleStatusesFor(true).includes("Draft"));
});

test("the document state machine refuses the transitions that must not exist", () => {
  assert.equal(access.canTransition("Draft", "Approved"), true);
  assert.equal(access.canTransition("Approved", "Finalised"), true);
  assert.equal(access.canTransition("Draft", "Finalised"), false, "a draft is never finalised directly");
  assert.equal(access.canTransition("Finalised", "Draft"), false, "a finalised invoice is not edited back");
  assert.equal(access.canTransition("Finalised", "Voided"), true);
  assert.equal(access.canTransition("Voided", "Draft"), false, "voided is terminal");
  assert.deepEqual(access.DOCUMENT_TRANSITIONS.Voided, []);
});

/* --------------------------------------------------------------- filename -- */

test("the export filename cannot be talked into a path separator", () => {
  const name = contract.exportFilename({
    clientName: "Smith & Co. (UK)/EU",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    invoiceNumber: "MS-00042",
    format: "pdf",
  });
  assert.equal(name, "MAINTSUPP_Smith-Co-UK-EU_2026-03-01_2026-03-31_MS-00042.pdf");
  assert.ok(!name.includes("/"));
  assert.ok(!name.includes("\\"));
  assert.match(
    contract.exportFilename({
      clientName: "Client",
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      invoiceNumber: null,
      format: "xlsx",
    }),
    /_DRAFT\.xlsx$/,
  );
});

test("a site on another DRAFT warns but is still charged", () => {
  /*
   * Found by running the real thing, not by reading it. Treating every
   * non-voided document as a charge made the SECOND draft for a month exclude
   * all sixteen sites and produce a £0.00 invoice with fourteen blockers — a
   * feature that cannot be used twice is not a safety property. A draft is a
   * document somebody is writing; only Approved and Finalised are decisions to
   * charge.
   */
  const section = buildInvoice({
    existingCharges: [
      {
        siteId: "b",
        invoiceId: "other-draft",
        invoiceNumber: null,
        status: "Draft",
        committed: false,
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
      },
    ],
  });
  const line = section.lines.find((entry) => entry.siteId === "b");
  assert.equal(line.included, true, "a draft elsewhere must not stop this one being priced");
  assert.equal(section.totals.includedSites, 2);
  const notice = line.validation.find(
    (entry) => entry.code === invoice.LINE_VALIDATION.siteOnAnotherDraft,
  );
  assert.ok(notice, "but the operator is told about it");
  assert.equal(notice.severity, "warning");

  // And it does not block finalisation, because a warning never does.
  const report = buildReport({ invoiceSection: section });
  const found = blockers.finalisationBlockers({
    payload: payloadFor(section, report),
    confirmedPartialPeriod: true,
    requireApproval: false,
  });
  assert.ok(!found.some((blocker) => blocker.code === quality.DQ.siteDuplicateCharge));
});
