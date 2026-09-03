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

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  auditEvents,
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
  DEFAULT_TEMPLATE,
  SECTION_SURFACES,
  SECTION_TEMPLATES,
  cleanSectionLabel,
  isChoosableTemplate,
  isGroupChoice,
  isIconName,
  isSurfaceKey,
  isTemplateKey,
  isWorkspaceSectionKey,
  sectionKeyFrom,
  surfaceDefinition,
  templateDefinition,
  type SurfaceKey,
  type WorkspaceSection,
} from "./catalogue";
import { BUILT_IN_GROUPS, FALLBACK_GROUP } from "../navigation/layout";
import { can, resolvePermissions } from "../../lib/permissions";
import {
  boardBinCount,
  boardItemCount,
  createBoard,
  deleteBoardStructure,
  renameBoard,
} from "../../lib/board-registry";

/** The headings a section may be filed under. `layout.ts` is the authority. */
const GROUP_KEYS = BUILT_IN_GROUPS.map((group) => group.key);

/**
 * The boards the PRODUCT owns, as opposed to one a section made for itself.
 *
 * Derived from `SECTION_SURFACES` rather than written out, so a surface added
 * later cannot be mistaken for a section-owned board and destroyed with it.
 * Anything not in here was created by `createBoard` for the section that names
 * it, and is the only kind of board a purge may remove.
 */
const BUILT_IN_BOARD_KEYS: ReadonlySet<string> = new Set<string>(
  /* `SECTION_SURFACES` is `as const`, so `boardKey` is a literal union and a
     `Set` inferred from it would only accept those two strings — the membership
     test below is asked about an arbitrary stored key. Widened to `string` here
     rather than cast at each call site. */
  SECTION_SURFACES.flatMap((surface) => (surface.boardKey ? [surface.boardKey as string] : [])),
);

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
    /* A board key that is not one of the product's own was created for this
       section by `createBoard`. The same test the purge uses, answered once and
       returned, so the dialog and the destructive path cannot disagree. */
    ownsBoard: row.surfaceRef !== null && !BUILT_IN_BOARD_KEYS.has(row.surfaceRef),
    /* W2 — returned as stored, INCLUDING a template this build no longer
       offers. A row is a record of what was chosen; re-labelling it as
       something else because the catalogue moved on would make the audit trail
       lie. NULL stays NULL, and means the section predates templates. */
    template: row.template ?? null,
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
      /* W2 — and what a NEW one may be created from. Sent whole, unavailable
         entries included, because the dialog has to be able to say WHY a
         template it is not offering is not on offer. `available` is the
         server's answer and the browser does not get to second-guess it: POST
         refuses an unchoosable template whatever the dialog drew. */
      templates: SECTION_TEMPLATES,
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

    /*
     * W2 — A TEMPLATE AND A SURFACE ARE DIFFERENT REQUESTS, AND ASKING FOR BOTH
     * IS A CONTRADICTION RATHER THAN A PREFERENCE.
     *
     * `template` says "give this section a register of its own, shaped like
     * that one". `surface` says "put a second door onto a screen the product
     * already has". Honouring one and dropping the other is exactly the silent
     * substitution the surface check above refuses, so both together is a 400.
     */
    if (
      body.template !== undefined &&
      (body.surface !== undefined || body.board !== undefined || body.surfaceRef !== undefined)
    ) {
      return Response.json(
        {
          error:
            "A section is either created from a template, with a register of its own, or pointed at one of the product's existing screens. Choose one.",
        },
        { status: 400 },
      );
    }
    if (body.template !== undefined) {
      if (!isTemplateKey(body.template)) {
        return Response.json(
          {
            error: "That is not a template this product offers.",
            templates: SECTION_TEMPLATES.filter((entry) => entry.available).map(
              (entry) => entry.key,
            ),
          },
          { status: 400 },
        );
      }
      /* §8 — a template that cannot yet give an INDEPENDENT instance is refused
         with the reason, not quietly downgraded to something that works. The
         dialog does not offer these; a script or a stale tab can still ask. */
      if (!isChoosableTemplate(body.template)) {
        return Response.json(
          {
            error:
              templateDefinition(body.template as string)?.unavailable ??
              "That template is not available yet.",
            template: body.template,
            available: false,
          },
          { status: 400 },
        );
      }
    }

    /*
     * Which of the three shapes this request is, decided once.
     *
     *   template named      -> an INSTANCE of that template
     *   surface named       -> a SECOND DOOR onto an existing screen (legacy,
     *                          and still supported: see the note further down)
     *   neither             -> an instance of the default template, which is
     *                          what every section created since W02-06 already
     *                          is. Recorded by name now rather than implied.
     */
    const template = body.template !== undefined
      ? (body.template as string)
      : body.surface === undefined
        ? DEFAULT_TEMPLATE
        : null;
    const surface: SurfaceKey = template
      ? (templateDefinition(template)?.surface ?? DEFAULT_SURFACE)
      : isSurfaceKey(body.surface)
        ? body.surface
        : DEFAULT_SURFACE;
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

    /*
     * W02-06 — the section gets its OWN register.
     *
     * The owner's decision, and it reverses this endpoint's original one. A
     * section used to be bound to an EXISTING screen, so "CCTV" and "Jobs" drew
     * the same board and showed the same rows; the checklist asks a new section
     * to "automatically generate the same default page structure used by the
     * existing sections", and pointing at somebody else's page is not
     * generating one.
     *
     * `createBoard` is the canonical primitive and provisions the default
     * columns and groups itself, so there is no second creation path and no way
     * to end up with a board that renders nothing. The register is generic by
     * construction — see `generic-board-template.ts` for why it is not a copy of
     * Maintenance and not a copy of a live board.
     *
     * A CALLER MAY STILL ASK FOR AN EXISTING SCREEN, and the editor no longer
     * offers it. `body.surface` is honoured when it names a non-board screen —
     * Reports, the calendar, the site register — because those sections predate
     * this decision and must keep working, and because "a second door onto the
     * calendar" is a coherent thing to want in a way that "a second Jobs board"
     * was not. Absent, which is what the dialog now sends, means a new register.
     */
    const wantsExistingScreen = template === null;
    let ownedBoardKey: string | null = null;

    if (!wantsExistingScreen) {
      /*
       * BOARD FIRST, SECTION SECOND, and the order is the failure plan.
       *
       * If the board cannot be created there is no section, so nothing
       * navigable exists — the outcome the checklist asks for by name. If the
       * section then fails, the board is removed below; an unbound board is
       * invisible either way, because nothing routes to a board except through
       * a section.
       */
      try {
        const provisioned = await createBoard(context.db, context.orgId, {
          name: label,
          description: cleanSectionLabel(body.description, 240) ?? undefined,
          itemNoun: "Item",
        });
        ownedBoardKey = provisioned.key;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "The section's register could not be created.";
        return Response.json(
          {
            error: `The section was not created: ${message}`,
            key,
          },
          { status: 409 },
        );
      }
    }

    const now = new Date().toISOString();
    try {
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
        surfaceRef: ownedBoardKey ?? board.boardKey,
        /* NULL for a second door, which is the honest record of what it is —
           see the column's own note in `db/schema.ts`. */
        template,
        groupKey: isGroupChoice(body.group, GROUP_KEYS) ? body.group : FALLBACK_GROUP,
        position: await nextPosition(context),
        createdBy: context.identityEmail,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      /* The section is what makes a board reachable, so a board with no section
         is not a half-created feature — it is litter. Removed rather than left,
         and the caller is told the whole operation failed. */
      if (ownedBoardKey) {
        await deleteBoardStructure(context.db, context.orgId, ownedBoardKey).catch(
          () => undefined,
        );
      }
      const message =
        error instanceof Error ? error.message : "The section could not be added.";
      return Response.json({ error: message }, { status: 400 });
    }

    const created = await findByKey(context, key);
    await recordSectionChange(
      context,
      request,
      "workspace.section_created",
      key,
      `Added the "${label}" workspace section${ownedBoardKey ? " and its register" : ""}.`,
      {
        key,
        label,
        surface,
        template,
        board: ownedBoardKey ?? board.boardKey,
        ownsBoard: ownedBoardKey !== null,
      },
    );
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
    /*
     * W2 — A TEMPLATE IS NOT AN EDITABLE FIELD.
     *
     * It records the structure the instance was born with. "Changing" it would
     * mean rebuilding a live register's columns, groups and views under rows
     * already filed on it, which is a migration and not a rename. Refused by
     * name rather than ignored, so a caller that tries learns it did nothing.
     */
    if (body.template !== undefined) {
      return Response.json(
        {
          error:
            "A section's template cannot be changed after it is created. Add a section from the template you want and move the work across.",
        },
        { status: 400 },
      );
    }

    /*
     * W2 — CHANGING THE SURFACE MUST NEVER STRAND A REGISTER. This is the
     * second half of the owner's first reproduction, and the half that made
     * the first half invisible.
     *
     * `resolveSurfaceRef` answers `{ boardKey: null }` for a surface with no
     * board of its own, so PATCHing `section:test` from the job board to, say,
     * Reports NULLED the `surface_ref` that said which register it owned. Every
     * later read of that row — the dialog's "Own register" badge, and crucially
     * the purge's ownership test — then saw a plain second door and left the
     * board behind. Nothing warned; nothing failed; the board simply stopped
     * belonging to anybody, and under the old name-derived keys it took its
     * name with it.
     *
     * SO A SECTION THAT IS THE LAST ONE POINTING AT ITS REGISTER CANNOT BE
     * RE-HOMED AT ALL. Not to a board-less surface (which was the silent
     * orphan), and not to another board-backed surface either — the surface
     * decides which component draws the page, and the Document board's is still
     * wired to the one shared board, so "re-home the instance" would have meant
     * "show and edit the canonical compliance data" (W2 R5).
     *
     * WHAT IS STILL ALLOWED, deliberately: re-homing a LEGACY second-door
     * section, which owns nothing and is the only reason the control exists;
     * and re-homing one of SEVERAL sections that share a register, because the
     * register survives in the hands of the others. Only the last owner is
     * pinned, and the way to be rid of it is the audited one — remove the
     * section, which archives it, then delete it permanently, which takes the
     * empty register with it.
     */
    const ownedBoard =
      row.surfaceRef && !BUILT_IN_BOARD_KEYS.has(row.surfaceRef) ? row.surfaceRef : null;
    const rehoming =
      (body.surface !== undefined && body.surface !== row.surface) ||
      (body.board !== undefined && body.board !== row.surfaceRef) ||
      (body.surfaceRef !== undefined && body.surfaceRef !== row.surfaceRef);
    if (ownedBoard && rehoming) {
      const sharing = (await loadWorkspaceSections(context.db, context.orgId)).filter(
        (section) => section.key !== row.key && section.boardKey === ownedBoard,
      );
      if (sharing.length === 0) {
        return Response.json(
          {
            error: `"${row.label}" has a register of its own, and it is the only section that opens it. Pointing it somewhere else would leave that register with no way in. Remove the section instead — that archives it, and deleting it permanently takes the empty register with it.`,
            key: row.key,
            board: ownedBoard,
            ownsBoard: true,
          },
          { status: 409 },
        );
      }
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

    /*
     * W2 R1 — the label follows onto `boards.name`, and the key does not move.
     *
     * This is the visible half of separating identity from display: the board's
     * own heading, its entry in a board list and the name any later export
     * carries are all `boards.name`, and leaving them on the name the section
     * had when it was created would make a rename look like it half-worked. The
     * ADDRESS — `boards.key`, `sec-<12hex>` — is untouched, so no link, no
     * stored view and no placement is invalidated by renaming, and the old name
     * becomes free the moment nothing is called it.
     */
    if (patch.label && ownedBoard) {
      await renameBoard(context.db, context.orgId, ownedBoard, patch.label);
    }

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
 * The register a section created, when the row no longer says which.
 *
 * WHY THIS IS NEEDED AT ALL. `surface_ref` is the ownership record, and until
 * the PATCH guard above there was a way to null it while the board it named
 * still existed: change the section's screen to one with no board of its own.
 * The purge then read a NULL, concluded the section owned nothing, and deleted
 * only the row — leaving a live register nothing routes to. That is the owner's
 * reproduction, and the audit trail on Staging shows it exactly: `section:test`
 * created with `{"board":"test","ownsBoard":true}` at 17:20, updated at 17:22
 * to `{"boardKey":null,"ownsBoard":false}`, deleted at 17:26 with
 * `{"board":null}`.
 *
 * THE GUARD STOPS NEW ONES. This recovers the rows already in that shape, and
 * it does it from a record the product already keeps rather than a guess: the
 * section's own `workspace.section_created` audit line names the board it was
 * given. A label match or a name heuristic could pick the wrong board; this
 * cannot, because it is the write itself, read back.
 *
 * IT PROVES OWNERSHIP RATHER THAN ASSUMING IT. The board must still exist, must
 * not be one of the product's own, and — checked by the caller on exactly the
 * same footing as a normally-owned board — must be unshared, empty, and empty
 * of binned rows. So the worst case of a wrong answer here is a refusal, never
 * a deletion.
 *
 * Only on the purge path: one indexed read on a deliberate, rare, destructive
 * act. It has no business on a page load, and none at all on a boot path.
 */
async function abandonedBoardFor(
  context: ScopedDatabase,
  sectionKey: string,
): Promise<string | null> {
  /* Newest first, and more than one, because a key can be created, purged and
     created again — the Staging trail has `section:test` twice. The newest
     creation that names a board is the one this row came from. */
  const events = await context.db
    .select({ detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organisationId, context.orgId),
        eq(auditEvents.action, "workspace.section_created"),
        eq(auditEvents.entityId, sectionKey),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(5);

  for (const event of events) {
    if (!event.detail) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.detail) as unknown;
    } catch {
      continue;
    }
    const board = (parsed as Record<string, unknown> | null)?.board;
    if (typeof board !== "string" || !board || BUILT_IN_BOARD_KEYS.has(board)) continue;

    const [exists] = await context.db
      .select({ key: boards.key })
      .from(boards)
      .where(and(eq(boards.organisationId, context.orgId), eq(boards.key, board)))
      .limit(1);
    if (exists) return exists.key;
  }
  return null;
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

    /*
     * W02-06 — a section that owns a register takes it with it, and only if the
     * register is empty.
     *
     * THE OWNERSHIP TEST. A board key that is not one of the product's own was
     * created by `createBoard` for this section. A section pointed at
     * `maintenance` or `store-documentation` is a door onto a shared screen and
     * must never take it away.
     *
     * THE SHARING TEST. `PATCH { board }` can re-point one section at another's
     * register, so a board with another section still on it is shared in fact
     * whoever created it. The section goes; the board stays.
     *
     * THE EMPTINESS TEST, and it is a refusal rather than a cascade. Rows on a
     * register are `maintenance_requests` — the same table the job board uses,
     * carrying attachments in object storage, comments and activity, and
     * referenced by sites and by the recycle bin. Destroying them because
     * somebody removed a MENU ENTRY is exactly the surprise this endpoint spent
     * its first version avoiding, and the product already has a deliberate,
     * audited path for destroying items: bin them, then purge the bin. So an
     * occupied register refuses, and says how many rows are in the way.
     */
    const ownedBoard =
      (row.surfaceRef && !BUILT_IN_BOARD_KEYS.has(row.surfaceRef) ? row.surfaceRef : null) ??
      /* And the register this section created but no longer names, for the rows
         that were detached before the PATCH guard existed. See
         `abandonedBoardFor` — it reads the section's own creation audit line,
         and everything below then treats what it finds exactly as it treats a
         board the row still points at. */
      (await abandonedBoardFor(context, row.key));

    if (ownedBoard) {
      const sharing = (await loadWorkspaceSections(context.db, context.orgId)).filter(
        (section) => section.key !== row.key && section.boardKey === ownedBoard,
      );
      if (sharing.length === 0) {
        const items = await boardItemCount(context.db, context.orgId, ownedBoard);
        if (items > 0) {
          return Response.json(
            {
              error: `"${row.label}" still holds ${items} ${items === 1 ? "item" : "items"}. Delete them from the section first — they go to the recycle bin, where they can be restored — and then it can be removed permanently.`,
              key: row.key,
              board: ownedBoard,
              items,
            },
            { status: 409 },
          );
        }
        /*
         * AND THE BIN, which the count above cannot see.
         *
         * Binning an item LIFTS its placement out of `maintenance_group_items`,
         * so a register whose every row was deleted yesterday answers "0 items"
         * here while the bin still offers all of them back. Destroying the
         * board at that point leaves them restorable onto a board that is gone
         * — the refusal above, defeated by taking one extra step first. The
         * message names the bin, because that is where the work now is and the
         * product already has a deliberate, audited way to empty it.
         */
        const binned = await boardBinCount(context.db, context.orgId, ownedBoard);
        if (binned > 0) {
          return Response.json(
            {
              error: `"${row.label}" still has ${binned} ${binned === 1 ? "item" : "items"} in the recycle bin, which can still be restored onto it. Empty the bin first, and then it can be removed permanently.`,
              key: row.key,
              board: ownedBoard,
              binned,
            },
            { status: 409 },
          );
        }
      }
    }

    /* Counted BEFORE they are cleared, so the audit line and the response say
       what the deletion actually discarded. */
    const references = await referencesTo(context, row.key);
    await forgetSection(context, row.key);

    /*
     * The register's own structure — its columns and its groups — and the board
     * row itself. Configuration only: `deleteBoardStructure` deletes no item, no
     * attachment and nothing that exists independently of this board, and it is
     * reached only after the emptiness test above.
     */
    let removedBoard: string | null = null;
    if (ownedBoard) {
      const stillShared = (await loadWorkspaceSections(context.db, context.orgId)).some(
        (section) => section.key !== row.key && section.boardKey === ownedBoard,
      );
      if (!stillShared) {
        await deleteBoardStructure(context.db, context.orgId, ownedBoard);
        removedBoard = ownedBoard;
      }
    }

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
      { key: row.key, label: row.label, recoverable: false, discarded: references, board: removedBoard },
    );
    return Response.json({
      ok: true,
      key: row.key,
      deleted: true,
      discarded: references,
      /* Null when the section was a door onto a shared screen, or when another
         section still uses the register. Named so the caller can tell the two
         outcomes apart rather than inferring them. */
      board: removedBoard,
    });
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
