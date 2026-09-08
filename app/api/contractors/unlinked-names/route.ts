/**
 * GET /api/contractors/unlinked-names — the audit, as an endpoint.
 *
 * Every distinct contractor string typed onto a job that resolves to no single
 * register record, with the jobs and the spend attached to it. This is the list
 * an operator works through to make the register's operational columns mean
 * something, and it is the same query that answers the brief's three audit
 * questions:
 *
 *   - how many distinct job-side names exist;
 *   - how many match a record;
 *   - how much spend is attached to each unmatched string.
 *
 * `board.view`, not a contractor capability: this is a read of the JOB feed
 * grouped by a column on it, and anybody who may read the board may read a
 * count of it. Writing a mapping is a different verb with a different guard —
 * see `POST /api/contractors/[id]/aliases`.
 */

import { ensureDatabase } from "../../../../db/init";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { unlinkedContractorNames } from "../../../lib/contractor-linking";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;

    const result = await unlinkedContractorNames(db, orgId);
    return Response.json({
      ...result,
      /*
       * The two figures the Overview's contractor card leads with, returned
       * here as well so the Contractors page can print the same sentence
       * without a second endpoint and without a second definition of it.
       */
      linkedSpend: result.totalSpend - result.unlinkedSpend,
      distinctUnlinked: result.names.length,
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json(
      {
        error:
          process.env.NODE_ENV === "development"
            ? `Preview database error: ${message}`
            : "The contractor register is temporarily unavailable.",
      },
      { status: 503 },
    );
  }
}
