/**
 * AN ORGANISATION'S JOB TYPES — the server half. The shapes are in
 * `job-type-contract.ts`; the table and its seed are in `db/init.ts`
 * (`job_type_config`, `seedJobTypes`).
 *
 * Tenant-scoped by construction: every read names the organisation, and a
 * write that names a type is resolved against that organisation's rows, so a
 * type id from another tenant — or a made-up one — is refused, never stored.
 */

import { and, asc, eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { jobTypeConfig } from "../../db/schema";
import { isJobTypeCode, type JobType } from "./job-type-contract";

type Database = Awaited<ReturnType<typeof getDb>>;

type JobTypeRow = typeof jobTypeConfig.$inferSelect;

export function jobTypeFromRow(row: JobTypeRow): JobType {
  return {
    id: row.id,
    code: isJobTypeCode(row.code) ? row.code : null,
    label: row.label,
    colourHex: row.colourHex ?? null,
    sortOrder: Number(row.sortOrder ?? 0),
    active: !row.deactivatedAt,
  };
}

/**
 * Every job type the organisation holds, deactivated ones included — a Reports
 * figure or a job's detail must still be able to name a retired type — in the
 * administrator's order.
 */
export async function listJobTypes(db: Database, organisationId: string): Promise<JobType[]> {
  const rows = (await db
    .select()
    .from(jobTypeConfig)
    .where(eq(jobTypeConfig.organisationId, organisationId))
    .orderBy(asc(jobTypeConfig.sortOrder), asc(jobTypeConfig.label))) as JobTypeRow[];
  return rows.map(jobTypeFromRow);
}

/**
 * What a job's `jobTypeId` may be set to.
 *
 *   · null, "" or absent-as-null → null (Unclassified);
 *   · an id of one of THIS organisation's types → that id;
 *   · a deactivated type only when it is already the job's type (`current`), so
 *     re-saving an old job never fails and a retired type is never newly chosen;
 *   · anything else — another tenant's id, a made-up one — is refused.
 */
export async function resolveJobTypeWrite(
  db: Database,
  organisationId: string,
  value: unknown,
  current: string | null = null,
): Promise<{ ok: true; id: string | null } | { ok: false; error: string; status: number }> {
  if (value === null || value === undefined || value === "") return { ok: true, id: null };
  if (typeof value !== "string" || value.length > 200) {
    return { ok: false, error: "A job type must be the id of one of this workspace's job types.", status: 400 };
  }
  const [row] = (await db
    .select()
    .from(jobTypeConfig)
    .where(and(eq(jobTypeConfig.organisationId, organisationId), eq(jobTypeConfig.id, value)))
    .limit(1)) as JobTypeRow[];
  /* One answer for "no such type" and "another tenant's type": the id is not a
     capability, and a different message would confirm the other tenant's id exists. */
  if (!row) return { ok: false, error: "That job type does not exist in this workspace.", status: 404 };
  if (row.deactivatedAt && row.id !== current) {
    return { ok: false, error: `"${row.label}" is no longer offered for new jobs. Choose an active job type.`, status: 400 };
  }
  return { ok: true, id: row.id };
}
