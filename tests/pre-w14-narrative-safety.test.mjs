/**
 * NARRATIVE SAFETY — the one subsystem whose failure mode is a lie.
 *
 * Module 4 §4.3 is unusually blunt about why this exists: "an invented number
 * in a client report is the worst thing this system can do". So the assertions
 * below are not about whether the feature works; they are about whether it
 * REFUSES. The four injected-orphan tests are the centre of the file — a
 * percentage, a currency amount, an integer and a date, each dropped into prose
 * that is otherwise entirely true, each of which must block generation on its
 * own.
 *
 * Two properties are being defended together, and they pull in opposite
 * directions, which is why both are pinned:
 *
 *   STRICT ENOUGH — an orphan of any of the four kinds blocks, spelled-out
 *   cardinals are checked, and a rounded figure (£1.75k against £1,758.00) is
 *   an orphan rather than a near-enough match.
 *
 *   NOT SO STRICT AS TO BE UNUSABLE — the same figure written a different way
 *   is the same figure, and the DETERMINISTIC executive summary that
 *   `narrative.ts` has always produced passes its own validator unchanged. If
 *   it did not, the locked set would be incomplete and the first real draft
 *   would be refused for stating something true.
 *
 * The provider is BLOCKED, not built: no vendor is chosen, no key exists, and
 * `resolveNarrativeProvider()` says so in a sentence. Everything around it is
 * driven here with an injected fake, so the whole path — prompt, generate,
 * validate, refuse or store — is exercised without one.
 *
 * Modules are transpiled to data URLs, the pattern
 * `tests/pre-w14-calendar-item-types.test.mjs` uses. These three import each
 * other, so each relative specifier is rewritten to the data URL of the module
 * it names — the same idea as the temp-directory staging in
 * `tests/w9-report-engine.test.mjs`, without the temp directory.
 *
 * Reads normalise CRLF: this is a Windows checkout and line endings are per
 * file.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

const VALIDATOR = "app/lib/reporting/figure-validator.ts";
const BLOCKS = "app/lib/reporting/narrative-blocks.ts";
const PROVIDER = "app/lib/reporting/narrative-provider.ts";
const ROUTE = "app/api/reports/documents/[id]/narrative/route.ts";
const PANEL = "app/(app)/portal/reports/narrative-panel.tsx";
const CSS = "app/(app)/portal/reports/narrative-panel.css";

/* Pure and importing nothing but types, so it loads on its own. */
const validatorUrl = asModule(transpile(await read(VALIDATOR)));
const validator = await import(validatorUrl);

const blocksUrl = asModule(
  transpile(await read(BLOCKS)).replace(
    /from ["']\.\/figure-validator["']/g,
    `from "${validatorUrl}"`,
  ),
);
const blocks = await import(blocksUrl);

const provider = await import(
  asModule(
    transpile(await read(PROVIDER))
      .replace(/from ["']\.\/figure-validator["']/g, `from "${validatorUrl}"`)
      .replace(/from ["']\.\/narrative-blocks["']/g, `from "${blocksUrl}"`),
  )
);

/* `narrative.ts` is the deterministic path and imports only types. */
const deterministic = await import(asModule(transpile(await read("app/lib/reporting/narrative.ts"))));

/* ------------------------------------------------------------- the payload */

const PERIOD = { start: "2026-03-01", end: "2026-03-31", label: "March 2026", partialMonth: false };
const PREVIOUS = {
  start: "2026-02-01",
  end: "2026-02-28",
  label: "February 2026",
  partialMonth: false,
};

const COUNTS = {
  totalJobs: 47,
  activeSites: 30,
  sitesWithJobs: 21,
  completedJobs: 39,
  openJobs: 8,
  cancelledJobs: 0,
  measurableJobs: 34,
  withinSla: 21,
  outsideSla: 13,
  slaPercent: 62,
  jobsWithApprovedHolds: 2,
  openPastTarget: 3,
  criticalOpen: 1,
  previousTotalJobs: 40,
};

const SPEND = {
  serviceFeePence: 250000,
  completedMaintenancePence: 175800,
  openCommittedPence: 42000,
  projectPence: 90000,
  routinePence: 85800,
  previousCompletedMaintenancePence: 160000,
};

const HOLD = {
  holdId: "hold_1",
  requestId: "req_1",
  reference: "JOB-1042",
  siteName: "Oxford Street",
  description: "Chiller not holding temperature",
  classification: "P2 Trading impaired",
  targetWorkingDays: 3,
  elapsedWorkingDays: 12,
  approvedHoldDays: 4,
  adjustedWorkingDays: 8,
  slaResult: "Outside",
  reason: "Awaiting a compressor",
  category: "Awaiting parts",
  startAt: "2026-03-09",
  endAt: "2026-03-13",
  approved: true,
  approvedBy: "owner@maintsupp.com",
  approvalDate: "2026-03-16",
  note: null,
};

function payloadFixture(overrides = {}) {
  const maintenance = {
    kpis: {
      jobsRecorded: 47,
      completedJobs: 39,
      openJobs: 8,
      openJobsPastTarget: 3,
      slaPerformancePercent: 62,
      jobsOnHold: 2,
      criticalOpenJobs: 1,
      completedMaintenanceSpendPence: 175800,
    },
    executive: { counts: COUNTS, narrative: [] },
    siteSummary: [],
    siteSummaryTotals: {
      jobsRaised: 47,
      completed: 39,
      open: 8,
      cancelled: 0,
      onHold: 2,
      pastTarget: 3,
      critical: 1,
      completedCostPence: 175800,
      openQuotedCostPence: 42000,
      fixedServiceFeePence: 250000,
    },
    spend: SPEND,
    sla: [
      {
        requestId: "req_1",
        reference: "JOB-1042",
        siteName: "Oxford Street",
        description: "Chiller not holding temperature",
        classification: "P2 Trading impaired",
        targetWorkingDays: 3,
        elapsedWorkingDays: 12,
        approvedHoldDays: 4,
        adjustedWorkingDays: 8,
        result: "Outside",
        exclusionReason: null,
      },
    ],
    holds: [HOLD],
    openPastTarget: [
      {
        requestId: "req_2",
        reference: "JOB-1050",
        siteName: "Camden",
        issue: "Roof leak over the stockroom",
        priority: "High",
        classification: "P2 Trading impaired",
        raisedOn: "2026-03-18",
        targetOn: "2026-03-23",
        workingDaysOpen: 9,
        daysPastTarget: 6,
        status: "In Progress",
        contractor: "Northbound Roofing",
        blocker: null,
        nextAction: null,
        responsibleUser: null,
      },
    ],
    criticalOpen: [],
    specialProjects: [],
    jobLog: [],
    dataQuality: [],
    slaRules: [],
    ...(overrides.maintenance ?? {}),
  };

  return {
    schemaVersion: 1,
    generatedAt: "2026-04-02T09:15:00.000Z",
    organisationId: "org_test",
    organisationName: "Sunnamusk UK",
    period: PERIOD,
    previousPeriod: PREVIOUS,
    invoice: {
      invoiceId: "inv_1",
      invoiceNumber: "MS-2026-003",
      status: "Draft",
      invoiceDate: "2026-04-01",
      dueAt: "2026-04-30",
      servicePeriod: PERIOD,
      clientName: "Sunnamusk UK",
      billingAddress: "1 Example Street",
      clientReference: null,
      purchaseOrder: null,
      internalReference: null,
      currency: "GBP",
      paymentTerms: "30 days",
      vatEnabled: false,
      vatRateBasisPoints: 0,
      vatNumber: null,
      clientNote: null,
      internalNote: null,
      lines: [],
      adjustments: [],
      totals: {
        totalSites: 30,
        includedSites: 28,
        excludedSites: 2,
        subtotalPence: 250000,
        vatPence: 0,
        adjustmentPence: 0,
        creditPence: 0,
        totalPence: 250000,
        singleFeePence: null,
        averageFeePence: 8928,
      },
    },
    maintenance,
    ...overrides,
  };
}

const PAYLOAD = payloadFixture();

/** The locked block the executive summary is generated and checked against. */
const EXEC_LOCKED = blocks.lockedFiguresForBlock(PAYLOAD, "executive-summary");

/**
 * Prose that is entirely true of the fixture. Every orphan test below injects
 * ONE token into a copy of this, so a failure can only be the injected token.
 */
const TRUE_PROSE =
  "This report covers March 2026 (2026-03-01 to 2026-03-31) across 30 active sites, of which 28 are charged the service fee. " +
  "47 jobs were recorded: 39 completed and 8 still open. " +
  "Of the 34 jobs measurable against an SLA target, 21 met the target and 13 did not — 62% within SLA. " +
  "Completed maintenance in the period cost £1,758.00, with £420.00 committed on jobs still open.";

test("the prose the orphan tests are built on is itself clean", () => {
  const result = validator.validateProseFigures(TRUE_PROSE, EXEC_LOCKED);
  assert.deepEqual(
    result.orphans.map((figure) => figure.token),
    [],
    "if this ever fails, every orphan test below is measuring the wrong thing",
  );
  assert.equal(result.ok, true);
  assert.equal(result.message, null);
  assert.ok(result.figures.length > 10, "the extractor must actually be reading this sentence");
});

/* ══════════════════════════════════════════════════════════════════════════
   THE FOUR INJECTED ORPHANS. §10: "an injected orphan number blocks
   generation." One test per kind the owner named.
   ══════════════════════════════════════════════════════════════════════════ */

function injected(sentence) {
  return `${TRUE_PROSE} ${sentence}`;
}

test("INJECTED ORPHAN — a percentage the data does not contain blocks", () => {
  const result = validator.validateProseFigures(
    injected("Performance improved to 88% across the portfolio."),
    EXEC_LOCKED,
  );
  assert.equal(result.ok, false, "88% is nowhere in the payload");
  assert.deepEqual(
    result.orphans.map((figure) => `${figure.kind}:${figure.canonical}`),
    ["percent:88"],
    "exactly one orphan, and it is the injected percentage",
  );
  assert.match(result.message, /^The draft contains a figure not present in the data\./);
});

test("INJECTED ORPHAN — a currency amount the data does not contain blocks", () => {
  const result = validator.validateProseFigures(
    injected("A further £9,999.00 was spent on the chiller."),
    EXEC_LOCKED,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.orphans.map((figure) => `${figure.kind}:${figure.canonical}`),
    ["money:9999"],
  );
  assert.match(result.message, /£9,999\.00/, "the operator is told WHICH figure was invented");
});

test("INJECTED ORPHAN — an integer the data does not contain blocks", () => {
  /*
   * 52 rather than 48: the fixture's job count is 47, and a number one away
   * from a real one is exactly the kind of near-miss a model produces. 52 is
   * chosen because nothing in the payload happens to equal it — the assertion
   * would otherwise be measuring the fixture rather than the validator.
   */
  const result = validator.validateProseFigures(
    injected("52 jobs were raised at the Camden site."),
    EXEC_LOCKED,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.orphans.map((figure) => `${figure.kind}:${figure.canonical}`),
    ["number:52"],
  );
});

test("INJECTED ORPHAN — a date the data does not contain blocks", () => {
  const result = validator.validateProseFigures(
    injected("The final visit was completed on 2026-04-30."),
    EXEC_LOCKED,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.orphans.map((figure) => `${figure.kind}:${figure.canonical}`),
    ["date:2026-04-30"],
    "a date outside the report's own dates is an invented date",
  );
});

test("an orphan blocks generation rather than being stored with a warning", async () => {
  /*
   * The four tests above prove the validator refuses. This one proves the
   * GENERATION PATH refuses — that there is no route from a provider's output
   * to stored prose that skips the check.
   */
  const outcome = await provider.draftNarrativeBlock({
    payload: PAYLOAD,
    blockKey: "executive-summary",
    resolve: async () => ({
      available: true,
      provider: {
        id: "test-fake",
        label: "Test fake",
        generate: async () => injected("Performance improved to 88%."),
      },
    }),
  });
  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /^The draft contains a figure not present in the data\./);
  assert.equal(outcome.prose, undefined, "refused prose is not carried anywhere it could be saved");
});

test("a clean draft from the same path is generated and carries its evidence", async () => {
  const outcome = await provider.draftNarrativeBlock({
    payload: PAYLOAD,
    blockKey: "executive-summary",
    resolve: async () => ({
      available: true,
      provider: { id: "test-fake", label: "Test fake", generate: async () => TRUE_PROSE },
    }),
  });
  assert.equal(outcome.status, "generated");
  assert.equal(outcome.providerId, "test-fake");
  assert.equal(outcome.validation.ok, true);
});

/* ══════════════════════════════════════════════════════════════════════════
   THE SAME FIGURE, WRITTEN DIFFERENTLY. A validator that only recognises one
   notation refuses true sentences, and a validator people route around is
   worth nothing.
   ══════════════════════════════════════════════════════════════════════════ */

test("one money figure is recognised in every notation a report would use", () => {
  /* £1,758.00 == 175800 pence. Both denominations, with and without separators. */
  for (const form of ["£1,758.00", "£1758.00", "£1,758", "1,758", "1758", "175800"]) {
    const result = validator.validateProseFigures(`Spend was ${form} in the period.`, EXEC_LOCKED);
    assert.equal(result.ok, true, `${form} is the same figure as £1,758.00 and must pass`);
  }
});

test("a rounded money figure is an orphan, because rounding is a figure the model made", () => {
  /* §4.3: "never round". £1.75k is not £1,758.00, however close it looks. */
  const rounded = validator.validateProseFigures("Spend was £1.75k.", EXEC_LOCKED);
  assert.equal(rounded.ok, false, "£1.75k is 1750 and the data says 1758");
  assert.equal(rounded.orphans[0].canonical, "1750");

  /* And the suffix itself is understood, so the refusal above is about the
     VALUE and not about the notation being unparsed. */
  const locked = blocks.lockedFiguresForBlock(
    payloadFixture({
      maintenance: {
        ...PAYLOAD.maintenance,
        spend: { ...SPEND, completedMaintenancePence: 175000 },
      },
    }),
    "executive-summary",
  );
  assert.equal(validator.validateProseFigures("Spend was £1.75k.", locked).ok, true);
});

test("one percentage is recognised in every notation, and only as a percentage", () => {
  for (const form of ["62%", "62.0%", "62 per cent"]) {
    assert.equal(
      validator.validateProseFigures(`${form} of measurable jobs met the target.`, EXEC_LOCKED).ok,
      true,
      `${form} is the payload's 62%`,
    );
  }
  /*
   * The separation that makes this strict: 47 is the job count and is a
   * perfectly good bare number, but "47%" is a percentage nobody computed.
   */
  assert.equal(validator.validateProseFigures("47 jobs were recorded.", EXEC_LOCKED).ok, true);
  assert.equal(
    validator.validateProseFigures("47% of jobs were recorded.", EXEC_LOCKED).ok,
    false,
    "a count must not license the same number as a percentage",
  );
});

test("one date is recognised in every notation, and its month and year with it", () => {
  for (const form of ["2026-03-31", "31 March 2026", "31st March 2026", "31/03/2026"]) {
    assert.equal(
      validator.validateProseFigures(`The period ended on ${form}.`, EXEC_LOCKED).ok,
      true,
      `${form} is the payload's period end`,
    );
  }
  assert.equal(validator.validateProseFigures("The period was March 2026.", EXEC_LOCKED).ok, true);
  assert.equal(validator.validateProseFigures("This was during 2026.", EXEC_LOCKED).ok, true);
  assert.equal(
    validator.validateProseFigures("The period was April 2026.", EXEC_LOCKED).ok,
    false,
    "a month the report does not cover is an invented month",
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   WHAT IS AND IS NOT A FIGURE. Every exclusion is a hole somebody could drive
   a wrong number through, so each one is pinned with the reason.
   ══════════════════════════════════════════════════════════════════════════ */

test("spelled-out cardinals ARE figures — the obvious way round the validator", () => {
  /*
   * The decision recorded in the module header. "four sites" is a claim about
   * a quantity and a reader treats it exactly as they treat "4"; leaving words
   * unchecked would make every digit rule in this file optional.
   */
  assert.equal(
    validator.validateProseFigures("Four sites were past target.", EXEC_LOCKED).ok,
    false,
    "4 is not in the executive summary's locked set, so the word is refused too",
  );
  assert.equal(
    validator.validateProseFigures("Eight jobs are still open.", EXEC_LOCKED).ok,
    true,
    "8 IS the open job count, so the word for it is accepted",
  );
  assert.equal(
    validator.extractFigures("twenty-four jobs")[0].canonical,
    "24",
    "hyphenated compounds are one number, not twenty and four",
  );
  /* The hyphen guard, which is what keeps the rule tolerable in real prose. */
  assert.deepEqual(validator.extractFigures("a one-off cost"), []);
});

test("ordinals, quarter labels, tier labels and clock times are not figures", () => {
  for (const phrase of [
    "the first site on the list",
    "the 21st job raised",
    "reported in Q1",
    "the visit was at 09:00",
    /*
     * Not hypothetical. `narrative.ts` writes "urgent or Tier 1" as a fixed
     * phrase, and reading its 1 as a count made the computed summary fail its
     * own validator against the live August data — the digit names a service
     * level, exactly as Q1 names a quarter.
     */
    "2 open jobs are urgent or Tier 1",
    "raised at Priority 2",
  ]) {
    assert.ok(
      validator.extractFigures(phrase).every((figure) => figure.canonical !== "1"),
      `${phrase}: a position, a period label, a tier label or a time is not a quantity`,
    );
  }
  assert.deepEqual(validator.extractFigures("reported in Q1"), []);
  assert.deepEqual(validator.extractFigures("the 21st job raised"), []);
  assert.deepEqual(
    validator.extractFigures("2 open jobs are urgent or Tier 1").map((f) => f.canonical),
    ["2"],
    "the count survives; only the tier label is dropped",
  );
  /* `P1` is identifier-shaped and IS still checked — see exclusion (8). */
  assert.equal(validator.extractFigures("raised as P1")[0].kind, "identifier");
});

test("a reference is checked as a reference, and its digits never as a number", () => {
  const holdLocked = blocks.lockedFiguresForBlock(PAYLOAD, "hold-explanation:hold_1");
  assert.equal(
    validator.validateProseFigures("JOB-1042 was held for 4 working days.", holdLocked).ok,
    true,
    "the reference is in the payload and 4 is the approved hold days",
  );
  assert.equal(
    validator.validateProseFigures("JOB-9999 was held for 4 working days.", holdLocked).ok,
    false,
    "an invented job reference is caught in the same pass",
  );
  const [figure] = validator.extractFigures("JOB-1042");
  assert.equal(figure.kind, "identifier");
  assert.equal(figure.canonical, "JOB-1042");
  assert.equal(
    validator.validateProseFigures("1042 jobs were raised.", holdLocked).ok,
    false,
    "the digits of a reference must never license the same digits as a count",
  );
});

test("rounding language is reported but does not block", () => {
  const result = validator.validateProseFigures(
    "Approximately 47 jobs were recorded.",
    EXEC_LOCKED,
  );
  assert.equal(result.ok, true, "blocking on 'approximately' trains people to work round the check");
  assert.deepEqual(
    result.hedges.map((hedge) => hedge.word.toLowerCase()),
    ["approximately"],
    "but it is surfaced, because it states a quantity without a figure behind it",
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   THE LOCKED SET
   ══════════════════════════════════════════════════════════════════════════ */

test("the locked set narrows per block, which is what makes the check strict", () => {
  const whole = blocks.lockedFigureSet(PAYLOAD);
  const holdOnly = blocks.lockedFiguresForBlock(PAYLOAD, "hold-explanation:hold_1");
  assert.ok(
    holdOnly.numbers.size < whole.numbers.size,
    "a hold explanation may not quote the whole report's figures",
  );
  /*
   * The point of the narrowing, stated as a behaviour rather than a size: the
   * portfolio job count is a real figure of the document and still must not be
   * available to a paragraph about one hold.
   */
  assert.equal(whole.numbers.has("47"), true);
  assert.equal(holdOnly.numbers.has("47"), false);
  assert.equal(holdOnly.numbers.has("8"), true, "the hold's own adjusted days");
});

test("money is locked in pounds AND pence, and percentages separately", () => {
  const locked = blocks.lockedFigureSet(PAYLOAD);
  assert.equal(locked.amounts.has("175800"), true, "integer pence, as the payload holds it");
  assert.equal(locked.amounts.has("1758"), true, "pounds, as the prose writes it");
  assert.equal(locked.percentages.has("62"), true);
  assert.equal(locked.percentages.has("47"), false, "a job count is not a percentage");
  assert.equal(locked.dates.has("2026-03-31"), true);
  assert.equal(locked.months.has("2026-03"), true);
  assert.equal(locked.years.has("2026"), true);
  assert.equal(locked.identifiers.has("JOB-1042"), true);
  assert.equal(locked.identifiers.has("MS-2026-003"), true);
});

test("array lengths and the prior-period deltas are locked, because the report states them", () => {
  const locked = blocks.lockedFiguresForBlock(PAYLOAD, "executive-summary");
  /* 47 - 40 = 7, and round(7/40*100) = 18. Neither is anywhere in the payload. */
  assert.equal(locked.numbers.has("7"), true, "the volume delta");
  assert.equal(locked.percentages.has("18"), true, "the volume delta as a percentage");
  /* £1,758.00 - £1,600.00 = £158.00 */
  assert.equal(locked.amounts.has("158"), true, "the spend delta, in pounds");

  const withFindings = blocks.lockedFiguresForBlock(
    payloadFixture({
      maintenance: {
        ...PAYLOAD.maintenance,
        dataQuality: [
          { severity: "blocking", code: "a", message: "", entityType: null, entityId: null, href: null },
          { severity: "blocking", code: "b", message: "", entityType: null, entityId: null, href: null },
          { severity: "warning", code: "c", message: "", entityType: null, entityId: null, href: null },
        ],
      },
    }),
    "executive-summary",
  );
  assert.equal(withFindings.numbers.has("2"), true, "two blocking findings, counted");
  assert.equal(
    validator.validateProseFigures(
      "2 data issues must be resolved before this document can be finalised.",
      withFindings,
    ).ok,
    true,
  );
});

test("the deterministic executive summary passes its own validator, unchanged", () => {
  /*
   * The completeness test, and the one that would fail first if the locked set
   * were missing something a real paragraph needs. `narrative.ts` has produced
   * this prose since before narrative blocks existed and computes every figure
   * in it from the payload — so if the validator refuses it, the validator is
   * wrong, not the prose.
   */
  const sentences = deterministic.buildNarrative({
    period: PERIOD,
    previousPeriod: PREVIOUS,
    counts: COUNTS,
    spend: SPEND,
    currency: "GBP",
    billableSites: PAYLOAD.invoice.totals.includedSites,
    blockingFindings: 0,
    warningFindings: 0,
  });
  assert.ok(sentences.length >= 6, "the fixture is rich enough to exercise the paragraph");
  const result = validator.validateProseFigures(sentences.join(" "), EXEC_LOCKED);
  assert.deepEqual(
    result.orphans.map((figure) => `${figure.kind}:${figure.token}`),
    [],
    "every figure the computed summary states must be in the locked set",
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   THE BLOCKS, THE STATES AND THE FINALISE GATE
   ══════════════════════════════════════════════════════════════════════════ */

test("the six blocks §4.3 names all exist", () => {
  assert.deepEqual(blocks.NARRATIVE_BLOCK_KINDS, [
    "executive-summary",
    "spend",
    "requiring-attention",
    "hold-explanation",
    "open-items-priority",
    "special-projects",
  ]);
  for (const kind of blocks.NARRATIVE_BLOCK_KINDS) {
    const definition = blocks.NARRATIVE_BLOCKS[kind];
    assert.ok(definition.title && definition.purpose && definition.instruction, `${kind} is defined`);
    assert.doesNotMatch(
      definition.instruction,
      /\d/,
      `${kind}: the brief must never carry a figure — the locked block is the only source`,
    );
  }
  assert.equal(blocks.NARRATIVE_BLOCKS["hold-explanation"].perSubject, true, "one per hold");
});

test("a block is planned only when there is something for it to describe", () => {
  const planned = blocks.plannedNarrativeBlocks(PAYLOAD).map((entry) => entry.key);
  assert.deepEqual(planned, [
    "executive-summary",
    "spend",
    "requiring-attention",
    "hold-explanation:hold_1",
    "open-items-priority",
  ]);
  assert.ok(
    !planned.includes("special-projects"),
    "the fixture has no special projects, and a paragraph about nothing would have to be reviewed",
  );

  const twoHolds = blocks.plannedNarrativeBlocks(
    payloadFixture({
      maintenance: { ...PAYLOAD.maintenance, holds: [HOLD, { ...HOLD, holdId: "hold_2" }] },
    }),
  );
  assert.equal(
    twoHolds.filter((entry) => entry.kind === "hold-explanation").length,
    2,
    "§4.3 asks for a per-job explanation for EACH hold",
  );
});

test("the badge text is one string, spelled the way Module 4 spells it", () => {
  assert.equal(blocks.AI_DRAFT_BADGE, "AI draft — not yet reviewed");
});

function block(state) {
  const base = blocks.emptyNarrativeBlock({
    key: "spend",
    kind: "spend",
    subjectId: null,
    title: "Spend paragraph",
  });
  if (state === "empty") return base;
  const drafted = blocks.draftedBlock(base, "Spend was £1,758.00.", "test-fake", "2026-04-02T00:00:00.000Z");
  return state === "ai-draft" ? drafted : blocks.acceptedBlock(drafted, "owner@maintsupp.com", "2026-04-02T00:01:00.000Z");
}

test("a generated draft is ai-draft, and an edit or an accept clears the badge", () => {
  const empty = block("empty");
  assert.equal(empty.state, "empty");
  assert.equal(empty.source, "none");

  const drafted = block("ai-draft");
  assert.equal(drafted.state, "ai-draft");
  assert.equal(drafted.source, "model");
  assert.equal(drafted.providerId, "test-fake");

  const accepted = blocks.acceptedBlock(drafted, "owner@maintsupp.com", "t");
  assert.equal(accepted.state, "reviewed");
  assert.equal(accepted.prose, drafted.prose, "accepting reads it; it does not rewrite it");

  const edited = blocks.editedBlock(drafted, "  Spend was £1,758.00 in March.  ", "owner@maintsupp.com", "t");
  assert.equal(edited.state, "reviewed", "§4.3: the badge clears once a human edits OR accepts");
  assert.equal(edited.source, "human");
  assert.equal(edited.prose, "Spend was £1,758.00 in March.", "trimmed, not padded");
});

test("regenerating a reviewed block puts the badge back", () => {
  const reviewed = block("reviewed");
  assert.equal(reviewed.state, "reviewed");
  const again = blocks.draftedBlock(reviewed, "Different sentences entirely.", "test-fake", "t");
  assert.equal(
    again.state,
    "ai-draft",
    "the sentence a person approved is gone; carrying their approval onto new text is the failure the badge exists to prevent",
  );
  assert.equal(again.updatedByEmail, null, "and it is no longer attributed to them");
});

test("emptying a block is not approving it", () => {
  const cleared = blocks.editedBlock(block("ai-draft"), "   ", "owner@maintsupp.com", "t");
  assert.equal(cleared.state, "empty");
  assert.equal(cleared.source, "none");
  assert.equal(cleared.providerId, null);
});

test("computed prose is reviewed on arrival, and says where it came from", () => {
  const computed = blocks.deterministicBlock(block("empty"), "47 jobs were recorded.", "t");
  assert.equal(computed.source, "deterministic");
  assert.equal(
    computed.state,
    "reviewed",
    "a sentence generated FROM the figures cannot contain one that is not in the data, so there is nothing for a review to catch",
  );
});

test("narrativeReviewComplete is false while any block is an ai-draft", () => {
  assert.equal(blocks.narrativeReviewComplete([]), true);
  assert.equal(blocks.narrativeReviewComplete([block("reviewed"), block("empty")]), true);
  assert.equal(
    blocks.narrativeReviewComplete([block("reviewed"), block("ai-draft")]),
    false,
    "§10: Finalise is blocked while any narrative block is unreviewed",
  );
  assert.equal(
    blocks.narrativeReviewComplete([block("empty")]),
    true,
    "an unwritten block is a decision about the document, not an unread machine draft",
  );
  assert.deepEqual(blocks.blocksAwaitingReview([block("reviewed")]), []);
  assert.equal(blocks.blocksAwaitingReview([block("ai-draft"), block("ai-draft")]).length, 2);
});

test("the blocker `blockers.ts` will call carries a code and a usable sentence", () => {
  assert.equal(blocks.narrativeReviewBlocker([block("reviewed")]), null);
  const blocker = blocks.narrativeReviewBlocker([block("ai-draft")]);
  assert.equal(blocker.code, "narrative.unreviewed");
  assert.equal(blocker.code, blocks.NARRATIVE_BLOCKER_CODE);
  assert.match(blocker.message, /accepted or edited before finalising/);
  assert.match(blocker.message, /Spend paragraph/, "it names the block to go and look at");
});

test("a block key round-trips, and an unknown one is refused rather than guessed", () => {
  assert.equal(blocks.narrativeBlockKey("spend"), "spend");
  assert.equal(blocks.narrativeBlockKey("hold-explanation", "hold_1"), "hold-explanation:hold_1");
  assert.deepEqual(blocks.parseNarrativeBlockKey("hold-explanation:hold_1"), {
    kind: "hold-explanation",
    subjectId: "hold_1",
  });
  assert.equal(blocks.parseNarrativeBlockKey("spend:anything"), null, "spend is not per-subject");
  assert.equal(blocks.parseNarrativeBlockKey("hold-explanation"), null, "a hold block needs its hold");
  assert.equal(blocks.parseNarrativeBlockKey("something-else"), null);
});

/* ══════════════════════════════════════════════════════════════════════════
   THE PROVIDER BOUNDARY — no vendor, no key, and no secret anywhere near the
   browser.
   ══════════════════════════════════════════════════════════════════════════ */

test("with nothing configured the provider is unavailable, with a sentence", async () => {
  delete process.env.REPORT_NARRATIVE_PROVIDER;
  const resolution = await provider.resolveNarrativeProvider();
  assert.equal(resolution.available, false);
  assert.equal(resolution.reason, "unconfigured");
  assert.match(resolution.message, /not configured on this deployment/);
  assert.match(
    resolution.message,
    /by hand/,
    "an operator must be told what still works, not only what does not",
  );
  assert.deepEqual(
    provider.registeredNarrativeProviders(),
    [],
    "no provider is selected or bundled — that is the owner's decision, not this code's",
  );
});

test("Generate explains itself rather than failing silently or pretending", async () => {
  delete process.env.REPORT_NARRATIVE_PROVIDER;
  const outcome = await provider.draftNarrativeBlock({
    payload: PAYLOAD,
    blockKey: "executive-summary",
  });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.reason, "unconfigured");
  assert.ok(outcome.message.length > 40, "a whole sentence, not a code");
  assert.equal(outcome.prose, undefined, "and nothing that could be mistaken for a draft");
});

test("a named provider with no adapter, and one with no credential, are told apart", async () => {
  process.env.REPORT_NARRATIVE_PROVIDER = "some-vendor";
  delete process.env.REPORT_NARRATIVE_API_KEY;
  const unknown = await provider.resolveNarrativeProvider();
  assert.equal(unknown.available, false);
  assert.equal(unknown.reason, "unknown-provider");

  provider.registerNarrativeProvider("some-vendor", () => ({
    id: "some-vendor",
    label: "Some vendor",
    generate: async () => "",
  }));
  const incomplete = await provider.resolveNarrativeProvider();
  assert.equal(incomplete.available, false);
  assert.equal(incomplete.reason, "incomplete");
  assert.match(incomplete.message, /credential is not set/);

  delete process.env.REPORT_NARRATIVE_PROVIDER;
});

test("NO SECRET REACHES THE CLIENT", async () => {
  const secret = "sk-test-this-must-never-be-serialised";
  process.env.REPORT_NARRATIVE_PROVIDER = "some-vendor";
  process.env.REPORT_NARRATIVE_API_KEY = secret;
  provider.registerNarrativeProvider("some-vendor", (context) => {
    assert.equal(context.credential, secret, "the adapter is the only thing that sees it");
    return { id: "some-vendor", label: "Some vendor", generate: async () => TRUE_PROSE };
  });

  /* The one shape the route is allowed to send outward. */
  const status = await provider.narrativeProviderStatus();
  assert.equal(status.available, true);
  assert.equal(status.providerLabel, "Some vendor");
  assert.ok(
    !JSON.stringify(status).includes(secret),
    "the status the browser receives must not contain the credential",
  );
  assert.deepEqual(
    Object.keys(status).sort(),
    ["available", "message", "providerLabel"],
    "three fields, and none of them is a place a key could hide",
  );

  /* And the whole generated outcome, which the route also serialises. */
  const outcome = await provider.draftNarrativeBlock({
    payload: PAYLOAD,
    blockKey: "executive-summary",
  });
  assert.equal(outcome.status, "generated");
  assert.ok(!JSON.stringify(outcome).includes(secret));

  delete process.env.REPORT_NARRATIVE_PROVIDER;
  delete process.env.REPORT_NARRATIVE_API_KEY;
});

test("no client-reachable module names a credential, or imports the one that reads it", async () => {
  /*
   * The enforcement is structural rather than a convention: the panel is the
   * only client component in this feature, and it may import the pure modules
   * and nothing else. `narrative-provider.ts` is where every variable name
   * lives and it must never appear in a browser bundle.
   */
  const clientReachable = [PANEL, CSS, BLOCKS, VALIDATOR];
  for (const file of clientReachable) {
    const source = await read(file);
    for (const forbidden of [
      "REPORT_NARRATIVE_API_KEY",
      "REPORT_NARRATIVE_PROVIDER",
      "REPORT_NARRATIVE_MODEL",
      "REPORT_NARRATIVE_ENDPOINT",
      "process.env",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `${file} must not name ${forbidden} — it is reachable from the browser`,
      );
    }
    /* An IMPORT, not a mention: `narrative-blocks.ts` names the provider in a
       comment on purpose, because a reader needs to know where the validator is
       actually called from. What must not exist is an edge in the graph. */
    assert.doesNotMatch(
      source,
      /(?:from|import)\s*\(?\s*["'][^"']*narrative-provider["']/,
      `${file} must not import the server-only provider module`,
    );
  }

  const providerSource = await read(PROVIDER);
  assert.match(
    providerSource,
    /process\.env\.REPORT_NARRATIVE_API_KEY/,
    "read as a literal member expression — a bundler substitutes the literal and nothing else",
  );
  assert.match(providerSource, /export function assertServerOnly/);
  assert.match(
    providerSource,
    /typeof window !== "undefined"/,
    "and it refuses outright if it is ever evaluated in a browser",
  );
});

test("the prompt carries the rule, the tone and the figures — and no figure of its own", async () => {
  const request = provider.buildNarrativeRequest(PAYLOAD, "spend");
  assert.match(request.system, /Use ONLY the figures supplied/);
  assert.match(request.system, /never round/);
  assert.match(request.system, /\[TBC\]/, "§4.3: leave any gap as [TBC] rather than guessing");
  assert.match(request.system, /UK spelling/);
  assert.match(request.system, /No marketing language/);
  assert.match(request.system, /no apology/);
  assert.match(request.user, /LOCKED FIGURES/);
  assert.match(request.user, /£1,758\.00/, "the printed form, so the model copies rather than formats");
  assert.equal(provider.buildNarrativeRequest(PAYLOAD, "not-a-block"), null);
});

/* ══════════════════════════════════════════════════════════════════════════
   THE ROUTE AND THE PANEL — source pins, in this suite's usual style. Each one
   is protecting a stated requirement, and the requirement is written into the
   assertion so a later refactor knows what it is being asked to preserve.
   ══════════════════════════════════════════════════════════════════════════ */

test("the route validates before it stores, and cannot be driven past it", async () => {
  const source = await read(ROUTE);
  assert.match(
    source,
    /draftNarrativeBlock\(/,
    "generation goes through the one function that validates",
  );
  assert.match(
    source,
    /outcome\.status === "refused"/,
    "and the refusal is handled explicitly rather than falling through to a write",
  );
  const refusedBranch = source.slice(source.indexOf('outcome.status === "refused"'));
  const writeIndex = refusedBranch.indexOf("writeStoredBlock");
  const returnIndex = refusedBranch.indexOf("status: 422");
  assert.ok(
    returnIndex !== -1 && returnIndex < writeIndex,
    "an orphan returns 422 BEFORE anything is written; no row may ever hold prose that failed the check",
  );
});

test("the route is capability-guarded, and refuses a finalised document", async () => {
  const source = await read(ROUTE);
  assert.match(
    source,
    /REPORT_CAPABILITIES\["document\.read"\]/,
    "reading the blocks is the read capability",
  );
  assert.match(
    source,
    /REPORT_CAPABILITIES\["document\.edit"\]/,
    "every write is `document.edit` — writing the report is the Operations Manager's job",
  );
  assert.match(
    source,
    /status === "Finalised" \|\| status === "Voided"/,
    "immutability has to mean the API refuses, not that a button is greyed",
  );
  assert.match(source, /visibleStatuses\(scope\)/, "a Viewer may not open a draft by guessing its id");
});

test("the panel shows the badge, offers a per-block Regenerate, and explains an unavailable provider", async () => {
  const source = await read(PANEL);
  assert.match(source, /AI_DRAFT_BADGE/, "one badge string, imported rather than retyped");
  assert.match(source, /"Regenerate"/, "§4.3: a Regenerate button per block");
  assert.match(source, />\s*Accept as reviewed\s*</, "and a way to clear the badge without editing");
  assert.match(
    source,
    /disabled=\{working \|\| !provider\?\.available\}/,
    "Regenerate is disabled when nothing is configured",
  );
  assert.match(
    source,
    /title=\{generateHint\}/,
    "and it says why on hover, rather than being silently greyed",
  );
  assert.match(source, /narrative-panel__badge--\$\{block\.state\}/);
  assert.match(source, /notice\.orphans\.map/, "a refusal names the figure it objected to");
  assert.match(source, /Finalising is blocked until each one is edited or accepted/);
});

test("the panel's stylesheet follows the theme rather than painting its own colours", async () => {
  const source = await read(CSS);
  /* The same rule `tests/w2-reports-tabs.test.mjs` enforces on reports.css.
     Comments may carry named colours; declarations may not. */
  const declarations = source.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(
    declarations.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [],
    [],
    "a colour literal in a declaration cannot follow the theme",
  );
  assert.deepEqual(
    declarations.match(/\brgba?\(/g) ?? [],
    [],
    "and neither can a hand-mixed alpha",
  );

  /* `body[data-theme="dark"] .portal-main button` in globals.css outranks every
     selector here, so a button that paints its own label must opt out. */
  for (const rule of source.split("}")) {
    const selector = rule.split("{")[0]?.trim().split("\n").pop()?.trim() ?? "";
    if (!/\.narrative-panel__button/.test(selector)) continue;
    if (!/\n\s*color:/.test(rule)) continue;
    assert.ok(
      rule.includes("--control-own-fg:"),
      `${selector} paints a button label the dark skin would overwrite`,
    );
  }

  assert.match(source, /min-height: 44px;/, "44px is the minimum comfortable touch target");
  /* CLAUDE.md: media queries are restricted to 640/767/768/1024/1280. */
  for (const width of source.match(/\(min-width: (\d+)px\)/g) ?? []) {
    assert.ok(
      ["640", "767", "768", "1024", "1280"].includes(/(\d+)/.exec(width)[1]),
      `${width} is not one of the agreed breakpoints`,
    );
  }
  assert.match(
    source,
    /\.narrative-panel__actions \{[\s\S]*?flex-direction: column;/,
    "the action row stacks below 640px, which is what makes the panel usable at 380px",
  );
});

test("new files are LF, per CLAUDE.md", async () => {
  for (const file of [VALIDATOR, BLOCKS, PROVIDER, ROUTE, PANEL, CSS]) {
    const raw = await readFile(path.join(root, file), "utf8");
    assert.ok(!raw.includes("\r\n"), `${file} must be LF`);
  }
});
