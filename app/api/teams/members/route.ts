/**
 * Team membership — who is on a team, and who leads it.
 *
 * A person may be on several teams; nothing here is exclusive. `team_role` is
 * "lead" or "member" and means escalation, not authority — a lead cannot do
 * anything a member cannot. See `app/api/teams/route.ts` for why.
 *
 * Removing a member deletes the join row, which is the only place in Stage 20
 * where a delete is correct: the row is a statement about the present, and a
 * workspace that cannot take somebody off a rota is not usable. The history is
 * not lost with it — every add, removal and role change writes an audit event
 * carrying the person, the team and the role, so "who was on Facilities in
 * March" is answered from `/dashboard/audit` rather than from a tombstone
 * column nobody would maintain.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { memberships, teamMembers, teams, users } from "../../../../db/schema";
import { auditActor, recordAudit } from "../../../lib/audit";
import { requireCapability, resolvePermissions } from "../../../lib/permissions";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/** Same capability as the team itself: who is on a team is part of the team. */
const MANAGE = "teams.manage" as const;
const TEAM_ROLES = new Set(["lead", "member"]);

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
  return Response.json(
    { error: "Team membership is temporarily unavailable." },
    { status: 503 },
  );
}

type Scope = Awaited<ReturnType<typeof scopedDb>>;

/**
 * Resolves the team and the person, refusing anything outside this workspace.
 *
 * Both lookups are filtered on `orgId`, so passing another organisation's team
 * id or user id reads as "not found" rather than as a cross-tenant write. The
 * person must hold an active membership here: adding an outsider to a team
 * would put their name in front of a client they have no relationship with.
 */
async function resolvePair(scope: Scope, teamId: string, userId: string) {
  const [team] = await scope.db
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.organisationId, scope.orgId)))
    .limit(1);
  if (!team) return { error: bad("That team no longer exists.", 404) } as const;

  const [person] = await scope.db
    .select({
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.organisationId, scope.orgId),
        eq(memberships.status, "active"),
        eq(users.id, userId),
      ),
    )
    .limit(1);
  if (!person) {
    return { error: bad("That person is not a member of this workspace.", 404) } as const;
  }

  return { team, person } as const;
}

function personLabel(person: { email: string; fullName: string | null }) {
  return person.fullName?.trim() || person.email;
}

/**
 * POST /api/teams/members — add somebody, or change the role they hold.
 *
 * Idempotent by design. The unique index on (team_id, user_id) means a repeat
 * add is not an error, it is a role update, and treating it as one keeps the
 * UI's "make lead" and "add" the same call.
 */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    /* `teams.manage` — see app/api/teams/route.ts. */
    const guard = await scopedDbWithCapability(request, "teams.manage");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const refusal = requireCapability(
      await resolvePermissions(scope.db, scope.orgId, scope.actor.role),
      MANAGE,
    );
    if (refusal) return refusal;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const teamId = text(body.teamId, 80);
    const userId = text(body.userId, 80);
    if (!teamId || !userId) return bad("A team and a person are both required.");

    const teamRoleInput = text(body.teamRole, 20) || "member";
    if (!TEAM_ROLES.has(teamRoleInput)) {
      return bad('A team role must be either "lead" or "member".');
    }

    const resolved = await resolvePair(scope, teamId, userId);
    if ("error" in resolved) return resolved.error;
    const { team, person } = resolved;

    const [existing] = await scope.db
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.organisationId, scope.orgId),
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, userId),
        ),
      )
      .limit(1);

    const who = personLabel(person);

    if (existing) {
      if (existing.teamRole === teamRoleInput) {
        return Response.json({ member: existing, unchanged: true });
      }
      const [updated] = await scope.db
        .update(teamMembers)
        .set({ teamRole: teamRoleInput })
        .where(
          and(eq(teamMembers.id, existing.id), eq(teamMembers.organisationId, scope.orgId)),
        )
        .returning();

      await recordAudit({
        db: scope.db,
        request,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: "team.member_role_changed",
        entityType: "team_member",
        entityId: existing.id,
        summary:
          teamRoleInput === "lead"
            ? `Made ${who} lead of "${team.name}".`
            : `${who} is no longer lead of "${team.name}".`,
        detail: {
          teamId,
          teamName: team.name,
          userId,
          email: person.email,
          changed: ["teamRole"],
          before: { teamRole: existing.teamRole },
          after: { teamRole: teamRoleInput },
        },
      });

      return Response.json({ member: updated });
    }

    const id = `tmem_${crypto.randomUUID().replace(/-/g, "")}`;
    const [created] = await scope.db
      .insert(teamMembers)
      .values({
        id,
        organisationId: scope.orgId,
        teamId,
        userId,
        teamRole: teamRoleInput,
        createdAt: new Date().toISOString(),
      })
      .returning();

    await recordAudit({
      db: scope.db,
      request,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "team.member_added",
      entityType: "team_member",
      entityId: id,
      summary: `Added ${who} to "${team.name}"${teamRoleInput === "lead" ? " as lead" : ""}.`,
      detail: {
        teamId,
        teamName: team.name,
        userId,
        email: person.email,
        teamRole: teamRoleInput,
      },
    });

    return Response.json({ member: created }, { status: 201 });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * DELETE /api/teams/members — take somebody off a team.
 *
 * Accepts the pair in the body or in the query string. A DELETE with a body is
 * legal but awkward for some clients, and this is one of the few calls that is
 * worth being able to make with a bare URL when proving behaviour by hand.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    /* `teams.manage` — see app/api/teams/route.ts. */
    const guard = await scopedDbWithCapability(request, "teams.manage");
    if (guard.denied) return guard.denied;
    const scope = guard.scope;
    const refusal = requireCapability(
      await resolvePermissions(scope.db, scope.orgId, scope.actor.role),
      MANAGE,
    );
    if (refusal) return refusal;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const url = new URL(request.url);
    const teamId = text(body.teamId, 80) || text(url.searchParams.get("teamId"), 80);
    const userId = text(body.userId, 80) || text(url.searchParams.get("userId"), 80);
    if (!teamId || !userId) return bad("A team and a person are both required.");

    const resolved = await resolvePair(scope, teamId, userId);
    if ("error" in resolved) return resolved.error;
    const { team, person } = resolved;

    const [existing] = await scope.db
      .select()
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.organisationId, scope.orgId),
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, userId),
        ),
      )
      .limit(1);
    if (!existing) return Response.json({ ok: true, removed: false });

    await scope.db
      .delete(teamMembers)
      .where(
        and(eq(teamMembers.id, existing.id), eq(teamMembers.organisationId, scope.orgId)),
      );

    const who = personLabel(person);
    // Recorded with the role they held and the date they joined, so the removed
    // row remains reconstructable from the log alone.
    await recordAudit({
      db: scope.db,
      request,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "team.member_removed",
      entityType: "team_member",
      entityId: existing.id,
      summary: `Removed ${who} from "${team.name}".`,
      detail: {
        teamId,
        teamName: team.name,
        userId,
        email: person.email,
        changed: ["member"],
        before: { teamRole: existing.teamRole, since: existing.createdAt },
        after: null,
      },
    });

    return Response.json({ ok: true, removed: true });
  } catch (error) {
    return unavailable(error);
  }
}
