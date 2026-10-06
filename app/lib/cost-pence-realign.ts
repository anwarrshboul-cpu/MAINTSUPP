/**
 * A JOB'S COST IN PENCE BROUGHT BACK IN STEP WITH ITS COST — a one-off,
 * individually reconciled operation (dashboard accuracy pass, 2026-10-06).
 *
 * `cost_pence` was filled from `cost` once, and until 2026-10-06 an edit to a
 * job's cost changed `cost` only. Every SQL total reads
 * `coalesce(cost_pence, round(cost * 100))` (`cost-sql.ts`) while the Reports
 * and Overview spend read `cost`, so one edited job made Contractors and the
 * cost cards disagree with Reports. The writes now keep the two together
 * (`request-fields.ts`, the import, the duplicate); this realigns the rows an
 * earlier edit left behind, taking `cost` — the value people see and edit — as
 * the truth.
 *
 * NOT A MIGRATION, deliberately: `tests/money-integer-pence.test.mjs` forbids a
 * backfill on the boot path. This runs only when platform staff ask, as a dry
 * run first that lists every row it would change, and only with `apply: true`
 * does it write. Only rows that already hold a pence value are considered: an
 * empty one already falls back to `cost`, which is the same answer.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import type { getDb } from "../../db";
import { maintenanceRequests } from "../../db/schema";
import { poundsToPence } from "./reporting/money";

type Database = Awaited<ReturnType<typeof getDb>>;

export type CostPenceDrift = {
  id: string;
  organisationId: string;
  reference: string | null;
  cost: number | null;
  costPence: number;
  /** What `cost_pence` becomes: `cost` in pence, or null when `cost` is empty. */
  realignedPence: number | null;
};

export async function realignCostPence(
  db: Database,
  options: { apply: boolean; organisationId?: string },
): Promise<{ applied: boolean; drifted: number; rows: CostPenceDrift[] }> {
  const rows = await db
    .select({
      id: maintenanceRequests.id,
      organisationId: maintenanceRequests.organisationId,
      reference: maintenanceRequests.reference,
      cost: maintenanceRequests.cost,
      costPence: maintenanceRequests.costPence,
    })
    .from(maintenanceRequests)
    .where(
      options.organisationId
        ? and(isNotNull(maintenanceRequests.costPence), eq(maintenanceRequests.organisationId, options.organisationId))
        : isNotNull(maintenanceRequests.costPence),
    );

  const drifted: CostPenceDrift[] = [];
  for (const row of rows) {
    const cost = row.cost === null || row.cost === undefined ? null : Number(row.cost);
    const realignedPence = cost === null ? null : poundsToPence(cost);
    if (realignedPence === Number(row.costPence)) continue;
    drifted.push({
      id: row.id,
      organisationId: row.organisationId,
      reference: row.reference ?? null,
      cost,
      costPence: Number(row.costPence),
      realignedPence,
    });
  }

  if (options.apply) {
    for (const row of drifted) {
      await db
        .update(maintenanceRequests)
        .set({ costPence: row.realignedPence })
        .where(and(eq(maintenanceRequests.id, row.id), eq(maintenanceRequests.organisationId, row.organisationId)));
    }
  }
  return { applied: options.apply, drifted: drifted.length, rows: drifted };
}
