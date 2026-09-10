/**
 * THE MODULE 5 HALF OF `billing_settings`, read in one place.
 *
 * ── WHY THIS IS RAW SQL ────────────────────────────────────────────────────
 *
 * `db/init.ts` adds eleven columns to `billing_settings` with `addColumn` —
 * three counters and their years, the over-quote tolerance, the duplicate
 * window, the payable terms and the inbox address — and the drizzle model in
 * `db/schema.ts` does not carry them. That is deliberate on both sides: the
 * bootstrap is additive and the model is not this module's to edit. The same
 * situation and the same answer already exist in `app/api/admin/users/route.ts`
 * ("Raw SQL because the Drizzle model does not carry the Stage 20 profile
 * columns"), so this follows it rather than inventing a second technique.
 *
 * Every statement here is a parameterised template with the organisation bound
 * as a value. The only `sql.raw` in this module and in `./references.ts` is a
 * COLUMN NAME taken from a fixed internal map — never from a request — because
 * an identifier cannot be a bind parameter in either dialect.
 *
 * ── THE DEFAULTS ARE §7's DEFAULTS ─────────────────────────────────────────
 *
 * `db/init.ts` declares them as column defaults (500 basis points, 5000 pence,
 * 30 days) and they are repeated here for the one case the column default
 * cannot cover: a workspace with no `billing_settings` row at all. Reading
 * settings creates the row lazily — see `readBillingSettings` — so this is a
 * belt-and-braces path, and it must agree with `db/init.ts`. It does, and the
 * test suite pins the pair.
 */

import { sql } from "drizzle-orm";
import type { getDb } from "../../../db";
import { readBillingSettings, type BillingSettingsRow } from "../billing/settings";

type Database = Awaited<ReturnType<typeof getDb>>;

export interface FinanceSettings {
  /** §7's tolerance: 5% is 500 basis points, and £50 is 5000 pence. */
  overQuoteToleranceBasisPoints: number;
  overQuoteTolerancePence: number;
  /** §7's duplicate window. Default 30 days. */
  duplicateWindowDays: number;
  /** Default payment terms for a payable, when the supplier's are not known. */
  payableTermsDays: number;
  /** The `invoices@` address, §12. Never a credential — just where post arrives. */
  financeInboxAddress: string | null;
  /** The workspace's own VAT registration. The only VAT number this schema holds. */
  vatNumber: string | null;
  vatEnabled: boolean;
  vatRateBasisPoints: number;
  /** Receivable terms, from the Module 4 settings that already existed. */
  receivableTermsDays: number;
  currency: string;
}

export const FINANCE_SETTING_DEFAULTS: FinanceSettings = {
  overQuoteToleranceBasisPoints: 500,
  overQuoteTolerancePence: 5000,
  duplicateWindowDays: 30,
  payableTermsDays: 30,
  financeInboxAddress: null,
  vatNumber: null,
  vatEnabled: false,
  vatRateBasisPoints: 2000,
  receivableTermsDays: 30,
  currency: "GBP",
};

interface FinanceSettingsRow {
  over_quote_tolerance_bp?: number | string | null;
  over_quote_tolerance_pence?: number | string | null;
  duplicate_window_days?: number | string | null;
  payable_terms_days?: number | string | null;
  finance_inbox_address?: string | null;
}

/**
 * The Module 5 settings for one workspace, with the row created if absent.
 *
 * `readBillingSettings` is called first and its result is used for the columns
 * the drizzle model DOES carry, because it is the only thing allowed to create
 * the row and re-implementing that here would be a second lazy creator racing
 * the first. The raw read then adds the eleven it does not.
 */
export async function readFinanceSettings(
  db: Database,
  organisationId: string,
): Promise<FinanceSettings & { billing: BillingSettingsRow }> {
  const billing = await readBillingSettings(db, organisationId);
  const row = await db.get<FinanceSettingsRow>(sql`
    select over_quote_tolerance_bp,
           over_quote_tolerance_pence,
           duplicate_window_days,
           payable_terms_days,
           finance_inbox_address
      from billing_settings
     where organisation_id = ${organisationId}
     limit 1
  `);

  return {
    billing,
    overQuoteToleranceBasisPoints: wholeNumber(
      row?.over_quote_tolerance_bp,
      FINANCE_SETTING_DEFAULTS.overQuoteToleranceBasisPoints,
    ),
    overQuoteTolerancePence: wholeNumber(
      row?.over_quote_tolerance_pence,
      FINANCE_SETTING_DEFAULTS.overQuoteTolerancePence,
    ),
    duplicateWindowDays: wholeNumber(
      row?.duplicate_window_days,
      FINANCE_SETTING_DEFAULTS.duplicateWindowDays,
    ),
    payableTermsDays: wholeNumber(row?.payable_terms_days, FINANCE_SETTING_DEFAULTS.payableTermsDays),
    financeInboxAddress: row?.finance_inbox_address ?? null,
    vatNumber: billing.vatNumber ?? null,
    vatEnabled: Boolean(billing.vatEnabled),
    vatRateBasisPoints: billing.vatRateBasisPoints,
    receivableTermsDays: billing.paymentTermsDays,
    currency: billing.currency,
  };
}

/**
 * A whole number from a column that may arrive as a string.
 *
 * Postgres returns `bigint` and `numeric` as strings through node-pg, and these
 * columns are `INTEGER` in SQLite but reach the shim as whatever the driver
 * decided. Coercing here rather than trusting the type is the difference
 * between a tolerance of 500 and a tolerance of `"500"`, which compares
 * `false` against every number it is measured with.
 */
function wholeNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}
