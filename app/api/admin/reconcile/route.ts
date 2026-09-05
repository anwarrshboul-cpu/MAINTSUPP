/**
 * `GET /api/admin/reconcile` — the numbers, both ways round.
 *
 * Module 3 §4.2 asks for an admin-only page that runs the application's real
 * queries and compares them, line by line, against values computed
 * independently of those queries. This route is the server half of it: it
 * builds the dataset for a day, computes the expected values with
 * `computeExpectedValues`, and hands both to `reconcileSeedData`, which reads
 * the DATABASE and classifies what it finds with the product's own functions.
 *
 * THE TWO SIDES ARE COMPUTED BY DIFFERENT CODE AND THIS ROUTE IS WHERE THAT IS
 * ARRANGED. `app/lib/seed/expected.ts` imports nothing at runtime and counts the
 * generated dataset directly; `app/lib/seed/reconcile.ts` never calls it. If a
 * later edit has the reconciler compute its own expectations, every row goes
 * green and the page stops meaning anything — §4's whole warning, and invisible
 * on screen. `tests/pre-w14-seed-reconcile.test.mjs` pins the import list.
 *
 * ── WHY A READ IS GUARDED AT ALL ──────────────────────────────────────────
 *
 * §4.2: "visible in preview only". The risk this addresses is not a leak — the
 * rows it counts are demo rows in the demo organisation — it is a person
 * reading a seeded number in a client meeting, which §2.3 calls the worst
 * outcome of the whole module. So the same two-check decision that gates a
 * purge gates this, and a refusal names which check refused and what to set.
 *
 * ── ADMIN-ONLY, AND ACROSS AN ORGANISATION BOUNDARY, DELIBERATELY ─────────
 *
 * `scopedDbWithCapability(request, "settings.edit")` proves who the caller is
 * and what they may do. The rows are then read from the DEMO organisation
 * rather than from the caller's own, because that is where the seed lives —
 * which is a cross-organisation read and is stated here rather than left to be
 * discovered. It is safe for one reason worth writing down: every query in
 * `reconcile.ts` is filtered on the demo organisation AND on `is_seed`, so this
 * route cannot return a row of the client's data even if it is wrong.
 */

import { ensureDatabase } from "../../../../db/init";
import { buildSeedDataset } from "../../../lib/seed/dataset";
import { computeExpectedValues } from "../../../lib/seed/expected";
import { assertPurgeAllowed } from "../../../lib/seed/guards";
import { SEED_ORGANISATION_ID, purgeEnvironment } from "../../../lib/seed/loader";
import { reconcileSeedData } from "../../../lib/seed/reconcile";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/** Today, UTC, or the `?today=` a `seed:travel` run is checking against. */
function resolveToday(url: URL): string {
  const asked = (url.searchParams.get("today") ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(asked)) return asked;
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const { db } = guard.scope;

    const decision = assertPurgeAllowed(await purgeEnvironment(db));
    if (!decision.allowed) {
      /*
       * 403 and not 404. The page exists; this deployment is not one it may run
       * on. The checks travel with the refusal so an operator reads "the
       * database identifies itself as maintsupp_prod" rather than "forbidden".
       */
      return Response.json(
        {
          error: "Reconciliation is not available on this deployment.",
          reason: decision.reason,
          refusedBy: decision.refusedBy,
          checks: decision.checks,
        },
        { status: 403 },
      );
    }

    const url = new URL(request.url);
    const today = resolveToday(url);
    const dataset = buildSeedDataset(today);
    const expected = computeExpectedValues(dataset, today);

    /*
     * Provenance, and only provenance.
     *
     * `matrixOffsetDays` is documented in `dataset.ts` as carried for tracing a
     * failing row back to the §3.3 line that produced it, and never for
     * counting — `expected.ts` re-derives the offset from the stored date
     * precisely so an error in the generator's arithmetic cannot cancel itself
     * out. Using it HERE, to label the expected side of a row with the ids the
     * matrix intended, is the use it exists for.
     */
    const expectedIdsByKey: Record<string, string[]> = {};
    for (const certificate of dataset.certificates) {
      const key = `offset.${certificate.matrixOffsetDays === null ? "undated" : certificate.matrixOffsetDays}`;
      (expectedIdsByKey[key] ??= []).push(certificate.id);
    }

    const report = await reconcileSeedData(db, {
      expected,
      today,
      mandatoryTypes: dataset.mandatoryCertificateTypes,
      expectedIdsByKey,
    });

    return Response.json({
      report,
      environment: {
        organisationId: SEED_ORGANISATION_ID,
        checks: decision.checks,
      },
      /*
       * Said on the payload rather than inferred from a zero. A page that shows
       * "0 of 0" against an unseeded database and a page that shows a genuine
       * failure look identical, and the reader needs to be able to tell them
       * apart without counting rows.
       */
      seeded: report.seeded,
      note: report.seeded
        ? null
        : "No seeded rows were found. Run `npm run seed` before reading these numbers.",
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/admin/reconcile]", error);
    return Response.json(
      { error: "Reconciliation is temporarily unavailable." },
      { status: 503 },
    );
  }
}
