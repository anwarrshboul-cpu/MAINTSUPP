import { and, eq } from "drizzle-orm";
import { getD1 } from "../../../../db";
import { ensureDatabase, seedStoreDocumentationGroups } from "../../../../db/init";
import { siteGroupMembers, siteGroups } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { listOptionValues } from "../../../lib/options-repository";
import { listSiteGroups, toSlug } from "../../../lib/sites-repository";
import { siteWriteFailure } from "../route";

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
    // Rebuilt on read rather than seeded once: membership is derived from each
    // site's lifecycle and region, so a store that closes or moves to Europe
    // has to change group without anyone maintaining a second list.
    await seedStoreDocumentationGroups(await getD1(), orgId);
    const [groups, kinds] = await Promise.all([
      listSiteGroups(db, orgId),
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
    const body = (await request.json()) as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    const name = text(data.name, 120);
    if (!name) throw new Error("A group name is required.");

    const existing = await listSiteGroups(db, orgId);
    const base = toSlug(name) || "group";
    let slug = base;
    let suffix = 2;
    while (existing.some((group) => group.slug === slug)) {
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
    const body = (await request.json()) as { id?: string; data?: Record<string, unknown> };
    const id = text(body.id, 120);
    if (!id) throw new Error("A group ID is required.");
    const data = body.data ?? {};

    const [existing] = await db
      .select()
      .from(siteGroups)
      .where(and(eq(siteGroups.id, id), eq(siteGroups.organisationId, orgId)))
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
      .where(and(eq(siteGroups.id, id), eq(siteGroups.organisationId, orgId)));
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
    const body = (await request.json()) as { id?: string };
    const id = text(body.id, 120);
    if (!id) throw new Error("A group ID is required.");

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
      .where(and(eq(siteGroups.id, id), eq(siteGroups.organisationId, orgId)));
    return Response.json({ ok: true, id });
  } catch (error) {
    const failure = siteWriteFailure(error, "The group could not be removed.");
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}
