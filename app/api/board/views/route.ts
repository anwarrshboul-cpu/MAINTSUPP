import { and, asc, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  boardViews,
  formConfigurations,
  maintenanceBoardColumns,
} from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import { RETENTION_DAYS, sendBoardViewToBin } from "../../../lib/recycle-bin";
/* `DEFAULT_BOARD_KEY` is deliberately NOT imported any more. `seedViews` was
   the last thing in this file that compared a board key to it, and importing a
   constant whose only use would be such a comparison is how the next one gets
   written. Which board a request is about comes from `resolveBoard`; what a
   board may DO comes from the board's own record and columns. */
import {
  BoardNotFoundError,
  isBoardNotFound,
  resolveBoard,
  type BoardRecord,
} from "../../../lib/board-registry";

export const dynamic = "force-dynamic";

/**
 * EVERY VIEW TYPE THE PRODUCT SHIPS A RENDERER FOR — AND NOTHING ELSE.
 *
 * ONE LIST, ONE ANSWER, FOR THE CANONICAL JOB BOARD AND FOR EVERY INSTANCE.
 * This is the "+ Add view" menu and the tab strip's build state at the same
 * time, and `typesFor` below is the only thing that narrows it. A section's
 * generated register therefore offers what its source offers BY CONSTRUCTION —
 * there is no second list, and nothing anywhere compares a board key to decide
 * what a board may draw.
 *
 * A TYPE WITH NO RENDERER IS NOT LISTED AT ALL — owner §8/§26.
 *
 * `timeline` sat in this list with `built: false`, so the "+" menu drew a
 * greyed "Timeline · soon" entry on every board and the route refused it with a
 * 409. The owner's rule is that a type the original does not support "must not
 * be offered at all — not greyed, not a no-op", and a disabled entry for
 * something nobody has started is still an offer. monday's capture of board
 * 1139774521 has no timeline tab either (see SEED_VIEWS below), so there is no
 * original to be at parity with and nothing was ever going to render. It is
 * gone from the offer entirely rather than disabled inside it.
 *
 * `built` here means "this product has a renderer". Whether THIS BOARD can
 * produce a working view of it is a different question, asked per board by
 * `typesFor`, which is where a form-backed type on a form-less register is
 * turned into an offer that carries its own configuration instruction.
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
  { key: "chart", label: "Chart", icon: "chart", built: true },
  { key: "gallery", label: "File gallery", icon: "image", built: true },
  { key: "reports", label: "Reports", icon: "chart", built: true },
  { key: "form-results", label: "Form results", icon: "chart", built: true },
  { key: "form-responses", label: "Form responses", icon: "inbox", built: true },
  { key: "flat-table", label: "Flat table", icon: "grid", built: true },
  { key: "vibe", label: "Vibe app", icon: "spark", built: true },
] as const;

/**
 * What a board is offered, once its own capabilities have been read.
 *
 * `built` is the product's answer narrowed to this board; `unavailable` is the
 * sentence that goes with a `false`. The pair exists because "not offered" and
 * "offered, and here is what to configure first" are different things to a
 * person, and the menu could previously only say "soon" — which is not true of
 * a renderer this product shipped a year ago.
 *
 * The shape mirrors `SECTION_TEMPLATES` in `app/api/workspace-sections/
 * catalogue.ts`, which answers the same §8 question for the Add-section dialog:
 * an entry that cannot be chosen is drawn WITH ITS REASON, because an
 * unavailable entry with no reason is a dead control.
 */
export type ViewTypeOffer = {
  key: string;
  label: string;
  icon: string;
  built: boolean;
  unavailable?: string;
};

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
 * Marks a board whose seeded strip has been decided. Stamped on the `main` row,
 * which is the one view DELETE refuses to remove, so the marker cannot be lost
 * by an admin tidying up their tab strip.
 *
 * THE VALUE IS HISTORY AND MUST NOT BE "CORRECTED". It read "monday's eleven"
 * when only the canonical job board was ever seeded; a generated Jobs register
 * with no form of its own takes eight of the same tabs, so the name is now
 * narrower than the thing it marks. Changing the string would make every board
 * already carrying it look unstamped and re-run the upgrade over strips their
 * admins have since edited — the one thing `seedViews` promises never to do.
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
 * The two view types that read a FORM'S ANSWERS rather than the board's rows.
 *
 * `form-results` counts how the answers to each question divide and
 * `form-responses` lists the submissions; both name the form in their own copy,
 * and `FormResultsView` walks `maintenanceFormSpec.questions` to decide what to
 * count. On a register with no form of its own that panel would head itself
 * with the CANONICAL form's title — "No responses to Maintenance Request yet"
 * on a register for CCTV — and list the job board's questions with zero answers
 * beside each. Not a leak of data, but a confident answer about a form that
 * does not exist.
 *
 * `form` IS NOT ONE OF THEM, and that changed with W2 requirement B. The Form
 * view is the form's own surface rather than a reader of it, and `FormBuilder`
 * now offers "Create a form for this register" when the board has none —
 * deriving its questions from that board's own columns — instead of falling
 * through to `FormView`, which posts to `/api/maintenance` and would have filed
 * onto the job board. Keeping `form` gated here would have left that create
 * button unreachable on the only boards that need it: an instance would be
 * refused the tab that offers to make the thing the tab is waiting for.
 */
const READS_FORM_ANSWERS: ReadonlySet<string> = new Set([
  "form-results",
  "form-responses",
]);

/**
 * WHICH TYPES THIS BOARD CAN ACTUALLY PRODUCE A WORKING VIEW OF — owner §8/§26.
 *
 * `VIEW_TYPES` says whether the product has BUILT a renderer. That is not the
 * same question as whether this board can use it, and this is the only place
 * the two answers are allowed to differ.
 *
 * IT IS AN OFFER WITH A CONDITION, NOT A REFUSAL. A type that lands here is
 * neither "supported" nor "not supported by the original" — it is the owner's
 * third category, REQUIRES CONFIGURATION: the original supports it, this board
 * will too once it has been configured, and until then the entry carries the
 * sentence saying exactly what is missing. Dropping it from the list would tell
 * an operator the product cannot do something it does every day on the board
 * next door; drawing it with a "soon" pill would say nobody has written it yet,
 * which is untrue of a renderer that shipped in Stage 19.
 *
 * THE SAME FUNCTION ANSWERS FOR EVERY BOARD. `maintenance` and `sec-<12hex>`
 * go through this identical query against their own `form_configurations` row.
 * That is the whole of requirement C's "absent for the same reason it is absent
 * on the original, expressed in shared code, not by comparing board keys": the
 * job board has a form, so it is offered everything; a register that has not
 * been given one yet is short exactly the two views that read a form's answers,
 * and it stops being short them the moment somebody creates one.
 */
function needsOwnForm(label: string) {
  return (
    `${label} counts the answers to this register's own form, and this ` +
    `register has none yet. Open the Form view and create one — its questions ` +
    `come from this board's own columns — and this view then reads it.`
  );
}

async function typesFor(
  db: Database,
  orgId: string,
  boardKey: string,
): Promise<ViewTypeOffer[]> {
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
    READS_FORM_ANSWERS.has(type.key)
      ? { ...type, built: false, unavailable: needsOwnForm(type.label) }
      : { ...type },
  );
}

/**
 * THE COLUMNS THAT MAKE A BOARD A JOBS REGISTER — the capability that replaced
 * a board-key comparison.
 *
 * `seedViews` below used to open with `if (boardKey !== DEFAULT_BOARD_KEY)
 * return;`, which is exactly the isolation-by-route-string the owner ruled out.
 * Its effect was the parity gap he is buying against: the canonical job board
 * came up with monday's eleven tabs and a register generated from the SAME Jobs
 * template came up with one, so "the original section, with all its
 * functionality and configuration, but empty" arrived without its Fix Tracker,
 * its Calendar, its Chart, its File gallery or its Board Reports.
 *
 * A board is a Jobs register when it carries the Jobs register's own columns,
 * and only `seedBoardStructure` in `db/init.ts` produces them — the canonical
 * board through `ensureDatabase`, an instance through
 * `provisionDefaultStructure`. So the test is true for both and false for
 * everything else: Store Documentation's twelve are `rams`/`patExpiry`/…, and
 * the pre-template generic register's six are `name`/`state`/`owner`/… . None
 * of them is `issuePictures`.
 *
 * Four keys rather than one, because a single column is a coincidence and these
 * four span the spec — a status, a priority, a date and a file column. All four
 * are `system` (request-backed) columns, which is what makes them the board's
 * shape rather than an admin's arrangement.
 */
const JOBS_REGISTER_COLUMNS = ["status", "priority", "requested", "issuePictures"];

async function isJobsRegister(db: Database, orgId: string, boardKey: string) {
  const rows = await db
    .select({ key: maintenanceBoardColumns.key })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, orgId),
        eq(maintenanceBoardColumns.boardId, boardKey),
      ),
    );
  const keys = new Set(rows.map((row) => row.key));
  return JOBS_REGISTER_COLUMNS.every((key) => keys.has(key));
}

/**
 * The seeded strip this board can actually serve.
 *
 * SEED_VIEWS is monday's eleven; a register with no form of its own cannot
 * serve three of them, and seeding a tab that opens onto its own refusal is the
 * dead tab this whole workstream is about. Filtered through the SAME
 * `typesFor` answer the "+" menu is drawn from, so the strip and the menu
 * cannot disagree about what this board can do.
 */
function seedStripFor(types: ViewTypeOffer[]) {
  const built = new Map(types.map((type) => [type.key, type.built]));
  return SEED_VIEWS.filter((view) => built.get(view.type) === true);
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
 * Brings a board that has a `main` tab and nothing else up to the strip its
 * template gives it — the missing tabs are inserted, "Reports" takes monday's
 * own name, and every seeded tab moves to its position in `strip`.
 *
 * TWO BOARDS ARRIVE HERE AND THEY ARE THE SAME CASE. The canonical job board
 * was seeded before Stage 19 and is missing the four tabs that were folded
 * away. A register generated for a workspace section was given exactly one tab
 * by `provisionMainView` in `app/lib/board-registry.ts` and is missing the rest
 * of the strip its Jobs template implies. Both are "a board holding a subset of
 * the strip it should have", and running one function over both is what stops
 * the instance drifting from its source the next time a tab is added.
 *
 * Runs once. The marker lives on `main.settings` rather than being inferred
 * from which tabs are present, so Stage 5's promise survives: an admin who
 * deletes Results does not get it back on the next page load.
 */
async function upgradeToTemplateStrip(
  db: Database,
  orgId: string,
  boardKey: string,
  rows: Array<typeof boardViews.$inferSelect>,
  main: typeof boardViews.$inferSelect,
  strip: SeedView[],
) {
  const byKey = new Map(rows.map((row) => [row.key, row]));

  for (const [position, view] of strip.entries()) {
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

  // Views an admin added keep their relative order, behind the seeded strip.
  for (const row of rows) {
    if (SEED_KEYS.has(row.key)) continue;
    await db
      .update(boardViews)
      .set({ position: strip.length + row.position, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(boardViews.id, row.id), eq(boardViews.organisationId, orgId)));
  }

  await stampStripApplied(db, orgId, main);
}

/**
 * Records that the seeded-strip decision has been made for this board.
 *
 * Written on the `main` row — the one view DELETE refuses to remove — so the
 * marker cannot be lost by an admin tidying up their tab strip. It is stamped
 * on a board that takes NO strip as well as on one that has just been given
 * its own, because "decided" is the thing being recorded: without that, a
 * register the product does not seed would re-ask the question on every single
 * page load for ever.
 */
async function stampStripApplied(
  db: Database,
  orgId: string,
  main: typeof boardViews.$inferSelect,
) {
  await db
    .update(boardViews)
    .set({
      settings: JSON.stringify({ ...readSettings(main.settings), seed: PARITY_STAMP }),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(eq(boardViews.id, main.id), eq(boardViews.organisationId, orgId)));
}

/**
 * Seeds the tab strip a board's own structure entitles it to, on first read.
 * Idempotent — an admin who deletes a seeded view does not get it back on the
 * next page load.
 *
 * NOT "ONLY THE MAINTENANCE BOARD". This opened `if (boardKey !==
 * DEFAULT_BOARD_KEY) return;`, and that single line was the parity gap the
 * owner reported: a register generated from the Jobs template came up with the
 * one tab `provisionMainView` gave it while the board it was copied from came
 * up with eleven, so "the original section, with all its functionality and
 * configuration" arrived with no Fix Tracker, no Calendar, no Chart, no File
 * gallery and no Board Reports. The question is now asked of the BOARD — see
 * `isJobsRegister` — so an instance is seeded because it IS a Jobs register,
 * not because of what it is called.
 *
 * A board that is not one keeps whatever its own creator gave it. Store
 * Documentation declares its three tabs in `views/store-documentation-board.tsx`
 * and holds no `board_views` rows at all; the pre-template generic register
 * holds the single Main table `board-registry.ts` seeds it. Neither is offered
 * Fix Tracker or the Maintenance Request form, which is what the board-key test
 * was protecting and what the column test protects properly.
 */
async function seedViews(
  db: Database,
  orgId: string,
  boardKey: string,
  types: ViewTypeOffer[],
) {
  const [existing] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(boardViews)
    .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, boardKey)));

  if (Number(existing?.total ?? 0) > 0) {
    const rows = await db
      .select()
      .from(boardViews)
      .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, boardKey)));
    const main = rows.find((row) => row.key === "main");
    // No `main` row means these views are not ours to reorder — leave them be.
    if (!main || readSettings(main.settings).seed === PARITY_STAMP) return;
    if (!(await isJobsRegister(db, orgId, boardKey))) {
      await stampStripApplied(db, orgId, main);
      return;
    }
    await upgradeToTemplateStrip(db, orgId, boardKey, rows, main, seedStripFor(types));
    return;
  }

  if (!(await isJobsRegister(db, orgId, boardKey))) return;
  for (const [position, view] of seedStripFor(types).entries()) {
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

    /*
     * Per BOARD, not per product — see `typesFor`. ONE answer feeds the seeded
     * strip, the tab strip's `built` flags and the "+" menu, so none of the
     * three can disagree about what this board can draw. Asked BEFORE seeding
     * because it is what decides which tabs the strip is entitled to; nothing
     * seeding does can change the answer.
     */
    const types = await typesFor(db, orgId, board.key);
    await seedViews(db, orgId, board.key, types);

    const rows = await db
      .select()
      .from(boardViews)
      .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, board.key)))
      .orderBy(asc(boardViews.position));

    const offers = new Map(types.map((type) => [type.key, type]));

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
        built: offers.get(row.type)?.built ?? false,
        /*
         * WHY THE ROW CARRIES THE REASON AND NOT JUST THE FLAG.
         *
         * `board-view-pane.tsx` used to hold its own copy of `FORM_BACKED` so
         * it could say why a tab was refusing to draw — a second statement of
         * the classification, in a file that has no idea whether this board has
         * a form. Sending the sentence with the row leaves one author of it.
         * A row naming a type this build no longer offers (`timeline`) is not
         * in `offers` at all and gets no reason, which is what the pane's
         * "is not built yet" fallback is for.
         */
        unavailable: offers.get(row.type)?.unavailable,
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
     * A TYPE THIS BOARD CANNOT SERVE IS NOT A VIEW — owner §8/§26.
     *
     * The "+" menu listed every entry in `VIEW_TYPES` as a live choice, unbuilt
     * ones included, so picking Timeline wrote a real row, drew a real tab and
     * opened a panel reading "Timeline is not built yet". A clickable no-op that
     * leaves a dead tab behind on the board. Timeline is no longer offered at
     * all; what is left here is the board-specific case — a form-backed type on
     * a register with no form — and the refusal carries `typesFor`'s own
     * sentence rather than a second copy of it, so the server's answer and the
     * menu's label are the same words.
     */
    if (!definition.built) {
      return bad(
        definition.unavailable ??
          `${definition.label} cannot be added to this board.`,
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

      /*
       * A REORDER NAMING A VIEW ON ANOTHER BOARD IS REFUSED, NOT IGNORED.
       *
       * Scoping the lookup to this board (above) already stopped the write —
       * a foreign id is simply not in `byId`, so the UPDATE never ran. But the
       * loop then `continue`d past it and the request came back `{ ok: true }`.
       * Measured on the running server: `PATCH ?board=<a section>` carrying the
       * canonical job board's `form` view answered 200 with the job board
       * untouched, so the caller was told a reorder had happened that could
       * not have happened. Every other verb on this route answers 404 for the
       * same mistake — `wrongBoard` — and an order list is no different: the
       * ids come from the client, and a client working from a stale strip needs
       * to be told its strip is stale rather than shown a success.
       *
       * Only when the request NAMED a board, exactly as `wrongBoard` is. A
       * caller addressing views purely by id keeps the old, lenient behaviour.
       */
      if (named) {
        for (const entry of body.order) {
          const id = text(entry?.id, 64);
          if (id && !byId.has(id)) return bad("That view is not on this board.", 404);
        }
      }

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
