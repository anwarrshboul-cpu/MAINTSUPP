import { and, eq } from "drizzle-orm";
import { getD1 } from "../../../../db";
import { ensureDatabase, seedStoreDocumentationGroups } from "../../../../db/init";
import { siteGroupMembers, siteGroups } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { listOptionValues } from "../../../lib/options-repository";
import { claimedGroupSlugs, listSiteGroups, toSlug } from "../../../lib/sites-repository";
import { siteWriteFailure } from "../route";
/* W2 — reporting groups belong to one register. See `register-scope.ts`. */
import {
  registerScopeFilter,
  resolveRegisterScope,
  scopeRefusal,
  CANONICAL_REGISTER,
} from "../../../lib/register-scope";

function text(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function colour(value: unknown, fallback: string) {
  const raw = text(value, 9);
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const resolved = await resolveRegisterScope(
      db,
      orgId,
      new URL(request.url),
      "sites",
    );
    const refused = scopeRefusal(resolved);
    if (refused) return refused;
    const scope = resolved.ok ? resolved.scope : CANONICAL_REGISTER;
    /*
     * Rebuilt on read rather than seeded once: membership is derived from each
     * site's lifecycle and region, so a store that closes or moves to Europe
     * has to change group without anyone maintaining a second list.
     *
     * W2 — the seeder runs for the CANONICAL register only, and deliberately.
     * It derives the four store-documentation groups from the workspace's own
     * estate; running it against an instance would furnish a register the
     * owner asked to be EMPTY with four groups and the canonical sites'
     * membership, which is the copy-the-live-board mistake W02-06 rules out.
     */
    if (scope === CANONICAL_REGISTER) {
      await seedStoreDocumentationGroups(await getD1(), orgId);
    }
    const [groups, kinds] = await Promise.all([
      listSiteGroups(db, orgId, scope),
      /* Group KINDS are a workspace vocabulary, not register rows — see the
         same decision for site types in `app/api/sites/route.ts`. */
      listOptionValues(db, orgId, "site_group_kind"),
    ]);
    return Response.json({ groups, kinds });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const failure = siteWriteFailure(error, "Site groups could not be loaded.");
    return Response.json({ error: failure.message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const resolved = await resolveRegisterScope(
      db,
      orgId,
      new URL(request.url),
      "sites",
    );
    const refused = scopeRefusal(resolved);
    if (refused) return refused;
    const scope = resolved.ok ? resolved.scope : CANONICAL_REGISTER;
    const body = (await request.json()) as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    const name = text(data.name, 120);
    if (!name) throw new Error("A group name is required.");

    /*
     * The slug is de-duplicated against the WHOLE ORGANISATION, not against
     * this register, because `site_groups_organisation_slug_idx` is still on
     * (organisation_id, slug) and the insert would be rejected by the database
     * otherwise. `existing` is therefore read twice with different scopes: the
     * wide one decides the slug, the narrow one decides the position.
     */
    const claimed = await claimedGroupSlugs(db, orgId);
    const existing = await listSiteGroups(db, orgId, scope);
    const base = toSlug(name) || "group";
    let slug = base;
    let suffix = 2;
    while (claimed.has(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }

    const id = `sgrp-${slug}-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(siteGroups).values({
      id,
      organisationId: orgId,
      name,
      slug,
      kind: text(data.kind, 40) || "region",
      colourHex: colour(data.colourHex, "#12B4A8"),
      /* W2 — the register this group belongs to, written at INSERT. NULL is
         the canonical register, so a create with no `?section=` is exactly
         what it was before this column existed. */
      boardId: scope,
      position: existing.length,
    });
    return Response.json({ ok: true, id });
  } catch (error) {
    const failure = siteWriteFailure(error, "The group could not be created.");
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const resolved = await resolveRegisterScope(
      db,
      orgId,
      new URL(request.url),
      "sites",
    );
    const refused = scopeRefusal(resolved);
    if (refused) return refused;
    const scope = resolved.ok ? resolved.scope : CANONICAL_REGISTER;
    const body = (await request.json()) as { id?: string; data?: Record<string, unknown> };
    const id = text(body.id, 120);
    if (!id) throw new Error("A group ID is required.");
    const data = body.data ?? {};

    const [existing] = await db
      .select()
      .from(siteGroups)
      .where(
        and(
          eq(siteGroups.id, id),
          eq(siteGroups.organisationId, orgId),
          registerScopeFilter(siteGroups.boardId, scope),
        ),
      )
      .limit(1);
    if (!existing) return Response.json({ error: "Group not found." }, { status: 404 });

    await db
      .update(siteGroups)
      .set({
        name: text(data.name, 120) || existing.name,
        kind: text(data.kind, 40) || existing.kind,
        colourHex: colour(data.colourHex, existing.colourHex),
        active: typeof data.active === "boolean" ? data.active : existing.active,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(siteGroups.id, id),
          eq(siteGroups.organisationId, orgId),
          registerScopeFilter(siteGroups.boardId, scope),
        ),
      );
    return Response.json({ ok: true, id });
  } catch (error) {
    const failure = siteWriteFailure(error, "The group could not be updated.");
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

/** Removing a group detaches its sites; the sites themselves are untouched. */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "sites.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const resolved = await resolveRegisterScope(
      db,
      orgId,
      new URL(request.url),
      "sites",
    );
    const refused = scopeRefusal(resolved);
    if (refused) return refused;
    const scope = resolved.ok ? resolved.scope : CANONICAL_REGISTER;
    const body = (await request.json()) as { id?: string };
    const id = text(body.id, 120);
    if (!id) throw new Error("A group ID is required.");

    /*
     * Look first, so a refusal reads as one.
     *
     * Both DELETEs below are organisation-scoped, so a group belonging to
     * another tenant was never actually touched — the isolation was already
     * sound. What was wrong was the answer: `{ ok: true }`, 200, for an id that
     * does not exist here. A caller deleting another tenant's group, or simply
     * a stale id, was told the removal had happened. `PATCH` already answers
     * "Group not found." for exactly this, and the two now agree.
     */
    const [existing] = await db
      .select({ id: siteGroups.id })
      .from(siteGroups)
      .where(
        and(
          eq(siteGroups.id, id),
          eq(siteGroups.organisationId, orgId),
          registerScopeFilter(siteGroups.boardId, scope),
        ),
      )
      .limit(1);
    if (!existing) {
      return Response.json({ error: "Group not found." }, { status: 404 });
    }

    await db
      .delete(siteGroupMembers)
      .where(
        and(
          eq(siteGroupMembers.organisationId, orgId),
          eq(siteGroupMembers.siteGroupId, id),
        ),
      );
    await db
      .delete(siteGroups)
      .where(
        and(
          eq(siteGroups.id, id),
          eq(siteGroups.organisationId, orgId),
          registerScopeFilter(siteGroups.boardId, scope),
        ),
      );
    return Response.json({ ok: true, id });
  } catch (error) {
    const failure = siteWriteFailure(error, "The group could not be removed.");
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}
