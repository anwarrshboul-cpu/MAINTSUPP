/**
 * Waived data issues, read from the database and turned into the one shape
 * `finalisationBlockers` understands.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM `waivers.ts` ──────────────────────────
 *
 * `waivers.ts` is pure and holds the RULES — which severities block, what makes
 * a waiver live, what its printed note reads like. It is staged into a temp
 * directory by the report suites and must stay free of a database handle. This
 * file is the read, and it is the only part of the waiver feature that knows
 * `report_issue_waivers` exists.
 *
 * ── THE KEY, AND WHY IT INCLUDES THE ENTITY ────────────────────────────────
 *
 * `${code}:${entityId ?? ""}`. A waiver is granted against ONE finding on ONE
 * record — "this job's completion date is missing, and here is why that is
 * acceptable" — not against a category. Keying on the code alone would mean
 * waiving one job's missing completion date silently waived every other job's
 * as well, which is precisely the blanket bypass the waiver design exists to
 * avoid. A finding with no entity (a settings-level one) keys on the empty
 * string, so it is still individually waivable and still cannot cover anything
 * else.
 */

import { and, eq, isNull } from "drizzle-orm";
import { reportIssueWaivers } from "../../../db/schema";

/* eslint-disable @typescript-eslint/no-explicit-any -- the drizzle handle is
   assembled per driver; the schema import is what types these queries. */
type Db = any;

/** The key `BlockerInput.waivedIssueKeys` is matched on. One finding, one key. */
export function waiverKey(code: string, entityId: string | null | undefined): string {
  return `${code}:${entityId ?? ""}`;
}

export type StoredWaiver = {
  id: string;
  issueCode: string;
  subjectId: string | null;
  reason: string;
  waivedByEmail: string | null;
  waivedAt: string;
};

/**
 * Live waivers on one document. A revoked waiver is excluded here rather than
 * filtered later, so a caller cannot accidentally treat one as still granting
 * passage — revocation has to put the block straight back.
 */
export async function listWaivers(
  db: Db,
  organisationId: string,
  invoiceId: string,
): Promise<StoredWaiver[]> {
  const rows = await db
    .select()
    .from(reportIssueWaivers)
    .where(
      and(
        eq(reportIssueWaivers.organisationId, organisationId),
        eq(reportIssueWaivers.invoiceId, invoiceId),
        isNull(reportIssueWaivers.revokedAt),
      ),
    );
  return rows.map((row: StoredWaiver) => ({
    id: row.id,
    issueCode: row.issueCode,
    subjectId: row.subjectId,
    reason: row.reason,
    waivedByEmail: row.waivedByEmail,
    waivedAt: row.waivedAt,
  }));
}

export async function loadWaivedIssueKeys(
  db: Db,
  organisationId: string,
  invoiceId: string | null | undefined,
): Promise<ReadonlySet<string>> {
  /*
   * No document, no waivers. A draft that has not been saved cannot have had
   * anything waived against it, and returning an empty set makes the caller
   * block MORE rather than less — the safe direction when in doubt.
   */
  if (!invoiceId) return new Set<string>();
  const waivers = await listWaivers(db, organisationId, invoiceId);
  return new Set(waivers.map((waiver) => waiverKey(waiver.issueCode, waiver.subjectId)));
}
