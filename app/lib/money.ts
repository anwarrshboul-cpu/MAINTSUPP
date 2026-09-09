/**
 * Money, in integer pence.
 *
 * This codebase already keeps money in `*_pence INTEGER` in twenty-one places —
 * invoices, contractor rates, site budgets, compliance costs. `maintenance_requests.cost`
 * is the exception: a `real`, which is IEEE-754 binary32 and cannot represent
 * £52,408.06 exactly. Every individual job cost round-trips fine, so nothing
 * looked wrong; the error only appears when they are added up.
 *
 * Measured on the migration's own 92 costed jobs:
 *
 *     SUM(cost)            -> 52408.10     (float4 accumulation)
 *     SUM(cost::numeric)   -> 52408.06
 *     integer pence        -> 5240806      exact, and the source agrees
 *
 * Four pence on £52k is not a rounding curiosity. It is the difference between
 * a finance figure that reconciles against an invoice and one that does not,
 * and it grows with the number of rows.
 *
 * PARSING IS STRING-FIRST, DELIBERATELY. `Math.round(Number("48.87") * 100)`
 * happens to give 4887, but `Number("1.005") * 100` is 100.49999999999999 —
 * the float is consulted before the rounding can help. Reading the digits
 * either side of the point avoids the question entirely.
 */

export type PenceResult = {
  /** The value in pence, or null when the input said nothing. */
  pence: number | null;
  /** False when the input was present but could not be read as money. */
  ok: boolean;
  /** Why, when `ok` is false — for a migration to list rather than guess. */
  reason?: string;
};

const CLEANABLE = /[£$€,\s ]/g;

/**
 * A money string or number to integer pence.
 *
 * `null` in means `null` out: **"no cost recorded" and "£0.00" are different
 * facts** and the migration is required to keep them apart. An empty string is
 * the same silence as null.
 *
 * More than two decimal places is refused rather than rounded. The source has
 * none, and a migration that silently turns £1.005 into £1.01 has made a
 * financial decision nobody asked it to make.
 */
export function poundsToPence(value: string | number | null | undefined): PenceResult {
  if (value === null || value === undefined) return { pence: null, ok: true };

  const text = String(value).replace(CLEANABLE, "").trim();
  if (text === "") return { pence: null, ok: true };

  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return { pence: null, ok: false, reason: `not a number: ${String(value)}` };

  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > 2) {
    return {
      pence: null,
      ok: false,
      reason: `more than two decimal places: ${String(value)}`,
    };
  }

  const pence = Number(whole) * 100 + Number(fraction.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(pence)) {
    return { pence: null, ok: false, reason: `out of safe integer range: ${String(value)}` };
  }
  return { pence: sign === "-" ? -pence : pence, ok: true };
}

/** Pence back to a decimal number of pounds, for display only. */
export function penceToPounds(pence: number | null | undefined): number | null {
  if (pence === null || pence === undefined) return null;
  return pence / 100;
}

/** "£52,408.06". Formatting only — never feed the result back into arithmetic. */
export function formatPence(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" })
    .format(pence / 100);
}

/**
 * The canonical spend of a set of rows, in pence.
 *
 * Rows carrying `costPence` are summed as integers. A row that has only the
 * legacy `cost` is converted first, so a workspace part-way through the
 * migration still totals exactly rather than mixing an integer sum with a float
 * one. Nothing here ever adds two floating-point numbers together.
 */
export function sumCostPence(
  rows: ReadonlyArray<{ costPence?: number | null; cost?: number | null }>,
): number {
  let total = 0;
  for (const row of rows) {
    if (typeof row.costPence === "number") {
      total += row.costPence;
      continue;
    }
    if (typeof row.cost === "number") {
      const converted = poundsToPence(row.cost.toFixed(2));
      if (converted.pence !== null) total += converted.pence;
    }
  }
  return total;
}

/** The same sum, as pounds, for a caller that still speaks in pounds. */
export function sumCostPounds(
  rows: ReadonlyArray<{ costPence?: number | null; cost?: number | null }>,
): number {
  return sumCostPence(rows) / 100;
}

/**
 * One row's cost in pence, for a caller accumulating into its own total.
 *
 * The same preference as `sumCostPence`: the canonical column when it is there,
 * the legacy decimal converted exactly when it is not, and zero for a row that
 * records no cost at all — a bucket total of nothing is 0, not null.
 */
export function costPenceOf(
  row: { costPence?: number | null; cost?: number | null },
): number {
  if (typeof row.costPence === "number") return row.costPence;
  if (typeof row.cost === "number") return poundsToPence(row.cost.toFixed(2)).pence ?? 0;
  return 0;
}
