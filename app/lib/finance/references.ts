/**
 * `QT-2026-001`, `AP-2026-001`, `AR-2026-001` — three gapless counters.
 *
 * ── THE TECHNIQUE IS `issueInvoiceNumber`'s, COPIED ON PURPOSE ─────────────
 *
 * `app/lib/billing/settings.ts` already allocates `MS-YYYY-NNN` correctly: read
 * the counter, UPDATE it only if it is still the value that was read, retry
 * when the update matches zero rows, give up after a bounded number of
 * attempts. That is a compare-and-swap, it is spelled identically in SQLite and
 * Postgres, and it is the only shape that cannot hand two documents one number
 * — a read-modify-write on a JSON blob cannot detect that somebody else moved
 * the counter in between.
 *
 * So the loop below is the same loop. Three counters rather than one because
 * three series must not share: `QT-`, `AP-` and `AR-` each get their own column
 * pair on `billing_settings`, exactly as `db/init.ts` says when it adds them.
 *
 * ── VOIDING NEVER WINDS A COUNTER BACK ─────────────────────────────────────
 *
 * There is no decrement in this file and there must not be one. The reasoning
 * is written out in full at the head of `app/lib/reporting/numbering.ts` and it
 * applies here without change: a counter that moves backwards re-issues a
 * reference a counterparty has already seen, and afterwards nobody can settle
 * which document was meant. A voided `AP-2026-004` stays spent and the sequence
 * has a hole in it; the hole is the evidence. "Gapless" means the counter issues
 * consecutive values, not that every value ends on a live row.
 *
 * ── WHY RAW SQL ────────────────────────────────────────────────────────────
 *
 * The six counter columns are added by `db/init.ts` with `addColumn` and are
 * not in the drizzle model. See the header of `./settings.ts`; the same
 * reasoning and the same precedent apply. The only `sql.raw` here is a column
 * name from `COUNTERS` below, which is a fixed internal map — no value from a
 * request ever reaches it.
 */

import { sql } from "drizzle-orm";
import type { getDb } from "../../../db";
import { readBillingSettings } from "../billing/settings";
import { formatDocumentNumber, nextSequenceForYear } from "../reporting/numbering";
import type { InvoiceDirection } from "./model";

type Database = Awaited<ReturnType<typeof getDb>>;

/** The three series Module 5 adds, beside Module 4's `MS-`. */
export type FinanceSeries = "quote" | "payable" | "receivable";

interface CounterDefinition {
  /** The prefix on the rendered reference. §3 and §4 name all three. */
  prefix: string;
  /** `billing_settings` column holding the sequence. Fixed, never from a request. */
  sequenceColumn: string;
  /** `billing_settings` column holding the year the sequence counts within. */
  yearColumn: string;
}

const COUNTERS: Record<FinanceSeries, CounterDefinition> = {
  quote: { prefix: "QT", sequenceColumn: "quote_sequence", yearColumn: "quote_sequence_year" },
  payable: { prefix: "AP", sequenceColumn: "payable_sequence", yearColumn: "payable_sequence_year" },
  receivable: {
    prefix: "AR",
    sequenceColumn: "receivable_sequence",
    yearColumn: "receivable_sequence_year",
  },
};

/** The series an invoice of this direction takes its internal reference from. §4. */
export function seriesForDirection(direction: InvoiceDirection): FinanceSeries {
  return direction === "payable" ? "payable" : "receivable";
}

interface CounterRow {
  seq?: number | string | null;
  yr?: number | string | null;
}

/**
 * Advance one counter and return the reference it issued.
 *
 * Throws after `attempts` rather than looping forever: a counter that cannot be
 * advanced is a fault to report, and every caller already answers a contended
 * write with a refusal rather than a silent retry.
 */
export async function issueFinanceReference(
  db: Database,
  organisationId: string,
  series: FinanceSeries,
  year: number,
  attempts = 5,
): Promise<string> {
  const counter = COUNTERS[series];
  /* Creates the row on first use. This is the ONLY lazy creator — duplicating
     it here would be two of them racing for the same UNIQUE index. */
  await readBillingSettings(db, organisationId);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await db.get<CounterRow>(sql`
      select ${sql.raw(counter.sequenceColumn)} as seq,
             ${sql.raw(counter.yearColumn)} as yr
        from billing_settings
       where organisation_id = ${organisationId}
       limit 1
    `);
    const current = wholeNumber(row?.seq, 0);
    const storedYear = row?.yr === null || row?.yr === undefined ? year : wholeNumber(row.yr, year);

    /*
     * `nextSequenceForYear` restarts at 001 when the year moves FORWARD and
     * refuses to restart when it moves backwards — a backdated document, or a
     * container whose clock is wrong, must not walk back through references
     * that have already been issued. Shared with `MS-` rather than
     * re-implemented, because there is exactly one correct answer to "what is
     * the next number" and it should have one home.
     */
    const next = nextSequenceForYear(storedYear, current, year);

    const swapped = await db.all<{ id: string }>(sql`
      update billing_settings
         set ${sql.raw(counter.sequenceColumn)} = ${next.sequence},
             ${sql.raw(counter.yearColumn)} = ${next.year},
             updated_at = ${new Date().toISOString()}
       where organisation_id = ${organisationId}
         and ${sql.raw(counter.sequenceColumn)} = ${current}
      returning id
    `);
    if (swapped.length > 0) return formatDocumentNumber(counter.prefix, next.year, next.sequence);
  }

  throw new Error(
    `A ${COUNTERS[series].prefix}- reference could not be issued; the counter is contended.`,
  );
}

/** `QT-2026-001`. */
export function issueQuoteReference(db: Database, organisationId: string, year: number) {
  return issueFinanceReference(db, organisationId, "quote", year);
}

/** `AP-2026-001` or `AR-2026-001`, chosen by direction. §4. */
export function issueInvoiceReference(
  db: Database,
  organisationId: string,
  direction: InvoiceDirection,
  year: number,
) {
  return issueFinanceReference(db, organisationId, seriesForDirection(direction), year);
}

/**
 * A CREDIT NOTE'S REFERENCE, DERIVED RATHER THAN COUNTED.
 *
 * §6 gives a credit note "their own reference" and `db/init.ts` adds no fourth
 * counter for one — and this module is not allowed to add a column. Deriving it
 * from the invoice it credits is better than inventing a counter that has
 * nowhere to live: `CN-AP-2026-004-1` says at a glance which invoice was
 * credited and in what order, it is unique by construction because the ordinal
 * counts the credit notes already against THAT invoice, and it needs no shared
 * state and therefore cannot collide across workspaces.
 *
 * It is NOT gapless, and it does not need to be: gaplessness is a property
 * demanded of a number a counterparty sees on a sequence of documents, and a
 * credit note is identified by the invoice it belongs to.
 *
 * `existingCount` is the number of credit notes already recorded against the
 * invoice; the caller counts them inside the same request that writes the new
 * row. Two concurrent credit notes on one invoice could therefore both compute
 * ordinal 2 — there is no unique index on `credit_notes.reference` to stop it,
 * so this returns a LABEL and not an identity. The row's `id` is the identity.
 */
export function creditNoteReference(invoiceRef: string | null, existingCount: number): string {
  const base = (invoiceRef ?? "").trim() || "INV";
  return `CN-${base}-${Math.max(1, Math.trunc(existingCount) + 1)}`;
}

function wholeNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}
