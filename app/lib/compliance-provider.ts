/**
 * THE RENEWAL PROVIDER ON A COMPLIANCE REQUIREMENT — the server half.
 *
 * `compliance_documents.provider_contractor_id` links a requirement to the
 * contractor RECORD booked to renew it, so "Who's renewing" can name a real
 * contractor instead of a role. It is optional and it is never inferred: a
 * requirement whose `issued_by` text happens to match a contractor's name stays
 * unlinked until a person links it, because a silent match would attribute a
 * renewal to the wrong company as soon as two share a name.
 *
 * Tenant-scoped by construction. The foreign key only proves the contractor
 * exists somewhere; `resolveProviderContractor` proves it is THIS
 * organisation's, with one answer for "no such contractor" and "another
 * tenant's contractor" so the id is not a way to probe another workspace.
 */

import { and, eq } from "drizzle-orm";
import type { getDb } from "../../db";
import { contractors } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

/** Every contractor this organisation holds, by id — the names a link is printed with. */
export async function contractorNamesById(db: Database, organisationId: string): Promise<Map<string, string>> {
  const rows = (await db
    .select({ id: contractors.id, name: contractors.name })
    .from(contractors)
    .where(eq(contractors.organisationId, organisationId))) as Array<{ id: string; name: string | null }>;
  return new Map(rows.map((row) => [row.id, (row.name ?? "").trim() || "Unnamed contractor"]));
}

/**
 * The contractors a person may choose as a renewal provider, for a picker:
 * this organisation's active contractors, name order, plus any contractor
 * already linked somewhere even if archived since (so a saved link still shows
 * its name rather than a blank).
 */
export async function providerOptions(
  db: Database,
  organisationId: string,
  alsoInclude: ReadonlySet<string> = new Set(),
): Promise<Array<{ id: string; name: string; active: boolean }>> {
  const rows = (await db
    .select({ id: contractors.id, name: contractors.name, active: contractors.active })
    .from(contractors)
    .where(eq(contractors.organisationId, organisationId))) as Array<{
    id: string;
    name: string | null;
    active: boolean | null;
  }>;
  return rows
    .filter((row) => row.active !== false || alsoInclude.has(row.id))
    .map((row) => ({ id: row.id, name: (row.name ?? "").trim() || "Unnamed contractor", active: row.active !== false }))
    .sort((left, right) => left.name.localeCompare(right.name, "en-GB"));
}

/**
 * What a requirement's renewal provider may be set to: null (clear — "not
 * linked"), or the id of one of THIS organisation's contractors. Anything else
 * is refused before a row is touched.
 */
export async function resolveProviderContractor(
  db: Database,
  organisationId: string,
  value: unknown,
): Promise<{ ok: true; id: string | null } | { ok: false; error: string; status: number }> {
  if (value === null || value === undefined || value === "") return { ok: true, id: null };
  if (typeof value !== "string" || value.length > 200) {
    return { ok: false, error: "A renewal contractor must be one of this workspace's contractors.", status: 400 };
  }
  const [row] = (await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(and(eq(contractors.organisationId, organisationId), eq(contractors.id, value)))
    .limit(1)) as Array<{ id: string }>;
  if (!row) return { ok: false, error: "Contractor not found.", status: 404 };
  return { ok: true, id: row.id };
}
