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
import { auditActor, recordAudit } from "../../lib/audit";
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
import { can, resolvePermissions } from "../../lib/permissions";

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
    description: row.description ?? null,
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
      /* Cleaned through `visibleText`'s rules like the label, so a description
         of three zero-width spaces is stored as absent rather than as a blurb
         that renders blank — the cleaner answers null for text that is not
         really there. */
      description: cleanSectionLabel(body.description, 240) || null,
      surface,
      surfaceRef: board.boardKey,
      groupKey: isGroupChoice(body.group, GROUP_KEYS) ? body.group : FALLBACK_GROUP,
      position: await nextPosition(context),
      createdBy: context.identityEmail,
      createdAt: now,
      updatedAt: now,
    });

    const created = await findByKey(context, key);
    await recordSectionChange(context, request, "workspace.section_created", key, `Added the "${label}" workspace section.`, { key, label, surface, board: board.boardKey });
    return Response.json({ section: created ? toSection(created) : null }, { status: 201 });
  } catch (error) {
    /* A session that has ended is not a bad request. Without this an expired
       session answered 400 here while the GET beside it answered 401
       {signIn:true}, and `installSessionGuard` bounces to /login only on the
       401 — so a save made just after a session lapsed failed silently and the
       person was left looking at a form that would never work again. */
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
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
      const order = [...ordered, ...trailing.map((section) => section.key)];
      await recordSectionChange(
        context,
        request,
        "workspace.sections_reordered",
        order[0] ?? "",
        `Reordered the workspace's added sections.`,
        { order },
      );
      return Response.json({ ok: true, order });
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
    if (body.description !== undefined) {
      // Explicitly clearable: an empty string means "no description", which is
      // NULL, not the literal "".
      patch.description = cleanSectionLabel(body.description, 240) || null;
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
    await recordSectionChange(
      context,
      request,
      "workspace.section_updated",
      row.key,
      `Changed the "${updated?.label ?? row.label}" workspace section.`,
      { key: row.key, before: toSection(row), after: updated ? toSection(updated) : null },
    );
    return Response.json({ section: updated ? toSection(updated) : null });
  } catch (error) {
    /* A session that has ended is not a bad request. Without this an expired
       session answered 400 here while the GET beside it answered 401
       {signIn:true}, and `installSessionGuard` bounces to /login only on the
       401 — so a save made just after a session lapsed failed silently and the
       person was left looking at a form that would never work again. */
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message =
      error instanceof Error ? error.message : "The section could not be changed.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * One audit line about a workspace section.
 *
 * A section is a nav destination the whole workspace shares — adding, renaming,
 * re-homing, archiving or deleting one changes the product for every colleague,
 * which is exactly the class of change W13-05 asks to be attributable. Wrapped
 * in one helper because five call sites in this file would otherwise each
 * assemble the same actor and the same request context by hand.
 */
async function recordSectionChange(
  context: ScopedDatabase,
  request: Request,
  action: string,
  key: string,
  summary: string,
  detail: unknown,
) {
  await recordAudit({
    db: context.db,
    organisationId: context.orgId,
    actor: auditActor(context),
    action,
    entityType: "workspace_section",
    entityId: key,
    summary,
    detail,
    request,
  });
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
 * May this caller destroy a section outright, as opposed to archiving one?
 *
 * `data.delete`, not `settings.edit`. The two verbs on this endpoint are not
 * the same kind of act and were behind the same capability, which meant an
 * `admin` — who holds `settings.edit` by default and is deliberately NOT given
 * `data.delete`, because "archiving is reversible and deletion is not"
 * (`app/lib/permissions.ts`) — could permanently destroy a section while being
 * refused the permanent deletion of a single row by `/api/trash`. This is the
 * platform's own stated rule applied to the one destructive verb in this file;
 * `/api/trash` and `/api/files/[id]` already read it exactly this way.
 */
async function mayPurge(context: ScopedDatabase) {
  const subject = await resolvePermissions(
    context.db,
    context.orgId,
    context.actor.role,
  );
  return can(subject, "data.delete");
}

/**
 * Forget every trace of a section that is about to stop existing.
 *
 * Its remembered and default views, and its name in every stored arrangement —
 * the workspace default and each person's own. `resolveNavigation` already
 * drops a key the catalogue no longer holds, so leaving these behind would draw
 * nothing; removing them is what stops a purge leaving rows nothing can ever
 * reach again, and what makes the browser's confirmation true when it says the
 * arrangement goes with the section.
 *
 * The arrangements are rewritten one row at a time because the key lives inside
 * a JSON blob. There is one row per person per organisation, so this is a small
 * loop over a small table, and it runs only on the deliberate destructive path.
 */
async function forgetSection(context: ScopedDatabase, key: string) {
  await context.db
    .delete(sectionViewPreferences)
    .where(
      and(
        eq(sectionViewPreferences.organisationId, context.orgId),
        eq(sectionViewPreferences.sectionKey, key),
      ),
    );

  const layouts = await context.db
    .select({
      id: navigationLayouts.id,
      items: navigationLayouts.items,
      locked: navigationLayouts.locked,
    })
    .from(navigationLayouts)
    .where(eq(navigationLayouts.organisationId, context.orgId));

  for (const layout of layouts) {
    let items: unknown;
    let locked: unknown;
    try {
      items = JSON.parse(layout.items) as unknown;
      locked = JSON.parse(layout.locked) as unknown;
    } catch {
      // A row that will not parse is already treated as "no opinion" by every
      // reader. Rewriting it here would be the first thing to give it meaning.
      continue;
    }
    if (!Array.isArray(items) && !Array.isArray(locked)) continue;
    const keptItems = Array.isArray(items)
      ? items.filter(
          (entry) =>
            !(
              entry &&
              typeof entry === "object" &&
              (entry as Record<string, unknown>).key === key
            ),
        )
      : [];
    const keptLocked = Array.isArray(locked)
      ? locked.filter((entry) => entry !== key)
      : [];
    const changed =
      (Array.isArray(items) && keptItems.length !== items.length) ||
      (Array.isArray(locked) && keptLocked.length !== locked.length);
    if (!changed) continue;
    await context.db
      .update(navigationLayouts)
      .set({
        items: JSON.stringify(keptItems),
        locked: JSON.stringify(keptLocked),
        updatedAt: new Date().toISOString(),
      })
      /* Scoped by organisation as well as by id. Every other write in this file
         names both, and an id-only WHERE would be safe here only because the
         SELECT above was scoped — a property of the caller rather than of the
         statement, which is the kind that stops being true after a refactor. */
      .where(
        and(
          eq(navigationLayouts.organisationId, context.orgId),
          eq(navigationLayouts.id, layout.id),
        ),
      );
  }
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
 * still chosen.
 *
 * A PURGE IS THE SECOND ACT, AND IT HAS TO BE REACHABLE.
 *
 * It used to be refused while ANY stored arrangement or chosen view named the
 * key. That read as caution and behaved as a dead end: `sidebar-nav.tsx` builds
 * its payload from the whole resolved layout, so every saved sidebar names
 * every catalogue key — which meant that the moment one colleague dragged one
 * item, no section could ever be purged again and the 409 was the permanent
 * answer. Worse, that refusal said the section "was archived rather than
 * deleted" while writing nothing at all, so a caller was told a live section
 * had been taken out of use when it had not been touched.
 *
 * The precondition is now the thing that actually means "nobody is using this":
 * the section must ALREADY BE ARCHIVED. Archiving is the reversible step and it
 * is what takes the section out of every sidebar; purging is then the
 * deliberate second request, gated on `data.delete`, and it CLEARS the
 * references rather than being blocked by them. What was discarded is counted
 * first and returned, so the caller learns what went with it.
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
      await recordSectionChange(
        context,
        request,
        "workspace.section_archived",
        row.key,
        `Archived the "${row.label}" workspace section. It can be restored.`,
        { key: row.key, label: row.label, recoverable: true },
      );
      return Response.json({ ok: true, key: row.key, archived: true });
    }

    if (!(await mayPurge(context))) {
      return Response.json(
        {
          error:
            "Permanently deleting a section needs the data.delete permission. Removing it archives it instead, which takes it out of every sidebar and can be undone.",
          key: row.key,
        },
        { status: 403 },
      );
    }

    /* Archived first, always. This is the precondition that used to be a
       reference count: it means the section is already out of every sidebar and
       somebody chose to take it out, which is the state a permanent deletion
       should follow rather than replace. */
    if (!row.archivedAt) {
      return Response.json(
        {
          error: `"${row.label}" is still in use. Remove it first, which archives it and takes it out of every sidebar, and then it can be deleted permanently.`,
          key: row.key,
          archived: false,
        },
        { status: 409 },
      );
    }

    /* Counted BEFORE they are cleared, so the audit line and the response say
       what the deletion actually discarded. */
    const references = await referencesTo(context, row.key);
    await forgetSection(context, row.key);

    await context.db
      .delete(workspaceSections)
      .where(
        and(
          eq(workspaceSections.organisationId, context.orgId),
          eq(workspaceSections.key, row.key),
        ),
      );
    await recordSectionChange(
      context,
      request,
      "workspace.section_deleted",
      row.key,
      `Permanently deleted the "${row.label}" workspace section.`,
      { key: row.key, label: row.label, recoverable: false, discarded: references },
    );
    return Response.json({ ok: true, key: row.key, deleted: true, discarded: references });
  } catch (error) {
    /* A session that has ended is not a bad request. Without this an expired
       session answered 400 here while the GET beside it answered 401
       {signIn:true}, and `installSessionGuard` bounces to /login only on the
       401 — so a save made just after a session lapsed failed silently and the
       person was left looking at a form that would never work again. */
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message =
      error instanceof Error ? error.message : "The section could not be removed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
