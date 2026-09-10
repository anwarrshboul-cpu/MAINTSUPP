/**
 * MODULE 5 — the invoice tracker's core server layer.
 *
 * TWO KINDS OF TEST, and the distinction is the same one
 * `tests/ops-rebuild-foundations.test.mjs` draws:
 *
 *   • The BEHAVIOURAL ones CALL the shipped modules. `app/lib/finance/model.ts`
 *     imports nothing at all and `app/lib/finance/rules.ts` imports only
 *     `./model`, which is exactly what lets them be transpiled and handed to
 *     `import()` from a `data:` URL with one specifier rewritten. Every rule
 *     worth arguing about — what a balance is, which ageing bucket, whether a
 *     split sums, the "5% or £50" boundary, duplicate detection, the approval
 *     band and maker/checker — is asserted by RUNNING it, not by reading it.
 *
 *   • The STRUCTURAL ones read SOURCE. "Balance is never stored" and "no route
 *     leaks a driver message" are statements about where code lives and what it
 *     does not contain, and the only way to hold them is to look. When one
 *     breaks, re-point it at the contract's new home with the reason written
 *     in — never delete it.
 *
 * The LIVE half runs against a dev server and SKIPS without one. Every fixture
 * it creates carries the literal string `ZZQA-M5` and is removed in a `finally`.
 * The live tests are deliberately weighted towards REFUSALS, which write
 * nothing at all: an unbalanced allocation, a waiver with no reason, an
 * approval past an open flag, a credit note larger than the balance. Those are
 * the assertions Module 5 exists for and they leave no residue to sweep.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/* Normalised, because line endings in this repo are PER FILE and there is no
   `.gitattributes` — CLAUDE.md says so. Every suite here that slices source
   does this; a CRLF copy makes every `indexOf` of a newline-bearing marker
   return -1 and the assertion then names the wrong cause. */
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Comments quote the strings they explain; a source rule against a literal
    has to strip them or it is a rule against writing the explanation down. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ts = (await import("typescript")).default;

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const asModule = (js) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

/* `model.ts` has NO imports, so it loads with no rewriting at all. `rules.ts`
   names exactly one specifier and it is relative, so it takes the same
   exact-string rewrite ten other suites use. A value import left unrewritten
   does not fail loudly — it takes the whole file out on load. */
const modelUrl = asModule(transpile(await read("app/lib/finance/model.ts")));
const model = await import(modelUrl);
const rules = await import(
  asModule(
    transpile(await read("app/lib/finance/rules.ts")).replace(
      /from ["']\.\/model["']/g,
      `from "${modelUrl}"`,
    ),
  )
);

/* ── 1. Money in, money out ───────────────────────────────────────────────── */

test("penceFromInput decides pounds-versus-pence by SHAPE, never by magnitude", () => {
  // The rule is one sentence and it is written at the function: a value
  // carrying a fraction or a currency symbol is pounds; a bare integer is
  // pence. Guessing by size books a £2,000 invoice at £20.
  assert.equal(model.penceFromInput(1234.56), 123456);
  assert.equal(model.penceFromInput("1234.56"), 123456);
  assert.equal(model.penceFromInput("£1,234.56"), 123456);
  assert.equal(model.penceFromInput("£1,234"), 123400);
  assert.equal(model.penceFromInput(123456), 123456, "a bare integer is already pence");
  assert.equal(model.penceFromInput("123456"), 123456, "a string and a number must not disagree");
  assert.equal(model.penceFromInput(0), 0);
});

test("penceFromInput refuses rather than defaulting to zero", () => {
  for (const bad of [null, undefined, "", "   ", "abc", "12.3.4", Number.NaN, Infinity, {}, []]) {
    assert.equal(model.penceFromInput(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("rounding is half AWAY FROM ZERO, so a credit and its invoice cannot drift apart", () => {
  assert.equal(model.penceFromInput(0.005), 1);
  assert.equal(model.penceFromInput(-0.005), -1);
  // 19.99 * 100 is 1998.9999999999998 in binary floating point.
  assert.equal(model.penceFromInput(19.99), 1999);
  assert.equal(model.poundsToPence(0.1 + 0.2), 30);
});

test("formatPence: no decimals above £1,000, two below", () => {
  // Dashboard master prompt §3.7, one sentence, and the boundary is literal —
  // exactly a thousand pounds is not ABOVE a thousand pounds.
  assert.equal(model.formatPence(1234), "£12.34");
  assert.equal(model.formatPence(99_999), "£999.99");
  assert.equal(model.formatPence(100_000), "£1,000.00");
  assert.equal(model.formatPence(100_001), "£1,000");
  assert.equal(model.formatPence(123_456_7), "£12,346");
  assert.equal(model.formatPence(-1234), "-£12.34");
});

test("formatPence abbreviates for a small screen without inventing precision", () => {
  assert.equal(model.formatPence(1_000_000, { abbreviate: true }), "£10k");
  assert.equal(model.formatPence(1_234_500, { abbreviate: true }), "£12.3k");
  assert.equal(model.formatPence(100_000_000, { abbreviate: true }), "£1m");
  // Below £10,000 the abbreviation adds nothing, so the plain rule stands.
  assert.equal(model.formatPence(999_99, { abbreviate: true }), "£999.99");
});

test("financeStatusKey folds spacing, case and hyphens onto the stored key", () => {
  assert.equal(model.financeStatusKey("Under review"), "under_review");
  assert.equal(model.financeStatusKey("  UNDER   REVIEW "), "under_review");
  assert.equal(model.financeStatusKey("part-paid"), "part_paid");
  assert.equal(model.financeStatusKey(null), "");
  // Unrecognised is NORMALISED, not rejected — §5's unmapped statuses must
  // render grey with their raw label, never disappear.
  assert.equal(model.financeStatusKey("Sent to bailiffs"), "sent_to_bailiffs");
});

test("the one legacy quote label is translated rather than migrated", () => {
  // `quotations.status` defaults to 'Awaiting approval' and every pre-Module-5
  // row holds it. `db/init.ts` performs no destructive UPDATE.
  assert.equal(model.quoteStatusKey("Awaiting approval"), "under_review");
  assert.equal(model.quoteStatusKey("Approved"), "approved");
});

/* ── 2. Balance — computed, never stored ──────────────────────────────────── */

test("a partial payment leaves the remainder outstanding", () => {
  const balance = rules.invoiceBalance({ grossPence: 120_000, paidPence: 50_000, creditedPence: 0 });
  assert.equal(balance.balancePence, 70_000);
  assert.equal(balance.settled, false);
  assert.equal(balance.overpaidPence, 0);
});

test("several payments settle one invoice exactly", () => {
  const balance = rules.invoiceBalance({ grossPence: 120_000, paidPence: 120_000, creditedPence: 0 });
  assert.equal(balance.balancePence, 0);
  assert.equal(balance.settled, true);
});

test("an over-payment is REPORTED, not clamped away", () => {
  // An invoice paid twice is the exact failure §7's duplicate check exists to
  // prevent; swallowing the evidence afterwards is the second half of it.
  const balance = rules.invoiceBalance({ grossPence: 100_000, paidPence: 120_000, creditedPence: 0 });
  assert.equal(balance.balancePence, -20_000);
  assert.equal(balance.overpaidPence, 20_000);
  assert.equal(balance.settled, true);
});

test("a credit note REDUCES the balance, in both directions", () => {
  // §6 prints `gross − allocations + credit notes`. That plus is a typo,
  // contradicted by §6's own prose ("reducing the balance") and by §16. Taken
  // literally a £200 credit on a £1,000 invoice would leave £1,200 owing.
  const credited = rules.invoiceBalance({ grossPence: 100_000, paidPence: 0, creditedPence: 20_000 });
  assert.equal(credited.balancePence, 80_000);

  // The arithmetic does not depend on direction — the sign is applied by
  // `signedForCashPosition` and only there.
  const both = rules.invoiceBalance({ grossPence: 100_000, paidPence: 30_000, creditedPence: 20_000 });
  assert.equal(both.balancePence, 50_000);
  assert.equal(rules.signedForCashPosition("receivable", both.balancePence), 50_000);
  assert.equal(rules.signedForCashPosition("payable", both.balancePence), -50_000);
});

test("a credit note for the whole balance settles the invoice without editing it", () => {
  const balance = rules.invoiceBalance({ grossPence: 60_000, paidPence: 0, creditedPence: 60_000 });
  assert.equal(balance.balancePence, 0);
  assert.equal(balance.settled, true);
});

/* ── 3. Ageing buckets — §9 ───────────────────────────────────────────────── */

test("ageing buckets match a manual calculation at every boundary", () => {
  const today = "2026-09-10";
  const at = (dueDay) => rules.ageingFor(dueDay, today);

  assert.equal(at("2026-09-11").ageingBucket, "current", "due tomorrow");
  assert.equal(at("2026-09-10").ageingBucket, "current", "due TODAY is not yet late");
  assert.equal(at("2026-09-10").daysOverdue, 0);

  assert.equal(at("2026-09-09").ageingBucket, "1-30");
  assert.equal(at("2026-09-09").daysOverdue, 1);
  assert.equal(at("2026-08-11").ageingBucket, "1-30", "30 days is the last day of 1-30");
  assert.equal(at("2026-08-11").daysOverdue, 30);
  assert.equal(at("2026-08-10").ageingBucket, "31-60", "31 days crosses");
  assert.equal(at("2026-07-12").ageingBucket, "31-60", "60 days is the last day of 31-60");
  assert.equal(at("2026-07-12").daysOverdue, 60);
  assert.equal(at("2026-07-11").ageingBucket, "61-90");
  assert.equal(at("2026-06-12").ageingBucket, "61-90", "90 days is the last day of 61-90");
  assert.equal(at("2026-06-12").daysOverdue, 90);
  assert.equal(at("2026-06-11").ageingBucket, "90+", "91 days is 90+");
  assert.equal(at("2026-06-11").daysOverdue, 91);
});

test("an invoice with no due date is CURRENT, not 90+", () => {
  // Nothing to be late against. Defaulting the other way puts every draft in
  // the worst bucket on the landing page.
  const ageing = rules.ageingFor(null, "2026-09-10");
  assert.equal(ageing.ageingBucket, "current");
  assert.equal(ageing.daysOverdue, 0);
});

test("day arithmetic crosses a month, a year and a leap day exactly", () => {
  assert.equal(model.daysBetweenDays("2026-02-28", "2026-03-01"), 1, "2026 is not a leap year");
  assert.equal(model.daysBetweenDays("2024-02-28", "2024-03-01"), 2, "2024 is");
  assert.equal(model.daysBetweenDays("2025-12-31", "2026-01-01"), 1);
  assert.equal(model.shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(model.dueDayFromTerms("2026-09-10", 30), "2026-10-10");
  assert.equal(model.dueDayFromTerms("2026-09-10", 0), "2026-09-10", "on receipt");
});

test("dayOf reads a bare day, an ISO instant and a cast Postgres timestamp alike", () => {
  assert.equal(model.dayOf("2026-09-10"), "2026-09-10");
  assert.equal(model.dayOf("2026-09-10T14:22:01.000Z"), "2026-09-10");
  assert.equal(model.dayOf("2026-09-10 14:22:01"), "2026-09-10");
  assert.equal(model.dayOf("  2026-09-10  "), "2026-09-10");
  assert.equal(model.dayOf("not a date"), null);
  assert.equal(model.dayOf(null), null);
});

/* ── 4. Allocation must sum — §4 ──────────────────────────────────────────── */

test("an allocation set that sums to the invoice net is balanced", () => {
  const state = rules.allocationState(120_000, [
    { requestId: "MN-1", amountPence: 40_000 },
    { requestId: "MN-2", amountPence: 30_000 },
    { requestId: "MN-3", amountPence: 30_000 },
    { requestId: "MN-4", amountPence: 20_000 },
  ]);
  assert.equal(state.totalPence, 120_000);
  assert.equal(state.balanced, true);
  assert.equal(state.difference, 0);
  assert.equal(state.count, 4);
});

test("one penny out is NOT balanced — there is no tolerance", () => {
  // A penny of tolerance is a penny that lands on no job, and four invoices
  // later it is fourpence nobody can find.
  const short = rules.allocationState(120_000, [{ requestId: "MN-1", amountPence: 119_999 }]);
  assert.equal(short.balanced, false);
  assert.equal(short.difference, -1);

  const over = rules.allocationState(120_000, [{ requestId: "MN-1", amountPence: 120_001 }]);
  assert.equal(over.balanced, false);
  assert.equal(over.difference, 1);
});

test("no allocations at all is unbalanced against a non-zero invoice", () => {
  const state = rules.allocationState(120_000, []);
  assert.equal(state.balanced, false);
  assert.equal(state.totalPence, 0);
  assert.equal(state.difference, -120_000);
});

test("a payment's allocations are held to the same rule", () => {
  const exact = rules.paymentAllocationState(50_000, [
    { invoiceId: "a", amountPence: 20_000 },
    { invoiceId: "b", amountPence: 30_000 },
  ]);
  assert.equal(exact.balanced, true);
  const short = rules.paymentAllocationState(50_000, [{ invoiceId: "a", amountPence: 49_900 }]);
  assert.equal(short.balanced, false, "£100 that left the bank and settles nothing");
});

/* ── 5. Over quote — "5% or £50, whichever is greater" ────────────────────── */

test("the tolerance is the GREATER of 5% and £50, and the crossover is £1,000", () => {
  const bp = 500;
  const floor = 5_000;
  assert.equal(rules.overQuoteTolerancePence(10_000, bp, floor), 5_000, "5% of £100 is £5; the floor wins");
  assert.equal(rules.overQuoteTolerancePence(100_000, bp, floor), 5_000, "at £1,000 they are equal");
  assert.equal(rules.overQuoteTolerancePence(200_000, bp, floor), 10_000, "5% of £2,000 is £100");
});

test("an invoice exactly AT the tolerance is not over it", () => {
  // "exceeds ... by more than a configurable tolerance" — a strict `>`. A `>=`
  // would flag the one case an operator has explicitly permitted.
  const base = { quoteAmountPence: 200_000, basisPoints: 500, floorPence: 5_000 };
  assert.equal(rules.overQuote({ ...base, invoiceAmountPence: 210_000 }).over, false, "exactly £100 over");
  assert.equal(rules.overQuote({ ...base, invoiceAmountPence: 210_001 }).over, true, "one penny past");
});

test("a small quote gets the £50 floor, not 5%", () => {
  const base = { quoteAmountPence: 10_000, basisPoints: 500, floorPence: 5_000 };
  assert.equal(rules.overQuote({ ...base, invoiceAmountPence: 14_000 }).over, false, "£40 over a £100 quote");
  assert.equal(rules.overQuote({ ...base, invoiceAmountPence: 15_001 }).over, true, "£50.01 over");
  assert.equal(rules.overQuote({ ...base, invoiceAmountPence: 15_001 }).tolerancePence, 5_000);
  assert.equal(rules.overQuote({ ...base, invoiceAmountPence: 15_001 }).excessPence, 5_001);
});

test("an invoice UNDER its quote is never over it", () => {
  const verdict = rules.overQuote({
    invoiceAmountPence: 90_000,
    quoteAmountPence: 100_000,
    basisPoints: 500,
    floorPence: 5_000,
  });
  assert.equal(verdict.over, false);
  assert.equal(verdict.excessPence, -10_000);
});

test("net beats gross when both sides have a net", () => {
  // VAT is a pass-through neither side chose; comparing gross to gross flags
  // every invoice issued after a rate change even though the price never moved.
  assert.deepEqual(rules.comparableAmount(100_000, 120_000), { amount: 100_000, basis: "net" });
  assert.deepEqual(rules.comparableAmount(null, 120_000), { amount: 120_000, basis: "gross" });
  assert.equal(rules.comparableAmount(null, null), null);
});

/* ── 6. Duplicate detection — §7 and §15.2 ────────────────────────────────── */

const supplier = (id, over = {}) => ({
  id,
  counterpartyKey: "id:apex",
  invoiceNumberKey: "",
  grossPence: 120_000,
  invoiceDay: "2026-09-01",
  ...over,
});

test("the same supplier invoice number reused is a duplicate", () => {
  const found = rules.duplicateFinding(
    supplier("new", { invoiceNumberKey: "inv001", grossPence: 5_000, invoiceDay: "2025-01-01" }),
    [supplier("old", { invoiceNumberKey: "inv001" })],
    30,
  );
  assert.ok(found, "a reused reference is a duplicate whatever the amount or the date");
  assert.equal(found.basis, "number");
  assert.equal(found.matchId, "old");
});

test("the same number from a DIFFERENT supplier is not a duplicate", () => {
  // "INV-001" is the first invoice every small trader ever raises.
  const found = rules.duplicateFinding(
    supplier("new", { invoiceNumberKey: "inv001" }),
    [supplier("other", { counterpartyKey: "id:brightspark", invoiceNumberKey: "inv001" })],
    30,
  );
  assert.equal(found, null);
});

test("same supplier, same amount, inside the window is a duplicate", () => {
  const found = rules.duplicateFinding(
    supplier("new", { invoiceDay: "2026-09-25" }),
    [supplier("old", { invoiceDay: "2026-09-01" })],
    30,
  );
  assert.ok(found);
  assert.equal(found.basis, "amount");
});

test("the window boundary is inclusive, and one day past it is not a duplicate", () => {
  const exact = rules.duplicateFinding(
    supplier("new", { invoiceDay: "2026-10-01" }),
    [supplier("old", { invoiceDay: "2026-09-01" })],
    30,
  );
  assert.ok(exact, "exactly 30 days apart still matches");

  const past = rules.duplicateFinding(
    supplier("new", { invoiceDay: "2026-10-02" }),
    [supplier("old", { invoiceDay: "2026-09-01" })],
    30,
  );
  assert.equal(past, null, "31 days apart is a monthly retainer, not a duplicate");
});

test("a different amount inside the window is not a duplicate", () => {
  const found = rules.duplicateFinding(
    supplier("new", { grossPence: 120_001 }),
    [supplier("old")],
    30,
  );
  assert.equal(found, null);
});

test("an invoice with no date can still match on the number but not on the amount", () => {
  assert.equal(
    rules.duplicateFinding(supplier("new", { invoiceDay: null }), [supplier("old")], 30),
    null,
    "no date means no window; treating it as inside everything flags every repeat charge",
  );
  assert.ok(
    rules.duplicateFinding(
      supplier("new", { invoiceDay: null, invoiceNumberKey: "abc" }),
      [supplier("old", { invoiceNumberKey: "abc" })],
      30,
    ),
  );
});

test("an invoice never duplicates itself", () => {
  assert.equal(rules.duplicateFinding(supplier("same"), [supplier("same")], 30), null);
});

test("counterparty and reference keys fold the spellings a human produces", () => {
  assert.equal(rules.counterpartyKey("Con-9", null), "id:con-9");
  assert.equal(rules.counterpartyKey(null, "  Apex   Electrical "), "name:apex_electrical");
  assert.equal(rules.counterpartyKey(null, null), "");
  assert.equal(rules.referenceKey("INV-001"), "inv001");
  assert.equal(rules.referenceKey(" inv 001 "), "inv001");
});

/* ── 7. Outside the agreement ─────────────────────────────────────────────── */

test("a category the product does not bill for is outside the agreement", () => {
  const base = { siteBillable: true, siteBillingFrom: null, siteBillingTo: null, invoiceDay: "2026-09-10" };
  assert.equal(rules.outsideAgreement({ ...base, category: "electrical" }), null);
  assert.equal(rules.outsideAgreement({ ...base, category: "HVAC" }), null, "normalised, not case-sensitive");
  assert.ok(rules.outsideAgreement({ ...base, category: "landscaping" }));
  assert.equal(
    rules.outsideAgreement({ ...base, category: null }),
    null,
    "a blank category is not stated, which is not evidence of anything",
  );
});

test("a site outside its billing window is outside the agreement", () => {
  const base = { category: "general", siteBillable: true, siteBillingFrom: null, siteBillingTo: null };
  assert.ok(rules.outsideAgreement({ ...base, siteBillable: false, invoiceDay: "2026-09-10" }));
  assert.ok(
    rules.outsideAgreement({ ...base, siteBillingFrom: "2026-10-01", invoiceDay: "2026-09-10" }),
  );
  assert.ok(rules.outsideAgreement({ ...base, siteBillingTo: "2026-08-31", invoiceDay: "2026-09-10" }));
  assert.equal(
    rules.outsideAgreement({
      ...base,
      siteBillingFrom: "2026-01-01",
      siteBillingTo: "2026-12-31",
      invoiceDay: "2026-09-10",
    }),
    null,
  );
});

/* ── 8. Flags ─────────────────────────────────────────────────────────────── */

test("only OPEN BLOCKING flags block, and a waiver is not a deletion", () => {
  const flags = [
    { flagType: "over_quote", severity: "blocking", status: "open" },
    { flagType: "possible_duplicate", severity: "blocking", status: "waived" },
    { flagType: "site_mismatch", severity: "warning", status: "open" },
    { flagType: "no_linked_job", severity: "blocking", status: "cleared" },
  ];
  const blocking = rules.blockingFlags(flags);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].flagType, "over_quote");
});

test("every §7 flag is in the vocabulary and blocks by default", () => {
  const expected = [
    "no_approved_quote",
    "over_quote",
    "job_not_complete",
    "site_mismatch",
    "possible_duplicate",
    "no_linked_job",
    "vat_anomaly",
    "outside_agreement",
  ];
  assert.deepEqual([...model.FINANCE_FLAG_TYPES], expected, "§7's table, in order");
  for (const flag of expected) {
    assert.equal(rules.DEFAULT_FLAG_SEVERITY[flag], "blocking", `${flag} blocks — §7 is blanket`);
  }
});

/* ── 9. Approval bands and maker/checker — §13 ────────────────────────────── */

/** §13's worked example, as `db/init.ts` seeds it. */
const LADDER = [
  { id: "b0", direction: "payable", minAmountPence: 0, maxAmountPence: 25_000, approversRequired: 0, requiresClient: false, makerCheckerFromPence: 100_000, active: true, sortOrder: 0 },
  { id: "b1", direction: "payable", minAmountPence: 25_000, maxAmountPence: 100_000, approversRequired: 1, requiresClient: false, makerCheckerFromPence: 100_000, active: true, sortOrder: 1 },
  { id: "b2", direction: "payable", minAmountPence: 100_000, maxAmountPence: 500_000, approversRequired: 2, requiresClient: false, makerCheckerFromPence: 100_000, active: true, sortOrder: 2 },
  { id: "b3", direction: "payable", minAmountPence: 500_000, maxAmountPence: null, approversRequired: 2, requiresClient: true, makerCheckerFromPence: 100_000, active: true, sortOrder: 3 },
];

test("bands are half-open on the upper bound, so no amount falls in two", () => {
  const band = (amount) => rules.resolveApprovalBand(LADDER, "payable", amount)?.id;
  assert.equal(band(0), "b0");
  assert.equal(band(24_999), "b0");
  assert.equal(band(25_000), "b1", "exactly £250 is in the second band, not the first");
  assert.equal(band(99_999), "b1");
  assert.equal(band(100_000), "b2", "exactly £1,000");
  assert.equal(band(499_999), "b2");
  assert.equal(band(500_000), "b3", "exactly £5,000");
  assert.equal(band(99_999_999), "b3", "a null upper bound is 'and above'");
});

test("a gap in the ladder returns NULL rather than a guessed default", () => {
  // An amount nobody has a rule for must not be silently given one approver;
  // that is how a £40,000 invoice gets signed off by one person.
  const holed = LADDER.filter((rule) => rule.id !== "b2");
  assert.equal(rules.resolveApprovalBand(holed, "payable", 200_000), null);
  assert.equal(rules.resolveApprovalBand(LADDER, "receivable", 200_000), null, "wrong direction");
  const inactive = LADDER.map((rule) => ({ ...rule, active: false }));
  assert.equal(rules.resolveApprovalBand(inactive, "payable", 200_000), null);
});

test("a second approval has to come from a second person", () => {
  const decision = rules.approvalDecision({
    band: LADDER[2],
    amountPence: 200_000,
    approvedBy: ["Anna@Maintsupp.com"],
    actorEmail: "anna@maintsupp.com",
    quoteApprovedBy: null,
    clientSignedOff: false,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.refusal, /already approved/i);
});

test("two approvers: the first is allowed and does not complete the band", () => {
  const first = rules.approvalDecision({
    band: LADDER[2],
    amountPence: 200_000,
    approvedBy: [],
    actorEmail: "anna@maintsupp.com",
    quoteApprovedBy: null,
    clientSignedOff: false,
  });
  assert.equal(first.allowed, true);
  assert.equal(first.approversRequired, 2);
  assert.equal(first.completesBand, false);

  const second = rules.approvalDecision({
    band: LADDER[2],
    amountPence: 200_000,
    approvedBy: ["anna@maintsupp.com"],
    actorEmail: "ben@maintsupp.com",
    quoteApprovedBy: null,
    clientSignedOff: false,
  });
  assert.equal(second.allowed, true);
  assert.equal(second.completesBand, true);
});

test("maker/checker: the quote's approver may not approve the invoice above the threshold", () => {
  // §13's small control. The threshold here is £1,000.
  const above = rules.approvalDecision({
    band: LADDER[2],
    amountPence: 200_000,
    approvedBy: [],
    actorEmail: "Anna@Maintsupp.com",
    quoteApprovedBy: "anna@maintsupp.com",
    clientSignedOff: false,
  });
  assert.equal(above.allowed, false, "case must not make it a different person");
  assert.match(above.refusal, /approved the quote/i);

  const atThreshold = rules.approvalDecision({
    band: LADDER[1],
    amountPence: 100_000,
    approvedBy: [],
    actorEmail: "anna@maintsupp.com",
    quoteApprovedBy: "anna@maintsupp.com",
    clientSignedOff: false,
  });
  assert.equal(atThreshold.allowed, false, "a threshold you are exactly on is one you have met");

  const below = rules.approvalDecision({
    band: LADDER[1],
    amountPence: 99_999,
    approvedBy: [],
    actorEmail: "anna@maintsupp.com",
    quoteApprovedBy: "anna@maintsupp.com",
    clientSignedOff: false,
  });
  assert.equal(below.allowed, true, "below the configured value the control does not apply");

  const somebodyElse = rules.approvalDecision({
    band: LADDER[2],
    amountPence: 200_000,
    approvedBy: [],
    actorEmail: "ben@maintsupp.com",
    quoteApprovedBy: "anna@maintsupp.com",
    clientSignedOff: false,
  });
  assert.equal(somebodyElse.allowed, true);
});

test("a band that requires client sign-off refuses until it is recorded", () => {
  const inputs = {
    band: LADDER[3],
    amountPence: 600_000,
    approvedBy: [],
    actorEmail: "anna@maintsupp.com",
    quoteApprovedBy: null,
  };
  assert.equal(rules.approvalDecision({ ...inputs, clientSignedOff: false }).allowed, false);
  assert.equal(rules.approvalDecision({ ...inputs, clientSignedOff: true }).allowed, true);
});

test("the recorded basis names the band, the count and the position", () => {
  const basis = rules.approvalBasis(LADDER[2], 200_000, 1);
  assert.match(basis, /£2,000\.00/);
  assert.match(basis, /2 approvers/);
  assert.match(basis, /approval 1 of 2/);
  assert.match(rules.approvalBasis(LADDER[0], 10_000, 1), /auto-approve/i);
  assert.match(rules.approvalBasis(LADDER[3], 600_000, 1), /Client sign-off/i);
});

/* ── 10. Source contracts ─────────────────────────────────────────────────── */

const FINANCE_LIB = [
  "app/lib/finance/model.ts",
  "app/lib/finance/rules.ts",
  "app/lib/finance/settings.ts",
  "app/lib/finance/references.ts",
  "app/lib/finance/balance.ts",
  "app/lib/finance/allocations.ts",
  "app/lib/finance/matching.ts",
  "app/lib/finance/approvals.ts",
  "app/lib/finance/repository.ts",
  "app/lib/finance/access.ts",
  "app/lib/finance/input.ts",
];

const FINANCE_ROUTES = [
  "app/api/finance/invoices/route.ts",
  "app/api/finance/invoices/[id]/route.ts",
  "app/api/finance/invoices/[id]/actions/route.ts",
  "app/api/finance/invoices/[id]/allocations/route.ts",
  "app/api/finance/invoices/[id]/flags/route.ts",
  "app/api/finance/quotes/route.ts",
  "app/api/finance/quotes/[id]/route.ts",
  "app/api/finance/quotes/[id]/actions/route.ts",
  "app/api/finance/payments/route.ts",
  "app/api/finance/payments/[id]/route.ts",
  "app/api/finance/credit-notes/route.ts",
];

test("no finance module uses a construct the Postgres translator refuses", async () => {
  // `db/sqlite-to-postgres.ts` refuses these BY NAME. A query built with one
  // passes locally on Miniflare and fails only once deployed.
  const forbidden = [
    "julianday(",
    "strftime(",
    "unixepoch(",
    "json_extract(",
    "printf(",
    " GLOB ",
    "rowid",
  ];
  for (const file of [...FINANCE_LIB, ...FINANCE_ROUTES]) {
    const source = codeOnly(await read(file));
    for (const token of forbidden) {
      assert.ok(!source.includes(token), `${file} must not use ${token.trim()}`);
    }
  }
});

test("balance is never stored — there is no balance column and no second answer", async () => {
  const schema = await read("db/schema.ts");
  const moduleFive = schema.slice(schema.indexOf("MODULE 5 — THE INVOICE TRACKER"));
  assert.ok(moduleFive.length > 1000, "the Module 5 block has moved; fix this test");
  assert.ok(
    !/balance_pence|balancePence: integer|"balance"/.test(moduleFive),
    "§6: never store a balance. A stored balance drifts and then no one trusts the ledger",
  );
  // Only `rules.ts` does the arithmetic; `balance.ts` re-exports it so callers
  // reach it through the module that owns the subject.
  const balance = await read("app/lib/finance/balance.ts");
  assert.match(balance, /export \{[\s\S]*invoiceBalance[\s\S]*\} from "\.\/rules"/);
  const arithmetic = (await read("app/lib/finance/rules.ts")).match(
    /grossPence - paidPence - creditedPence/g,
  );
  assert.equal(arithmetic?.length, 1, "one subtraction, in one place");
});

test("every finance route is dynamic, guarded and refuses through one funnel", async () => {
  for (const file of FINANCE_ROUTES) {
    const source = await read(file);
    assert.match(source, /export const dynamic = "force-dynamic";/, `${file} must be dynamic`);
    /* Either a literal operation or, on the two action routes, the operation
       the parsed action maps to — §13's capability depends on the action, not
       on the route, which is why the guard runs after the body is read. */
    assert.match(source, /guardFinance\(request, /, `${file} must resolve a capability`);
    assert.match(source, /financeUnavailable\(error, /, `${file} must catch through the funnel`);
    assert.ok(
      !/error\.message|String\(error\)/.test(codeOnly(source)),
      `${file} must not put a driver message in a response`,
    );
  }
});

test("the refusal funnel tries 401 then pooler-capacity then the generic 503", async () => {
  const access = await read("app/lib/finance/access.ts");
  const funnel = access.slice(access.indexOf("export function financeUnavailable"));
  const anonymousAt = funnel.indexOf("anonymousRefusal(");
  const busyAt = funnel.indexOf("busyRefusal(");
  const genericAt = funnel.indexOf("status: 503");
  assert.ok(anonymousAt > 0 && busyAt > anonymousAt && genericAt > busyAt, "order is the contract");
});

test("no finance route invents a capability", async () => {
  // `app/lib/permissions.ts` is not this feature's to edit, and a second role
  // system is how two screens come to disagree about who an Administrator is.
  const access = await read("app/lib/finance/access.ts");
  const used = [...access.matchAll(/"(board\.view|board\.edit|settings\.edit|data\.delete|[a-z_]+\.[a-z_]+)"/g)]
    .map((match) => match[1]);
  const catalogue = await read("app/lib/permissions.ts");
  const table = access.slice(
    access.indexOf("export const FINANCE_CAPABILITIES"),
    access.indexOf("/** `scopedDbWithCapability`"),
  );
  for (const capability of [...new Set(used)]) {
    if (!table.includes(`: "${capability}"`)) continue;
    assert.ok(
      catalogue.includes(`key: "${capability}"`),
      `${capability} is not in the capability catalogue`,
    );
  }
  assert.match(table, /"flag\.waive": "settings\.edit"/, "a waiver is the sharp end of §7");
  assert.match(table, /"ledger\.delete": "data\.delete"/);
});

test("finalisation freezes the accounting fields, server-side", async () => {
  const route = await read("app/api/finance/invoices/[id]/route.ts");
  assert.match(route, /if \(invoice\.finalisedAt\)/, "§15.14 is checked on the server");
  assert.match(route, /accountingFieldsIn\(patch\)/);
  const repository = await read("app/lib/finance/repository.ts");
  for (const field of ["netPence", "vatPence", "grossPence", "invoiceNumber", "invoiceDate", "dueAt"]) {
    assert.ok(
      repository.includes(`"${field}",`),
      `${field} must be in ACCOUNTING_FIELDS — a credit note is the only correction`,
    );
  }
});

test("a waiver cannot happen without a typed reason", async () => {
  const route = await read("app/api/finance/invoices/[id]/flags/route.ts");
  assert.match(route, /action === "waive" && \(!reason \|\| reason\.length < MIN_REASON\)/);
  const matching = await read("app/lib/finance/matching.ts");
  const setter = matching.slice(matching.indexOf("export async function setFlagStatus"));
  assert.match(setter, /if \(!input\.reason\) return null;/, "the library refuses too");
  assert.match(setter, /waivedBy: input\.actorEmail/);
  assert.match(setter, /waivedAt: stamp/);
});

test("the match engine never deletes a flag row", async () => {
  const matching = codeOnly(await read("app/lib/finance/matching.ts"));
  assert.ok(!/\.delete\(invoiceFlags\)/.test(matching), "a waiver has an author and must survive");
  assert.ok(!/delete from invoice_flags/i.test(matching));
});

test("a check that could not be evaluated does not clear its flag", async () => {
  const matching = await read("app/lib/finance/matching.ts");
  assert.match(
    matching,
    /if \(!result\.evaluated\.includes\(row\.flagType as FinanceFlagType\)\) continue;/,
    "skipped is not the same as passed — vat_anomaly on a payable is not determinable",
  );
  // The reason it is not determinable, stated where somebody will look for it.
  assert.ok(!/contractors\.vatNumber|vat_number.*contractors/.test(codeOnly(matching)));
});

test("voiding never winds a reference counter back", async () => {
  const references = codeOnly(await read("app/lib/finance/references.ts"));
  assert.ok(!/- 1|decrement|sequence - /.test(references), "a spent reference stays spent");
  assert.match(references, /nextSequenceForYear\(/, "the per-year reset is shared with MS-, not re-written");
  // Compare-and-swap: the update must match on the value that was read.
  assert.match(references, /and \$\{sql\.raw\(counter\.sequenceColumn\)\} = \$\{current\}/);
});

test("the ledger's totals are computed in SQL, not by summing a page", async () => {
  const repository = await read("app/lib/finance/repository.ts");
  const totals = repository.slice(
    repository.indexOf("export async function invoiceTotals"),
    repository.indexOf("export async function readInvoice"),
  );
  assert.ok(totals.length > 200, "invoiceTotals has moved; fix this test");
  assert.match(totals, /invoiceConditions\(organisationId, filters\)/, "the same WHERE as the page");
  assert.match(totals, /coalesce\(sum\(/);
  assert.ok(!/\.reduce\(/.test(totals), "a page sum under a four-hundred-row list is a wrong number");
});

test("every repository read is scoped to the organisation", async () => {
  const repository = await read("app/lib/finance/repository.ts");
  const froms = [...repository.matchAll(/\.from\((\w+)\)/g)].map((match) => match[1]);
  assert.ok(froms.length > 8, "the repository has shrunk unexpectedly; fix this test");
  // Every table this module reads has an organisation filter somewhere near it.
  for (const table of new Set(froms)) {
    if (table === "payments" && repository.includes("innerJoin(payments")) continue;
    assert.ok(
      repository.includes(`eq(${table}.organisationId, organisationId)`),
      `${table} must be filtered by organisation — RLS is defence in depth, not the enforcement layer`,
    );
  }
});

test("balances are batched, never one query per invoice", async () => {
  const balance = await read("app/lib/finance/balance.ts");
  assert.match(balance, /selectInChunks\(/);
  const body = balance.slice(
    balance.indexOf("export async function invoiceBalances"),
    balance.indexOf("/** One invoice's balance"),
  );
  assert.ok(!/for \(const id of ids\)/.test(body), "no N+1");
  assert.equal((body.match(/\.from\(/g) ?? []).length, 3, "three reads: invoices, payments, credits");
});

/* ── 11. Live ─────────────────────────────────────────────────────────────── */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: "owner@maintsupp.com", password: "Sunnamusk-Owner-2026" };
/** Every fixture carries this so a sweep can find them. */
const MARK = "ZZQA-M5";

const serverUp = async () => {
  try {
    await fetch(`${BASE}/api/context`, { signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
};

async function signIn() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  assert.ok(response.ok, `sign-in failed: ${response.status}`);
  return (response.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
}

const api = (jar) => async (path, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie: jar, ...(init.headers ?? {}) },
  });

/** Removes a draft invoice. Never touches anything without the marker. */
async function sweep(call, invoiceId) {
  if (!invoiceId) return;
  await call(`/api/finance/invoices/${invoiceId}`, { method: "DELETE" }).catch(() => undefined);
}

async function createFixture(call, over = {}) {
  const response = await call("/api/finance/invoices", {
    method: "POST",
    body: JSON.stringify({
      direction: "payable",
      invoiceNumber: `${MARK}-${Date.now()}`,
      counterpartyName: `${MARK} Supplier`,
      counterpartyId: `${MARK}-supplier`,
      netPence: 100_000,
      vatPence: 20_000,
      invoiceDate: "2026-09-01",
      category: "general",
      notes: `${MARK} fixture — safe to delete`,
      ...over,
    }),
  });
  return response;
}

test("live: an invoice with no job raises no_linked_job on save", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  try {
    const response = await createFixture(call);
    assert.equal(response.status, 201, `create must succeed, got ${response.status}`);
    const body = await response.json();
    id = body.id;
    assert.match(body.internalRef, /^AP-\d{4}-\d{3,}$/, "§4's AP-YYYY-NNN");
    assert.equal(body.status, "draft", "nothing enters the ledger approved");
    const types = body.findings.map((finding) => finding.flagType);
    assert.ok(types.includes("no_linked_job"), `§7 runs on save; got ${JSON.stringify(types)}`);
  } finally {
    await sweep(call, id);
  }
});

test("live: the balance is computed and moves with a payment", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  let paymentId = null;
  try {
    const created = await (await createFixture(call)).json();
    id = created.id;

    const before = await (await call(`/api/finance/invoices/${id}`)).json();
    assert.equal(before.balance.grossPence, 120_000);
    assert.equal(before.balance.balancePence, 120_000);
    assert.equal(before.balance.settled, false);

    const payment = await call("/api/finance/payments", {
      method: "POST",
      body: JSON.stringify({
        direction: "out",
        amountPence: 50_000,
        paymentDate: "2026-09-05",
        reference: `${MARK}-part`,
        allocations: [{ invoiceId: id, amountPence: 50_000 }],
      }),
    });
    assert.equal(payment.status, 201, `payment must be recorded, got ${payment.status}`);
    paymentId = (await payment.json()).id;

    const after = await (await call(`/api/finance/invoices/${id}`)).json();
    assert.equal(after.balance.paidPence, 50_000);
    assert.equal(after.balance.balancePence, 70_000, "gross − paid − credited");
    assert.equal(after.invoice.netPence, 100_000, "the invoice row itself is untouched");
  } finally {
    if (paymentId) await call(`/api/finance/payments/${paymentId}`, { method: "DELETE" }).catch(() => undefined);
    await sweep(call, id);
  }
});

test("live: a payment whose allocations do not sum is refused, and writes nothing", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  try {
    const created = await (await createFixture(call)).json();
    id = created.id;
    const response = await call("/api/finance/payments", {
      method: "POST",
      body: JSON.stringify({
        direction: "out",
        amountPence: 100_000,
        paymentDate: "2026-09-05",
        reference: `${MARK}-short`,
        allocations: [{ invoiceId: id, amountPence: 90_000 }],
      }),
    });
    assert.equal(response.status, 400, "§6: allocations must sum to the payment");
    assert.match((await response.json()).error, /match exactly/i);

    const after = await (await call(`/api/finance/invoices/${id}`)).json();
    assert.equal(after.balance.paidPence, 0, "the refusal wrote nothing");
  } finally {
    await sweep(call, id);
  }
});

test("live: money IN does not settle a payable", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  try {
    const created = await (await createFixture(call)).json();
    id = created.id;
    const response = await call("/api/finance/payments", {
      method: "POST",
      body: JSON.stringify({
        direction: "in",
        amountPence: 120_000,
        paymentDate: "2026-09-05",
        reference: `${MARK}-wrongway`,
        allocations: [{ invoiceId: id, amountPence: 120_000 }],
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /money out settles payables/i);
  } finally {
    await sweep(call, id);
  }
});

test("live: an unbalanced allocation set is refused with the gap named", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  try {
    const created = await (await createFixture(call)).json();
    id = created.id;
    const response = await call(`/api/finance/invoices/${id}/allocations`, {
      method: "PUT",
      body: JSON.stringify({ allocations: [{ requestId: "MN-1049", amountPence: 40_000 }] }),
    });
    assert.equal(response.status, 409, "§4: enforce the sum");
    const body = await response.json();
    assert.match(body.error, /£400\.00/, "the sentence names what the lines come to");
    assert.match(body.error, /£1,000\.00/, "and the invoice net");
    assert.equal(body.allocation.balanced, false);
  } finally {
    await sweep(call, id);
  }
});

test("live: finalising an unallocated invoice is refused", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  try {
    const created = await (await createFixture(call)).json();
    id = created.id;
    const response = await call(`/api/finance/invoices/${id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "finalise" }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /land on a job/i);
  } finally {
    await sweep(call, id);
  }
});

test("live: approval is blocked while a §7 flag is open", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  try {
    const created = await (await createFixture(call)).json();
    id = created.id;
    const response = await call(`/api/finance/invoices/${id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(response.status, 409, "§16: flags block Approved for payment");
    const body = await response.json();
    assert.match(body.error, /clear or waive/i);
    assert.ok(Array.isArray(body.flags) && body.flags.length > 0);
  } finally {
    await sweep(call, id);
  }
});

test("live: a waiver with no reason is refused, and the flag stays open", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  try {
    const created = await (await createFixture(call)).json();
    id = created.id;
    const flags = (await (await call(`/api/finance/invoices/${id}/flags`)).json()).flags;
    assert.ok(flags.length > 0, "the fixture must carry a flag to waive");

    const refused = await call(`/api/finance/invoices/${id}/flags`, {
      method: "POST",
      body: JSON.stringify({ flagId: flags[0].id, action: "waive", reason: "ok" }),
    });
    assert.equal(refused.status, 400, "§7: waived with a TYPED reason");
    assert.match((await refused.json()).error, /typed reason/i);

    const after = (await (await call(`/api/finance/invoices/${id}/flags`)).json()).flags;
    assert.equal(after.find((row) => row.id === flags[0].id).status, "open");
  } finally {
    await sweep(call, id);
  }
});

test("live: voiding needs a reason and never re-issues the reference", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let first = null;
  let second = null;
  try {
    const a = await (await createFixture(call)).json();
    first = a.id;
    const refused = await call(`/api/finance/invoices/${first}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "void" }),
    });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /reason/i);

    const b = await (await createFixture(call)).json();
    second = b.id;
    assert.notEqual(a.internalRef, b.internalRef, "two invoices never share a reference");
    const sequenceA = Number(a.internalRef.split("-").at(-1));
    const sequenceB = Number(b.internalRef.split("-").at(-1));
    assert.equal(sequenceB, sequenceA + 1, "the counter advances by one, gaplessly");
  } finally {
    await sweep(call, first);
    await sweep(call, second);
  }
});

test("live: a credit note larger than the balance is refused, and writes nothing", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  try {
    const created = await (await createFixture(call)).json();
    id = created.id;
    const response = await call("/api/finance/credit-notes", {
      method: "POST",
      body: JSON.stringify({
        invoiceId: id,
        amountPence: 200_000,
        reason: `${MARK} over-credit attempt`,
      }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /still outstanding/i);

    const blank = await call("/api/finance/credit-notes", {
      method: "POST",
      body: JSON.stringify({ invoiceId: id, amountPence: 1_000 }),
    });
    assert.equal(blank.status, 400, "a credit note with no reason is an unexplained reduction");

    const after = await (await call(`/api/finance/invoices/${id}`)).json();
    assert.equal(after.balance.creditedPence, 0, "both refusals wrote nothing");
  } finally {
    await sweep(call, id);
  }
});

test("live: the same supplier, the same amount, inside the window is flagged", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let first = null;
  let second = null;
  try {
    // Same counterparty id, same money, twenty days apart — §7's amount branch,
    // and the one §15.2 calls "the most expensive routine failure in AP".
    // Different supplier invoice numbers, so this cannot pass on the reference.
    const a = await (await createFixture(call, { invoiceDate: "2026-09-01" })).json();
    first = a.id;
    const b = await (await createFixture(call, { invoiceDate: "2026-09-20" })).json();
    second = b.id;

    const types = b.findings.map((finding) => finding.flagType);
    assert.ok(
      types.includes("possible_duplicate"),
      `the second invoice must be flagged before it can be paid; got ${JSON.stringify(types)}`,
    );
    const flag = b.flags.find((row) => row.flagType === "possible_duplicate");
    assert.equal(flag.status, "open");
    assert.equal(flag.severity, "blocking");
    assert.match(flag.detail, /nothing has been removed/i, "never auto-delete");

    // The first invoice is untouched — a flag accuses the newcomer, not the ledger.
    const original = await (await call(`/api/finance/invoices/${first}`)).json();
    assert.equal(original.invoice.voidedAt, null);
  } finally {
    await sweep(call, second);
    await sweep(call, first);
  }
});

test("live: the ledger's totals describe the filtered set, not the page", async (t) => {
  if (!(await serverUp())) {
    t.skip(`no dev server at ${BASE}`);
    return;
  }
  const call = api(await signIn());
  let id = null;
  try {
    const created = await (await createFixture(call)).json();
    id = created.id;
    const response = await call(`/api/finance/invoices?q=${MARK}&limit=1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.totals, "totals must be present");
    assert.ok(body.totals.invoiceCount >= 1);
    assert.ok(body.cashPosition, "§9's cash position rides with the list");
    assert.equal(typeof body.totals.outstandingPence, "number");
    assert.ok(body.invoices.length <= 1, "the page is a page");
  } finally {
    await sweep(call, id);
  }
});
