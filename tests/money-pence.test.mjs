/**
 * Money is integer pence.
 *
 *   node --test tests/money-pence.test.mjs
 *
 * The number that matters is £52,408.06 across the migration's 92 costed jobs.
 * `SUM(cost)` over the `real` column returns £52,408.10, because binary32
 * cannot hold those values and the error only appears once they are added
 * together. Four pence is the difference between a finance figure that
 * reconciles against an invoice and one that does not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  poundsToPence,
  penceToPounds,
  formatPence,
  sumCostPence,
  sumCostPounds,
  costPenceOf,
} from "../app/lib/money.ts";
import { costPenceValue, costValue } from "../db/monday-export/monday-transform.mjs";

test("null and zero stay different facts", () => {
  // "no cost recorded" and "£0.00" mean different things to a finance report.
  assert.deepEqual(poundsToPence(null), { pence: null, ok: true });
  assert.deepEqual(poundsToPence(undefined), { pence: null, ok: true });
  assert.deepEqual(poundsToPence(""), { pence: null, ok: true });
  assert.deepEqual(poundsToPence("   "), { pence: null, ok: true });
  assert.equal(poundsToPence("0").pence, 0);
  assert.equal(poundsToPence("0.00").pence, 0);
  assert.equal(costPenceValue(""), null);
  assert.equal(costPenceValue("0"), 0);
});

test("the real source values convert exactly", () => {
  // Every shape present in the 92: 83 integers and 9 with two decimals.
  assert.equal(poundsToPence("1142").pence, 114200);
  assert.equal(poundsToPence("48.87").pence, 4887);
  assert.equal(poundsToPence("7954.82").pence, 795482);
  assert.equal(poundsToPence("£1,250.50").pence, 125050);
  assert.equal(poundsToPence("6500").pence, 650000);
});

test("parsing reads digits, not a float", () => {
  // Math.round(Number("1.005") * 100) is 100 — the float is consulted before
  // the rounding can help, and 1.005 * 100 is 100.49999999999999.
  assert.equal(poundsToPence("1.00").pence, 100);
  assert.equal(poundsToPence("0.07").pence, 7);
  assert.equal(poundsToPence("0.1").pence, 10);
  assert.equal(poundsToPence("1.1").pence, 110);
});

test("more than two decimals is refused, never rounded", () => {
  const r = poundsToPence("1.005");
  assert.equal(r.pence, null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /two decimal places/);
  // The migration lists such a value rather than making a financial decision.
  assert.equal(costPenceValue("1.005"), null);
});

test("a negative is carried, not silently corrected", () => {
  assert.equal(poundsToPence("-25.50").pence, -2550);
  assert.equal(costPenceValue("-25.50"), -2550);
});

test("a non-numeric value is reported rather than treated as zero", () => {
  const r = poundsToPence("about twenty quid");
  assert.equal(r.pence, null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a number/);
});

test("the migration total is exact to the penny", () => {
  // The nine two-decimal values from the source, plus enough integers to make
  // the point: summed as pence this is exact, summed as floats it is not.
  const cells = ["7954.82", "48.87", "1142", "996", "60", "180", "220", "1500", "0"];
  const pence = cells.reduce((total, c) => total + (poundsToPence(c).pence ?? 0), 0);
  assert.equal(pence, 1210169);
  assert.equal(penceToPounds(pence), 12101.69);
});

test("sumCostPence prefers the canonical column", () => {
  const rows = [{ costPence: 795482 }, { costPence: 4887 }, { costPence: 0 }, { costPence: null }];
  assert.equal(sumCostPence(rows), 800369);
  assert.equal(sumCostPounds(rows), 8003.69);
});

test("a row carrying only the legacy real still totals exactly", () => {
  // A workspace part-way through the migration must not mix an integer sum
  // with a float one.
  const rows = [{ cost: 7954.82 }, { costPence: 4887 }, { cost: 0 }];
  assert.equal(sumCostPence(rows), 800369);
});

test("a row with no cost contributes nothing, and is not an error", () => {
  assert.equal(sumCostPence([{ cost: null }, { costPence: null }, {}]), 0);
  assert.equal(costPenceOf({}), 0);
  assert.equal(costPenceOf({ cost: null }), 0);
  assert.equal(costPenceOf({ costPence: 0 }), 0);
});

test("costPenceOf prefers pence and falls back exactly", () => {
  assert.equal(costPenceOf({ costPence: 4887, cost: 48.87 }), 4887);
  assert.equal(costPenceOf({ cost: 48.87 }), 4887);
});

test("the transform's two cost readings agree with each other", () => {
  for (const cell of ["1142", "48.87", "7954.82", "0", "996"]) {
    const pounds = costValue(cell);
    const pence = costPenceValue(cell);
    assert.equal(pence, Math.round(pounds * 100), cell);
  }
});

test("formatting is for display and never feeds arithmetic", () => {
  assert.equal(formatPence(5240806), "£52,408.06");
  assert.equal(formatPence(0), "£0.00");
  assert.equal(formatPence(null), "—");
});
