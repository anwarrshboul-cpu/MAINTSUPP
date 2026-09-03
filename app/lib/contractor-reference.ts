/**
 * The one place a contractor NAME becomes a contractor REFERENCE.
 *
 * `maintenance_requests` carries both: `contractor`, the free text a person
 * typed or monday exported, and `contractor_id`, the foreign key added by Batch
 * 1B (`db/init.ts`). The text is the historical record of who was named on the
 * job. The id is a live reference — and until this module existed, nothing in
 * the running application ever wrote one.
 *
 * Two writers set `contractor_id`, and neither of them runs while a person is
 * using the product: the boot backfill in `db/init.ts`, memoised once per
 * isolate by `ensureDatabase()`, and `scripts/import-d1.mjs`. So assigning a
 * contractor through the UI stored a name and left the reference NULL, and the
 * contractor register — which tallies a contractor's jobs by matching that name
 * — silently dropped every job the moment the contractor was RENAMED. Measured:
 * a QA contractor with one job read `assigned: 1, urgent: 1, spend: 250` before
 * a rename and `0, 0, 0` after it, with the row's `contractor_id` still pointing
 * straight at the renamed contractor.
 *
 * ── The rule, and where it comes from ──────────────────────────────────────
 *
 * This is NOT a new policy. `db/init.ts:207-231` already states the product's
 * canonical resolution rule, and this module is that same rule moved onto the
 * write path so it applies to a job created a second ago as well as one
 * imported last year:
 *
 *   - organisation-scoped — the contractor must belong to the JOB's tenant;
 *   - exact `lower(trim(...))` equality on both sides, in SQL, never in JS;
 *   - guarded by "exactly one match", so an ambiguous register links nothing.
 *
 * No fuzzy matching, no substrings, no closest name, no "first contractor
 * found". "Saed" is probably "Saed Electrical" and probably is not good enough
 * to put a company's name against an invoice. Nothing here CREATES a
 * contractor: a name the register does not know stays text and nothing more.
 *
 * ── Why the id is RECOMPUTED rather than patched ───────────────────────────
 *
 * When `contractor` is part of a write, `contractor_id` is derived from the
 * text being written — every time, in one branch, with no exceptions. Unique
 * match wins; no match and ambiguous both clear it.
 *
 * The alternative — leaving a previous id in place when the new text resolves
 * to nothing — keeps a reference that contradicts the text beside it. Once the
 * register reads the id (see the tally), a stale one means changing a job's
 * contractor to somebody else leaves it counted against the previous
 * contractor for ever, invisibly. That is a worse failure than the undercount
 * it would be replacing, and it is not what this codebase does elsewhere: the
 * column is declared `ON DELETE SET NULL` (`db/init.ts:186`) precisely because
 * a reference that can no longer be honoured is dropped, not kept.
 *
 * `active` is deliberately NOT part of the predicate, exactly as in the
 * backfill. Deactivating a contractor must not detach the jobs they did.
 *
 * A write that does not mention `contractor` at all never reaches this module,
 * so an unrelated PATCH cannot disturb a link — see the callers.
 */

import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { contractors } from "../../db/schema";
/*
 * W2 — which REGISTER the roster being searched is. See `register-scope.ts`
 * for the model; the two paragraphs below are why this module needed it.
 */
import {
  CANONICAL_REGISTER,
  registerScopeFilter,
  type RegisterScope,
} from "./register-scope";

type ContractorDatabase = Awaited<ReturnType<typeof getDb>>;

/**
 * Why a job holds the reference it holds.
 *
 * Carried out with the id so a caller can say what happened — an ambiguous
 * register and an unknown name are different facts about the workspace and a
 * person is entitled to be told which one they hit.
 */
export type ContractorLinkReason =
  /** Exactly one contractor in this organisation carries that name. */
  | "matched"
  /** The text was blank or null — the caller is clearing the assignment. */
  | "cleared"
  /** Nobody in this organisation carries that name. Text kept, no reference. */
  | "unknown"
  /** Two or more carry it. Linking either would be a guess, so neither is linked. */
  | "ambiguous";

export type ContractorLink = {
  contractorId: string | null;
  reason: ContractorLinkReason;
  /** How many contractors in this organisation carry the name. Capped at 2. */
  matches: number;
};

/**
 * The contractor id a piece of contractor text resolves to in one organisation.
 *
 * `limit(2)` rather than a `count(*)`: one round trip answers both "is there a
 * match" and "is it unique", and it is the same question the backfill asks with
 * `(SELECT count(*) ...) = 1`. Two rows is as much as any caller needs to know.
 *
 * Both sides of the comparison are lowered and trimmed by the DATABASE, not by
 * JavaScript. `String.prototype.toLowerCase` and SQL `lower()` disagree on
 * non-ASCII names, and a register that links a contractor on one dialect and
 * not the other is worse than one that links neither. `lower` and `trim` are
 * spelled identically in SQLite and Postgres, so this one statement serves
 * both — the constraint `db/sqlite-to-postgres.ts` puts on every query here.
 */
export async function resolveContractorLink(
  db: ContractorDatabase,
  orgId: string,
  contractor: unknown,
  /**
   * WHICH ROSTER IS BEING SEARCHED — W2, and the reason this argument exists.
   *
   * Before it, the predicate was organisation-wide. So the moment a section
   * created from the Contractors template held a row under a name the canonical
   * roster already used, `rows.length` became 2 for every canonical job naming
   * that contractor, the answer flipped to `ambiguous`, and every one of those
   * jobs silently stopped linking — accepted W5/W6 behaviour regressed by
   * somebody adding a ROW, with no code change and no error anywhere. That is
   * the blocker `SECTION_TEMPLATES` names in the Contractors entry.
   *
   * The default is `CANONICAL_REGISTER`, and that is the whole fix: a job
   * resolves against the workspace's own roster unless a caller explicitly says
   * otherwise, so an instance's rows are invisible to it and the canonical
   * links are exactly what they were. An instance's contractors are reachable
   * only by naming that instance — see `resolveRegisterScope`.
   */
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<ContractorLink> {
  const text = typeof contractor === "string" ? contractor.trim() : "";
  if (!text) return { contractorId: null, reason: "cleared", matches: 0 };

  const rows = await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(
      and(
        eq(contractors.organisationId, orgId),
        registerScopeFilter(contractors.boardId, scope),
        sql`lower(trim(${contractors.name})) = lower(trim(${text}))`,
      ),
    )
    .limit(2);

  if (rows.length === 1) {
    return { contractorId: rows[0].id, reason: "matched", matches: 1 };
  }
  return {
    contractorId: null,
    reason: rows.length === 0 ? "unknown" : "ambiguous",
    matches: rows.length,
  };
}

/**
 * The `contractor_id` to write alongside a set of column values, or nothing.
 *
 * The guard is the whole point: `contractor_id` is only ever recomputed when
 * `contractor` is PART OF THIS WRITE. A PATCH that changes a job's priority
 * must leave the reference exactly as it found it, and a caller that spreads
 * the result of this function into its `set({...})` gets that for free —
 * an absent key is not an update.
 */
export async function contractorLinkValues(
  db: ContractorDatabase,
  orgId: string,
  values: { contractor?: string | null },
  /* The roster the job's own register draws from. Omitted means the canonical
     one, which is what every existing caller means and what a job on the job
     board must keep meaning. */
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<{ contractorId?: string | null; link?: ContractorLink }> {
  if (!("contractor" in values)) return {};
  const link = await resolveContractorLink(db, orgId, values.contractor, scope);
  return { contractorId: link.contractorId, link };
}
