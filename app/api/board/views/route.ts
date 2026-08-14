import { and, asc, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { boardViews } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { DEFAULT_BOARD_KEY, resolveBoard } from "../../../lib/board-registry";

export const dynamic = "force-dynamic";

/**
 * View types the chrome can render. `table` and `form` exist today; the rest
 * render a placeholder until their group lands, so the tab strip is honest
 * about what is built rather than hiding future work.
 *
 * The last four are Stage 19's monday-parity renderers. Their labels describe
 * what the type does rather than repeating the seeded tab name, because this
 * list is the "add a view" menu: an admin picking "Flat table" needs to know it
 * is the group-free one, not that monday happens to call its instance "Table".
 */
export const VIEW_TYPES = [
  { key: "table", label: "Table", icon: "grid", built: true },
  { key: "form", label: "Form", icon: "document", built: true },
  { key: "kanban", label: "Kanban", icon: "list", built: true },
  { key: "calendar", label: "Calendar", icon: "calendar", built: true },
  { key: "timeline", label: "Timeline", icon: "chart", built: false },
  { key: "chart", label: "Chart", icon: "chart", built: true },
  { key: "gallery", label: "File gallery", icon: "image", built: true },
  { key: "reports", label: "Reports", icon: "chart", built: true },
  { key: "form-results", label: "Form results", icon: "chart", built: true },
  { key: "form-responses", label: "Form responses", icon: "inbox", built: true },
  { key: "flat-table", label: "Flat table", icon: "grid", built: true },
  { key: "vibe", label: "Vibe app", icon: "spark", built: true },
] as const;

type SeedView = {
  key: string;
  name: string;
  type: string;
  icon: string;
  /**
   * monday's tab decoration, reproduced in the chrome. `pin` is the pinned
   * Form; `app` marks a board that is served by a monday app rather than by a
   * view type — the capture records Fix Tracker (app 22247989) and Build Vibe
   * view (app 15528052) as carrying an app glyph rather than a view icon.
   */
  glyph?: "pin" | "app";
  isDefault?: boolean;
};

/**
 * Seeded tabs — all eleven monday publishes on board 1139774521, in monday's
 * own tab order (see db/monday-export/MAINTENANCE-MONDAY-CAPTURE.md).
 *
 * Form comes first because monday pins it. Stage 5 seeded seven of these and
 * folded Results into the table and Form Response Viewer into the item panel;
 * the capture shows both are live tabs the store managers use, so they are
 * tabs here too.
 *
 * `key` is the app's own identifier and does not have to read like the monday
 * name: `form-results` and `form-responses` say which form surface they are,
 * which matters when an admin adds a second form to the board.
 */
const SEED_VIEWS: SeedView[] = [
  { key: "form", name: "Form", type: "form", icon: "document", glyph: "pin" },
  { key: "main", name: "Main table", type: "table", icon: "grid", isDefault: true },
  { key: "fix-tracker", name: "Fix Tracker", type: "kanban", icon: "list", glyph: "app" },
  { key: "form-results", name: "Results", type: "form-results", icon: "chart" },
  { key: "calendar", name: "Calendar", type: "calendar", icon: "calendar" },
  { key: "form-responses", name: "Form Response Viewer", type: "form-responses", icon: "inbox" },
  { key: "table", name: "Table", type: "flat-table", icon: "grid" },
  { key: "chart", name: "Chart", type: "chart", icon: "chart" },
  { key: "vibe", name: "Build Vibe view", type: "vibe", icon: "spark", glyph: "app" },
  { key: "gallery", name: "File gallery", type: "gallery", icon: "image" },
  { key: "reports", name: "Board Reports", type: "reports", icon: "chart" },
];

const SEED_KEYS = new Set(SEED_VIEWS.map((view) => view.key));

/**
 * Marks a board as carrying monday's eleven tabs. Stamped on the `main` row,
 * which is the one view DELETE refuses to remove, so the marker cannot be lost
 * by an admin tidying up their tab strip.
 */
const PARITY_STAMP = "monday-11";

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
  return Response.json({ error: "Board views are temporarily unavailable." }, { status: 503 });
}

function newId() {
  return `view_${crypto.randomUUID().replace(/-/g, "")}`;
}

function slug(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || `view-${Date.now()}`
  );
}

type Database = Awaited<ReturnType<typeof scopedDb>>["db"];

function seedId(orgId: string, boardKey: string, viewKey: string) {
  return `seed-${orgId}-${boardKey}-${viewKey}`;
}

/** A view's stored settings, never throwing on a row an admin has hand-edited. */
function readSettings(raw: string | null) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function seedSettings(view: SeedView) {
  const settings: Record<string, unknown> = {};
  if (view.glyph) settings.glyph = view.glyph;
  if (view.key === "main") settings.seed = PARITY_STAMP;
  return JSON.stringify(settings);
}

/**
 * Brings a board seeded before Stage 19 up to monday's eleven tabs — the four
 * that were folded away are inserted, "Reports" takes monday's own name, and
 * every seeded tab moves to monday's position.
 *
 * Runs once. The marker lives on `main.settings` rather than being inferred
 * from which tabs are present, so Stage 5's promise survives: an admin who
 * deletes Results does not get it back on the next page load.
 */
async function upgradeToMondayViews(db: Database, orgId: string, boardKey: string) {
  const rows = await db
    .select()
    .from(boardViews)
    .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, boardKey)));

  const main = rows.find((row) => row.key === "main");
  // No `main` row means these views are not ours to reorder — leave them be.
  if (!main || readSettings(main.settings).seed === PARITY_STAMP) return;

  const byKey = new Map(rows.map((row) => [row.key, row]));

  for (const [position, view] of SEED_VIEWS.entries()) {
    const existing = byKey.get(view.key);
    if (!existing) {
      await db
        .insert(boardViews)
        .values({
          id: seedId(orgId, boardKey, view.key),
          organisationId: orgId,
          boardId: boardKey,
          key: view.key,
          name: view.name,
          type: view.type,
          icon: view.icon,
          settings: seedSettings(view),
          position,
          isDefault: Boolean(view.isDefault),
          system: view.key === "main",
        })
        .onConflictDoNothing();
      continue;
    }

    const patch: Record<string, unknown> = { position, updatedAt: sql`CURRENT_TIMESTAMP` };
    // monday calls this tab "Board Reports"; Stage 5 shortened it. Only that
    // exact name is corrected, so an admin's own rename is left alone.
    if (view.key === "reports" && existing.name === "Reports") patch.name = view.name;
    if (view.glyph) {
      patch.settings = JSON.stringify({ ...readSettings(existing.settings), glyph: view.glyph });
    }
    await db
      .update(boardViews)
      .set(patch)
      .where(and(eq(boardViews.id, existing.id), eq(boardViews.organisationId, orgId)));
  }

  // Views an admin added keep their relative order, behind monday's eleven.
  for (const row of rows) {
    if (SEED_KEYS.has(row.key)) continue;
    await db
      .update(boardViews)
      .set({ position: SEED_VIEWS.length + row.position, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(boardViews.id, row.id), eq(boardViews.organisationId, orgId)));
  }

  await db
    .update(boardViews)
    .set({
      settings: JSON.stringify({ ...readSettings(main.settings), seed: PARITY_STAMP }),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(eq(boardViews.id, main.id), eq(boardViews.organisationId, orgId)));
}

/**
 * Seeds the default tab set on first read. Idempotent — an admin who deletes a
 * seeded view does not get it back on the next page load.
 *
 * The set is the maintenance board's, so it is only seeded there. Every other
 * board declares its own tabs in its own component — Store Documentation's
 * three (Main table, Compliance Tracker, Calendar) live in
 * `views/store-documentation-board.tsx` — and seeding Fix Tracker or the
 * Maintenance Request form onto them would offer tabs that cannot render.
 */
async function seedViews(db: Database, orgId: string, boardKey: string) {
  if (boardKey !== DEFAULT_BOARD_KEY) return;

  const [existing] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(boardViews)
    .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, boardKey)));
  if (Number(existing?.total ?? 0) > 0) {
    await upgradeToMondayViews(db, orgId, boardKey);
    return;
  }

  for (const [position, view] of SEED_VIEWS.entries()) {
    await db
      .insert(boardViews)
      .values({
        id: seedId(orgId, boardKey, view.key),
        organisationId: orgId,
        boardId: boardKey,
        key: view.key,
        name: view.name,
        type: view.type,
        icon: view.icon,
        settings: seedSettings(view),
        position,
        isDefault: Boolean(view.isDefault),
        system: view.key === "main",
      })
      .onConflictDoNothing();
  }
}

/** GET /api/board/views — the tab strip. */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const board = await resolveBoard(db, orgId, url.searchParams.get("board") ?? undefined);

    await seedViews(db, orgId, board.key);

    const rows = await db
      .select()
      .from(boardViews)
      .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, board.key)))
      .orderBy(asc(boardViews.position));

    const built = new Map<string, boolean>(
      VIEW_TYPES.map((type) => [type.key as string, type.built as boolean]),
    );

    return Response.json({
      board,
      views: rows.map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        type: row.type,
        icon: row.icon,
        position: row.position,
        isDefault: row.isDefault,
        system: row.system,
        filters: JSON.parse(row.filters || "[]"),
        sort: JSON.parse(row.sort || "[]"),
        settings: readSettings(row.settings),
        built: built.get(row.type) ?? false,
      })),
      types: VIEW_TYPES,
    });
  } catch (error) {
    return unavailable(error);
  }
}

/** POST /api/board/views — add a view. AA6. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;
    const body = await request.json().catch(() => ({}));
    const board = await resolveBoard(db, orgId, text(body.board, 48) || undefined);

    const name = text(body.name, 60);
    const type = text(body.type, 24);
    if (!name) return bad("A view name is required.");
    if (!VIEW_TYPES.some((entry) => entry.key === type)) {
      return bad(`"${type}" is not a view type.`);
    }

    let key = slug(name);
    const existing = await db
      .select({ key: boardViews.key })
      .from(boardViews)
      .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, board.key)));
    const taken = new Set(existing.map((row) => row.key));
    let suffix = 2;
    while (taken.has(key)) key = `${slug(name)}-${suffix++}`;

    const [tail] = await db
      .select({ maxPosition: sql<number>`COALESCE(MAX(${boardViews.position}), -1)` })
      .from(boardViews)
      .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, board.key)));

    const id = newId();
    await db.insert(boardViews).values({
      id,
      organisationId: orgId,
      boardId: board.key,
      key,
      name,
      type,
      icon: text(body.icon, 24) || null,
      filters: JSON.stringify(body.filters ?? []),
      sort: JSON.stringify(body.sort ?? []),
      settings: JSON.stringify(body.settings ?? {}),
      position: Number(tail?.maxPosition ?? -1) + 1,
      createdBy: actor.displayName || null,
    });

    return Response.json({ id, key, name, type }, { status: 201 });
  } catch (error) {
    return unavailable(error);
  }
}

/** PATCH /api/board/views — rename, reorder, set default, save filters. AA4. */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const body = await request.json().catch(() => ({}));

    if (Array.isArray(body.order)) {
      for (const entry of body.order) {
        const id = text(entry?.id, 64);
        const position = Number(entry?.position);
        if (!id || !Number.isFinite(position)) continue;
        await db
          .update(boardViews)
          .set({ position, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(and(eq(boardViews.id, id), eq(boardViews.organisationId, orgId)));
      }
      return Response.json({ ok: true });
    }

    const id = text(body.id, 64);
    if (!id) return bad("A view id is required.");

    const [existing] = await db
      .select()
      .from(boardViews)
      .where(and(eq(boardViews.id, id), eq(boardViews.organisationId, orgId)));
    if (!existing) return bad("View not found.", 404);

    const patch: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };
    if (typeof body.name === "string") {
      const name = text(body.name, 60);
      if (!name) return bad("View name cannot be empty.");
      patch.name = name;
    }
    if (Array.isArray(body.filters)) patch.filters = JSON.stringify(body.filters);
    if (Array.isArray(body.sort)) patch.sort = JSON.stringify(body.sort);
    if (body.settings && typeof body.settings === "object") {
      patch.settings = JSON.stringify(body.settings);
    }

    // Only one default per board.
    if (body.isDefault === true) {
      await db
        .update(boardViews)
        .set({ isDefault: false })
        .where(
          and(
            eq(boardViews.organisationId, orgId),
            eq(boardViews.boardId, existing.boardId),
          ),
        );
      patch.isDefault = true;
    }

    await db
      .update(boardViews)
      .set(patch)
      .where(and(eq(boardViews.id, id), eq(boardViews.organisationId, orgId)));

    return Response.json({ ok: true });
  } catch (error) {
    return unavailable(error);
  }
}

/** DELETE /api/board/views?id=… — the default table view cannot be removed. */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), 64);
    if (!id) return bad("A view id is required.");

    const [existing] = await db
      .select()
      .from(boardViews)
      .where(and(eq(boardViews.id, id), eq(boardViews.organisationId, orgId)));
    if (!existing) return bad("View not found.", 404);
    if (existing.system) {
      return bad("The main table cannot be removed — it is how the board is edited.", 409);
    }

    await db
      .delete(boardViews)
      .where(and(eq(boardViews.id, id), eq(boardViews.organisationId, orgId)));

    return Response.json({ ok: true });
  } catch (error) {
    return unavailable(error);
  }
}
