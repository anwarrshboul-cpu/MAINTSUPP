/**
 * ONE INVOICE, SEVERAL JOBS, AND THE SUM THAT MUST COME OUT RIGHT.
 *
 * §4: "A contractor invoice covering four jobs at one site must split across
 * those jobs with a per-job allocation that sums to the invoice total. Enforce
 * the sum. Your August report already flags costs sitting on the first line of a
 * multi-task visit — this field is the fix for that."
 *
 * ── WHERE ENFORCEMENT ACTUALLY HAPPENS ─────────────────────────────────────
 *
 * Server-side, in three places, and never in the browser:
 *
 *   1. `allocationState` refuses to call an unbalanced set balanced. It is pure
 *      and lives in `./rules.ts` so the test suite can call it.
 *   2. `writeAllocations` below refuses to write one unless the caller passes
 *      `allowUnbalanced` — which only the draft-editing path does, because a
 *      person building a four-way split is unbalanced for as long as they are
 *      typing and refusing every keystroke would make the screen unusable.
 *   3. FINALISATION refuses outright. `app/api/finance/invoices/[id]/actions`
 *      will not finalise an invoice whose allocations do not sum, whatever was
 *      allowed while it was a draft. That is the guarantee §16 asks for: "the
 *      allocation is forced to sum to the invoice total".
 *
 * ── TRANSACTIONAL IN SPIRIT, NOT IN NAME ───────────────────────────────────
 *
 * `PUT`-ing a whole allocation set is a delete followed by inserts, and there
 * is no interactive transaction a route can hold across awaits on D1. So the
 * set is VALIDATED IN FULL before a single statement runs, and the statements
 * are then ordered so that the only way they can fail leaves an invoice with
 * too FEW allocations rather than too many — which does not sum, and which
 * finalisation therefore refuses. See `writeAllocations` for the whole
 * argument; it is the difference between a visible short split and a silently
 * doubled job cost in §8's margin roll-up.
 *
 * ── THE LEGACY MIRROR ──────────────────────────────────────────────────────
 *
 * `invoices.request_id` is NOT NULL and predates Module 5. `db/schema.ts` says
 * what it now means: "the invoice's PRIMARY job … maintained as a mirror of the
 * first allocation". Every write here maintains it, so a legacy reader joining
 * on that column still sees a real job, and `invoice_job_alloc` remains the one
 * table the finance module reconciles against.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../../../db";
import { invoiceJobAllocations, invoices } from "../../../db/schema";
import { selectInChunks } from "../sql-batching";
import { UNLINKED_JOB_ID } from "./model";
import { allocationState, type AllocationLike, type AllocationState } from "./rules";

type Database = Awaited<ReturnType<typeof getDb>>;

/* Pure, re-exported so callers reach it through the module that owns the
   subject — see the header of `./rules.ts` for why it lives there. */
export { allocationState, type AllocationLike, type AllocationState } from "./rules";

export interface AllocationRow {
  id: string;
  invoiceId: string;
  requestId: string;
  amountPence: number;
  note: string | null;
}

export interface AllocationInput {
  requestId: string;
  amountPence: number;
  note?: string | null;
}

/** Every allocation on one invoice, ordered by job so two reads never disagree. */
export async function listAllocations(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<AllocationRow[]> {
  const rows = await db
    .select()
    .from(invoiceJobAllocations)
    .where(
      and(
        eq(invoiceJobAllocations.organisationId, organisationId),
        eq(invoiceJobAllocations.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(invoiceJobAllocations.requestId));
  return rows.map(toRow);
}

/**
 * Allocations for many invoices at once, grouped by invoice.
 *
 * The batched twin of `listAllocations`, for the ledger list — one statement
 * per chunk of ninety ids rather than one per invoice. §8's margin roll-up
 * reads the same rows the other way round (by job), which is what
 * `invoice_job_alloc_job_idx` exists for.
 */
export async function listAllocationsForInvoices(
  db: Database,
  organisationId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, AllocationRow[]>> {
  const grouped = new Map<string, AllocationRow[]>();
  const ids = [...new Set(invoiceIds.filter(Boolean))];
  if (ids.length === 0) return grouped;

  const rows = await selectInChunks(ids, (chunk) =>
    db
      .select()
      .from(invoiceJobAllocations)
      .where(
        and(
          eq(invoiceJobAllocations.organisationId, organisationId),
          inArray(invoiceJobAllocations.invoiceId, chunk),
        ),
      ),
  );
  for (const raw of rows) {
    const row = toRow(raw);
    const bucket = grouped.get(row.invoiceId);
    if (bucket) bucket.push(row);
    else grouped.set(row.invoiceId, [row]);
  }
  return grouped;
}

export type WriteAllocationsResult =
  | { ok: true; state: AllocationState; rows: AllocationRow[] }
  | { ok: false; error: string; state: AllocationState };

export interface WriteAllocationsOptions {
  /**
   * Permit a set that does not sum yet.
   *
   * True only while an invoice is a DRAFT and somebody is still typing. Never
   * true on a finalisation path — see the header.
   */
  allowUnbalanced?: boolean;
}

/**
 * Replace an invoice's whole allocation set.
 *
 * WHOLE SET, not a patch, and that is the safer shape by some distance: a
 * per-row API makes "these four rows sum to the invoice" a property nothing
 * owns, and every partial edit is a moment where it is false. Sending the set
 * makes the sum checkable in one place, against one payload, before anything is
 * written.
 *
 * Refuses a duplicate job outright rather than letting the UNIQUE index catch
 * it: `invoice_job_alloc_once_idx` would surface as a bare 503 and the operator
 * would have no idea which of the four lines was the repeat.
 */
export async function writeAllocations(
  db: Database,
  organisationId: string,
  invoiceId: string,
  targetPence: number,
  entries: readonly AllocationInput[],
  options: WriteAllocationsOptions = {},
): Promise<WriteAllocationsResult> {
  const cleaned: AllocationLike[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const requestId = (entry.requestId ?? "").trim();
    if (!requestId) {
      return {
        ok: false,
        error: "Every allocation line has to name a job.",
        state: allocationState(targetPence, cleaned),
      };
    }
    if (seen.has(requestId)) {
      return {
        ok: false,
        error: `${requestId} appears twice. A job can take one share of an invoice, not two.`,
        state: allocationState(targetPence, cleaned),
      };
    }
    seen.add(requestId);
    cleaned.push({ requestId, amountPence: Math.trunc(entry.amountPence || 0) });
  }

  const state = allocationState(targetPence, cleaned);
  if (!state.balanced && !options.allowUnbalanced) {
    return { ok: false, error: unbalancedSentence(state), state };
  }

  const now = new Date().toISOString();

  /*
   * DELETE FIRST, THEN INSERT, and the order is the safety property.
   *
   * There is no interactive transaction a route can hold across awaits here —
   * D1 has none, and nothing else in `app/` uses drizzle's `batch`, so this
   * does not introduce it on a write path that has to work on two dialects.
   * What makes the sequence safe instead is the DIRECTION it fails in: an
   * insert that never happens leaves FEWER allocations than intended, the set
   * therefore does not sum, and finalisation refuses it. The operator sees a
   * split that is short and fixes it.
   *
   * The other order is the dangerous one. Inserting before deleting would
   * collide with `invoice_job_alloc_once_idx` on any job that appears in both
   * the old set and the new, and a failure between the two would leave an
   * invoice allocated TWICE — which sums to nothing sensible and, in §8's
   * margin roll-up, doubles a job's cost silently.
   */
  await db
    .delete(invoiceJobAllocations)
    .where(
      and(
        eq(invoiceJobAllocations.organisationId, organisationId),
        eq(invoiceJobAllocations.invoiceId, invoiceId),
      ),
    );
  for (const entry of entries) {
    await db.insert(invoiceJobAllocations).values({
      id: crypto.randomUUID(),
      organisationId,
      invoiceId,
      requestId: (entry.requestId ?? "").trim(),
      amountPence: Math.trunc(entry.amountPence || 0),
      note: entry.note?.trim() ? entry.note.trim().slice(0, 400) : null,
      createdAt: now,
    });
  }
  await mirrorPrimaryJob(db, organisationId, invoiceId, cleaned);

  return { ok: true, state, rows: await listAllocations(db, organisationId, invoiceId) };
}

/**
 * Keep `invoices.request_id` pointing at the invoice's first allocation.
 *
 * §14 puts every share in `invoice_job_alloc`, INCLUDING the primary one, so
 * this column is a mirror and never a second source of truth — nothing in this
 * module reads it back to work out what an invoice is allocated to.
 *
 * With no allocations left it falls back to the `UNLINKED_JOB_ID` sentinel
 * rather than to null, because the column is NOT NULL. See the note beside that
 * constant for why the sentinel is storable on both dialects.
 */
export async function mirrorPrimaryJob(
  db: Database,
  organisationId: string,
  invoiceId: string,
  allocations: readonly AllocationLike[],
): Promise<void> {
  const primary = allocations[0]?.requestId?.trim() || UNLINKED_JOB_ID;
  await db
    .update(invoices)
    .set({ requestId: primary, updatedAt: new Date().toISOString() })
    .where(and(eq(invoices.organisationId, organisationId), eq(invoices.id, invoiceId)));
}

/** The sentence an operator reads when the split does not sum. Names the gap. */
export function unbalancedSentence(state: AllocationState): string {
  const gap = Math.abs(state.difference);
  const direction = state.difference > 0 ? "more than" : "less than";
  return (
    `The job allocations come to ${pounds(state.totalPence)}, which is ${pounds(gap)} ${direction} `
    + `the invoice net of ${pounds(state.targetPence)}. Every penny has to land on a job.`
  );
}

function pounds(pence: number): string {
  const value = Math.trunc(pence || 0);
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? "-" : ""}£${Math.floor(absolute / 100).toLocaleString("en-GB")}.${String(
    absolute % 100,
  ).padStart(2, "0")}`;
}

function toRow(row: typeof invoiceJobAllocations.$inferSelect): AllocationRow {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    requestId: row.requestId,
    amountPence: row.amountPence,
    note: row.note ?? null,
  };
}
