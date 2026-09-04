/**
 * `POST|GET /api/cron/retention` — the thirty-day retention sweep, on a timer.
 *
 * W2-A. The recycle bin has always had a thirty-day expiry and a purge that
 * honours it; what it did not have was anything to run that purge on its own.
 * `maybeSweepRecycleBin` fires on roughly one call in ten to `/api/trash`, so
 * the honest description of the old behaviour was "the bin empties when
 * somebody opens it" — which for a workspace nobody visits means never.
 *
 * WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It adds an entry point. It does NOT add a second purge: every row still goes
 * through `sweepRecycleBin` and the same `purgeFor` closure the bin screen and
 * the operator's `?sweep=1` already use. A second implementation of "destroy
 * this for good" is the last thing this product needs — section bundles,
 * attachment objects in R2 and the restore contract all live in that one path,
 * and a copy would drift from it silently and destructively.
 *
 * WHY AN UNSCOPED HANDLE IS SAFE HERE.
 *
 * Every other data route resolves `scopedDb()`, which decides an `orgId` from
 * the caller's memberships. A scheduler has no caller and no memberships, so it
 * uses `getDb()` and sweeps across workspaces — which is the point, since the
 * bin it most needs to empty belongs to whoever is NOT using the app.
 *
 * That is not a hole in the tenancy model, because of how the sweep is shaped:
 * `sweepRecycleBin` reads the bin rows and passes each entry's OWN
 * `organisationId` into the purge, and every purge helper filters on that id
 * (`purgeJob`, `purgeGroup`, `purgeSectionBundle` and the rest all take it as a
 * parameter and put it in the WHERE clause). The scheduler therefore cannot
 * purge across a boundary even in principle: it has no way to name an
 * organisation, it only forwards the one already written on the row.
 *
 * AUTHENTICATION — READ BEFORE LOOSENING.
 *
 * This endpoint destroys data irreversibly, so it is bearer-authenticated
 * against `CRON_SECRET` and REFUSES WHEN THAT VARIABLE IS UNSET. Refusing on a
 * missing secret rather than falling open is the whole design: a deployment
 * that forgets the variable gets an endpoint that does nothing, not a public
 * one that empties every workspace's bin for anybody who finds the URL. The
 * comparison is constant-time — a fast-exit `===` on a secret leaks its length
 * and prefix to anyone willing to time it.
 *
 * WHEN IT ACTUALLY FIRES.
 *
 * On Vercel, `crons` in the build output run against PRODUCTION deployments
 * only. The portal ships to Preview today (see docs/DEPLOYMENT-PORTAL.md), so
 * on Preview this route is reachable and correct and NOTHING CALLS IT. It
 * becomes automatic at the first Production deployment and not before. The
 * opportunistic sweep in `/api/trash` therefore stays exactly where it is; it
 * is not superseded until then.
 */

import { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  RETENTION_DAYS,
  sweepRecycleBin,
} from "../../../lib/recycle-bin";
import { purgeFor } from "../../trash/route";

export const dynamic = "force-dynamic";

/**
 * Constant-time string comparison.
 *
 * `a === b` returns as soon as two bytes differ, so the time it takes reveals
 * how much of the secret was right. This always walks the whole of the longer
 * string. The length is compared into the accumulator rather than short-
 * circuiting on it for the same reason.
 */
function secretMatches(provided: string, expected: string): boolean {
  // Folded in rather than returned on, so a wrong LENGTH costs the same as a
  // wrong byte. Out-of-range indices read as 0 instead of NaN — `NaN ^ x` is
  // `x` in JS, which would have made the accumulator lie for short inputs.
  let difference = provided.length ^ expected.length;
  const length = Math.max(provided.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    const left = index < provided.length ? provided.charCodeAt(index) : 0;
    const right = index < expected.length ? expected.charCodeAt(index) : 0;
    difference |= left ^ right;
  }
  return difference === 0;
}

/**
 * The bearer token Vercel Cron sends, or an explicit refusal.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. A plain `x-cron-secret`
 * header is accepted too so the endpoint can be driven by Railway's scheduler
 * or by an operator's curl without pretending to be an OAuth client.
 */
function authorise(request: Request): Response | null {
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected) {
    /*
     * 503, not 401. There is nothing the caller can do — the deployment is
     * missing a variable — and answering 401 would invite a credential hunt
     * for a credential that does not exist.
     */
    return Response.json(
      {
        error:
          "Scheduled retention is not configured on this deployment: CRON_SECRET is unset.",
      },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  const provided = bearer || (request.headers.get("x-cron-secret") ?? "");

  if (!provided || !secretMatches(provided, expected)) {
    // Deliberately says nothing about which half was wrong.
    return Response.json({ error: "Not authorised." }, { status: 401 });
  }
  return null;
}

async function runSweep() {
  await ensureDatabase();
  const db = await getDb();

  /*
   * `sweepRecycleBin` is capped per pass (SWEEP_LIMIT), so one call drains at
   * most that many entries. Looping until it reports nothing would let a large
   * bin hold a scheduled invocation open indefinitely, so this makes a bounded
   * number of passes and reports whether more remain. The rows left behind are
   * still expired and still first in line on the next run — the same argument
   * the capped sweep itself makes.
   */
  const MAX_PASSES = 10;
  const purge = purgeFor(db);
  let swept = 0;
  let passes = 0;
  // Set only by the pass that came back empty — that is the one thing that
  // proves the bin is drained rather than merely that we stopped looking.
  let drained = false;

  while (passes < MAX_PASSES) {
    const purged = await sweepRecycleBin(db, purge);
    passes += 1;
    swept += purged;
    if (purged === 0) {
      drained = true;
      break;
    }
  }

  return { swept, passes, more: !drained };
}

export async function POST(request: Request) {
  const refusal = authorise(request);
  if (refusal) return refusal;

  try {
    const outcome = await runSweep();
    return Response.json({
      ok: true,
      retentionDays: RETENTION_DAYS,
      ...outcome,
      ranAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[/api/cron/retention]", error);
    /*
     * A failed sweep must not look like a successful empty one. The rows stay
     * expired and the next run retries them, which is exactly what the
     * opportunistic sweep does with its own failures.
     */
    return Response.json(
      { error: "The retention sweep could not complete." },
      { status: 503 },
    );
  }
}

/**
 * Vercel Cron issues a GET. Same work, same authentication — the method is the
 * scheduler's choice, not a different operation.
 */
export async function GET(request: Request) {
  return POST(request);
}
