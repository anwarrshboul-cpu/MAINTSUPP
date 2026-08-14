/**
 * The audit log, read side.
 *
 * GET only. There is no POST, PATCH or DELETE here and there will not be one:
 * events are written by `recordAudit()` from inside the action being audited,
 * never by anything a browser can call. An endpoint that accepts an audit event
 * from a client is an endpoint that lets a client fabricate one.
 *
 * Scoping. A reader sees the organisations their memberships name — the same
 * set `scopedDb` resolves — and nothing else. Events with a NULL organisation
 * (a failed sign-in, which happens before a workspace is known) are visible
 * only to a super admin, because they are the only reader whose remit is the
 * whole installation.
 *
 * Permission. `audit.read`, resolved against the workspace's own capability
 * table rather than against a role literal, so an admin who has had the
 * capability withdrawn loses this page without a deploy. The capability is
 * checked for the workspace being *read*, which for a super admin may be more
 * than one — see the note at the check.
 */

import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { auditEvents, organisations } from "../../../db/schema";
import { requireCapability, resolvePermissions } from "../../lib/permissions";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function text(value: unknown, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function unavailable(error?: unknown) {
  // A session that has ended is not an outage: 503 tells a browser to retry
  // something no amount of retrying will fix, and blames the workspace for
  // what a person fixes by signing in. See `anonymousRefusal`.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json({ error: "The audit log is temporarily unavailable." }, { status: 503 });
}

/**
 * `created_at`, in one comparable shape.
 *
 * Two writers stamp this column and they disagree about the separator: a row
 * inserted with an explicit `toISOString()` reads "2026-08-07T14:35:37.123Z",
 * one left to the column's `CURRENT_TIMESTAMP` default reads
 * "2026-08-07 14:35:37". Compared as text, 'T' sorts *after* a space, so every
 * ISO row would sort above every default row whatever their dates — the log
 * would silently stop being in time order.
 *
 * Replacing the separator makes the two forms comparable: the shorter string
 * is then a prefix of the longer, which is exactly what a lexicographic
 * comparison needs. Both forms are UTC, so nothing else has to be reconciled.
 */
const COMPARABLE_CREATED_AT = sql`replace(${auditEvents.createdAt}, 'T', ' ')`;

/**
 * A date filter, widened to cover the whole day and in the comparable shape.
 *
 * Without the widening, a `to` of "2026-08-07" compares as that day's midnight
 * and excludes everything that actually happened during it.
 */
function dayBound(value: string, edge: "start" | "end") {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const day = value.slice(0, 10);
  return edge === "start" ? `${day} 00:00:00` : `${day} 23:59:59.999`;
}

function parseDetail(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // A detail that will not parse is still evidence — hand it back as text
    // rather than pretending the event had none.
    return { raw: value };
  }
}

/**
 * GET /api/audit
 *
 * Query: `organisationId`, `actor`, `action`, `entityType`, `entityId`,
 * `from`, `to`, `page`, `pageSize`, `q`. Newest first, always.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);

    // Checked against the actor's *current* workspace. A super admin bypasses
    // overrides by construction (see `can()`), so the cross-workspace read
    // below cannot be reached by anyone whose capability was withdrawn here.
    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role);
    const refusal = requireCapability(subject, "audit.read");
    if (refusal) return refusal;

    const url = new URL(request.url);
    const params = url.searchParams;

    // The organisations this reader may see. A requested workspace outside the
    // set is ignored rather than honoured — the same rule `scopedDb` applies to
    // the organisation cookie, for the same reason.
    const readable = scope.organisationIds;
    const requested = text(params.get("organisationId"), 80);
    const organisationIds =
      requested && readable.includes(requested) ? [requested] : readable;

    const conditions = [];

    const orgScope = scope.crossOrganisation
      ? // Only a super admin sees the workspace-less events, and only when they
        // have not narrowed to one workspace.
        requested && readable.includes(requested)
        ? inArray(auditEvents.organisationId, organisationIds)
        : or(
            inArray(auditEvents.organisationId, organisationIds),
            isNull(auditEvents.organisationId),
          )
      : inArray(auditEvents.organisationId, organisationIds);
    if (orgScope) conditions.push(orgScope);

    const actor = text(params.get("actor"), 200).toLowerCase();
    if (actor) conditions.push(like(auditEvents.actorEmail, `%${actor}%`));

    const action = text(params.get("action"), 80);
    if (action) {
      // "team" matches the whole team.* family; "team.created" matches exactly.
      conditions.push(
        action.includes(".")
          ? eq(auditEvents.action, action)
          : like(auditEvents.action, `${action}.%`),
      );
    }

    const entityType = text(params.get("entityType"), 60);
    if (entityType) conditions.push(eq(auditEvents.entityType, entityType));

    const entityId = text(params.get("entityId"), 120);
    if (entityId) conditions.push(eq(auditEvents.entityId, entityId));

    const from = dayBound(text(params.get("from"), 30), "start");
    if (from) conditions.push(sql`${COMPARABLE_CREATED_AT} >= ${from}`);

    const to = dayBound(text(params.get("to"), 30), "end");
    if (to) conditions.push(sql`${COMPARABLE_CREATED_AT} <= ${to}`);

    const search = text(params.get("q"), 120);
    if (search) conditions.push(like(auditEvents.summary, `%${search}%`));

    const where = conditions.length ? and(...conditions) : undefined;

    const pageSize = Math.min(
      Math.max(Number(params.get("pageSize")) || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const page = Math.max(Number(params.get("page")) || 1, 1);

    const [totals] = await scope.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(auditEvents)
      .where(where);
    const total = Number(totals?.total ?? 0);

    const rows = await scope.db
      .select()
      .from(auditEvents)
      .where(where)
      // The id breaks ties: two events in the same millisecond must still come
      // back in a stable order, or page 2 can repeat a row from page 1.
      .orderBy(sql`${COMPARABLE_CREATED_AT} desc`, desc(auditEvents.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    // The action list is derived from the events actually present rather than
    // from the union type, so the filter never offers a verb with no rows.
    const actionRows = await scope.db
      .selectDistinct({ action: auditEvents.action })
      .from(auditEvents)
      .where(where ? orgScope : undefined);

    const workspaces = await scope.db
      .select({ id: organisations.id, name: organisations.name })
      .from(organisations)
      .where(inArray(organisations.id, readable));

    return Response.json({
      events: rows.map((row) => ({ ...row, detail: parseDetail(row.detail) })),
      page,
      pageSize,
      total,
      pageCount: Math.max(Math.ceil(total / pageSize), 1),
      filters: {
        organisationId: requested && readable.includes(requested) ? requested : "",
        actor,
        action,
        from: text(params.get("from"), 30),
        to: text(params.get("to"), 30),
        q: search,
      },
      actions: actionRows.map((row) => row.action).sort(),
      workspaces,
      viewer: {
        email: scope.identityEmail,
        role: scope.actor.role,
        crossOrganisation: scope.crossOrganisation,
      },
    });
  } catch (error) {
    return unavailable(error);
  }
}
