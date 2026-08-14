/**
 * Stage 23 — `GET | POST | PATCH | DELETE /api/workspace-sections`.
 *
 * The owner asked for what a monday workspace does: "to the workspace I should
 * be able to add more or remove sections — for example I might need to add the
 * CCTV section." This is that, and adding one is a row rather than a deploy.
 *
 * THE TWO RULES THIS HAD TO KEEP
 *
 * 1. A saved layout is an ARRANGEMENT, never an inventory. So this endpoint
 *    writes to a *different* table than `/api/navigation` does. Creating a
 *    section does not touch anybody's stored arrangement; the section joins the
 *    catalogue, and the existing three-layer merge puts it at the end of its
 *    heading, visible, for everyone — including people who arranged their
 *    sidebar long before it existed. Archiving one removes it from the
 *    catalogue and again touches nobody's arrangement, so a section restored
 *    next week comes back where it was.
 *
 * 2. Add must not invent a destination. A section names a `surface` from
 *    `SECTION_SURFACES`, every one of which is a screen `portal-app.tsx`
 *    already renders. There is no way to write a row that points at nothing.
 *
 * WHO MAY WRITE
 *
 * `settings.edit`, through `scopedDbWithCapability` — the established pattern,
 * and the same capability that guards the workspace default dashboard. Not a
 * role check: an admin whose `settings.edit` has been revoked in Roles must be
 * refused here too, and a role check would wave them through. Reading is open
 * to any member, because the sidebar has to be drawable by everybody.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  boards,
  navigationLayouts,
  sectionViewPreferences,
  workspaceSections,
} from "../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability, type ScopedDatabase } from "../../lib/tenant-db";
import {
  DEFAULT_ICON,
  DEFAULT_SURFACE,
  SECTION_SURFACES,
  cleanSectionLabel,
  isGroupChoice,
  isIconName,
  isSurfaceKey,
  isWorkspaceSectionKey,
  sectionKeyFrom,
  surfaceDefinition,
  type SurfaceKey,
  type WorkspaceSection,
} from "./catalogue";
import { BUILT_IN_GROUPS, FALLBACK_GROUP } from "../navigation/layout";

/** The headings a section may be filed under. `layout.ts` is the authority. */
const GROUP_KEYS = BUILT_IN_GROUPS.map((group) => group.key);

export const dynamic = "force-dynamic";

type SectionRow = typeof workspaceSections.$inferSelect;

/** How many sections one workspace may define. A sidebar is not a filing cabinet. */
const MAX_SECTIONS = 40;

function toSection(row: SectionRow): WorkspaceSection {
  const surface = isSurfaceKey(row.surface) ? row.surface : DEFAULT_SURFACE;
  const definition = surfaceDefinition(surface);
  return {
    key: row.key,
    label: row.label,
    icon: isIconName(row.icon) ? row.icon : DEFAULT_ICON,
    surface,
    // The row's own board when it has one, otherwise whatever the surface is
    // bound to. Stored separately so pointing a section at a different board is
    // a row change rather than a release.
    boardKey: row.surfaceRef ?? definition?.boardKey ?? null,
    group: isGroupChoice(row.groupKey, GROUP_KEYS) ? row.groupKey : FALLBACK_GROUP,
    position: row.position,
    archived: row.archivedAt !== null,
  };
}

/**
 * Every section this workspace has defined, live and archived.
 *
 * Exported because `GET /api/navigation` needs exactly this list to build its
 * catalogue, and a second query written there would be a second chance to
 * forget the organisation filter.
 */
export async function loadWorkspaceSections(
  db: ScopedDatabase["db"],
  orgId: string,
): Promise<WorkspaceSection[]> {
  const rows = await db
    .select()
    .from(workspaceSections)
    .where(eq(workspaceSections.organisationId, orgId));
  return rows.map(toSection);
}

async function findByKey(context: ScopedDatabase, key: string) {
  const [row] = await context.db
    .select()
    .from(workspaceSections)
    .where(
      and(
        eq(workspaceSections.organisationId, context.orgId),
        eq(workspaceSections.key, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The board a section may be bound to.
 *
 * Only surfaces that already have a board accept one, and the board must exist
 * in *this* organisation — checked against the `boards` table rather than an
 * allow-list, so a board added later works with no change here. An unknown key
 * is refused rather than quietly ignored: a section silently pointed at the
 * wrong board is the kind of wrong that looks right.
 */
async function resolveSurfaceRef(
  context: ScopedDatabase,
  surface: SurfaceKey,
  requested: unknown,
): Promise<{ error: string } | { boardKey: string | null }> {
  const definition = surfaceDefinition(surface);
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return { boardKey: null };
  if (!definition?.boardKey) {
    return {
      error: `The "${surface}" surface has no board, so it cannot be pointed at one.`,
    };
  }
  const [row] = await context.db
    .select({ key: boards.key })
    .from(boards)
    .where(and(eq(boards.organisationId, context.orgId), eq(boards.key, raw)))
    .limit(1);
  if (!row) return { error: `There is no board called "${raw}" in this workspace.` };
  return { boardKey: row.key };
}

/** The next position: after everything, so a new section lands at the bottom. */
async function nextPosition(context: ScopedDatabase) {
  const [row] = await context.db
    .select({
      value: sql<number>`COALESCE(MAX(${workspaceSections.position}), -1)`,
    })
    .from(workspaceSections)
    .where(eq(workspaceSections.organisationId, context.orgId));
  return Number(row?.value ?? -1) + 1;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const context = await scopedDb(request);
    const sections = await loadWorkspaceSections(context.db, context.orgId);
    const guard = await scopedDbWithCapability(request, "settings.edit");
    return Response.json({
      sections: sections.sort((left, right) => left.position - right.position),
      /* What a section is allowed to be, so the editor does not need a second
         copy of the list and cannot offer a surface the server would refuse. */
      surfaces: SECTION_SURFACES,
      /* Stated rather than inferred from the role, because a role whose
         `settings.edit` was revoked in Roles is still called "Admin". */
      canEdit: !guard.denied,
      role: context.actor.role,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message =
      error instanceof Error ? error.message : "The workspace sections could not be loaded.";
    return Response.json({ error: message }, { status: 503 });
  }
}

/** POST — add a section. Body: `{ label, icon?, surface?, group?, board? }`. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const context = guard.scope;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const label = cleanSectionLabel(body.label);
    if (!label) {
      return Response.json({ error: "Give the section a name." }, { status: 400 });
    }
    const key = sectionKeyFrom({ key: body.key, label });
    if (!key) {
      return Response.json(
        { error: "That name has no letters or digits in it, so it cannot be addressed." },
        { status: 400 },
      );
    }

    /* An absent surface takes the default; a NAMED one that does not exist is
       refused. Falling back would hand somebody who asked for a screen we do
       not have a job board instead, and they would have no way to tell — a
       silent substitution is worse than a refusal. */
    if (body.surface !== undefined && !isSurfaceKey(body.surface)) {
      return Response.json(
        {
          error: "That is not a screen this product renders.",
          surfaces: SECTION_SURFACES.map((surface) => surface.key),
        },
        { status: 400 },
      );
    }
    const surface = isSurfaceKey(body.surface) ? body.surface : DEFAULT_SURFACE;
    const board = await resolveSurfaceRef(context, surface, body.board ?? body.surfaceRef);
    if ("error" in board) {
      return Response.json({ error: board.error }, { status: 400 });
    }

    const existing = await findByKey(context, key);
    if (existing) {
      /* An archived section reappearing under its old name is a RESTORE, not a
         duplicate. Refusing here would leave the owner unable to re-add a
         section they removed, with no clue why — the row they cannot see is in
         the way. */
      if (existing.archivedAt) {
        return Response.json(
          {
            error: `"${existing.label}" was removed and is archived. Restore it instead of adding it again.`,
            archived: true,
            key,
          },
          { status: 409 },
        );
      }
      return Response.json(
        { error: `A section called "${existing.label}" already exists.`, key },
        { status: 409 },
      );
    }

    const [{ value: count }] = await context.db
      .select({ value: sql<number>`COUNT(*)` })
      .from(workspaceSections)
      .where(
        and(
          eq(workspaceSections.organisationId, context.orgId),
          isNull(workspaceSections.archivedAt),
        ),
      );
    if (Number(count) >= MAX_SECTIONS) {
      return Response.json(
        { error: `A workspace can have ${MAX_SECTIONS} added sections.` },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    await context.db.insert(workspaceSections).values({
      id: `wsec_${crypto.randomUUID().replace(/-/g, "")}`,
      organisationId: context.orgId,
      key,
      label,
      icon: isIconName(body.icon) ? body.icon : DEFAULT_ICON,
      surface,
      surfaceRef: board.boardKey,
      groupKey: isGroupChoice(body.group, GROUP_KEYS) ? body.group : FALLBACK_GROUP,
      position: await nextPosition(context),
      createdBy: context.identityEmail,
      createdAt: now,
      updatedAt: now,
    });

    const created = await findByKey(context, key);
    return Response.json({ section: created ? toSection(created) : null }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The section could not be added.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * PATCH — rename, re-icon, re-home, restore, or reorder.
 *
 * Two shapes, because reordering is a different operation from editing one row:
 *   `{ key, label?, icon?, surface?, group?, board?, archived? }`
 *   `{ order: ["section:cctv", "section:fire", …] }`
 *
 * The reorder form takes keys rather than `{ key, position }` pairs on purpose:
 * a client that sends a list cannot send two sections the same position, so the
 * invalid state is unrepresentable rather than validated.
 */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const context = guard.scope;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (Array.isArray(body.order)) {
      const wanted = body.order
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => isWorkspaceSectionKey(value));
      const known = new Map(
        (await loadWorkspaceSections(context.db, context.orgId)).map((section) => [
          section.key,
          section,
        ]),
      );
      /* Only keys this workspace actually has. An unknown key is ignored rather
         than 400: the browser's list can be a moment stale, and a reorder that
         refuses the whole request because one section was archived elsewhere
         would be worse than one that orders what is there. */
      const ordered = wanted.filter((key) => known.has(key));
      const now = new Date().toISOString();
      for (const [index, key] of ordered.entries()) {
        await context.db
          .update(workspaceSections)
          .set({ position: index, updatedAt: now })
          .where(
            and(
              eq(workspaceSections.organisationId, context.orgId),
              eq(workspaceSections.key, key),
            ),
          );
      }
      /* Anything the list did not mention keeps its relative order after the
         ones that were named — the same "no opinion means no change" the layout
         merge uses, rather than collapsing unmentioned rows to position 0. */
      const trailing = [...known.values()]
        .filter((section) => !ordered.includes(section.key))
        .sort((left, right) => left.position - right.position);
      for (const [index, section] of trailing.entries()) {
        await context.db
          .update(workspaceSections)
          .set({ position: ordered.length + index, updatedAt: now })
          .where(
            and(
              eq(workspaceSections.organisationId, context.orgId),
              eq(workspaceSections.key, section.key),
            ),
          );
      }
      return Response.json({
        ok: true,
        order: [...ordered, ...trailing.map((section) => section.key)],
      });
    }

    const key = typeof body.key === "string" ? body.key.trim() : "";
    const row = key ? await findByKey(context, key) : null;
    if (!row) {
      return Response.json({ error: "That section does not exist." }, { status: 404 });
    }

    const patch: Partial<typeof workspaceSections.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };

    if (body.label !== undefined) {
      const label = cleanSectionLabel(body.label);
      if (!label) {
        return Response.json({ error: "Give the section a name." }, { status: 400 });
      }
      patch.label = label;
    }
    if (body.icon !== undefined) {
      if (!isIconName(body.icon)) {
        return Response.json(
          { error: "That is not an icon this product ships." },
          { status: 400 },
        );
      }
      patch.icon = body.icon;
    }
    if (body.group !== undefined) {
      if (!isGroupChoice(body.group, GROUP_KEYS)) {
        return Response.json({ error: "That heading does not exist." }, { status: 400 });
      }
      patch.groupKey = body.group;
    }
    if (body.surface !== undefined) {
      if (!isSurfaceKey(body.surface)) {
        return Response.json(
          { error: "That is not a screen this product renders." },
          { status: 400 },
        );
      }
      patch.surface = body.surface;
      // Re-validated against the NEW surface, so moving a board section to a
      // board-less one cannot leave a stale board key behind it.
      const board = await resolveSurfaceRef(
        context,
        body.surface,
        body.board ?? body.surfaceRef ?? (surfaceDefinition(body.surface)?.boardKey ? row.surfaceRef : null),
      );
      if ("error" in board) return Response.json({ error: board.error }, { status: 400 });
      patch.surfaceRef = board.boardKey;
    } else if (body.board !== undefined || body.surfaceRef !== undefined) {
      const surface = isSurfaceKey(row.surface) ? row.surface : DEFAULT_SURFACE;
      const board = await resolveSurfaceRef(context, surface, body.board ?? body.surfaceRef);
      if ("error" in board) return Response.json({ error: board.error }, { status: 400 });
      patch.surfaceRef = board.boardKey;
    }
    if (body.archived !== undefined) {
      /* Restore is a PATCH rather than its own verb because it is the exact
         inverse of the DELETE below, and nothing else about the row changes. */
      patch.archivedAt = body.archived === true ? new Date().toISOString() : null;
    }

    await context.db
      .update(workspaceSections)
      .set(patch)
      .where(
        and(
          eq(workspaceSections.organisationId, context.orgId),
          eq(workspaceSections.key, row.key),
        ),
      );

    const updated = await findByKey(context, row.key);
    return Response.json({ section: updated ? toSection(updated) : null });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The section could not be changed.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * What still points at a section — the reason a purge can be refused.
 *
 * A stored arrangement naming the key, and any remembered or default view for
 * it. Neither is "content" in the sense of rows a user typed, but both are work
 * somebody did, and both come back intact if the section is restored. That is
 * what makes archiving the safe default and purging the deliberate act.
 */
async function referencesTo(context: ScopedDatabase, key: string) {
  const [layouts, views] = await Promise.all([
    context.db
      .select({ id: navigationLayouts.id, items: navigationLayouts.items })
      .from(navigationLayouts)
      .where(eq(navigationLayouts.organisationId, context.orgId)),
    context.db
      .select({ id: sectionViewPreferences.id })
      .from(sectionViewPreferences)
      .where(
        and(
          eq(sectionViewPreferences.organisationId, context.orgId),
          eq(sectionViewPreferences.sectionKey, key),
        ),
      ),
  ]);
  const arrangements = layouts.filter((row) => {
    try {
      const parsed = JSON.parse(row.items) as unknown;
      return (
        Array.isArray(parsed) &&
        parsed.some(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            (entry as Record<string, unknown>).key === key,
        )
      );
    } catch {
      return false;
    }
  }).length;
  return { arrangements, views: views.length };
}

/**
 * DELETE — remove a section. `?key=section:cctv`, optionally `&purge=1`.
 *
 * ARCHIVE IS THE DEFAULT, AND THAT IS THE POINT.
 *
 * Removing a nav item must not be a way to lose work. An archived section drops
 * out of the catalogue, so it stops being drawn in every sidebar immediately —
 * no arrangement is rewritten, no stored layout is migrated, and restoring it
 * puts it back exactly where it was, with the view everybody was landing on
 * still chosen. A hard delete throws all of that away, so it is a separate,
 * explicit request, and it is REFUSED while anything still refers to the
 * section. Silently dropping those rows is the one outcome not on offer.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const context = guard.scope;

    const params = new URL(request.url).searchParams;
    const key = (params.get("key") ?? "").trim();
    const row = key ? await findByKey(context, key) : null;
    if (!row) {
      return Response.json({ error: "That section does not exist." }, { status: 404 });
    }

    const purge = params.get("purge") === "1" || params.get("purge") === "true";
    if (!purge) {
      if (row.archivedAt) {
        return Response.json({ ok: true, key: row.key, archived: true, alreadyArchived: true });
      }
      await context.db
        .update(workspaceSections)
        .set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(workspaceSections.organisationId, context.orgId),
            eq(workspaceSections.key, row.key),
          ),
        );
      return Response.json({ ok: true, key: row.key, archived: true });
    }

    const references = await referencesTo(context, row.key);
    if (references.arrangements > 0 || references.views > 0) {
      return Response.json(
        {
          error:
            "This section is still referred to by a saved sidebar or a chosen view, so it was archived rather than deleted. Nothing was lost.",
          key: row.key,
          archived: true,
          references,
        },
        { status: 409 },
      );
    }

    await context.db
      .delete(workspaceSections)
      .where(
        and(
          eq(workspaceSections.organisationId, context.orgId),
          eq(workspaceSections.key, row.key),
        ),
      );
    return Response.json({ ok: true, key: row.key, deleted: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The section could not be removed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
