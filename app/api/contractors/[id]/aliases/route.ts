/**
 * POST/DELETE /api/contractors/:id/aliases — map a job-side name to a record.
 *
 * This is where the linking problem in the Contractors brief stops growing. A
 * mapping written here makes every job carrying that string count towards this
 * contractor's Assigned, Completed, Completion rate, Open urgent and Spend,
 * on this page and on the Overview, because both read the same rule.
 *
 * ── THE GUARDS, AND WHY EACH ONE IS HERE ──────────────────────────────────
 *
 * `sites.edit` — the capability every write to a workspace register already
 * demands (`WORKSPACE_CAPABILITY` in `/api/workspace`), and this is one: it
 * changes what a contractor is credited with, and ultimately what somebody is
 * paid for. Inventing a `contractors.edit` here would be a seventeenth switch
 * in the permission matrix that no administrator has been shown and that
 * `stage-twentythree-capabilities` would fail for having no catalogue entry.
 *
 * The contractor must be in the CALLER'S organisation. An id is an address, not
 * a credential: the same rule `getSite` has always applied, and the reason a
 * 404 is returned for another tenant's id rather than a 403 — a 403 confirms
 * the id exists.
 *
 * One name maps to at most one record, enforced by the unique index on
 * (organisation, normalised). A duplicate is answered with the record that
 * already holds it rather than with a database error, because "Saed Electrical
 * is already linked to Saed Ltd" is something the operator can act on and
 * "UNIQUE constraint failed" is not.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../../db/init";
import { contractorNameAliases, contractors } from "../../../../../db/schema";
import { anonymousRefusal, scopedDbWithCapability } from "../../../../lib/tenant-db";
import { contractorNameKey } from "../../../../lib/contractor-linking";
import { auditActor, recordAudit } from "../../../../lib/audit";

export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json(
    {
      error:
        process.env.NODE_ENV === "development"
          ? `Preview database error: ${message}`
          : "The mapping could not be saved.",
    },
    { status: 503 },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const { id } = await params;

    const [record] = await db
      .select({ id: contractors.id, name: contractors.name })
      .from(contractors)
      .where(and(eq(contractors.id, id), eq(contractors.organisationId, orgId)))
      .limit(1);
    if (!record) {
      return Response.json({ error: "Contractor not found." }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as { alias?: unknown };
    const alias = typeof body.alias === "string" ? body.alias.trim().slice(0, 160) : "";
    if (!alias) {
      return Response.json(
        { error: "Name the job-side string this contractor answers to." },
        { status: 400 },
      );
    }
    const normalised = contractorNameKey(alias);

    const [existing] = await db
      .select({
        contractorId: contractorNameAliases.contractorId,
        alias: contractorNameAliases.alias,
      })
      .from(contractorNameAliases)
      .where(
        and(
          eq(contractorNameAliases.organisationId, orgId),
          eq(contractorNameAliases.normalised, normalised),
        ),
      )
      .limit(1);

    if (existing) {
      if (existing.contractorId === id) {
        // Already what was asked for. Idempotent rather than an error: the
        // operator's intent is satisfied and a red message would suggest
        // otherwise.
        return Response.json({ ok: true, alias: existing.alias, alreadyLinked: true });
      }
      const [holder] = await db
        .select({ name: contractors.name })
        .from(contractors)
        .where(and(eq(contractors.id, existing.contractorId), eq(contractors.organisationId, orgId)))
        .limit(1);
      return Response.json(
        {
          error: `"${alias}" is already linked to ${holder?.name ?? "another contractor"}. Unlink it there first.`,
        },
        { status: 409 },
      );
    }

    await db.insert(contractorNameAliases).values({
      id: `alias_${normalised.replace(/[^a-z0-9]+/g, "-").slice(0, 60)}_${Date.now().toString(36)}`,
      organisationId: orgId,
      contractorId: id,
      alias,
      normalised,
      createdBy: actor.email ?? null,
    });

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(guard.scope),
      action: "contractor.alias.linked",
      entityType: "contractor",
      entityId: id,
      summary: `Linked the job name "${alias}" to ${record.name}.`,
      detail: { alias, contractorId: id },
      request,
    });

    return Response.json({ ok: true, alias });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const { id } = await params;

    const url = new URL(request.url);
    const alias = (url.searchParams.get("alias") ?? "").trim();
    if (!alias) {
      return Response.json({ error: "Name the mapping to remove." }, { status: 400 });
    }

    await db
      .delete(contractorNameAliases)
      .where(
        and(
          eq(contractorNameAliases.organisationId, orgId),
          eq(contractorNameAliases.contractorId, id),
          eq(contractorNameAliases.normalised, contractorNameKey(alias)),
        ),
      );

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor(guard.scope),
      action: "contractor.alias.unlinked",
      entityType: "contractor",
      entityId: id,
      summary: `Unlinked the job name "${alias}".`,
      detail: { alias, contractorId: id },
      request,
    });

    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
