/**
 * Module 5's analytics — the arithmetic, called rather than re-implemented.
 *
 * `ageing.ts`, `cash.ts`, `margin.ts` and `exports.ts` are pure by design: they
 * take rows and return a report, and `analytics.ts` beside them does the
 * reading and decides nothing. That split is what lets this file exercise the
 * SHIPPED functions from a `data:` URL — a re-implementation could agree with
 * itself while the product is wrong.
 *
 * The cases below are the ones where a plausible implementation is wrong:
 *
 *   · an ageing boundary, on the day itself and the day either side;
 *   · a margin percentage over a zero denominator, which is unknown and not
 *     minus one hundred;
 *   · a payment allocated across two invoices, which must not be counted twice
 *     in a cash forecast;
 *   · a CSV cell that a spreadsheet would execute;
 *   · a recurring rule set for the 31st, in February.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const ts = (await import("typescript")).default;
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const asModule = (js) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

/*
 * `model.ts` has zero imports and `rules.ts` imports only `model`, which is the
 * whole reason for that split — every module below reaches drizzle through one
 * of them or not at all, so the chain is three rewrites deep and no further.
 */
const modelSource = transpile(await read("app/lib/finance/model.ts"));
const model = asModule(modelSource);
const rules = asModule(
  transpile(await read("app/lib/finance/rules.ts")).replace(
    /from ["']\.\/model["']/g,
    `from "${model}"`,
  ),
);

const load = async (file) =>
  import(
    asModule(
      transpile(await read(file))
        .replace(/from ["']\.\/model["']/g, `from "${model}"`)
        .replace(/from ["']\.\/rules["']/g, `from "${rules}"`),
    )
  );

const ageing = await load("app/lib/finance/ageing.ts");
const cash = await load("app/lib/finance/cash.ts");
const margin = await load("app/lib/finance/margin.ts");
const exports_ = await load("app/lib/finance/exports.ts");

const TODAY = "2026-09-10";

/* ── §9's buckets ─────────────────────────────────────────────────────────── */

test("an ageing bucket breaks on the day, not near it", () => {
  const at = (dueDay) =>
    ageing.ageingReport(
      [{ invoiceId: "i", counterpartyId: "c", counterpartyName: "C", dueDay, balancePence: 100 }],
      TODAY,
    ).totals;

  /* Due today is CURRENT. An invoice is not late on the day it falls due — the
     same rule `duePassed` encodes on the jobs side of this product. */
  assert.equal(at(TODAY).current, 100);
  assert.equal(at("2026-09-11").current, 100, "due tomorrow is current");

  assert.equal(at("2026-09-09").b1_30, 100, "one day late");
  assert.equal(at("2026-08-11").b1_30, 100, "thirty days late is still 1-30");
  assert.equal(at("2026-08-10").b31_60, 100, "thirty-one days late crosses");
  assert.equal(at("2026-07-12").b31_60, 100, "sixty days late is still 31-60");
  assert.equal(at("2026-07-11").b61_90, 100, "sixty-one crosses");
  assert.equal(at("2026-06-12").b61_90, 100, "ninety days late is still 61-90");
  assert.equal(at("2026-06-11").b90, 100, "ninety-one is 90+");
});

test("an invoice with no due date is current, not ninety days late", () => {
  /* Absent is not old. Bucketing a missing date at the far end would put the
     product's most alarming column in front of a data gap. */
  const report = ageing.ageingReport(
    [{ invoiceId: "i", counterpartyId: null, counterpartyName: "C", dueDay: null, balancePence: 500 }],
    TODAY,
  );
  assert.equal(report.totals.current, 500);
  assert.equal(report.totals.b90, 0);
});

test("a settled invoice contributes nothing, and an over-payment does not net off", () => {
  const report = ageing.ageingReport(
    [
      { invoiceId: "a", counterpartyId: "c", counterpartyName: "C", dueDay: "2026-01-01", balancePence: 0 },
      { invoiceId: "b", counterpartyId: "c", counterpartyName: "C", dueDay: "2026-01-01", balancePence: -400 },
      { invoiceId: "d", counterpartyId: "c", counterpartyName: "C", dueDay: "2026-01-01", balancePence: 900 },
    ],
    TODAY,
  );
  /*
   * The over-payment is a real event — §7's duplicate-payment failure — and
   * letting it reduce the total would hide the evidence inside a smaller
   * number. 900, not 500.
   */
  assert.equal(report.totals.totalPence, 900);
});

test("counterparties are grouped by id where there is one and by name where there is not", () => {
  const report = ageing.ageingReport(
    [
      { invoiceId: "a", counterpartyId: "c1", counterpartyName: "UK Safety", dueDay: TODAY, balancePence: 100 },
      { invoiceId: "b", counterpartyId: "c1", counterpartyName: "UK Safety Ltd", dueDay: TODAY, balancePence: 200 },
      { invoiceId: "c", counterpartyId: null, counterpartyName: "Saed", dueDay: TODAY, balancePence: 300 },
    ],
    TODAY,
  );
  assert.equal(report.counterparties.length, 2, "a rename does not split a supplier");
  const linked = report.counterparties.find((row) => row.id === "c1");
  assert.equal(linked.totalPence, 300);
  assert.equal(linked.invoiceIds.length, 2, "the ids ride along so a row can drill down");
});

/* ── §9's cash position and forecast ──────────────────────────────────────── */

test("the due windows look forward and nest, and exclude money already overdue", () => {
  const rows = [
    { direction: "receivable", dueDay: "2026-09-12", balancePence: 100, daysOverdue: 0 },
    { direction: "receivable", dueDay: "2026-09-20", balancePence: 200, daysOverdue: 0 },
    { direction: "payable", dueDay: "2026-10-05", balancePence: 400, daysOverdue: 0 },
    { direction: "payable", dueDay: "2026-01-05", balancePence: 800, daysOverdue: 248 },
  ];
  const summary = cash.cashSummary(rows, TODAY);

  assert.equal(summary.due7.in, 100, "only the invoice inside seven days");
  assert.equal(summary.due14.in, 300, "and the windows nest");
  assert.equal(summary.due30.in, 300);
  assert.equal(summary.due30.out, 400);
  /*
   * An invoice that was due in January is not "due in the next thirty days".
   * It is already counted, in full, in the overdue figure.
   */
  assert.equal(summary.due30.out, 400, "overdue money is not also upcoming");
  assert.equal(summary.payableOverduePence, 800);
  assert.equal(summary.payableOutstandingPence, 1200);
  assert.equal(summary.netPositionPence, 300 - 1200);
});

test("the forecast folds overdue money into day zero and states what it cannot plot", () => {
  const forecast = cash.cashForecast(
    [
      { direction: "receivable", dueDay: "2026-01-01", balancePence: 500, daysOverdue: 252 },
      { direction: "payable", dueDay: null, balancePence: 700, daysOverdue: 0 },
      { direction: "receivable", dueDay: "2030-01-01", balancePence: 900, daysOverdue: 0 },
      { direction: "payable", dueDay: "2026-09-20", balancePence: 300, daysOverdue: 0 },
    ],
    TODAY,
  );

  assert.equal(forecast.points.length, 91, "ninety days plus today");
  assert.equal(forecast.points[0].day, TODAY);
  assert.equal(forecast.overdueInPence, 500, "money already late is due now, not never");
  /* Neither of these can be drawn, so neither is silently dropped. */
  assert.equal(forecast.undatedOutPence, 700);
  assert.equal(forecast.beyondHorizonInPence, 900);

  const twentieth = forecast.points.find((point) => point.day === "2026-09-20");
  assert.equal(twentieth.outPence, 300);
});

test("a payment split across two invoices is not counted twice", () => {
  /*
   * The trap this guards: a forecast built from PAYMENT rows rather than from
   * invoice balances would add a £1,000 transfer allocated £600/£400 to two
   * invoices as £1,000 twice. The forecast reads balances, so the arithmetic
   * cannot double — each invoice reports only what is still outstanding.
   */
  const beforePayment = cash.cashForecast(
    [
      { direction: "payable", dueDay: "2026-09-20", balancePence: 60000, daysOverdue: 0 },
      { direction: "payable", dueDay: "2026-09-20", balancePence: 40000, daysOverdue: 0 },
    ],
    TODAY,
  );
  const afterPayment = cash.cashForecast(
    [
      { direction: "payable", dueDay: "2026-09-20", balancePence: 0, daysOverdue: 0 },
      { direction: "payable", dueDay: "2026-09-20", balancePence: 0, daysOverdue: 0 },
    ],
    TODAY,
  );
  const day = (forecast) => forecast.points.find((point) => point.day === "2026-09-20").outPence;
  assert.equal(day(beforePayment), 100000);
  assert.equal(day(afterPayment), 0, "a settled pair leaves nothing on the day");
});

/* ── §8's margin ──────────────────────────────────────────────────────────── */

const job = (over = {}) => ({
  requestId: "j1",
  reference: "MN-1",
  title: "A job",
  siteId: "s1",
  siteName: "Aldgate",
  contractorId: "c1",
  contractorName: "UK Safety",
  category: "Lights",
  completedAt: "2026-08-01",
  requestedAt: "2026-07-01",
  complete: true,
  ...over,
});

test("a margin percentage over nothing charged out is unknown, never minus one hundred", () => {
  const report = margin.marginRollup(
    [job()],
    [
      {
        requestId: "j1",
        direction: "payable",
        amountPence: 50000,
        invoiceCategory: null,
        invoiceCounterpartyId: null,
        invoiceCounterpartyName: null,
      },
    ],
    "job",
  );
  const row = report.rows[0];
  assert.equal(row.costInPence, 50000);
  assert.equal(row.chargedOutPence, 0);
  assert.equal(row.marginPence, -50000);
  assert.equal(row.marginPercent, null, "unknown, not -100%");
  assert.equal(row.lossMaking, true);
  assert.equal(row.coverage, 0, "and the row says how much of it has been billed");
});

test("margin is charged out minus cost in, and the worst row sorts first", () => {
  const jobs = [job(), job({ requestId: "j2", reference: "MN-2", siteName: "Bristol" })];
  const allocation = (requestId, direction, amountPence) => ({
    requestId,
    direction,
    amountPence,
    invoiceCategory: null,
    invoiceCounterpartyId: null,
    invoiceCounterpartyName: null,
  });
  const report = margin.marginRollup(
    jobs,
    [
      allocation("j1", "payable", 10000),
      allocation("j1", "receivable", 15000),
      allocation("j2", "payable", 90000),
      allocation("j2", "receivable", 20000),
    ],
    "job",
  );
  assert.equal(report.rows[0].marginPence, -70000, "§8's loss-making work opens the list");
  assert.equal(report.rows[1].marginPence, 5000);
  assert.equal(report.totals.costInPence, 100000);
  assert.equal(report.totals.chargedOutPence, 35000);
  assert.equal(report.totals.marginPence, -65000);
});

/* ── §15.6's accounting export ────────────────────────────────────────────── */

test("a cell a spreadsheet would execute is neutralised", () => {
  /*
   * A supplier name is attacker-controlled text as far as a CSV is concerned,
   * and Excel runs a cell that opens with any of these. Neutralising means the
   * value is still READABLE — it is prefixed, not stripped — because a
   * bookkeeper has to be able to see what the supplier actually called
   * themselves.
   */
  for (const dangerous of ["=1+1", "+44 7700 900000", "-1+1", "@SUM(A1)", "\tTabbed"]) {
    const cell = exports_.neutraliseCsvCell(dangerous);
    assert.ok(
      !/^[=+\-@\t\r]/.test(cell),
      `${JSON.stringify(dangerous)} still opens with a formula character: ${cell}`,
    );
    /* Prefixed, not stripped: a bookkeeper has to be able to see what the
       supplier actually called themselves. */
    assert.ok(cell.endsWith(dangerous), "and the original is still legible");
  }

  /*
   * A PLAIN NUMBER IS LEFT ALONE, INCLUDING A NEGATIVE ONE — and that is the
   * more important half of this rule rather than an exception to it.
   *
   * `-2` opens with a formula character and is not a formula; it is a credit.
   * Prefixing it would turn every negative amount in the file into text, and a
   * bookkeeper's import would then fail to total a column — which is a worse
   * outcome, and a far more likely one, than the attack. `-1+1` above is the
   * case that is genuinely dangerous, and it is not a plain number.
   */
  assert.equal(exports_.neutraliseCsvCell("-2"), "-2");
  assert.equal(exports_.neutraliseCsvCell("1234.50"), "1234.50");
  assert.equal(exports_.csvCell(1234.5), '"1234.5"');
  /* Every field is quoted, whatever it holds, so the bytes are predictable. */
  assert.equal(exports_.csvCell("=1+1"), `"'=1+1"`);
});

test("each accounting format keeps its own header row", () => {
  const invoice = {
    direction: "payable",
    internalRef: "AP-2026-001",
    invoiceNumber: "INV-9",
    counterpartyId: "c1",
    counterpartyName: "UK Safety",
    invoiceDate: "2026-06-01",
    dueAt: "2026-06-30",
    paymentTermsDays: 30,
    netPence: 100000,
    vatPence: 20000,
    grossPence: 120000,
    currency: "GBP",
    category: "fire",
    notes: null,
    siteName: "Aldgate",
    jobReference: "MN-1",
  };
  for (const format of exports_.EXPORT_FORMATS) {
    const result = exports_.accountingExport(format, [invoice]);
    assert.ok(result.headers.length > 4, `${format} has a header row`);
    assert.equal(result.rows.length, 1);
    assert.equal(
      result.rows[0].length,
      result.headers.length,
      `${format}: every row must be as wide as its header`,
    );
    /*
     * Each format identifies the counterparty in ITS OWN vocabulary, which is
     * what makes these three mappings rather than one file renamed twice. Xero
     * and QuickBooks take the contact NAME; Sage takes an ACCOUNT REFERENCE,
     * because that is the column a Sage import reads — and it prefers the
     * stable `counterpartyId` over a name somebody can retype, which is the
     * same reasoning `contractorId` exists for on the jobs side.
     *
     * Asserting the name in all three would have been asserting that Sage was
     * mapped wrongly.
     */
    const identifier = format === "sage" ? exports_.sageAccountCode(invoice) : "UK Safety";
    assert.ok(
      result.csv.includes(identifier),
      `${format} identifies the counterparty in its own vocabulary (${identifier})`,
    );
    assert.ok(result.csv.includes("1000.00"), `${format} carries the money`);
  }
  /* The id wins where there is one; the name is the fallback, not the default. */
  assert.equal(
    exports_.sageAccountCode({ counterpartyId: "c1", counterpartyName: "UK Safety" }),
    "C1",
  );
  assert.equal(
    exports_.sageAccountCode({ counterpartyId: null, counterpartyName: "UK Safety" }),
    "UKSAFETY",
  );
  /* The three are genuinely different mappings, not one renamed twice. */
  const [xero, quickbooks, sage] = exports_.EXPORT_FORMATS.map((format) =>
    exports_.exportHeaders(format).join("|"),
  );
  assert.notEqual(xero, quickbooks);
  assert.notEqual(quickbooks, sage);
});

test("money crosses into a CSV as pounds, from pence, without a float", () => {
  assert.equal(exports_.poundsText(120000), "1200.00");
  assert.equal(exports_.poundsText(1), "0.01");
  assert.equal(exports_.poundsText(0), "0.00");
  assert.equal(exports_.poundsText(-2550), "-25.50");
});

/* ── §15.13's schedule ────────────────────────────────────────────────────── */

test("a recurring rule set for the 31st still fires in February", async () => {
  /*
   * The case naive date maths gets wrong: 31 January plus one month is not a
   * date, and rolling it forward would move a January retainer into March.
   * Clamped to the month's last day instead.
   */
  const source = await read("app/api/finance/recurring/route.ts");
  const start = source.indexOf("export function nextRunAfter");
  assert.ok(start > 0, "nextRunAfter has moved; fix this test");
  const body = source.slice(start, source.indexOf("\n}\n", start) + 3).replace("export ", "");
  const nextRunAfter = new Function(
    `${body.replace(/: (string|number|Frequency)\b/g, "").replace(/\): string/, ")")}; return nextRunAfter;`,
  )();

  assert.equal(nextRunAfter("2026-02-01", 31, "monthly"), "2026-02-28", "February clamps");
  assert.equal(nextRunAfter("2026-04-05", 31, "monthly"), "2026-04-30", "April has thirty days");
  assert.equal(nextRunAfter("2026-01-05", 31, "monthly"), "2026-01-31");
  assert.equal(nextRunAfter("2026-01-31", 31, "monthly"), "2026-01-31", "today still counts");
  assert.equal(
    nextRunAfter("2026-02-01", 15, "quarterly"),
    "2026-02-15",
    "quarterly still takes this month's occurrence when it has not passed",
  );
  assert.equal(nextRunAfter("2026-02-20", 15, "quarterly"), "2026-05-15", "then steps three months");
  assert.equal(nextRunAfter("2026-02-20", 15, "annually"), "2027-02-15");
});

/* ── The routes' own rules, read from source ──────────────────────────────── */

test("no analytics figure is computed in the loader", async () => {
  /*
   * `analytics.ts` reads and decides nothing — that separation is what makes
   * every assertion above possible, because the arithmetic is in a module with
   * no database behind it. A `marginPence` or a bucket name appearing here
   * would mean a second implementation nobody is testing.
   */
  const source = await read("app/lib/finance/analytics.ts");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["marginPence", "b31_60", "netPositionPence", "due7"]) {
    assert.ok(!code.includes(forbidden), `${forbidden} is decided in a pure module, not here`);
  }
});

test("every invoice figure excludes a voided row", async () => {
  /* §5 makes voiding the way a mistake is withdrawn. A cash forecast that
     planned around a cancelled obligation would be worse than none. */
  const source = await read("app/lib/finance/analytics.ts");
  assert.match(source, /isNull\(invoices\.voidedAt\)/);
  const count = (source.match(/isNull\(invoices\.voidedAt\)/g) ?? []).length;
  assert.ok(count >= 3, `every reader filters voided rows, found ${count}`);
});

test("a calendar chip can never be dragged", async () => {
  /* §10: "a due date is contractual, not something to move by accident." It is
     a FIELD on every chip rather than an assumption the calendar makes. */
  const source = await read("app/lib/finance/analytics.ts");
  assert.match(source, /draggable: false/);
  assert.doesNotMatch(source, /draggable: true/);
  const chips = (source.match(/draggable: false/g) ?? []).length;
  assert.ok(chips >= 2, "both chip kinds carry it");
});

test("no payment credential is stored, returned or accepted", async () => {
  /*
   * RE-POINTED, from masking to absence.
   *
   * This asserted that a sort code and account number were MASKED for anyone
   * without `billing.manage`. The mask worked — an independent review proved
   * it — but W06-09 is an owner-approved decision that predates Module 5: the
   * payment model is terms plus an EXTERNAL accounting reference, and never a
   * credential, "precisely because the alternative … is a breach waiting for
   * its first misconfigured backup". This repository is public.
   *
   * So the columns are gone rather than hidden, and a `bank_accounts` table
   * that holds no bank details is not one — it is a `payment_sources` row: a
   * label, an account name, and the reference that finds it in the accounting
   * system. §16 asks for bank details in settings; this is the safe reading of
   * it, and the divergence is deliberate.
   *
   * Absence is asserted at every layer, because a credential can come back in
   * three different ways: a column, a response field, or an accepted body key.
   */
  const route = await read("app/api/finance/settings/route.ts");
  const schema = await read("db/schema.ts");
  const init = await read("db/init.ts");
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const [name, source] of [["schema", schema], ["init", init], ["settings route", route]]) {
    for (const pattern of [/IBAN/i, /sort_?code/i, /account_?number/i, /card_?number/i]) {
      assert.doesNotMatch(code(source), pattern, `${name} still names a payment credential (${pattern})`);
    }
  }

  /* The capability still guards EDITING a payment source, which is the part of
     §16 that survives: `billing.manage`, which the built-in defaults grant to
     `super_admin` alone. */
  assert.match(route, /can\(\{ role: scope\.actor\.role, capabilities: \{\} \}, "billing\.manage"\)/);
  /* A refusal, not a silent skip: a form that appears to save and does not is
     worse than one that says no. */
  assert.match(route, /status: 403/);
  /* And what a payment source DOES carry is a reference, not a number. */
  assert.match(schema, /accountingReference: text\("accounting_reference"\)/);
});

test("exporting a payment run is what schedules it", async () => {
  /*
   * §13. One operation, because a run that could be exported without being
   * marked is a file somebody pays from twice.
   */
  const source = await read("app/api/finance/payment-runs/[id]/export/route.ts");
  assert.match(source, /export async function POST/, "it is a POST, because it writes");
  assert.match(source, /status: "scheduled"/);
  assert.match(source, /if \(run\.status === "draft"\)/, "and a second export does not re-schedule");

  /*
   * THIS PIN USED TO PROTECT THE BUG IT WAS WRITTEN TO PREVENT.
   *
   * It asserted `inArray(invoices.status, ["approved", "scheduled"])` and
   * called it "the batch is re-derived, so an invoice settled since the run
   * was built cannot reach a bank file". Re-deriving did achieve that — and it
   * also meant a run exported every OTHER run's invoices, because it never
   * asked which invoices this run was for. Measured: a run created for one £10
   * invoice exported two rows totalling £1,210, and a second run created for
   * one £1 invoice exported three, re-including both of the first run's.
   * `scheduled` in that list is what made it compound — the first export moved
   * its invoices to `scheduled` and the next export swept them back up. Two
   * suppliers paid twice, by the ordinary path, with no attacker involved.
   *
   * Re-pointed at the contract that replaced it: membership is claimed on the
   * invoice when the run is created, and the export reads that claim. The
   * property the old pin was protecting is kept by the balance re-read below,
   * which is what actually keeps a settled invoice out of a bank file.
   */
  assert.match(
    source,
    /eq\(invoices\.paymentRunId, run\.id\)/,
    "the export reads this run's own membership, not every approved payable",
  );
  assert.doesNotMatch(
    source,
    /inArray\(invoices\.status, \["approved", "scheduled"\]\)/,
    "and never re-derives the batch from status again",
  );
  assert.match(
    source,
    /balancePence > 0/,
    "an invoice settled since the run was built still cannot reach the file",
  );

  /* The claim is written where it can be enforced, and released when a draft
     run is cancelled — a claim with no release would strand the invoices. */
  const create = await read("app/api/finance/payment-runs/route.ts");
  assert.match(create, /set\(\{ paymentRunId: id/, "creating a run claims its invoices");
  assert.match(create, /isNull\(invoices\.paymentRunId\)/, "and a claimed invoice is not offered again");
  const cancel = await read("app/api/finance/payment-runs/[id]/route.ts");
  assert.match(cancel, /export async function DELETE/, "a draft run can be cancelled");
  assert.match(cancel, /paymentRunId: null/, "which releases what it was holding");
});
