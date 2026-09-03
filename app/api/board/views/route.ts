import { and, asc, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { boardViews, formConfigurations } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import { RETENTION_DAYS, sendBoardViewToBin } from "../../../lib/recycle-bin";
import {
  BoardNotFoundError,
  DEFAULT_BOARD_KEY,
  isBoardNotFound,
  resolveBoard,
  type BoardRecord,
} from "../../../lib/board-registry";

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
  /*
   * A board key this organisation does not have is a bad REQUEST, not an
   * outage, and must never be quietly answered with somebody else's board —
   * see `boardFrom` below. `resolveBoard` throws `BoardNotFoundError` for it;
   * without this arm that landed here and came back as 503 "temporarily
   * unavailable", telling the browser to retry something no retry can fix.
   */
  if (isBoardNotFound(error)) {
    const named = (error as Error).message;
    /* `boardFrom` throws this with an empty key for `?board=` with nothing
       after it, and 'Board "" does not exist.' explains nothing. */
    return Response.json(
      { error: named.includes('""') ? "No board was named." : named },
      { status: 404 },
    );
  }
  return Response.json({ error: "Board views are temporarily unavailable." }, { status: 503 });
}

/**
 * WHICH BOARD A REQUEST IS ABOUT — ONE ANSWER FOR ALL FOUR VERBS.
 *
 * THE FAULT THIS FIXES. `GET` read `?board=` from the query string and `POST`
 * read `body.board` from the JSON body. `board-chrome.tsx`'s `send()` puts the
 * key in the QUERY STRING for every verb, so `body.board` was always absent,
 * `resolveBoard`'s default parameter took over, and every view added from a
 * custom section's register was written to the canonical job board. Proven on
 * the running server: `POST /api/board/views?board=sec-f47167fe0157` with a
 * Calendar produced view `s2qa-calendar` on `maintenance` — the job board's tab
 * strip went from eleven tabs to twelve — while the section's own strip still
 * showed only `main`. Nothing errored, which is what made it survive.
 *
 * So the question is asked ONCE, here, and the query string is the authority
 * because that is where the client has always put it. The body is still read as
 * a fallback so a caller written against the old POST contract keeps working.
 *
 * NO SILENT FALLBACK. An unknown key throws `BoardNotFoundError` and comes back
 * as a 404 through `unavailable` above; it is never answered with the default
 * board. An ABSENT key still means the default, because that is how the
 * canonical job board addresses itself — `boardUrl()` in `live-board.tsx` omits
 * the parameter for `maintenance` — so an absent parameter is a positive
 * statement about which board is meant rather than a missing scope.
 */
async function boardFrom(
  request: Request,
  db: Database,
  orgId: string,
  body?: unknown,
): Promise<BoardRecord> {
  const raw = new URL(request.url).searchParams.get("board");
  const fromQuery = text(raw, 48);
  /*
   * `?board=` WITH NOTHING AFTER IT IS NOT "NO OPINION".
   *
   * Absent means the default board, as above. Present and empty means a caller
   * that meant to name a board and had none to name — which is exactly what a
   * section with no register of its own produces: `portal-app.tsx` passes
   * `activeCustom.boardKey ?? ""`. Treating that as absent would hand a
   * detached section the JOB BOARD's tab strip and let it write views onto it,
   * which is the whole failure this route was just fixed for.
   */
  if (raw !== null && !fromQuery) throw new BoardNotFoundError("");
  const fromBody =
    body && typeof body === "object"
      ? text((body as Record<string, unknown>).board, 48)
      : "";
  return resolveBoard(db, orgId, fromQuery || fromBody || undefined);
}

/**
 * The refusal a write gets when the view it names lives on a different board
 * than the request does.
 *
 * A view id is unique, so the update would "work" — which is the problem. The
 * tab strip on a section's register would be able to rename, reorder, re-default
 * or bin a tab on the canonical job board, and the operator would see nothing
 * happen on their own screen. Only checked when the caller named a board, so a
 * caller that addresses a view purely by id is unaffected.
 */
function wrongBoard(viewBoardId: string, board: BoardRecord, named: boolean) {
  if (!named || viewBoardId === board.key) return null;
  return bad("That view is not on this board.", 404);
}

/** Did this request actually name a board, or is it taking the default? */
function namesBoard(request: Request, body?: unknown) {
  if (text(new URL(request.url).searchParams.get("board"), 48)) return true;
  return Boolean(
    body && typeof body === "object" && text((body as Record<string, unknown>).board, 48),
  );
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

/**
 * The three view types that are a FORM's surfaces rather than the board's.
 *
 * `form` is the form itself, and `form-results` and `form-responses` count and
 * list what people sent through it. All three name the form in their own copy.
 */
const FORM_BACKED: ReadonlySet<string> = new Set([
  "form",
  "form-results",
  "form-responses",
]);

/**
 * WHICH TYPES THIS BOARD CAN ACTUALLY PRODUCE A WORKING VIEW OF — owner §8/§26.
 *
 * `VIEW_TYPES` says whether the product has BUILT a renderer. That is not the
 * same question as whether this board can use it, and the difference is a leak
 * rather than a cosmetic one: a section's generated register has no form, and
 * `FormBuilder` asks `/api/board/form` with no board at all, so a Form view
 * added to a register drew the CANONICAL JOB BOARD's public form — its title,
 * its questions, and the Location dropdown listing all 39 real store names —
 * with a working Submit that filed the job onto the job board. Verified on the
 * running server: the Form tab on `sec-f47167fe0157` rendered "Maintenance
 * Request … Please fill up 1 form for each repair requested" and the estate.
 *
 * So a board with no form of its own reports the three form-backed types as
 * unbuilt: the "+" menu draws them disabled, `POST` refuses them, and an
 * existing row of that type renders the placeholder instead of somebody else's
 * form. The job board has a form and is unaffected. The other half of this —
 * teaching `FormBuilder` to ask for its own board — belongs to the form lane;
 * until it lands, this is what stops the form being served where it does not
 * belong.
 */
async function typesFor(db: Database, orgId: string, boardKey: string) {
  const [form] = await db
    .select({ id: formConfigurations.id })
    .from(formConfigurations)
    .where(
      and(
        eq(formConfigurations.organisationId, orgId),
        eq(formConfigurations.boardId, boardKey),
      ),
    )
    .limit(1);
  if (form) return VIEW_TYPES.map((type) => ({ ...type }));
  return VIEW_TYPES.map((type) =>
    FORM_BACKED.has(type.key) ? { ...type, built: false } : { ...type },
  );
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
    const board = await boardFrom(request, db, orgId);

    await seedViews(db, orgId, board.key);

    const rows = await db
      .select()
      .from(boardViews)
      .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, board.key)))
      .orderBy(asc(boardViews.position));

    /* Per BOARD, not per product — see `typesFor`. One answer feeds both the
       tab strip's `built` flags and the "+" menu, so they cannot disagree. */
    const types = await typesFor(db, orgId, board.key);
    const built = new Map<string, boolean>(types.map((type) => [type.key, type.built]));

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
      types,
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
    /* The query string first — that is where the chrome puts it. See `boardFrom`. */
    const board = await boardFrom(request, db, orgId, body);

    const name = text(body.name, 60);
    const type = text(body.type, 24);
    if (!name) return bad("A view name is required.");
    /* The same list the "+" menu was drawn from, asked of the same board. */
    const definition = (await typesFor(db, orgId, board.key)).find(
      (entry) => entry.key === type,
    );
    if (!definition) {
      return bad(`"${type}" is not a view type.`);
    }
    /*
     * A TYPE NOTHING CAN RENDER IS NOT A VIEW — owner §8/§26.
     *
     * The "+" menu listed every entry in `VIEW_TYPES` as a live choice, unbuilt
     * ones included, so picking Timeline wrote a real row, drew a real tab and
     * opened a panel reading "Timeline is not built yet". A clickable no-op that
     * leaves a dead tab behind on the board. The menu now draws those entries
     * disabled (`AddViewMenu`), and this is the same rule on the server so the
     * row cannot be created by any other caller either.
     */
    if (!definition.built) {
      return bad(
        FORM_BACKED.has(type)
          ? `This board has no form of its own, so ${definition.label} would have nothing to show.`
          : `${definition.label} is not built yet, so it cannot be added.`,
        409,
      );
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

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({
        actor,
        identityEmail: guard.scope.identityEmail,
        session: guard.scope.session,
      }),
      action: "board.view_created",
      entityType: "board_view",
      entityId: id,
      summary: `Added the "${name}" ${type} view to ${board.key}.`,
      detail: { board: board.key, key, name, type },
      request,
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
    /* The same question the other three verbs ask, asked the same way. */
    const board = await boardFrom(request, db, orgId, body);
    const named = namesBoard(request, body);

    if (Array.isArray(body.order)) {
      /*
       * Scoped to THIS board's views, not to every view in the organisation.
       *
       * The lookup read the whole organisation and the UPDATE keyed on the id
       * alone, so a reorder posted from a section's strip could renumber tabs on
       * the job board — the same cross-board write `POST` was making, in the one
       * verb where the ids come from the client. The board filter turns an id
       * from another board into a row this loop simply does not know about.
       */
      const before = await db
        .select({ id: boardViews.id, name: boardViews.name, position: boardViews.position, boardId: boardViews.boardId })
        .from(boardViews)
        .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, board.key)));
      const byId = new Map(before.map((row) => [row.id, row]));
      const moved: Array<{ id: string; name: string; from: number; to: number }> = [];

      for (const entry of body.order) {
        const id = text(entry?.id, 64);
        const position = Number(entry?.position);
        if (!id || !Number.isFinite(position)) continue;
        const existing = byId.get(id);
        if (!existing) continue;
        if (existing.position !== position) {
          moved.push({ id, name: existing.name, from: existing.position, to: position });
        }
        await db
          .update(boardViews)
          .set({ position, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(boardViews.id, id),
              eq(boardViews.organisationId, orgId),
              eq(boardViews.boardId, board.key),
            ),
          );
      }

      if (moved.length) {
        await recordAudit({
          db,
          organisationId: orgId,
          actor: auditActor({
            actor: guard.scope.actor,
            identityEmail: guard.scope.identityEmail,
            session: guard.scope.session,
          }),
          action: "board.views_reordered",
          entityType: "board_view",
          entityId: moved[0].id,
          summary: `Reordered ${moved.length} view${moved.length === 1 ? "" : "s"} on ${byId.get(moved[0].id)?.boardId ?? "the board"}.`,
          detail: { moved },
          request,
        });
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
    const misplaced = wrongBoard(existing.boardId, board, named);
    if (misplaced) return misplaced;

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

    /*
     * Renaming a view and making it the board's default are changes everybody
     * in the workspace sees; saving a filter or a sort onto it is a change to
     * what that view shows, which is the same kind of thing. All four are
     * recorded. The `settings` blob is not diffed field by field — it carries
     * a tab glyph and the parity stamp, neither of which is a decision.
     */
    const auditable = ["name", "filters", "sort", "isDefault"].filter(
      (field) => field in patch,
    );
    if (auditable.length) {
      await recordAudit({
        db,
        organisationId: orgId,
        actor: auditActor({
          actor: guard.scope.actor,
          identityEmail: guard.scope.identityEmail,
          session: guard.scope.session,
        }),
        action: "board.view_updated",
        entityType: "board_view",
        entityId: id,
        summary: `Updated the "${patch.name ?? existing.name}" view on ${existing.boardId} (${auditable.join(", ")}).`,
        detail: {
          board: existing.boardId,
          ...changeDetail(
            Object.fromEntries(
              auditable.map((field) => [field, (existing as Record<string, unknown>)[field]]),
            ),
            Object.fromEntries(auditable.map((field) => [field, patch[field]])),
          ),
        },
        request,
      });
    }

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
    /* Same question, same answer — and a 404 rather than the default board. */
    const board = await boardFrom(request, db, orgId);

    const [existing] = await db
      .select()
      .from(boardViews)
      .where(and(eq(boardViews.id, id), eq(boardViews.organisationId, orgId)));
    if (!existing) return bad("View not found.", 404);
    const misplaced = wrongBoard(existing.boardId, board, namesBoard(request));
    if (misplaced) return misplaced;
    if (existing.system) {
      return bad("The main table cannot be removed — it is how the board is edited.", 409);
    }

    /*
     * W13-06 — the view goes to the recycle bin rather than to nothing.
     *
     * It used to be a straight DELETE, so a mis-click on "Delete" in the tab
     * menu destroyed the view's saved filters and sort with no way back. A view
     * is one small configuration row, so the whole of it fits in the bin's
     * existing snapshot column and Restore is a single insert — no schema
     * change, and the 30-day retention every other binned thing gets.
     */
    const binned = await sendBoardViewToBin(
      db,
      orgId,
      {
        email: guard.scope.identityEmail || guard.scope.actor.email,
        displayName: guard.scope.actor.displayName,
      },
      id,
    );
    if (!binned) return bad("View not found.", 404);

    await recordAudit({
      db,
      organisationId: orgId,
      actor: auditActor({
        actor: guard.scope.actor,
        identityEmail: guard.scope.identityEmail,
        session: guard.scope.session,
      }),
      action: "board.view_deleted",
      entityType: "board_view",
      entityId: id,
      summary: `Moved the "${existing.name}" view on ${existing.boardId} to the recycle bin.`,
      detail: {
        board: existing.boardId,
        type: existing.type,
        recoverable: true,
        retentionDays: RETENTION_DAYS,
      },
      request,
    });

    return Response.json({ ok: true, recycled: true, retentionDays: RETENTION_DAYS });
  } catch (error) {
    return unavailable(error);
  }
}
