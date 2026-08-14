/**
 * Teams — named groups of people inside one workspace.
 *
 * A team is an organisational fact, not a permission. Membership answers "who
 * do I escalate this to" and "who else covers this site"; what a person may do
 * still comes from their `memberships` row and the capability table. Keeping
 * those separate is deliberate: the moment a team grants access, renaming a
 * team becomes a security change and nobody will treat it as one.
 *
 * Deleting is archiving. `archived` hides a team from the pickers but keeps its
 * rows, so last year's assignments still resolve to a name rather than to a
 * dangling id, and the audit trail for "who was on Facilities in March" is
 * still answerable.
 *
 * Everything below is scoped through `scopedDb`, so `orgId` is decided by the
 * actor's memberships and never by anything the caller sends — including the
 * `organisationId` on a team row, which is written from `orgId` and never read
 * from the body.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { memberships, teamMembers, teams, users } from "../../../db/schema";
import { auditActor, changeDetail, recordAudit } from "../../lib/audit";
import { can, requireCapability, resolvePermissions } from "../../lib/permissions";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The MAINTSUPP teal, matching the schema default. */
const DEFAULT_COLOUR = "#12B4A8";

/**
 * Who may change a team: the `teams.manage` capability, per workspace.
 *
 * Reading is open to any member — a client should be able to see who is on the
 * team that maintains their sites. Writing is checked against the capability
 * table rather than a role literal, so an admin whose `teams.manage` has been
 * withdrawn loses it here without a deploy.
 */
const MANAGE = "teams.manage" as const;

function text(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function unavailable(error?: unknown) {
  // A session that has ended is not an outage: 503 tells a browser to retry
  // something no amount of retrying will fix, and blames the workspace for
  // what a person fixes by signing in. See `anonymousRefusal`.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json({ error: "Teams are temporarily unavailable." }, { status: 503 });
}

function newId() {
  return `team_${crypto.randomUUID().replace(/-/g, "")}`;
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "team"
  );
}

type Database = Awaited<ReturnType<typeof scopedDb>>["db"];

/**
 * A slug free within this organisation.
 *
 * Uniqueness is per organisation, so two clients may both have a "Facilities"
 * team. The suffix loop is bounded because an unbounded retry on a unique index
 * is a request that never returns.
 */
async function uniqueSlug(db: Database, orgId: string, name: string, ignoreId?: string) {
  const base = slugify(name);
  const rows = await db
    .select({ id: teams.id, slug: teams.slug })
    .from(teams)
    .where(eq(teams.organisationId, orgId));
  const taken = new Set(
    rows.filter((row) => row.id !== ignoreId).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let index = 2; index < 200; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 60);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`.slice(0, 60);
}

/** Every team in the workspace, each with its members resolved to people. */
async function loadTeams(db: Database, orgId: string) {
  const rows = await db
    .select()
    .from(teams)
    .where(eq(teams.organisationId, orgId))
    .orderBy(asc(teams.position), asc(teams.name));

  const memberRows = await db
    .select({
      id: teamMembers.id,
      teamId: teamMembers.teamId,
      userId: teamMembers.userId,
      teamRole: teamMembers.teamRole,
      createdAt: teamMembers.createdAt,
      email: users.email,
      fullName: users.fullName,
      active: users.active,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.organisationId, orgId))
    .orderBy(asc(teamMembers.teamRole), asc(users.email));

  const byTeam = new Map<string, typeof memberRows>();
  for (const row of memberRows) {
    const list = byTeam.get(row.teamId) ?? [];
    list.push(row);
    byTeam.set(row.teamId, list);
  }

  return rows.map((team) => ({
    ...team,
    members: (byTeam.get(team.id) ?? []).map((member) => ({
      id: member.id,
      userId: member.userId,
      teamRole: member.teamRole,
      email: member.email,
      fullName: member.fullName,
      active: member.active,
      since: member.createdAt,
    })),
  }));
}

/**
 * The people who may be put on a team: this workspace's active memberships.
 *
 * Read from `memberships` rather than `users.organisation_id` because a person
 * created under one organisation may hold a membership in another, and it is
 * the membership that says they belong here.
 */
async function loadPeople(db: Database, orgId: string) {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
      active: users.active,
      role: memberships.role,
      status: memberships.status,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organisationId, orgId), eq(memberships.status, "active")))
    .orderBy(asc(users.email));
  return rows;
}

async function getTeam(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, id), eq(teams.organisationId, orgId)))
    .limit(1);
  return row ?? null;
}

/** GET /api/teams — every team, its members, and the people who could join. */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const [list, people, subject] = await Promise.all([
      loadTeams(scope.db, scope.orgId),
      loadPeople(scope.db, scope.orgId),
      resolvePermissions(scope.db, scope.orgId, scope.actor.role),
    ]);
    return Response.json({
      organisation: { id: scope.organisation.id, name: scope.organisation.name },
      // The screen hides its controls from this; the routes below enforce it.
      canManage: can(subject, MANAGE),
      teams: list,
      people,
    });
  } catch (error) {
    return unavailable(error);
  }
}

/** POST /api/teams — create a team. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    /* `teams.manage` decides something now. Creating, renaming, archiving a
     team and moving people between them was open to every member of the
     workspace — the capability existed in the matrix and read nothing.
     Reading the teams is not gated: a rota is meant to be legible. */
    const guard = await scopedDbWithCapability(request, "teams.manage");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const refusal = requireCapability(
      await resolvePermissions(scope.db, scope.orgId, scope.actor.role),
      MANAGE,
    );
    if (refusal) return refusal;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = text(body.name, 80);
    if (!name) return bad("A team name is required.");

    const colourInput = text(body.colourHex ?? body.colour, 7);
    const colourHex = HEX.test(colourInput) ? colourInput : DEFAULT_COLOUR;
    const description = text(body.description, 400) || null;

    const [tail] = await scope.db
      .select({ maxPosition: sql<number>`COALESCE(MAX(${teams.position}), -1)` })
      .from(teams)
      .where(eq(teams.organisationId, scope.orgId));

    const id = newId();
    const now = new Date().toISOString();
    const [created] = await scope.db
      .insert(teams)
      .values({
        id,
        organisationId: scope.orgId,
        name,
        slug: await uniqueSlug(scope.db, scope.orgId, name),
        description,
        colourHex,
        position: Number(tail?.maxPosition ?? -1) + 1,
        archived: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await recordAudit({
      db: scope.db,
      request,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "team.created",
      entityType: "team",
      entityId: id,
      summary: `Created the team "${name}".`,
      detail: { name, slug: created?.slug, colourHex, description },
    });

    return Response.json({ team: { ...created, members: [] } }, { status: 201 });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * PATCH /api/teams — rename, recolour, describe, reorder, archive or restore.
 *
 * One handler rather than four routes because they are one edit from the user's
 * point of view, and because a single before/after snapshot then covers all of
 * them: whatever moved is what the audit entry reports.
 */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    /* `teams.manage` decides something now. Creating, renaming, archiving a
     team and moving people between them was open to every member of the
     workspace — the capability existed in the matrix and read nothing.
     Reading the teams is not gated: a rota is meant to be legible. */
    const guard = await scopedDbWithCapability(request, "teams.manage");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const refusal = requireCapability(
      await resolvePermissions(scope.db, scope.orgId, scope.actor.role),
      MANAGE,
    );
    if (refusal) return refusal;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const id = text(body.id, 80);
    if (!id) return bad("Which team?");

    const existing = await getTeam(scope.db, scope.orgId, id);
    if (!existing) return bad("That team no longer exists.", 404);

    const patch: Partial<typeof teams.$inferInsert> = {};

    if (body.name !== undefined) {
      const name = text(body.name, 80);
      if (!name) return bad("A team name is required.");
      if (name !== existing.name) {
        patch.name = name;
        // The slug follows the name so links stay readable, but only when the
        // name actually moved — regenerating it on every save would churn the
        // unique index for no reason.
        patch.slug = await uniqueSlug(scope.db, scope.orgId, name, id);
      }
    }
    if (body.description !== undefined) {
      patch.description = text(body.description, 400) || null;
    }
    if (body.colourHex !== undefined || body.colour !== undefined) {
      const colour = text(body.colourHex ?? body.colour, 7);
      if (!HEX.test(colour)) return bad("A team colour must be a #rrggbb value.");
      patch.colourHex = colour;
    }
    if (body.position !== undefined) {
      const position = Number(body.position);
      if (Number.isFinite(position)) patch.position = Math.max(0, Math.trunc(position));
    }
    if (body.archived !== undefined) {
      patch.archived = body.archived === true || body.archived === "true";
    }

    if (!Object.keys(patch).length) {
      return Response.json({ team: existing, unchanged: true });
    }

    patch.updatedAt = new Date().toISOString();
    const [updated] = await scope.db
      .update(teams)
      .set(patch)
      .where(and(eq(teams.id, id), eq(teams.organisationId, scope.orgId)))
      .returning();

    const archiveChanged =
      patch.archived !== undefined && patch.archived !== existing.archived;
    const renamed = patch.name !== undefined;
    const action = archiveChanged
      ? patch.archived
        ? "team.archived"
        : "team.restored"
      : renamed
        ? "team.renamed"
        : "team.updated";
    const summary = archiveChanged
      ? patch.archived
        ? `Archived the team "${existing.name}".`
        : `Restored the team "${existing.name}".`
      : renamed
        ? `Renamed the team "${existing.name}" to "${patch.name}".`
        : `Updated the team "${existing.name}".`;

    await recordAudit({
      db: scope.db,
      request,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action,
      entityType: "team",
      entityId: id,
      summary,
      detail: changeDetail(
        {
          name: existing.name,
          description: existing.description,
          colourHex: existing.colourHex,
          position: existing.position,
          archived: existing.archived,
        },
        {
          name: updated?.name,
          description: updated?.description,
          colourHex: updated?.colourHex,
          position: updated?.position,
          archived: updated?.archived,
        },
      ),
    });

    return Response.json({ team: updated });
  } catch (error) {
    return unavailable(error);
  }
}
