/**
 * `billing_settings` — one row per organisation, created on first read.
 *
 * ── WHY THE ROW IS CREATED LAZILY RATHER THAN SEEDED ───────────────────────
 *
 * `db/init.ts` runs on the boot path of EVERY request. Seeding a row there for
 * every organisation would put a write on the hot path of every page load in
 * the product to support one screen most workspaces never open. Creating it the
 * first time the billing settings are read costs one insert, once, to the
 * caller who actually wants it.
 *
 * The insert is `INSERT ... ON CONFLICT DO NOTHING`-shaped by way of the UNIQUE
 * index on `organisation_id` and a re-read afterwards: two requests racing to
 * open the settings screen produce one row, and whichever loses the race reads
 * the winner's row rather than failing.
 *
 * ── WHY THE INVOICE NUMBER LIVES HERE AND NOT IN A JSON BLOB ───────────────
 *
 * `invoice_sequence` is a counter that must never issue the same value twice.
 * `workspace_settings` stores its contents as a JSON document, which is read,
 * mutated in memory and written back — a read-modify-write with no way to
 * detect that somebody else moved it in between. A column can be updated
 * CONDITIONALLY, which is what `issueInvoiceNumber` below does: it advances the
 * counter only if it is still the value that was read, and retries if it is
 * not. That is a compare-and-swap, it is spelled identically in SQLite and
 * Postgres, and it is the reason this table exists separately at all.
 */

import { and, eq } from "drizzle-orm";
import type { getDb } from "../../../db";
import { billingSettings } from "../../../db/schema";
import { formatDocumentNumber, nextSequenceForYear } from "../reporting/numbering";
import type { BillingConfiguration } from "../reporting/inputs";

type Database = Awaited<ReturnType<typeof getDb>>;

export type BillingSettingsRow = typeof billingSettings.$inferSelect;

/**
 * The row for an organisation, creating it on first read.
 *
 * Never returns null. A workspace with no billing settings has DEFAULTS, and
 * the defaults are the column defaults — no VAT, 30-day terms, no default fee.
 * "No default fee" is deliberately null rather than zero, so the fee resolver
 * reports a site with nothing configured instead of charging it nothing.
 */
export async function readBillingSettings(
  db: Database,
  organisationId: string,
): Promise<BillingSettingsRow> {
  const existing = await db
    .select()
    .from(billingSettings)
    .where(eq(billingSettings.organisationId, organisationId))
    .limit(1);
  if (existing[0]) return existing[0];

  const now = new Date().toISOString();
  try {
    await db.insert(billingSettings).values({
      id: crypto.randomUUID(),
      organisationId,
      updatedAt: now,
    });
  } catch {
    /* The UNIQUE index refused it, which means somebody else created the row
       between the select and the insert. That is the outcome we wanted; fall
       through and read theirs. Swallowed deliberately — see the header. */
  }

  const created = await db
    .select()
    .from(billingSettings)
    .where(eq(billingSettings.organisationId, organisationId))
    .limit(1);
  if (created[0]) return created[0];

  throw new Error("Billing settings could not be created for this organisation.");
}

/** The settings, in the shape the pure computation takes. */
export function billingConfiguration(row: BillingSettingsRow): BillingConfiguration {
  return {
    currency: row.currency,
    defaultSiteFeePence: row.defaultSiteFeePence ?? null,
    vatEnabled: Boolean(row.vatEnabled),
    vatRateBasisPoints: row.vatRateBasisPoints,
    vatNumber: row.vatNumber ?? null,
    paymentTermsDays: row.paymentTermsDays,
    paymentTermsNote: row.paymentTermsNote ?? null,
    billingAddress: row.billingAddress ?? null,
    invoiceNumberPrefix: row.invoiceNumberPrefix,
    proRataEnabled: Boolean(row.proRataEnabled),
  };
}

export type BillingSettingsPatch = Partial<{
  currency: string;
  defaultSiteFeePence: number | null;
  vatEnabled: boolean;
  vatRateBasisPoints: number;
  vatNumber: string | null;
  paymentTermsDays: number;
  paymentTermsNote: string | null;
  billingAddress: string | null;
  invoiceNumberPrefix: string;
  proRataEnabled: boolean;
}>;

/**
 * Write a patch. `invoice_sequence` is deliberately NOT patchable — it is the
 * counter, and letting a settings form reset it is how two invoices end up with
 * one number.
 */
export async function writeBillingSettings(
  db: Database,
  organisationId: string,
  patch: BillingSettingsPatch,
  actorEmail: string | null,
): Promise<BillingSettingsRow> {
  await readBillingSettings(db, organisationId);
  await db
    .update(billingSettings)
    .set({ ...patch, updatedBy: actorEmail, updatedAt: new Date().toISOString() })
    .where(eq(billingSettings.organisationId, organisationId));
  return readBillingSettings(db, organisationId);
}

/**
 * `MS-2026-042`. Prefix from the settings, YEAR, sequence zero-padded.
 *
 * The format changed from `MS-00042` when Module 4 §5.1 asked for
 * `MS-YYYY-NNN`. The allocator below did NOT change: it was already gapless and
 * already compare-and-swap, and a second counter would have been the surest way
 * to hand two documents one number. Only the rendering moved, into
 * `app/lib/reporting/numbering.ts`, which is pure and tested at its edges.
 */
export function formatInvoiceNumber(prefix: string, year: number, sequence: number): string {
  return formatDocumentNumber(prefix, year, sequence);
}

/**
 * Advance the counter and return the number it issued.
 *
 * COMPARE AND SWAP, retried. The update matches on the sequence that was read,
 * so a concurrent finalisation cannot hand two documents the same number: one
 * of the two updates matches zero rows and that caller loops and takes the next
 * value. The partial UNIQUE index on `(organisation_id, invoice_number)` is the
 * backstop — this is the thing that stops the collision happening, and the
 * index is the thing that proves it did not.
 *
 * Throws after a bounded number of attempts rather than looping forever: a
 * counter that cannot be advanced is a fault to report, and `blockers.ts`
 * carries `invoice.number_unavailable` for exactly that answer.
 */
export async function issueInvoiceNumber(
  db: Database,
  organisationId: string,
  year: number,
  attempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const settings = await readBillingSettings(db, organisationId);
    const current = settings.invoiceSequence;
    /*
     * The year decides whether this is the next number or the first of a new
     * one. `nextSequenceForYear` restarts at 001 when the year moves FORWARD
     * and refuses to restart when it moves backwards — a backdated document,
     * or a container whose clock is wrong, must not walk back through numbers
     * that have already been issued.
     */
    const nextNumber = nextSequenceForYear(
      settings.invoiceSequenceYear ?? year,
      current,
      year,
    );
    const updated = await db
      .update(billingSettings)
      .set({
        invoiceSequence: nextNumber.sequence,
        invoiceSequenceYear: nextNumber.year,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(billingSettings.organisationId, organisationId),
          eq(billingSettings.invoiceSequence, current),
        ),
      )
      .returning({ sequence: billingSettings.invoiceSequence });
    if (updated.length > 0) {
      return formatInvoiceNumber(
        settings.invoiceNumberPrefix,
        nextNumber.year,
        nextNumber.sequence,
      );
    }
  }
  throw new Error("An invoice number could not be issued; the counter is contended.");
}
