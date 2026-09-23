/**
 * THE WRITE HALF OF Contractors → Resolve names — one transaction per action.
 *
 * `app/api/overview/contractor-aliases/route.ts` decides WHAT an action does:
 * it validates, re-reads the contractor in this tenant, works out the target
 * jobs and answers a preview. This module does the writing, and does all of it
 * in ONE `batch()`, so an action either happens completely or not at all.
 *
 * ── WHY, MEASURED ────────────────────────────────────────────────────────
 *
 * Dashboard §3.6 and §9 item 20: linking "backfills `contractor_id` on matching
 * jobs in one transaction". It did not. A link ran up to five separate awaited
 * statements — the new contractor, the alias, the backfill in chunks of 80, the
 * activity row, the audit row — so a failure part-way (a pooler refusal, a
 * timeout, an instance recycled mid-request) left an alias with half its jobs
 * attributed, or attributed jobs with no activity row, and the activity row is
 * the REVERSAL RECORD: `unlink` reads its `jobIds` to undo a link exactly. A
 * half-applied link could therefore not be cleanly reversed either.
 *
 * `batch()` is a transaction on both databases: Miniflare D1 runs it as one,
 * and `db/node-pg-d1.ts` runs it as BEGIN … COMMIT on one reserved connection
 * (which is also what Supavisor's transaction mode requires). The audit row is
 * written AFTER the commit by `recordAudit`, the product-wide helper that never
 * throws — an audit trail describes an action that happened; it is not part of
 * the action.
 *
 * ── THE COUNT IS READ BEFORE, NOT RETURNED AFTER ─────────────────────────
 *
 * The activity row states how many jobs the action changed, and it is INSIDE
 * the transaction, so it has to be written before the UPDATEs report anything.
 * So the ids the guarded UPDATE will change are read first, with the same
 * guard, and the UPDATE is then applied to exactly those ids — still guarded,
 * so a job another writer attributed in the meantime is left alone rather than
 * overwritten. The row can only ever overstate by such a race, never write a
 * job the reversal does not know about.
 *
 * Pure of `tenant-db` and of any request: it takes the scoped Drizzle handle
 * and the organisation, so `tests/contractor-alias-transaction.test.mjs` runs
 * it against real SQLite and makes a statement fail half-way.
 */

import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { getDb } from "../../db";
import {
  activityLog,
  contractorNameAliases,
  contractors,
  maintenanceRequests,
} from "../../db/schema";
import { chunkIds } from "./sql-batching";

type Db = Awaited<ReturnType<typeof getDb>>;

/** What the writes need of a `ScopedDatabase`, and nothing more. */
export type AliasWriteScope = { db: Db; orgId: string };

/**
 * `contractor_id`, written in chunks.
 *
 * D1 binds one variable per element of an `IN` list and refuses a statement past
 * roughly a hundred of them (`app/lib/sql-batching.ts`). The two set values and
 * the organisation take three of the budget, so the ids get 80 and not 90 —
 * `chunkIds`'s default is sized for a bare `IN` list and this statement is not
 * one. Every chunk is a statement in the SAME batch, so the chunking no longer
 * splits the transaction.
 */
const BACKFILL_CHUNK = 80;

type Guard = { onlyNull?: boolean; onlyContractorId?: string };

function jobClauses(scope: AliasWriteScope, chunk: string[], guard: Guard): SQL[] {
  const clauses = [
    eq(maintenanceRequests.organisationId, scope.orgId),
    inArray(maintenanceRequests.id, chunk),
  ];
  if (guard.onlyNull) clauses.push(isNull(maintenanceRequests.contractorId));
  if (guard.onlyContractorId) {
    clauses.push(eq(maintenanceRequests.contractorId, guard.onlyContractorId));
  }
  return clauses as SQL[];
}

/** The ids among `ids` that the guarded UPDATE would change, read in this tenant. */
async function idsPassingGuard(scope: AliasWriteScope, ids: string[], guard: Guard): Promise<string[]> {
  const found: string[] = [];
  for (const chunk of chunkIds(ids, BACKFILL_CHUNK)) {
    const rows = await scope.db
      .select({ id: maintenanceRequests.id })
      .from(maintenanceRequests)
      .where(and(...jobClauses(scope, chunk, guard)));
    for (const row of rows) found.push(row.id);
  }
  return found;
}

/* `updated_at` is deliberately not set — see the route's header: "Held for"
   falls back to it, and fixing who did the work must not restate when it moved. */
function contractorIdStatements(
  scope: AliasWriteScope,
  ids: string[],
  contractorId: string | null,
  guard: Guard,
) {
  return chunkIds(ids, BACKFILL_CHUNK).map((chunk) =>
    scope.db
      .update(maintenanceRequests)
      .set({ contractorId })
      .where(and(...jobClauses(scope, chunk, guard))),
  );
}

export type AliasActivity = {
  entityType: string;
  /** `name:<normalised>` — the key the route reads the reversal record back by. */
  entityId: string;
  action: string;
  actor: string;
  at: string;
};

function activityStatement(scope: AliasWriteScope, activity: AliasActivity, detail: Record<string, unknown>) {
  return scope.db.insert(activityLog).values({
    id: crypto.randomUUID(),
    organisationId: scope.orgId,
    entityType: activity.entityType,
    entityId: activity.entityId,
    action: activity.action,
    actorEmail: activity.actor,
    detail: JSON.stringify(detail),
    createdAt: activity.at,
  });
}

async function commit(scope: AliasWriteScope, statements: BatchItem<"sqlite">[]) {
  if (statements.length === 0) return;
  await scope.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

export type LinkPlan = {
  /** The normalised string — `contractor_name_aliases.normalised`. */
  key: string;
  /** The string as the jobs spell it. */
  name: string;
  contractorId: string;
  contractorName: string;
  /** Set for `create`: the contractor record to insert first, in the same transaction. */
  createContractor: { name: string } | null;
  /** The alias row a re-link updates in place, if one exists. */
  existingAliasId: string | null;
  /** The jobs carrying this string; only those with no `contractor_id` are written. */
  targetIds: string[];
  activity: AliasActivity;
};

/**
 * `link` and `create`, applied: contractor (for create), alias, backfill and
 * activity row, committed together. Returns the jobs it attributed.
 */
export async function applyAliasLink(scope: AliasWriteScope, plan: LinkPlan): Promise<{ written: number }> {
  const eligible = await idsPassingGuard(scope, plan.targetIds, { onlyNull: true });
  const statements: BatchItem<"sqlite">[] = [];

  if (plan.createContractor) {
    statements.push(
      scope.db.insert(contractors).values({
        id: plan.contractorId,
        organisationId: scope.orgId,
        name: plan.createContractor.name,
        active: true,
        createdAt: plan.activity.at,
        updatedAt: plan.activity.at,
      }),
    );
  }

  /* ONE JOB-SIDE NAME RESOLVES TO AT MOST ONE RECORD, EVER — the UNIQUE index
     on (organisation, normalised) says so, and a re-link updates in place. */
  statements.push(
    plan.existingAliasId
      ? scope.db
          .update(contractorNameAliases)
          .set({ contractorId: plan.contractorId, alias: plan.name, createdBy: plan.activity.actor, createdAt: plan.activity.at })
          .where(
            and(
              eq(contractorNameAliases.organisationId, scope.orgId),
              eq(contractorNameAliases.id, plan.existingAliasId),
            ),
          )
      : scope.db.insert(contractorNameAliases).values({
          id: crypto.randomUUID(),
          organisationId: scope.orgId,
          contractorId: plan.contractorId,
          alias: plan.name,
          normalised: plan.key,
          createdAt: plan.activity.at,
          createdBy: plan.activity.actor,
        }),
  );

  statements.push(...contractorIdStatements(scope, eligible, plan.contractorId, { onlyNull: true }));

  /* The ids are the reversal record — see the route's `idsFromLastLink`. Capped
     so a very large link cannot write an unreadable log line; the cap is reported. */
  const recorded = plan.targetIds.slice(0, 500);
  statements.push(
    activityStatement(scope, plan.activity, {
      name: plan.name,
      contractorId: plan.contractorId,
      contractorName: plan.contractorName,
      created: plan.createContractor !== null,
      jobsChanged: eligible.length,
      jobIds: recorded,
      truncated: plan.targetIds.length > recorded.length,
    }),
  );

  await commit(scope, statements);
  return { written: eligible.length };
}

export type UnlinkPlan = {
  name: string;
  /** The alias being cleared, or null when this unlink only un-ignores a string. */
  alias: { id: string; contractorId: string } | null;
  /** The jobs the link attributed; only those still naming that contractor are cleared. */
  targetIds: string[];
  exactReversal: boolean;
  activity: AliasActivity;
};

/**
 * `unlink`, applied: `contractor_id` back to empty on the jobs this link wrote,
 * the alias deleted, and the activity row — committed together.
 */
export async function applyAliasUnlink(scope: AliasWriteScope, plan: UnlinkPlan): Promise<{ cleared: number }> {
  const eligible =
    plan.alias && plan.targetIds.length
      ? await idsPassingGuard(scope, plan.targetIds, { onlyContractorId: plan.alias.contractorId })
      : [];
  const statements: BatchItem<"sqlite">[] = [];

  if (plan.alias) {
    statements.push(
      ...contractorIdStatements(scope, eligible, null, { onlyContractorId: plan.alias.contractorId }),
    );
    statements.push(
      scope.db
        .delete(contractorNameAliases)
        .where(
          and(
            eq(contractorNameAliases.organisationId, scope.orgId),
            eq(contractorNameAliases.id, plan.alias.id),
          ),
        ),
    );
  }

  statements.push(
    activityStatement(scope, plan.activity, {
      name: plan.name,
      contractorId: plan.alias?.contractorId ?? null,
      cleared: eligible.length,
      exactReversal: plan.exactReversal,
    }),
  );

  await commit(scope, statements);
  return { cleared: eligible.length };
}
