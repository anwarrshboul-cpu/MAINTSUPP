/**
 * The cross-client owner console.
 *
 * Every other route in the product answers about one workspace. This one is the
 * deliberate exception: the owner needs a single screen showing every client,
 * how much is in each, and when it was last touched — a question that cannot be
 * answered from inside a tenant boundary, and that is otherwise only answerable
 * by switching workspace and looking, one at a time.
 *
 * TWO GATES, AND NEITHER SUBSTITUTES FOR THE OTHER
 * ------------------------------------------------
 * 1. Capability. `clients.view_all` is required, and a client's built-in
 *    defaults do not include it. A client calling this route gets 403 — not an
 *    empty list, and certainly not a hidden button on a page that would have
 *    served them the data anyway.
 *
 * 2. Tenancy. The rows returned are still `access.organisationIds`, the set
 *    `tenant-access.ts` built from the caller's own memberships. For a super
 *    admin that is every active workspace, which is what makes this a console.
 *    For anyone else it is their own workspaces even if the capability has been
 *    granted to them by hand — because Stage 19's rule is that only a super
 *    admin is ever handed more than one organisation, and a capability toggle
 *    must not be a way around it.
 *
 * Every number below is counted from real rows. A workspace with nothing in it
 * reports zeros and a null last-activity, which is the truth about a workspace
 * that has just been created.
 */

import { and, count, eq, inArray, isNull, max, ne } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  activityLog,
  auditEvents,
  maintenanceRequests,
  memberships,
  sites,
  units,
  users,
} from "../../../../db/schema";
import {
  ROLE_LABELS,
  effectiveCapabilities,
  requireCapability,
} from "../../../lib/permissions";
import { adminContext, adminError, isRefusal } from "../admin-context";

/** The latest of several nullable ISO timestamps, or null when there are none. */
function latest(...values: Array<string | null | undefined>) {
  const present = values.filter((value): value is string => Boolean(value));
  if (!present.length) return null;
  return present.reduce((best, value) => (value > best ? value : best));
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const context = await adminContext(request, null);
    if (isRefusal(context)) return context;

    // Gate one. Before a single count is read.
    const denied = requireCapability(context.subject, "clients.view_all");
    if (denied) return denied;

    // Gate two. See the header — the capability decides whether the screen may
    // be opened; the membership list still decides which rows it may contain.
    const ids = context.organisationIds;
    const visible = context.activeOrganisations.filter((item) => ids.includes(item.id));
    if (!visible.length) {
      return Response.json({ clients: [], totals: emptyTotals(), actor: actorPayload(context) });
    }

    const scope = visible.map((item) => item.id);
    const [
      memberRows,
      jobRows,
      openJobRows,
      siteRows,
      unitRows,
      activityRows,
      auditRows,
      jobTouchRows,
    ] = await Promise.all([
      context.db
        .select({
          organisationId: memberships.organisationId,
          role: memberships.role,
          value: count(),
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        // The same two conditions `tenant-access.ts` requires before it treats
        // a grant as real, so "5 users" means five people who can sign in.
        .where(
          and(
            inArray(memberships.organisationId, scope),
            eq(memberships.status, "active"),
            eq(users.active, true),
          ),
        )
        .groupBy(memberships.organisationId, memberships.role),
      context.db
        .select({ organisationId: maintenanceRequests.organisationId, value: count() })
        .from(maintenanceRequests)
        // Stage 23 — the platform summary counts live jobs, not binned ones.
        .where(
          and(
            inArray(maintenanceRequests.organisationId, scope),
            isNull(maintenanceRequests.deletedAt),
          ),
        )
        .groupBy(maintenanceRequests.organisationId),
      context.db
        .select({ organisationId: maintenanceRequests.organisationId, value: count() })
        .from(maintenanceRequests)
        .where(
          and(
            inArray(maintenanceRequests.organisationId, scope),
            ne(maintenanceRequests.stage, "Completed"),
            isNull(maintenanceRequests.deletedAt),
          ),
        )
        .groupBy(maintenanceRequests.organisationId),
      context.db
        .select({ organisationId: sites.organisationId, value: count() })
        .from(sites)
        .where(inArray(sites.organisationId, scope))
        .groupBy(sites.organisationId),
      context.db
        .select({ organisationId: units.organisationId, value: count() })
        .from(units)
        .where(inArray(units.organisationId, scope))
        .groupBy(units.organisationId),
      context.db
        .select({
          organisationId: activityLog.organisationId,
          at: max(activityLog.createdAt),
        })
        .from(activityLog)
        .where(inArray(activityLog.organisationId, scope))
        .groupBy(activityLog.organisationId),
      context.db
        .select({
          organisationId: auditEvents.organisationId,
          at: max(auditEvents.createdAt),
        })
        .from(auditEvents)
        .where(inArray(auditEvents.organisationId, scope))
        .groupBy(auditEvents.organisationId),
      context.db
        .select({
          organisationId: maintenanceRequests.organisationId,
          at: max(maintenanceRequests.updatedAt),
        })
        .from(maintenanceRequests)
        // Stage 23 — the platform summary counts live jobs, not binned ones.
        .where(
          and(
            inArray(maintenanceRequests.organisationId, scope),
            isNull(maintenanceRequests.deletedAt),
          ),
        )
        .groupBy(maintenanceRequests.organisationId),
    ]);

    const membersByOrganisation = new Map<string, Record<string, number>>();
    for (const row of memberRows) {
      const bucket = membersByOrganisation.get(row.organisationId) ?? {};
      bucket[row.role] = (bucket[row.role] ?? 0) + row.value;
      membersByOrganisation.set(row.organisationId, bucket);
    }

    const numbers = (rows: Array<{ organisationId: string; value: number }>) =>
      new Map(rows.map((row) => [row.organisationId, row.value]));
    const stamps = (rows: Array<{ organisationId: string | null; at: string | null }>) =>
      new Map(
        rows
          .filter((row): row is { organisationId: string; at: string | null } =>
            Boolean(row.organisationId),
          )
          .map((row) => [row.organisationId, row.at]),
      );

    const jobs = numbers(jobRows);
    const openJobs = numbers(openJobRows);
    const siteCounts = numbers(siteRows);
    const unitCounts = numbers(unitRows);
    const activityAt = stamps(activityRows);
    const auditAt = stamps(auditRows);
    const jobAt = stamps(jobTouchRows);

    const clients = visible
      .map((organisation) => {
        const byRole = membersByOrganisation.get(organisation.id) ?? {};
        const userCount = Object.values(byRole).reduce((sum, value) => sum + value, 0);
        return {
          id: organisation.id,
          name: organisation.name,
          slug: organisation.slug,
          planTier: organisation.planTier,
          status: organisation.status,
          primaryColour: organisation.primaryColour,
          createdAt: organisation.createdAt,
          users: userCount,
          usersByRole: Object.fromEntries(
            Object.entries(byRole).map(([role, value]) => [
              ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role,
              value,
            ]),
          ),
          jobs: jobs.get(organisation.id) ?? 0,
          openJobs: openJobs.get(organisation.id) ?? 0,
          sites: siteCounts.get(organisation.id) ?? 0,
          units: unitCounts.get(organisation.id) ?? 0,
          // Three independent signals of "something happened here", reduced to
          // the most recent. A workspace that has only ever been administered
          // still reports a last activity; one that has never been touched
          // reports null rather than its creation date dressed up as use.
          lastActivityAt: latest(
            activityAt.get(organisation.id),
            auditAt.get(organisation.id),
            jobAt.get(organisation.id),
          ),
          isCurrent: organisation.id === context.orgId,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    return Response.json({
      clients,
      totals: {
        workspaces: clients.length,
        users: clients.reduce((sum, item) => sum + item.users, 0),
        jobs: clients.reduce((sum, item) => sum + item.jobs, 0),
        openJobs: clients.reduce((sum, item) => sum + item.openJobs, 0),
        sites: clients.reduce((sum, item) => sum + item.sites, 0),
      },
      actor: actorPayload(context),
    });
  } catch (error) {
    return adminError(error, "The client console is temporarily unavailable.");
  }
}

function emptyTotals() {
  return { workspaces: 0, users: 0, jobs: 0, openJobs: 0, sites: 0 };
}

function actorPayload(context: Exclude<Awaited<ReturnType<typeof adminContext>>, Response>) {
  return {
    email: context.identityEmail,
    role: context.actor.role,
    roleLabel: ROLE_LABELS[context.actor.role],
    currentOrganisationId: context.orgId,
    capabilities: effectiveCapabilities(context.actor.role, context.subject.capabilities),
  };
}
