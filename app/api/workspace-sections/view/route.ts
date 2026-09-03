/**
 * Stage 23 — `GET | PUT | DELETE /api/workspace-sections/view`.
 *
 * The owner asked: "what is the default view for the section … Check how
 * monday.com have the default section, make it the same."
 *
 * WHAT MONDAY DOES
 *
 * A monday board is a set of VIEWS — tabs across the top, one of which is the
 * Main Table a new board is created with. Two separate things then decide which
 * tab you land on:
 *
 *   1. THE BOARD'S DEFAULT VIEW. A board owner sets it ("Set as default view"),
 *      and it is the tab a person who has never opened this board lands on. It
 *      is one setting for the whole board, shared by everybody.
 *   2. THE VIEWER'S LAST VIEW. Once you have used a board, monday puts you back
 *      on the tab you were last on — per board, per person. It overrides the
 *      board default for you, and for nobody else.
 *
 * WHAT IS BUILT HERE
 *
 * Both, and in that order. `board_views.is_default` was already the first one —
 * org-wide, board-wide, set from the view tab menu — and this endpoint adds the
 * second, plus a per-SECTION default that sits between them.
 *
 * The resolution, highest first:
 *
 *   user's remembered view  →  the section's workspace default
 *                           →  the board's `is_default` view
 *                           →  the first view on the board
 *
 * Each layer is skipped when the view it names no longer exists. That is the
 * same discipline the sidebar's layers use: a stored key is a PREFERENCE, and
 * existence is decided by the live list of views. Deleting a view therefore
 * lands everybody who was on it back on the default, rather than on a tab that
 * is not there.
 *
 * WHY A SECTION DEFAULT RATHER THAN ONLY THE BOARD'S
 *
 * Two sections can read the same board — that is exactly what a workspace
 * section pointed at the job board is — and the owner's whole reason for adding
 * one is to land somewhere different. A default stored per board could not tell
 * them apart. `board_views.is_default` is left alone and still answers when this
 * layer has nothing to say, so nothing that already worked changed.
 *
 * WHO MAY WRITE WHICH LAYER
 *
 * The workspace default is `settings.edit`: it changes where every colleague
 * lands. Your own last view is not gated at all beyond being a member of the
 * workspace — it is your screen, it grants nothing, and gating it would mean a
 * client could never be put back where they were. That split is the one
 * `/api/dashboard-layout` already makes, in the same words.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { boardViews, sectionViewPreferences, users } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability, type ScopedDatabase } from "../../../lib/tenant-db";
import {
  DEFAULT_SURFACE,
  builtInSectionBoard,
  isSurfaceKey,
  isWorkspaceSectionKey,
  surfaceDefinition,
} from "../catalogue";
import { loadWorkspaceSections } from "../route";
import { builtInCatalogue } from "../../navigation/layout";

export const dynamic = "force-dynamic";

type ViewRow = {
  key: string;
  name: string;
  type: string;
  icon: string | null;
  position: number;
  isDefault: boolean;
};

/** The caller's `users.id`, or null for an identity with no user row yet. */
async function resolveUserId(context: ScopedDatabase) {
  const email = context.identityEmail?.trim().toLowerCase();
  if (!email) return null;
  const [row] = await context.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Which board a section reads, or null when it has no board and so no views.
 *
 * A built-in section is answered from the surface table — a surface key IS a
 * built-in section key, so the lookup is direct. A workspace section is
 * answered from its own row, so an owner who re-points a section at a different
 * board changes which views it offers without a deploy.
 */
async function boardForSection(context: ScopedDatabase, sectionKey: string) {
  if (!isWorkspaceSectionKey(sectionKey)) {
    /* Checked against the built-in catalogue rather than waved through, so a
       typo is a 404 and not a section with silently no views — the two answers
       look the same to a caller and mean very different things. */
    const known = builtInCatalogue().some((entry) => entry.key === sectionKey);
    return { known, boardKey: builtInSectionBoard(sectionKey) as string | null };
  }
  const sections = await loadWorkspaceSections(context.db, context.orgId);
  const section = sections.find((entry) => entry.key === sectionKey);
  if (!section || section.archived) return { known: false, boardKey: null };
  const surface = isSurfaceKey(section.surface) ? section.surface : DEFAULT_SURFACE;
  return {
    known: true,
    boardKey: section.boardKey ?? surfaceDefinition(surface)?.boardKey ?? null,
  };
}

async function loadViews(context: ScopedDatabase, boardKey: string): Promise<ViewRow[]> {
  const rows = await context.db
    .select({
      key: boardViews.key,
      name: boardViews.name,
      type: boardViews.type,
      icon: boardViews.icon,
      position: boardViews.position,
      isDefault: boardViews.isDefault,
    })
    .from(boardViews)
    .where(
      and(eq(boardViews.organisationId, context.orgId), eq(boardViews.boardId, boardKey)),
    )
    .orderBy(asc(boardViews.position));
  return rows;
}

async function loadPreferences(context: ScopedDatabase, sectionKey: string, userId: string | null) {
  const [workspaceRows, personalRows] = await Promise.all([
    context.db
      .select()
      .from(sectionViewPreferences)
      .where(
        and(
          eq(sectionViewPreferences.organisationId, context.orgId),
          eq(sectionViewPreferences.sectionKey, sectionKey),
          isNull(sectionViewPreferences.userId),
        ),
      )
      .limit(1),
    userId
      ? context.db
          .select()
          .from(sectionViewPreferences)
          .where(
            and(
              eq(sectionViewPreferences.organisationId, context.orgId),
              eq(sectionViewPreferences.sectionKey, sectionKey),
              eq(sectionViewPreferences.userId, userId),
            ),
          )
          .limit(1)
      : Promise.resolve([] as Array<typeof sectionViewPreferences.$inferSelect>),
  ]);
  return {
    workspace: workspaceRows[0]?.viewKey ?? null,
    personal: personalRows[0]?.viewKey ?? null,
    workspaceRow: workspaceRows[0] ?? null,
    personalRow: personalRows[0] ?? null,
  };
}

/**
 * The four layers, resolved.
 *
 * `source` is returned rather than left to be inferred, because "you are here
 * because you were last here" and "you are here because the owner said so" look
 * identical on screen and mean different things when somebody asks why.
 */
function resolveView(
  views: ViewRow[],
  personal: string | null,
  workspace: string | null,
): { viewKey: string | null; source: "user" | "workspace" | "board" | "first" | "none" } {
  const has = (key: string | null) =>
    Boolean(key) && views.some((view) => view.key === key);
  if (has(personal)) return { viewKey: personal, source: "user" };
  if (has(workspace)) return { viewKey: workspace, source: "workspace" };
  const boardDefault = views.find((view) => view.isDefault);
  if (boardDefault) return { viewKey: boardDefault.key, source: "board" };
  if (views.length) return { viewKey: views[0].key, source: "first" };
  return { viewKey: null, source: "none" };
}

function sectionFrom(request: Request) {
  return (new URL(request.url).searchParams.get("section") ?? "").trim();
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const context = await scopedDb(request);
    const sectionKey = sectionFrom(request);
    if (!sectionKey) {
      return Response.json({ error: "Name a section." }, { status: 400 });
    }

    const { known, boardKey } = await boardForSection(context, sectionKey);
    if (!known) {
      return Response.json({ error: "That section does not exist." }, { status: 404 });
    }

    const userId = await resolveUserId(context);
    const views = boardKey ? await loadViews(context, boardKey) : [];
    const preferences = await loadPreferences(context, sectionKey, userId);
    const resolved = resolveView(views, preferences.personal, preferences.workspace);
    const guard = await scopedDbWithCapability(request, "settings.edit");

    return Response.json({
      section: sectionKey,
      boardKey,
      /* The live list. A caller comparing a stored key against this is doing
         the same existence check the resolver above does. */
      views,
      view: resolved.viewKey,
      source: resolved.source,
      /* Unmerged, so an editor can say "the workspace lands on X, you land on
         Y" and offer a reset that means something. */
      workspaceDefault: preferences.workspace,
      mine: preferences.personal,
      canEditDefault: !guard.denied,
      canRemember: userId !== null,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message =
      error instanceof Error ? error.message : "The section view could not be resolved.";
    return Response.json({ error: message }, { status: 503 });
  }
}

/**
 * PUT — remember a view, or set the one everybody lands on.
 *
 * Body: `{ section, view, scope?: "user" | "workspace" }`, default `"user"`.
 *
 * The view is checked against the board's live views before it is stored. A key
 * that is not a view of this section's board is refused rather than written,
 * because a stored preference that can never resolve is a setting that silently
 * does nothing — the owner would set a default, see everyone land somewhere
 * else, and have no way to tell that the value never applied.
 */
export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const scope = body.scope === "workspace" ? "workspace" : "user";

    /* The capability is resolved for the workspace scope only. A client
       remembering their own tab must not need `settings.edit`, and asking for
       it would refuse them their own screen. */
    const context =
      scope === "workspace"
        ? await (async () => {
            const guard = await scopedDbWithCapability(request, "settings.edit");
            return guard.denied ? guard.denied : guard.scope;
          })()
        : await scopedDb(request);
    if (context instanceof Response) return context;

    const sectionKey = typeof body.section === "string" ? body.section.trim() : "";
    if (!sectionKey) {
      return Response.json({ error: "Name a section." }, { status: 400 });
    }
    const { known, boardKey } = await boardForSection(context, sectionKey);
    if (!known) {
      return Response.json({ error: "That section does not exist." }, { status: 404 });
    }
    if (!boardKey) {
      return Response.json(
        {
          error:
            "This section's screen has no views, so there is no default view to set for it.",
          section: sectionKey,
        },
        { status: 409 },
      );
    }

    const viewKey = typeof body.view === "string" ? body.view.trim().slice(0, 80) : "";
    if (!viewKey) {
      return Response.json({ error: "Name a view." }, { status: 400 });
    }
    const views = await loadViews(context, boardKey);
    if (!views.some((view) => view.key === viewKey)) {
      return Response.json(
        {
          error: `"${viewKey}" is not a view on this section's board.`,
          views: views.map((view) => view.key),
        },
        { status: 400 },
      );
    }

    const userId = scope === "user" ? await resolveUserId(context) : null;
    if (scope === "user" && !userId) {
      return Response.json(
        {
          error:
            "This identity has no user record in the workspace, so it has nowhere to remember a view.",
        },
        { status: 409 },
      );
    }

    const preferences = await loadPreferences(context, sectionKey, userId);
    const existing = scope === "workspace" ? preferences.workspaceRow : preferences.personalRow;
    const now = new Date().toISOString();
    if (existing) {
      await context.db
        .update(sectionViewPreferences)
        .set({ viewKey, updatedBy: context.identityEmail, updatedAt: now })
        .where(eq(sectionViewPreferences.id, existing.id));
    } else {
      await context.db.insert(sectionViewPreferences).values({
        id: `svp_${crypto.randomUUID().replace(/-/g, "")}`,
        organisationId: context.orgId,
        sectionKey,
        userId,
        viewKey,
        updatedBy: context.identityEmail,
        createdAt: now,
        updatedAt: now,
      });
    }

    return Response.json({ ok: true, section: sectionKey, scope, view: viewKey });
  } catch (error) {
    /* A session that has ended is not a bad request. Without this an expired
       session answered 400 here while the GET beside it answered 401
       {signIn:true}, and `installSessionGuard` bounces to /login only on the
       401 — so a save made just after a session lapsed failed silently and the
       person was left looking at a form that would never work again. */
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message =
      error instanceof Error ? error.message : "The view could not be saved.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * DELETE — forget. `?section=…`, and `&scope=workspace` to clear the default.
 *
 * Deleting the row rather than writing an empty one, for the reason
 * `/api/navigation` gives: the layer has to genuinely disappear so the one
 * beneath it answers again.
 */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const params = new URL(request.url).searchParams;
    const scope = params.get("scope") === "workspace" ? "workspace" : "user";
    const context =
      scope === "workspace"
        ? await (async () => {
            const guard = await scopedDbWithCapability(request, "settings.edit");
            return guard.denied ? guard.denied : guard.scope;
          })()
        : await scopedDb(request);
    if (context instanceof Response) return context;

    const sectionKey = (params.get("section") ?? "").trim();
    if (!sectionKey) {
      return Response.json({ error: "Name a section." }, { status: 400 });
    }

    if (scope === "workspace") {
      await context.db
        .delete(sectionViewPreferences)
        .where(
          and(
            eq(sectionViewPreferences.organisationId, context.orgId),
            eq(sectionViewPreferences.sectionKey, sectionKey),
            isNull(sectionViewPreferences.userId),
          ),
        );
      return Response.json({ ok: true, section: sectionKey, scope });
    }

    const userId = await resolveUserId(context);
    if (userId) {
      await context.db
        .delete(sectionViewPreferences)
        .where(
          and(
            eq(sectionViewPreferences.organisationId, context.orgId),
            eq(sectionViewPreferences.sectionKey, sectionKey),
            eq(sectionViewPreferences.userId, userId),
          ),
        );
    }
    return Response.json({ ok: true, section: sectionKey, scope });
  } catch (error) {
    /* A session that has ended is not a bad request. Without this an expired
       session answered 400 here while the GET beside it answered 401
       {signIn:true}, and `installSessionGuard` bounces to /login only on the
       401 — so a save made just after a session lapsed failed silently and the
       person was left looking at a form that would never work again. */
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const message =
      error instanceof Error ? error.message : "The view could not be reset.";
    return Response.json({ error: message }, { status: 400 });
  }
}
