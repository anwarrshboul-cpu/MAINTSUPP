/**
 * `POST /api/admin/seed` — seed, purge, or verify.
 *
 * Module 3 §5 names five commands. Four of them are this route with a different
 * `action`, and the fifth (`seed:cron`) is `/api/cron/reminders`, which already
 * exists and is not re-implemented here — a second dispatcher would be a second
 * place that decides whether mail leaves the building.
 *
 *   seed    delete every seeded row, then write the dataset for `today`.
 *   purge   delete every seeded row and every seeded object.
 *   verify  run the reconciliation and answer 200 or 409, so a CI step can
 *           branch on the status code rather than parse a table.
 *
 * ── EVERY ACTION HERE IS DESTRUCTIVE, INCLUDING `seed` ────────────────────
 *
 * A seed run deletes before it writes, because §7 requires two consecutive runs
 * to produce byte-identical data and an insert-only loader cannot. So `seed` is
 * held to exactly the standard `purge` is: BOTH production checks, and the
 * strict `EMAIL_MODE` reading. `app/lib/seed/loader.ts` performs both and
 * returns a typed refusal; this route's job is to turn that into a status code
 * and a sentence, not to decide anything of its own.
 *
 * `verify` is a read and is guarded the same way, for the reason
 * `/api/admin/reconcile` gives: the danger of a seeded number is that somebody
 * reads it believing it is the client's.
 *
 * ── NO real EMAIL, EVER ───────────────────────────────────────────────────
 *
 * Nothing here sends. Seeded certificates generate `reminder_rules` rows, which
 * the cron would send from — and `assertEmailModeSafe` refuses to seed at all
 * unless `EMAIL_MODE` is `sink` or `log`, so by the time a rule exists the
 * deployment has already promised it cannot mail a stranger. That check lives
 * at the seed entry point and not on the send path; the long reason is in
 * `app/lib/seed/guards.ts`.
 */

import { ensureDatabase } from "../../../../db/init";
import { buildSeedDataset } from "../../../lib/seed/dataset";
import { computeExpectedValues } from "../../../lib/seed/expected";
import { assertEmailModeSafe, assertPurgeAllowed } from "../../../lib/seed/guards";
import {
  SEED_ORGANISATION_ID,
  loadSeedDataset,
  platformVars,
  purgeEnvironment,
  purgeSeedData,
  travelTo,
} from "../../../lib/seed/loader";
import { reconcileSeedData } from "../../../lib/seed/reconcile";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

type SeedAction = "seed" | "purge" | "verify";

const ACTIONS: readonly SeedAction[] = ["seed", "purge", "verify"];

function isAction(value: unknown): value is SeedAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

/** The day to build for: an explicit date, or today shifted by `days`. */
function resolveToday(body: { today?: unknown; days?: unknown }): string {
  const asked = typeof body.today === "string" ? body.today.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(asked)) return asked;
  const now = new Date().toISOString().slice(0, 10);
  const days = Number(body.days);
  return Number.isFinite(days) && days !== 0 ? travelTo(now, days) : now;
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const { db, actor } = guard.scope;

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      /* An empty body is a request with no action, answered below. */
      body = {};
    }

    if (!isAction(body.action)) {
      return Response.json(
        { error: `action must be one of: ${ACTIONS.join(", ")}.` },
        { status: 400 },
      );
    }

    /*
     * The gates, before anything is read or written.
     *
     * Evaluated HERE as well as inside the loader — deliberately, and not as
     * belt and braces for its own sake. `verify` never reaches the loader, so
     * without this it would be the one action on this route that ran against
     * production. Two calls, one answer, and the loader stays safe to call from
     * anywhere.
     */
    const vars = await platformVars();
    const email = assertEmailModeSafe(vars.EMAIL_MODE);
    if (!email.safe) {
      return Response.json(
        {
          error: "This deployment may not run seed commands.",
          reason: email.reason,
          /*
           * What was actually readable, by name and value.
           *
           * Neither is a secret — `/api/account/platform` already reports
           * whether an API key is present — and without them a refusal is
           * indistinguishable between "you did not set it" and "you set it
           * somewhere this runtime cannot see", which are different problems
           * with different fixes. That second case is real here: the local
           * Miniflare worker does not project `.dev.vars` onto `process.env`.
           */
          observed: {
            EMAIL_MODE: vars.EMAIL_MODE ?? null,
            ENVIRONMENT: vars.ENVIRONMENT ?? null,
            VERCEL_ENV: vars.VERCEL_ENV ?? null,
          },
        },
        { status: 403 },
      );
    }
    const decision = assertPurgeAllowed(await purgeEnvironment(db));
    if (!decision.allowed) {
      return Response.json(
        {
          error: "This deployment may not run seed commands.",
          reason: decision.reason,
          refusedBy: decision.refusedBy,
          checks: decision.checks,
        },
        { status: 403 },
      );
    }

    if (body.action === "purge") {
      const result = await purgeSeedData(db);
      if (!result.ok) {
        return Response.json({ error: result.reason, refusedBy: result.refusedBy }, { status: 403 });
      }
      return Response.json({ action: "purge", result });
    }

    const today = resolveToday(body);

    if (body.action === "seed") {
      const dataset = buildSeedDataset(today);
      const result = await loadSeedDataset(db, dataset, {
        actorEmail: actor?.email ?? null,
        withFiles: body.withFiles !== false,
      });
      if (!result.ok) {
        return Response.json({ error: result.reason, refusedBy: result.refusedBy }, { status: 403 });
      }
      return Response.json({
        action: "seed",
        result,
        /*
         * §4 asks the seed to emit the expected values as it generates the
         * data. They are returned rather than written to `/seed/expected-values.json`
         * because this product has no writable disk on either deployment target
         * — Vercel's filesystem is read-only apart from a scratch directory
         * that is not shared between invocations. `scripts/seed.mjs` writes the
         * file locally from this payload, which puts it where §4 wants it
         * without pretending the server can.
         */
        expected: computeExpectedValues(dataset, today),
      });
    }

    /* verify */
    const dataset = buildSeedDataset(today);
    const expected = computeExpectedValues(dataset, today);
    const report = await reconcileSeedData(db, {
      expected,
      today,
      mandatoryTypes: dataset.mandatoryCertificateTypes,
    });
    return Response.json(
      { action: "verify", report, organisationId: SEED_ORGANISATION_ID },
      /*
       * 409 on a mismatch, so `npm run seed:verify` can exit 1 on the status
       * code alone. §5 wires this into CI, and a CI step that has to parse a
       * table to decide whether it failed is a CI step that eventually stops
       * failing.
       */
      { status: report.failed > 0 ? 409 : 200 },
    );
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    console.error("[/api/admin/seed]", error);
    return Response.json({ error: "The seed command could not be run." }, { status: 503 });
  }
}
