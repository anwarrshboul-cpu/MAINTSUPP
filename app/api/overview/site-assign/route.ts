/**
 * `POST /api/overview/site-assign` — the bulk repair behind §6.4.
 *
 * ── WHY THIS IS NOT UNDER `/api/dashboard` ────────────────────────────────
 *
 * `/api/dashboard/*` is READ-ONLY AGGREGATES and writes nothing. `/api/overview/*`
 * is the Overview's three WRITE tools and nothing else, which is what makes §8's
 * promise — "no change to any job record as a side effect of dashboard work,
 * except the explicit, confirmed, reversible actions in the contractor linking
 * tool and the bulk site-assign view" — a boundary a reviewer can see instead of
 * one they have to trust.
 *
 * ── WHAT §6.4 ASKS FOR ────────────────────────────────────────────────────
 *
 * "31 jobs point at no site in the register — Fix these opens a bulk assign view
 * listing the affected jobs with a site picker so several are assigned in one
 * pass." Several, not one at a time: the whole complaint is that repairing 31
 * jobs one row at a time is why they were never repaired.
 *
 * ── THE THREE THINGS THIS ROUTE IS CAREFUL ABOUT ──────────────────────────
 *
 * 1. A FOREIGN KEY IS NOT A TENANT CHECK, and `maintenance_requests.site_id` has
 *    no foreign key at all (see `db/schema.ts`: an existing SQLite database
 *    cannot be relaxed in place). Both the site and every job id therefore come
 *    out of the request body and are re-read against `orgId` before anything is
 *    written. Ids not in this workspace are dropped and reported, never written
 *    and never 404'd one at a time — a caller who sends fifty and owns forty
 *    gets forty assigned and a count of the ten that were not theirs.
 *
 * 2. THE D1 VARIABLE CAP IS REAL. SQLite compiles every element of an `IN` list
 *    to its own bound parameter and D1 refuses a statement past roughly a
 *    hundred — `app/lib/sql-batching.ts` exists because a 20-row bulk delete at
 *    12 columns a row hit 240 variables and answered 503. Both statements here
 *    are chunked: the verification `SELECT` at `SQL_VARIABLE_CHUNK` (a bare `IN`
 *    list, one variable an id) and the `UPDATE` at `ASSIGN_CHUNK`, which is
 *    lower because its `SET` clause and organisation filter spend variables of
 *    their own before a single id is bound.
 *
 * 3. IT SAYS WHAT IT WILL DO FIRST. `mode` defaults to `"preview"`, so a POST
 *    that forgets to confirm answers with the jobs and their current sites and
 *    changes nothing. `siteId: null` is the REVERSAL — it puts the jobs back to
 *    having no site — and it is a first-class mode rather than an oversight,
 *    because §8 requires every one of these actions to be reversible.
 */

import { and, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { activityLog, maintenanceRequests, sites } from "../../../../db/schema";
import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import { liveWorkOrderCondition } from "../../../lib/dashboard-filters";
import {
  canonicalSiteId,
  isUnassignedSite,
  unassignedSiteId,
} from "../../../lib/site-reference";
import { SQL_VARIABLE_CHUNK, chunkIds } from "../../../lib/sql-batching";
import {
  anonymousRefusal,
  busyRefusal,
  scopedDbWithCapability,
  type ScopedDatabase,
} from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * The most jobs one press may move.
 *
 * §6.4's real case is 31. 200 is generous enough that no honest repair is split
 * across two presses and small enough that a mistake is reviewable — the whole
 * point of the preview is that somebody reads it, and nobody reads two thousand
 * rows. A larger batch is refused rather than silently truncated: truncating
 * would report success over work that did not happen.
 */
const MAX_BATCH = 200;

/**
 * Ids per `UPDATE`, deliberately below `SQL_VARIABLE_CHUNK`.
 *
 * That constant is 90 and is sized for a bare `IN` list — "one variable per
 * element, with a comfortable margin for the handful of other bound values".
 * This statement is not bare: `set site_id = ?, status_changed_at is untouched`
 * plus `organisation_id = ?` spend variables before the list starts, and the
 * margin is what pays for them. 80 keeps twenty in hand, which is more than any
 * plausible future clause on this statement needs.
 */
const ASSIGN_CHUNK = 80;

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

type JobRow = {
  id: string;
  reference: string | null;
  title: string;
  siteId: string | null;
  status: string;
};

/** The jobs this workspace actually owns, out of the ids a caller sent. */
async function verifyJobs(scope: ScopedDatabase, ids: string[]): Promise<JobRow[]> {
  const rows: JobRow[] = [];
  /* One variable per id and nothing else in the list, so the default chunk. */
  for (const chunk of chunkIds(ids, SQL_VARIABLE_CHUNK)) {
    const found = await scope.db
      .select({
        id: maintenanceRequests.id,
        reference: maintenanceRequests.reference,
        title: maintenanceRequests.title,
        siteId: maintenanceRequests.siteId,
        status: maintenanceRequests.status,
      })
      .from(maintenanceRequests)
      .where(and(liveWorkOrderCondition(scope.orgId), inArray(maintenanceRequests.id, chunk)));
    rows.push(...found);
  }
  return rows;
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guarded = await scopedDbWithCapability(request, "board.edit");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const rawIds = Array.isArray(body.requestIds) ? body.requestIds : [];
    const requestIds = [
      ...new Set(
        rawIds
          .map((value) => (typeof value === "string" ? value.trim().slice(0, 64) : ""))
          .filter(Boolean),
      ),
    ];
    if (!requestIds.length) return badRequest("Choose at least one job to assign.");
    if (requestIds.length > MAX_BATCH) {
      return badRequest(
        `That is ${requestIds.length} jobs. Assign at most ${MAX_BATCH} in one pass so the confirmation stays readable.`,
      );
    }

    /*
     * "NO SITE" HAS THREE SPELLINGS AND THE REVERSAL DEPENDS ON ALL THREE.
     *
     * A Postgres row holds NULL; a SQLite row holds the `site-unassigned`
     * sentinel, because `site_id` is NOT NULL there and cannot be relaxed in
     * place; and an older row can hold a `site-website-intake-…` id that names
     * no register row either. `app/lib/site-reference.ts` owns that reading and
     * is used here rather than re-derived — the first version of this route
     * checked the register directly, and the reversal it handed back
     * (`siteId: "site-unassigned"`, straight off the rows it had just changed)
     * came back 400 "That site does not belong to this workspace." Measured, on
     * three fixture jobs the board itself had created.
     *
     * An ABSENT key is still an error. A body that simply forgot `siteId` is a
     * mistake, and reading it as "clear the site on 40 jobs" is exactly the
     * silent destruction this namespace exists to avoid — so `undefined` is
     * refused while `null` and the sentinels are honoured.
     */
    if (body.siteId === undefined) {
      return badRequest("Choose the site to assign these jobs to, or send siteId: null to clear it.");
    }
    const asked =
      body.siteId === null
        ? null
        : typeof body.siteId === "string"
          ? body.siteId.trim().slice(0, 64)
          : "";
    if (asked === "") {
      return badRequest("Choose the site to assign these jobs to, or send siteId: null to clear it.");
    }
    const clearing = isUnassignedSite(asked);
    /* What actually goes into the column: NULL where the dialect allows it and
       the estate's own sentinel where it does not. Never an invented site. */
    const siteId = clearing ? unassignedSiteId() : asked;

    let siteName = "no site";
    if (!clearing) {
      /* The site must be one THIS organisation owns. An id is an address, not a
         credential — the same rule every site-joined read in this product uses. */
      const [site] = await scope.db
        .select({ id: sites.id, name: sites.name })
        .from(sites)
        .where(and(eq(sites.organisationId, scope.orgId), eq(sites.id, asked as string)));
      if (!site) return badRequest("That site does not belong to this workspace.");
      siteName = site.name;
    }

    const owned = await verifyJobs(scope, requestIds);
    const ownedIds = new Set(owned.map((row) => row.id));
    const rejected = requestIds.filter((id) => !ownedIds.has(id));
    /* Already where they are going. Counted, reported, and not written: an
       UPDATE that changes nothing still writes an activity_log line, and a
       feed full of "assigned to Aldgate" for jobs already at Aldgate is noise
       that hides the real changes beside it. */
    /* Compared through `canonicalSiteId`, so a row already reading NULL and one
       already reading the sentinel are both "already there" when the ask is to
       clear — rewriting one into the other is a change nobody asked for. */
    const changing = owned.filter(
      (row) => canonicalSiteId(row.siteId) !== canonicalSiteId(siteId),
    );
    const unchanged = owned.length - changing.length;

    const apply = body.mode === "apply";
    if (!apply) {
      return Response.json({
        mode: "preview",
        siteId,
        siteName,
        requested: requestIds.length,
        willChange: changing.length,
        unchanged,
        rejected: rejected.length,
        jobs: changing.slice(0, MAX_BATCH).map((row) => ({
          id: row.id,
          reference: row.reference,
          title: row.title,
          fromSiteId: row.siteId,
          status: row.status,
        })),
        summary: `Assigns ${changing.length} job${changing.length === 1 ? "" : "s"} to ${siteName}.`,
      });
    }

    if (!changing.length) {
      return Response.json({
        ok: true,
        assigned: 0,
        unchanged,
        rejected: rejected.length,
        siteId,
        siteName,
        summary: "Nothing to do — every job named is already there.",
      });
    }

    const at = new Date().toISOString();
    const previous = new Map(changing.map((row) => [row.id, row.siteId ?? null]));
    let assigned = 0;
    const written: string[] = [];

    /* Chunked. See `ASSIGN_CHUNK` and the module header — the variable cap is
       counted per column per row, and this statement binds two before the list. */
    for (const chunk of chunkIds(
      changing.map((row) => row.id),
      ASSIGN_CHUNK,
    )) {
      const rows = await scope.db
        .update(maintenanceRequests)
        .set({ siteId, updatedAt: at })
        .where(
          and(
            eq(maintenanceRequests.organisationId, scope.orgId),
            inArray(maintenanceRequests.id, chunk),
          ),
        )
        .returning({ id: maintenanceRequests.id });
      assigned += rows.length;
      written.push(...rows.map((row) => row.id));
    }

    /*
     * ONE ACTIVITY LINE PER JOB — §6.4 through §8. The job's own history is
     * where somebody looks to ask "why is this filed under Aldgate", and a
     * single summary row filed against the batch would not appear there at all.
     * The audit trail gets the summary instead, because that reader is asking
     * about the ACTION and not about the job.
     */
    for (const id of written) {
      await scope.db.insert(activityLog).values({
        id: crypto.randomUUID(),
        organisationId: scope.orgId,
        entityType: "maintenance_request",
        entityId: id,
        action: "request.site_assigned",
        actorEmail: scope.identityEmail.toLowerCase(),
        detail: JSON.stringify({
          from: previous.get(id) ?? null,
          to: siteId,
          siteName,
          bulk: true,
        }),
        createdAt: at,
      });
    }

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "dashboard.sites_bulk_assigned",
      entityType: "maintenance_request",
      entityId: siteId ?? "unassigned",
      summary: clearing
        ? `Cleared the site on ${assigned} job(s) from the Overview.`
        : `Assigned ${assigned} job(s) to ${siteName} from the Overview.`,
      detail: {
        ...changeDetail(
          { siteId: [...new Set(previous.values())] },
          { siteId: [siteId] },
        ),
        siteId,
        siteName,
        assigned,
        unchanged,
        rejected: rejected.length,
        /* Enough to reverse it exactly, in the shape the reversal takes. */
        reverse: [...previous.entries()].slice(0, 200).map(([id, from]) => ({ id, siteId: from })),
      },
      request,
    });

    return Response.json({
      ok: true,
      assigned,
      unchanged,
      rejected: rejected.length,
      siteId,
      siteName,
      summary: clearing
        ? `Cleared the site on ${assigned} job${assigned === 1 ? "" : "s"}.`
        : `Assigned ${assigned} job${assigned === 1 ? "" : "s"} to ${siteName}.`,
      /* The reversal, ready to POST back. Grouped by the site each job came
         from, because putting 40 jobs back means as many calls as there were
         distinct origins — usually one. */
      reverse: groupReversal(previous),
    });
  } catch (error) {
    return failure(error, "Those jobs could not be assigned.");
  }
}

/** `{ siteId, requestIds }` per origin — exactly what POSTing back would need. */
function groupReversal(previous: Map<string, string | null>) {
  const byOrigin = new Map<string | null, string[]>();
  for (const [id, from] of previous) {
    const list = byOrigin.get(from);
    if (list) list.push(id);
    else byOrigin.set(from, [id]);
  }
  return [...byOrigin.entries()].map(([origin, ids]) => ({
    siteId: origin,
    requestIds: ids,
  }));
}

/** See `/api/overview/meter-settings` — the same three arms, for the same reasons. */
function failure(error: unknown, consequence: string): Response {
  const anonymous = anonymousRefusal(error);
  if (anonymous) return anonymous;
  const busy = busyRefusal(error, consequence);
  if (busy) return busy;
  console.error("[/api/overview/site-assign]", error);
  if (error instanceof Error && error.cause) {
    console.error("[/api/overview/site-assign] cause:", error.cause);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json(
    {
      error:
        process.env.NODE_ENV === "development" ? `${consequence} ${message}` : consequence,
    },
    { status: 503 },
  );
}
