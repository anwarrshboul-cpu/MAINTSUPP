/**
 * The contractor roster, read WITHIN ONE REGISTER — W2.
 *
 * ── WHY THIS MODULE EXISTS AND WHAT IT DELIBERATELY DOES NOT HOLD ─────────
 *
 * `app/api/workspace/route.ts` owns contractor WRITES, and it owns them
 * completely: ten refusal guards (`contractorActiveRefusal`,
 * `contractorEmailRefusal`, `contractorRateRefusal`, `contractorCostRefusal`,
 * `contractorPostcodeRefusal`, `contractorExpiryRefusal`,
 * `contractorCertificationsRefusal`, `contractorAvailabilityRefusal`,
 * `contractorPaymentTermsRefusal`, `contractorNameConflict`), the trade folding
 * in `contractorTradeValues`, the pence coercion in `contractorCostSet` and the
 * certification writer. That is one implementation of what a contractor row may
 * contain, and its own comments explain at length why the create and the edit
 * must never disagree about it.
 *
 * Copying those here so a second endpoint could write contractors would create
 * exactly the asymmetry those comments are written against — two answers to
 * "is 2027-13-45 a date", drifting the first time either is edited. So this
 * module holds the READS and the one predicate the write path needs to become
 * scope-aware, and the write verbs stay where they are and take a scope
 * argument. One implementation, told which register it is working in.
 *
 * ── WHY THE READ NEEDED A NEW HOME AT ALL ─────────────────────────────────
 *
 * `GET /api/workspace` is a single unparameterised snapshot — sites, units,
 * compliance, contractors, planned work, team, settings and activity in one
 * response — read by `portal-app.tsx` and by the compliance tracker. Adding a
 * register parameter to it would change what every one of those consumers
 * receives, for a scope only the Contractors screen can act on. So the scoped
 * read is a separate endpoint (`GET /api/contractors`) built on this module,
 * and the snapshot keeps meaning what it has always meant: the workspace's own
 * canonical registers.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { contractors } from "../../db/schema";
import {
  CANONICAL_REGISTER,
  registerScopeFilter,
  type RegisterScope,
} from "./register-scope";

type Database = Awaited<ReturnType<typeof getDb>>;

export type ContractorRow = typeof contractors.$inferSelect;

/**
 * Every contractor in ONE register, ordered as the register draws them.
 *
 * DEFAULT-DENY BY OMISSION, the same contract every scoped function in this
 * codebase carries: leaving `scope` out selects the canonical roster
 * (`board_id IS NULL`) and never every register. So the workspace snapshot,
 * which calls nothing here yet, and any future caller that forgets the argument
 * both get the roster that existed before instances did.
 *
 * `includeInactive` is a presentation choice made after the fact; the scope is
 * in the SQL, because which register we are looking at is not a question that
 * may be answered once the rows are already in memory.
 */
export async function listContractors(
  db: Database,
  organisationId: string,
  options: { includeInactive?: boolean } = {},
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<ContractorRow[]> {
  const rows = await db
    .select()
    .from(contractors)
    .where(
      and(
        eq(contractors.organisationId, organisationId),
        registerScopeFilter(contractors.boardId, scope),
      ),
    )
    .orderBy(asc(contractors.name));
  return options.includeInactive ? rows : rows.filter((row) => row.active);
}

/**
 * Every contractor in SEVERAL NAMED REGISTERS — the management surface only.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 *
 * "Manage dashboard data → Contractors" is an INVENTORY of what the
 * organisation holds, not a view of one register, and it was showing the
 * canonical roster alone: on the live Preview that meant three contractors
 * listed and two — created inside a custom Contractors section — missing
 * entirely, with nothing on screen to say anything was missing. Aggregating
 * here is what closes that, and it aggregates registers THIS ORGANISATION OWNS
 * rather than widening the query, which is a different and much worse thing.
 *
 * ── WHY IT IS A SEPARATE FUNCTION FROM `listContractors` ──────────────────
 *
 * `listContractors` defaults its scope to `CANONICAL_REGISTER`, and that
 * default is the model's default-deny — omission means the workspace's own
 * roster, never every roster. Widening its parameter would leave the default in
 * place but stop it being provable: `tests/w2-scope-model.test.mjs` reads the
 * literal declaration to hold it there. So the plural read has NO default and
 * the registers must be named, which is the same rule said the other way round.
 *
 * ── ONE QUERY ─────────────────────────────────────────────────────────────
 *
 * The scopes become one `IS NULL OR IN (…)` predicate in `registerScopeFilter`.
 * A per-section loop would be an N+1 on a screen the owner opens constantly,
 * and fetching every contractor in the organisation and sorting them out in
 * React is the fetch-all-then-filter the owner ruled out by name — it would
 * also return rows belonging to registers no live section resolves to.
 */
export async function listContractorsInRegisters(
  db: Database,
  organisationId: string,
  scopes: RegisterScope[],
  options: { includeInactive?: boolean } = {},
): Promise<ContractorRow[]> {
  const rows = await db
    .select()
    .from(contractors)
    .where(
      and(
        eq(contractors.organisationId, organisationId),
        registerScopeFilter(contractors.boardId, scopes),
      ),
    )
    .orderBy(asc(contractors.name));
  return options.includeInactive ? rows : rows.filter((row) => row.active);
}

/**
 * One contractor, BY ID AND BY REGISTER.
 *
 * The scope is in the predicate even though an id is unique, for the reason
 * `getSite` gives: this is what a route uses to decide whether a caller may
 * read or edit a row, and without it an id belonging to an instance would be
 * reachable through the canonical screen by anyone who had seen it once. An id
 * is an address, not a credential.
 */
export async function getContractor(
  db: Database,
  organisationId: string,
  id: string,
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<ContractorRow | null> {
  const [row] = await db
    .select()
    .from(contractors)
    .where(
      and(
        eq(contractors.id, id),
        eq(contractors.organisationId, organisationId),
        registerScopeFilter(contractors.boardId, scope),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether another contractor IN THIS REGISTER already answers to this name.
 *
 * ── WHY THE ANSWER MUST BE PER REGISTER ───────────────────────────────────
 *
 * `contractorNameConflict` in the workspace route refuses a duplicate name
 * because `resolveContractorLink` attributes a job's free-text contractor to a
 * row by name, and two rows carrying one name make that attribution impossible
 * — the register answers `ambiguous` and links neither.
 *
 * That reasoning is entirely about ONE roster. Once `resolveContractorLink`
 * searches within a register, a name held in a different register cannot make
 * anything ambiguous, because the two rows never appear in the same result set.
 * Refusing across registers would therefore forbid something that is now safe,
 * and forbid it for a reason that had stopped being true — an instance created
 * for a subcontractor network could not hold "Apex Electrical" because the
 * canonical roster does.
 *
 * Returns the conflicting id, or null. The refusal Response is built by the
 * caller, so this module stays free of HTTP and can be called from the write
 * path and from a test alike.
 */
export async function contractorNameHolder(
  db: Database,
  organisationId: string,
  name: string,
  selfId: string | null,
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<string | null> {
  const text = typeof name === "string" ? name.trim() : "";
  if (!text) return null;
  const rows = await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(
      and(
        eq(contractors.organisationId, organisationId),
        registerScopeFilter(contractors.boardId, scope),
        /* Lowered and trimmed by the DATABASE on both sides, exactly as
           `resolveContractorLink` does it: `String.prototype.toLowerCase` and
           SQL `lower()` disagree on non-ASCII names, and a register that
           refuses a duplicate on one dialect and accepts it on the other is
           worse than one that does neither. `lower` and `trim` are spelled
           identically in SQLite and Postgres. */
        sql`lower(trim(${contractors.name})) = lower(trim(${text}))`,
      ),
    )
    .limit(2);
  const other = rows.find((row) => row.id !== selfId);
  return other?.id ?? null;
}
