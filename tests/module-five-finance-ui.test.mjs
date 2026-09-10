/**
 * MODULE 5's SIX TABS — the rules that are expensive to get wrong twice.
 *
 * The Invoice Tracker's UI carries a handful of statements that are correct
 * today and one careless edit away from being false, and each of them is false
 * in a way nobody notices until money has moved:
 *
 *   · a status drawn in a colour typed into a component rather than read from
 *     §5's token block, so recolouring "Query raised" misses one screen;
 *   · a finalised invoice whose edit button is merely greyed out, teaching an
 *     operator that the product is broken rather than that corrections go
 *     through credit notes;
 *   · an approve button that stops being blocked while a duplicate-payment flag
 *     is open;
 *   · an allocation editor that stops showing the difference, so a split that
 *     does not sum is only discovered by a 409 at finalisation;
 *   · the unbilled-work widget — §15.1's "highest-value item here" — quietly
 *     demoted off the landing tab;
 *   · payable and receivable growing into two components, which is precisely
 *     the failure §1 opens by naming.
 *
 * TWO KINDS OF TEST, following `tests/overview-financial-performance.test.mjs`:
 *
 *   • BEHAVIOURAL — the pure helpers are sliced out of the shipped source by
 *     name, stripped of their types by the compiler the repo already carries,
 *     and called. React cannot be mounted under `node:test` here, and a
 *     re-implementation would agree with itself while the product was wrong.
 *
 *   • STRUCTURAL — "the refusal explains itself" is a statement about what is
 *     RENDERED, and without a DOM the only way to hold it is to read the
 *     source. When a refactor invalidates one of these, RE-POINT it at the
 *     contract's new home with the reason written in — never delete it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/* Normalised: this is a Windows checkout and line endings are per file. */
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Comments quote the rules they explain; every source check strips them. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DIR = "app/(app)/portal/finance/";
const LANDING = `${DIR}finance-landing.tsx`;
const LEDGER = `${DIR}finance-ledger.tsx`;
const PANEL = `${DIR}finance-invoice-panel.tsx`;
const QUOTES = `${DIR}finance-quotes.tsx`;
const PAYMENTS = `${DIR}finance-payments.tsx`;
const ANALYSIS = `${DIR}finance-analysis.tsx`;
const SETTINGS = `${DIR}finance-settings.tsx`;
const SHARED = `${DIR}finance-shared.tsx`;
const STATUS = `${DIR}finance-status.ts`;
const RECORDS = `${DIR}finance-records.ts`;
const SHELL = `${DIR}invoice-tracker-page.tsx`;
const CSS = `${DIR}finance.css`;
const RULES = "app/lib/finance/rules.ts";

const landing = await read(LANDING);
const ledger = await read(LEDGER);
const panel = await read(PANEL);
const quotes = await read(QUOTES);
const payments = await read(PAYMENTS);
const analysis = await read(ANALYSIS);
const settings = await read(SETTINGS);
const shared = await read(SHARED);
const status = await read(STATUS);
const records = await read(RECORDS);
const shell = await read(SHELL);
const css = await read(CSS);
const rules = await read(RULES);

const TABS = [
  [LANDING, landing],
  [LEDGER, ledger],
  [PANEL, panel],
  [QUOTES, quotes],
  [PAYMENTS, payments],
  [ANALYSIS, analysis],
  [SETTINGS, settings],
];

/* ── The harness: pure helpers, out of a .tsx, without React ──────────────── */

const ts = (await import("typescript")).default;

function slice(source, name) {
  const exported = source.indexOf(`export function ${name}(`);
  const at = exported >= 0 ? exported : source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} has moved or is no longer a function declaration; fix this test`);
  const end = source.indexOf("\n}\n", at);
  assert.ok(end > 0, `${name} must end with a brace at column zero`);
  return source.slice(at, end + 2).replace(/^export /, "");
}

/**
 * One `const`, exported or not, up to its terminating semicolon.
 *
 * The name may carry a type annotation — `const NO_WINDOW: DueWindowPayload =`
 * — so the match is a regex rather than an `indexOf` of `name + " ="`. The
 * annotation is then stripped along with the rest of the types by `strip`.
 */
function constant(source, name) {
  const pattern = new RegExp(`^(export )?const ${name}(: [^=\\n]+)? =`, "m");
  const found = pattern.exec(source);
  assert.ok(found, `${name} has moved or is no longer a const; fix this test`);
  const at = found.index;
  const end = source.indexOf(";\n", at);
  assert.ok(end > 0, `${name} must end in a semicolon at the end of a line`);
  return source.slice(at, end + 1).replace(/^export /, "");
}

const strip = (code) =>
  ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/*
 * Sliced rather than imported, for the reason this repository's notes record:
 * `finance-records.ts` carries a relative specifier and a relative specifier
 * cannot resolve from a `data:` URL. Slicing keeps this file from needing an
 * import graph at all — and it means `recordBalance` is exercised against the
 * REAL `invoiceBalance` out of `app/lib/finance/rules.ts`, which is the whole
 * point of the test that follows.
 */
const helpers = new Function(
  `${strip(
    [
      slice(rules, "invoiceBalance"),
      slice(records, "recordBalance"),
      constant(records, "NO_WINDOW"),
      slice(records, "readCashPosition"),
      slice(records, "whole"),
      constant(landing, "FORECAST_WEEKS"),
      constant(landing, "MONTHS"),
      slice(landing, "weekLabel"),
      slice(landing, "weeklyBuckets"),
      constant(analysis, "MONEY"),
      constant(analysis, "THOUSANDS"),
      constant(analysis, "COMMA_HOLD"),
      constant(analysis, "DAY"),
      slice(analysis, "parseStatementLines"),
    ].join("\n\n"),
  )}
   return { invoiceBalance, recordBalance, readCashPosition, weeklyBuckets, parseStatementLines };`,
)();

/* ══ 1. §1 — payable and receivable are ONE component ═════════════════════ */

test("the shell renders one ledger component for both directions", () => {
  const code = codeOnly(shell);
  assert.match(
    code,
    /tab === "payable" \|\| tab === "receivable"/,
    "§1: the two sides share one branch. Splitting them here is the first step towards two components and two allocation bugs.",
  );
  assert.match(
    code,
    /<FinanceLedger\s+direction=\{tab === "payable" \? "payable" : "receivable"\}/,
    "the direction is a PROP, not a different component",
  );
  assert.doesNotMatch(
    code,
    /FinancePayableLedger|FinanceReceivableLedger/,
    "§1 opens by naming this failure: 'Most systems build one and bolt the other on badly.'",
  );
});

test("the ledger takes a direction and gets every word from DIRECTION_WORDS", () => {
  assert.match(
    ledger,
    /export function FinanceLedger\(\{\s*\n\s*direction,/,
    "the shell passes `direction`; renaming it breaks both tabs at once",
  );
  assert.match(
    codeOnly(ledger),
    /const words = DIRECTION_WORDS\[direction\];/,
    "§4's asymmetric vocabulary lives in one table. A ternary on `direction` in the JSX is the thing that drifts.",
  );
  for (const [file, source] of [[LEDGER, ledger], [PANEL, panel]]) {
    assert.doesNotMatch(
      codeOnly(source),
      /direction === "payable" \? "Received from" : "Issued to"/,
      `${file} must read the words from DIRECTION_WORDS, never restate them`,
    );
  }
});

/* ══ 2. §5 — the colour is a token, and never the only signal ═════════════ */

test("every §5 status colour is a token reference, not a literal", () => {
  const groups = status.slice(status.indexOf("const GROUPS"), status.indexOf("function rawLabel"));
  assert.doesNotMatch(
    groups,
    /#[0-9a-fA-F]{3,8}/,
    "§5's colours live in finance.css's token block; a hex here is a second copy that the dark theme cannot lift",
  );
  assert.match(groups, /tone: "var\(--fin-/, "each group names a CSS custom property");
});

test("no component writes a colour literal", () => {
  for (const [file, source] of [...TABS, [SHARED, shared], [RECORDS, records]]) {
    const found = codeOnly(source).match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    assert.deepEqual(
      found,
      [],
      `${file} writes a colour literal (${found.join(", ")}). Read a token, or in the one data case UNMAPPED_STATUS_COLOUR from app/lib/finance/model.ts.`,
    );
  }
});

test("finance.css keeps every hex inside the one token block", () => {
  const start = css.indexOf("fin-token-block:start");
  const end = css.indexOf("fin-token-block:end");
  assert.ok(start > 0 && end > start, "the token block markers must survive; they are what this test measures");
  const outside = css.slice(0, start) + css.slice(end);
  const found = outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(
    found,
    [],
    `finance.css writes a hex outside its token block (${found.join(", ")}). Recolouring §5 has to stay one edit in one place.`,
  );
});

test("finance.css uses only the agreed breakpoints", () => {
  const widths = [...new Set((css.match(/\(m(?:in|ax)-width:\s*(\d+)px\)/g) ?? [])
    .map((query) => query.replace(/\D+/g, "")))].sort();
  assert.deepEqual(
    widths.filter((width) => !["640", "767", "768", "1024", "1280"].includes(width)),
    [],
    "several stage tests fail on any width but 640 / 767 / 768 / 1024 / 1280",
  );
});

test("colour is never the only signal: every row carries an icon and a days badge", () => {
  assert.match(
    codeOnly(shared),
    /<Icon name=\{presentation\.icon\}/,
    "§5: 'each row also carries a days-overdue badge and a status icon'",
  );
  assert.match(codeOnly(shared), /export function AgeBadge\(/, "the days-overdue badge");
  for (const [file, source] of [[LEDGER, ledger], [QUOTES, quotes]]) {
    assert.match(
      codeOnly(source),
      /<AgeBadge/,
      `${file} draws rows with a date on them and must carry the second, non-colour signal`,
    );
  }
});

test("an unmapped status raises the admin notice rather than disappearing", () => {
  assert.match(
    codeOnly(ledger),
    /<UnmappedStatusNotice keys=\{unmapped\} \/>/,
    "§5: 'Unmapped statuses render grey with the raw label and raise an admin notice, never disappear.'",
  );
  assert.match(codeOnly(ledger), /unmappedKeys\(/, "the keys come from the shared scan, not a second filter");
});

/* ══ 3. §15.14 — the edit path explains itself ════════════════════════════ */

test("a finalised invoice's edit path says WHY, not merely disables a button", () => {
  const code = codeOnly(panel);
  assert.match(
    code,
    /const frozen = Boolean\(invoice\.finalisedAt\);/,
    "the panel has to know the invoice is finalised in order to explain it",
  );
  /*
   * The sentence itself, not just the flag. A `disabled` attribute is a
   * suggestion; the prose is the only thing that tells an operator what to do
   * instead, and §15.14 is explicit that the instead is a credit note.
   */
  assert.match(
    panel,
    /This invoice was finalised on \{dayText\(invoice\.finalisedAt\)\}/,
    "the date it froze has to be on screen — 'you cannot edit this' with no date is unanswerable",
  );
  assert.match(
    panel,
    /A correction is a credit note against this[\s\S]{0,40}invoice, never an edit to it/,
    "§15.14's remedy, in words, beside the refusal",
  );
  assert.match(
    code,
    /\{frozen \? "Edit the notes" : "Edit this invoice"\}/,
    "notes stay editable on a finalised invoice, exactly as the server allows",
  );
  assert.match(
    panel,
    /Raise a credit note/,
    "the remedy is a control on the same panel, not an instruction to go and find one",
  );
});

test("a voided invoice explains itself too, and keeps its figures", () => {
  assert.match(
    panel,
    /A voided invoice keeps the[\s\S]{0,40}figures it was issued with/,
    "the void refusal carries its own reason rather than reusing the finalisation one",
  );
});

/* ══ 4. §7 and §16 — approve is blocked while a blocking flag is open ═════ */

test("approve is disabled while a blocking flag is open AND the flags are named", () => {
  const code = codeOnly(panel);
  assert.match(
    code,
    /const blocking = openBlockingCount\(flags\);/,
    "the count comes from `blockingFlags` in app/lib/finance/rules.ts — the same function the server refuses with",
  );
  assert.match(
    code,
    /disabled=\{busy \|\| voided \|\| blocking > 0\}/,
    "§16: 'An invoice exceeding its approved quote beyond tolerance blocks approval until cleared or waived with a reason.'",
  );
  assert.match(
    panel,
    /is blocked while \{plural\(blocking, "flag"\)\}/,
    "the block is explained above the button, with the number of flags",
  );
  assert.match(
    code,
    /blockingNames\.join\(", "\)/,
    "and the flags are NAMED: 'two flags are open' sends somebody hunting, 'Possible duplicate' does not",
  );
});

test("waiving a flag needs a typed reason, in the UI as well as on the server", () => {
  assert.match(
    codeOnly(shared),
    /disabled=\{busy \|\| \(reasons\[flag\.id\] \?\? ""\)\.trim\(\)\.length < 8\}/,
    "§7: 'cleared or waived with a typed reason'. The server's minimum is eight characters; the button matches it so the refusal never has to happen.",
  );
});

/* ══ 5. §4 and §6 — the allocation difference is shown, live ══════════════ */

test("the allocation editor prints the difference with its sign", () => {
  const code = codeOnly(shared);
  assert.match(code, /const state = draftState\(targetPence, rows\);/);
  assert.match(
    shared,
    /\$\{formatPence\(outstanding\)\} still to allocate/,
    "under-allocated and over-allocated are different mistakes; 'does not balance' identifies neither",
  );
  assert.match(shared, /\$\{formatPence\(-outstanding\)\} over-allocated/);
  assert.match(
    code,
    /allocationState\(/,
    "the arithmetic is the server's own `allocationState`, so the number under the form and the number in the 409 cannot disagree",
  );
});

test("both places that split money use the one editor", () => {
  assert.match(codeOnly(panel), /<AllocationEditor/, "§4: an invoice across several jobs");
  assert.match(codeOnly(payments), /<AllocationEditor/, "§6: a payment across several invoices");
});

test("a payment cannot be recorded until its shares sum to it", () => {
  assert.match(
    codeOnly(payments),
    /const ready = amountPence !== null && state\.balanced && rows\.every/,
    "§6: allocations 'must sum to the payment'",
  );
});

/* ══ 6. §6 — the balance is computed, never re-derived ════════════════════ */

test("no component works out a balance for itself", () => {
  for (const [file, source] of TABS) {
    const code = codeOnly(source);
    assert.doesNotMatch(
      code,
      /grossPence\s*-\s*paidPence/,
      `${file} subtracts its own balance. §6 has one answer to that question and it is invoiceBalance().`,
    );
    assert.doesNotMatch(
      code,
      /payments\.reduce\(/,
      `${file} adds up payments to find a balance; the server already measured it`,
    );
  }
  assert.match(
    codeOnly(records),
    /return invoiceBalance\(\{/,
    "recordBalance delegates; it does not compute",
  );
});

test("recordBalance is the real invoiceBalance, and a credit note REDUCES", () => {
  const balance = helpers.recordBalance({
    grossPence: 120000,
    balance: { grossPence: 120000, paidPence: 20000, creditedPence: 10000 },
  });
  assert.equal(balance.balancePence, 90000, "£1,200 less £200 paid less £100 credited is £900");
  assert.equal(balance.settled, false);

  /* §6 prints a plus and means a minus — see the head of rules.ts. If that plus
     is ever taken literally, this is the test that says so. */
  const credited = helpers.recordBalance({
    grossPence: 100000,
    balance: { grossPence: 100000, paidPence: 0, creditedPence: 20000 },
  });
  assert.equal(credited.balancePence, 80000, "a £200 credit against £1,000 leaves £800, never £1,200");

  /* An over-payment is reported, not clamped: it is what a duplicate looks like. */
  const overpaid = helpers.recordBalance({
    grossPence: 100000,
    balance: { grossPence: 100000, paidPence: 120000, creditedPence: 0 },
  });
  assert.equal(overpaid.overpaidPence, 20000);
});

/* ══ 7. §8 and §15.1 — the unbilled widget is on the landing tab ══════════ */

test("the unbilled-work widget is on the landing tab, with a count, a total and a drill-down", () => {
  const code = codeOnly(landing);
  assert.match(code, /<UnbilledCard/, "§15.1: 'the highest-value item here'");
  assert.match(
    code,
    /useFinanceEndpoint<UnbilledPayload>\("\/api\/finance\/unbilled"\)/,
    "it reads the dedicated route",
  );
  assert.match(landing, /<Money pence=\{report\.totalPence\} \/>/, "§8: 'with a total'");
  assert.match(
    landing,
    /across \{plural\(report\.count, "completed job"\)\}/,
    "and a count, in words, beside it",
  );
  assert.match(
    code,
    /onClick=\{\(\) => onOpenJob\(row\.requestId\)\}/,
    "the drill-down opens the job — a list that leads nowhere is a count with extra steps",
  );
  assert.match(
    landing,
    /className="fin-card fin-unbilled"/,
    "it has its own accented frame; §15.1 is explicit that this is not a footnote",
  );
});

test("the landing tab never guesses a figure it did not receive", () => {
  assert.match(
    codeOnly(landing),
    /<DegradedNotice[\s\S]{0,200}endpoint="\/api\/finance\/summary"/,
    "a card whose route is missing says so; it does not print zero",
  );
  assert.doesNotMatch(
    codeOnly(landing),
    /ledger\.data\?\.cashPosition/,
    "the ledger route's cashPosition describes ONE PAGE of invoices; using it here would be a page total under a whole-ledger heading",
  );
});

test("readCashPosition reads either spelling and refuses a payload that is neither", () => {
  const flat = helpers.readCashPosition({
    receivableOutstandingPence: 5000,
    receivableOverduePence: 1000,
    payableOutstandingPence: 2000,
    payableOverduePence: 0,
    netPositionPence: 3000,
    due7: { in: 100, out: 50 },
  });
  assert.equal(flat.receivableOutstandingPence, 5000);
  assert.deepEqual(flat.due7, { in: 100, out: 50 }, "/api/finance/summary spells it `due7`");

  const nested = helpers.readCashPosition({
    receivableOutstandingPence: 1,
    payableOutstandingPence: 1,
    netPositionPence: 0,
    dueNext7Pence: { in: 7, out: 8 },
  });
  assert.deepEqual(nested.due7, { in: 7, out: 8 }, "the ledger route spells it `dueNext7Pence`");

  assert.equal(helpers.readCashPosition(null), null);
  assert.equal(
    helpers.readCashPosition({ somethingElse: 1 }),
    null,
    "a payload carrying none of the headline figures is a different payload, not a cash position of zero",
  );
});

test("the 90-day forecast folds into weeks without losing a penny", () => {
  const points = Array.from({ length: 91 }, (_, index) => ({
    day: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
    inPence: 100,
    outPence: 50,
  }));
  const weeks = helpers.weeklyBuckets(points);
  assert.equal(weeks.length, 13, "ninety-one days is thirteen whole weeks");
  assert.equal(
    weeks.reduce((sum, week) => sum + week.in, 0),
    9100 - 100 * 0,
    "every point lands in exactly one week",
  );
  assert.equal(weeks[0].label, "This week");
  assert.equal(weeks.reduce((sum, week) => sum + week.out, 0), 4550);
});

/* ══ 8. §3 — the comparison view ══════════════════════════════════════════ */

test("quotes on one job are compared side by side, and approving one rejects the rest", () => {
  const code = codeOnly(quotes);
  assert.match(code, /const compared = jobs\.filter\(\(group\) => group\.quotes\.length > 1\);/,
    "§3: 'Where a job has more than one quote, show them side by side'");
  assert.match(code, /className="fin-compare"/, "the side-by-side grid");
  assert.match(quotes, /Approve this one/, "§3 names this control");
  assert.match(
    code,
    /\{ action: "approve", reason: reason\.trim\(\) \|\| undefined \}/,
    "the typed reason travels with the approval and is written onto every quote it rejects",
  );
  assert.match(
    code,
    /disabled=\{busy \|\| rejected \|\| reason\.trim\(\)\.length === 0\}/,
    "§3: 'Rejection reason | Required to move to Rejected'",
  );
  assert.match(
    quotes,
    /Approved by \{quote\.approvedBy\} on \{dayText\(quote\.approvedAt\)\}/,
    "§3: approval records who and when",
  );
  assert.match(
    code,
    /<AgeBadge dueDay=\{quote\.validUntil\} today=\{today\} kind="expiry" \/>/,
    "§3: expiry is visible on the card — 'an expired quote on an unstarted job is money quietly leaking'",
  );
});

/* ══ 9. §13 — payment runs, and §15.6 — the exports ═══════════════════════ */

test("a payment run is built from the server's own candidates and exports a file", () => {
  const code = codeOnly(payments);
  assert.match(
    code,
    /const rows = runs\.data\?\.candidates \?\? \[\];/,
    "'eligible' is a server-side judgement; a second definition here would offer a settled invoice for a batch that then refuses it",
  );
  assert.match(
    code,
    /body: \{ paymentDate, invoiceIds: chosen \}/,
    "§13: 'select multiple approved payables, group into a run with a payment date'",
  );
  assert.match(
    code,
    /fetchDownload\(`\/api\/finance\/payment-runs\/\$\{run\.id\}\/export`/,
    "§13: 'export as a bank-ready CSV, and mark the batch scheduled'",
  );
});

test("the accounting exports go through the one download helper", () => {
  assert.match(codeOnly(analysis), /fetchDownload\(`\/api\/finance\/exports\?/);
  assert.match(
    codeOnly(shared),
    /export async function fetchDownload\(/,
    "a window.location navigation to a download URL shows neither a 404 nor a refusal",
  );
  for (const format of ["xero", "quickbooks", "sage"]) {
    assert.ok(
      analysis.includes(format),
      `§15.6 names ${format}; the button has to exist or the bookkeeper does everything twice`,
    );
  }
});

test("a pasted statement is parsed in front of the person who pasted it", () => {
  const parsed = helpers.parseStatementLines(
    "INV-1001, 2026-08-01, 1,250.00\nINV-1002\t2026-08-09\t£99.50\n\n  \nINV-1003,2026-08-12,40",
  );
  assert.equal(parsed.length, 3, "blank lines are not statement lines");
  assert.deepEqual(parsed[0], {
    supplierRef: "INV-1001",
    invoiceDate: "2026-08-01",
    amount: "1,250.00",
  });
  assert.equal(parsed[1].supplierRef, "INV-1002", "tabs split as well as commas");
  assert.equal(parsed[1].amount, "£99.50", "a currency symbol is still an amount");
  assert.equal(parsed[2].amount, "40");
  assert.match(
    codeOnly(analysis),
    /lines: parsed,/,
    "the route takes rows, not a blob — the server must not be left guessing on somebody's behalf",
  );
});

/* ══ 10. §16 — bank details, and 380px ════════════════════════════════════ */

test("bank details are the server's to mask, and this screen never un-masks them", () => {
  const code = codeOnly(settings);
  assert.match(
    code,
    /const canSeeBankDetails = payload\?\.canSeeBankDetails === true;/,
    "the flag comes from the settings payload — the same check that masked the digits",
  );
  assert.doesNotMatch(
    code,
    /useCapability\(/,
    "asking /api/context separately would be a second answer to one question, and the two would eventually differ",
  );
  assert.doesNotMatch(
    settings,
    /sortCode:\s*"\d/,
    "§16: 'Bank details appear only in settings, never in code' — and this repository is public",
  );
  assert.match(
    code,
    /\{canSee \? \(/,
    "the editable form exists only where the server would accept it; elsewhere the mask is explained instead",
  );
});

test("every ledger view is built to work at 380px", () => {
  /* §16's acceptance criterion. The table becomes cards below 768, which only
     works if each cell carries the column name the hidden header row used to
     supply — and if the roles survive `display: block`. */
  assert.match(css, /@media \(max-width: 767px\)/, "the card breakpoint");
  assert.match(css, /content: attr\(data-label\)/, "each cell prints its own column name as a card");
  for (const [file, source] of [[LEDGER, ledger], [QUOTES, quotes], [PAYMENTS, payments], [ANALYSIS, analysis], [SETTINGS, settings]]) {
    assert.match(
      source,
      /<table className="fin-table" role="table">/,
      `${file} must keep the explicit role: Chrome drops the table role when the cells become blocks`,
    );
    assert.match(source, /data-label=/, `${file} must label its cells for the card layout`);
  }
  assert.match(
    css,
    /\.fin-table td input,\n\.fin-table td select \{\n  min-height: 44px;/,
    "a control inside a table cell is still a touch target; measured at 380px these came out 24px tall",
  );
  assert.match(
    css,
    /\.fin-select input\[type="checkbox"\] \{[\s\S]{0,200}width: 44px;/,
    "the checkbox draws a 20px box inside a 44px hit area",
  );
});

test("every tab reads its data through the one fetch wrapper", () => {
  for (const [file, source] of TABS) {
    const code = codeOnly(source);
    assert.ok(
      code.includes("useFinanceEndpoint") || code.includes("useFinanceWrite"),
      `${file} must go through the shared hooks; a hand-rolled fetch loses the 404-is-not-an-error distinction`,
    );
  }
});
