import { and, asc, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import {
  automationRuns,
  boardAutomations,
  boardViews,
  boards,
  formConfigurations,
  maintenanceBoardColumns,
  maintenanceBoardOptions,
  maintenanceGroupItems,
  maintenanceGroups,
  recycleBin,
} from "../../db/schema";
import {
  GENERIC_BOARD_COLUMNS,
  GENERIC_BOARD_GROUPS,
  GENERIC_COLUMN_SETTINGS,
} from "./generic-board-template";

type Database = Awaited<ReturnType<typeof getDb>>;

export type BoardRecord = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: string;
  itemNoun: string;
  referencePrefix: string;
  position: number;
  archived: boolean;
};

/** The board every pre-Stage-3 row implicitly belonged to. */
export const DEFAULT_BOARD_KEY = "maintenance";

/**
 * A caller named a board that does not exist in this organisation.
 *
 * This is a bad *request*, not an outage: without a type for it the generic
 * `Error` thrown below was indistinguishable from a database failure in a
 * route's catch, so `/api/board/items?board=<unknown>` answered 503 "temporarily
 * unavailable" — telling a browser to retry a request no retry can fix. Routes
 * that care can catch this and return 404 instead; those that do not keep their
 * existing behaviour.
 */
export class BoardNotFoundError extends Error {
  constructor(key: string) {
    super(`Board "${key}" does not exist.`);
    this.name = "BoardNotFoundError";
  }
}

/** True when `error` is a request for a board that does not exist. */
export function isBoardNotFound(error: unknown): error is BoardNotFoundError {
  return error instanceof BoardNotFoundError;
}

function newId() {
  return `board_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function slugifyKey(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** The namespace every board created FOR a workspace section carries. */
export const SECTION_BOARD_PREFIX = "sec-";

/**
 * W2 R1 — A BOARD'S IDENTITY IS NEVER ITS DISPLAY NAME.
 *
 * `createBoard` used to key a board `slugifyKey(name)`, which made the label an
 * identifier and produced the owner's reproduction: create a section called
 * "test", remove it permanently, create "test" again — refused, because a board
 * keyed `test` was still there. Two independent defects met in that one key.
 * The board survived (a `surface` change had silently nulled the `surface_ref`
 * that made it owned, so the purge's ownership test found nothing to delete),
 * and because the key WAS the name, the surviving board held the name hostage.
 *
 * The key is now generated from the instance, so the two are decoupled for
 * good: renaming a section changes `boards.name` and nothing else, and a board
 * that somehow outlives its section is invisible litter rather than a name
 * nobody can use again. 48 bits is far past collision for the handful of boards
 * one organisation has, and `createBoard` still checks for a clash.
 *
 * The prefix is load-bearing as well as readable: it is what tells a
 * section-generated board apart from a board keyed by the pre-W2 code, which is
 * how `db/init.ts` can sweep the legacy orphans without ever being able to race
 * a board being created right now.
 */
export function newSectionBoardKey() {
  return `${SECTION_BOARD_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** True for a key this build's `createBoard` generated, exactly. */
export function isSectionBoardKey(key: string) {
  return new RegExp(`^${SECTION_BOARD_PREFIX}[0-9a-f]{12}$`).test(key);
}

/**
 * Derives a reference prefix from a board name — "Maintenance" becomes MS,
 * "Store Fit Out" becomes SFO. Falls back to MS so a reference is never blank.
 */
export function derivePrefix(name: string) {
  const words = name.split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words.map((word) => word[0]).join("")
      : (words[0] ?? "").slice(0, 2);
  return (letters || "MS").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) || "MS";
}

export async function listBoards(
  db: Database,
  organisationId: string,
): Promise<BoardRecord[]> {
  const rows = await db
    .select()
    .from(boards)
    .where(eq(boards.organisationId, organisationId))
    .orderBy(asc(boards.position), asc(boards.name));

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    kind: row.kind,
    itemNoun: row.itemNoun,
    referencePrefix: row.referencePrefix,
    position: row.position,
    archived: row.archived,
  }));
}

/**
 * Which board a work order actually sits on.
 *
 * `maintenance_requests` carries no board id — placement is what decides, so
 * the answer comes from the row's placement. A row that has not been placed
 * yet belongs to the default board, which is what the board route assumes when
 * it files an unplaced row into `groups[0]`.
 *
 * This exists because both upload routes asked whether a file column belonged
 * to `"maintenance"` as a literal. Store Documentation's twelve file columns
 * are on `"store-documentation"`, so every certificate upload was answered
 * "The file column no longer exists." — the compliance tracker's entire
 * purpose, refused by its own API. Comparing against the work order's own
 * board fixes that without loosening anything: a column belonging to some
 * other board is still refused, which is the property the literal was there
 * to hold.
 */
export async function boardKeyForRequest(
  db: Database,
  organisationId: string,
  requestId: string,
): Promise<string> {
  /*
   * The placement's own `board_id`, not its group's.
   *
   * These can disagree: one Store Documentation row was found carrying
   * `board_id = "store-documentation"` while pointing at a *maintenance*
   * group, left behind by an earlier title-keyed import. Reading through the
   * group would call that row a maintenance row and refuse its certificates,
   * which is how the inconsistency was found.
   *
   * `board_id` is the authority because it is what the board route itself
   * filters on when it decides which rows a board contains. Answering from a
   * different column than the one the board reads would mean the upload check
   * and the board could disagree about where a row lives.
   */
  const [placement] = await db
    .select({ boardId: maintenanceGroupItems.boardId })
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.requestId, requestId),
        eq(maintenanceGroupItems.organisationId, organisationId),
      ),
    )
    .limit(1);

  return placement?.boardId ?? DEFAULT_BOARD_KEY;
}

/**
 * Resolves a board by key, creating the default one on first use.
 *
 * Existing rows carry `board_id = "maintenance"` as a literal string. Rather
 * than rewrite them, the default board is materialised on demand so both the
 * old text value and the new record resolve to the same thing.
 */
export async function resolveBoard(
  db: Database,
  organisationId: string,
  key: string = DEFAULT_BOARD_KEY,
): Promise<BoardRecord> {
  /*
   * A KEY THAT WAS GIVEN AND MEANS NOTHING IS NOT THE JOB BOARD.
   *
   * This was `slugifyKey(key) || DEFAULT_BOARD_KEY`, so a key of "!!!" — or any
   * string of punctuation, which `slugifyKey` reduces to "" — resolved to
   * maintenance. Callers that had already validated their input never noticed;
   * callers that pass a key straight through were handing an attacker-shaped
   * value a silent redirect onto the canonical board. It is the last member of
   * the fallback family this workstream has been closing.
   *
   * Omitting the argument still means the default board, because sixteen
   * callers rely on that and "no board named" genuinely does mean maintenance
   * here. Naming something that is not a board is now a `BoardNotFoundError`,
   * which the routes already turn into a 404.
   */
  const wanted = slugifyKey(key);
  if (!wanted) throw new BoardNotFoundError(key);

  const [existing] = await db
    .select()
    .from(boards)
    .where(and(eq(boards.organisationId, organisationId), eq(boards.key, wanted)));

  if (existing) {
    return {
      id: existing.id,
      key: existing.key,
      name: existing.name,
      description: existing.description,
      kind: existing.kind,
      itemNoun: existing.itemNoun,
      referencePrefix: existing.referencePrefix,
      position: existing.position,
      archived: existing.archived,
    };
  }

  if (wanted !== DEFAULT_BOARD_KEY) {
    throw new BoardNotFoundError(wanted);
  }

  const id = `board_${organisationId}_${DEFAULT_BOARD_KEY}`;
  await db
    .insert(boards)
    .values({
      id,
      organisationId,
      key: DEFAULT_BOARD_KEY,
      name: "Maintenance",
      kind: "maintenance",
      itemNoun: "Job",
      referencePrefix: "MS",
      position: 0,
    })
    .onConflictDoNothing();

  return {
    id,
    key: DEFAULT_BOARD_KEY,
    name: "Maintenance",
    description: null,
    kind: "maintenance",
    itemNoun: "Job",
    referencePrefix: "MS",
    position: 0,
    archived: false,
  };
}

/**
 * Give a board the default register structure — W02-06.
 *
 * Columns and groups, so the board is usable on its first load rather than an
 * empty canvas an owner has to furnish before it does anything. Called from
 * `createBoard` below rather than exported for callers to remember: a board
 * created by the canonical primitive is always complete, which is the property
 * that stops a second, half-finished creation path appearing later.
 *
 * The ids carry the BOARD KEY, and that is not cosmetic. The board route's own
 * self-healing seeder uses `tenantSeedId("column-system-<key>", orgId)`, which
 * does not — so on a second board in the same organisation every one of its
 * inserts collides with the first board's row and is discarded by
 * `onConflictDoNothing`, and the board comes up with no columns at all and no
 * error. Any per-board seeding here must key on the board or repeat that.
 *
 * Idempotent throughout: `maintenance_board_columns` is unique on
 * (organisation_id, board_id, column_key), so re-provisioning an existing board
 * changes nothing and cannot restore a column an admin deleted.
 */
async function provisionDefaultStructure(
  db: Database,
  organisationId: string,
  boardKey: string,
) {
  for (const [position, column] of GENERIC_BOARD_COLUMNS.entries()) {
    await db
      .insert(maintenanceBoardColumns)
      .values({
        id: `seed-${organisationId}-${boardKey}-${column.key}`,
        organisationId,
        boardId: boardKey,
        key: column.key,
        title: column.title,
        type: column.type,
        position: position * 1000,
        width: column.width,
        /* A custom column's choices live in its own `settings`, which is what
           the grid, the column menu and the mobile editor all read for a column
           that is not one of the five request-backed maintenance ones. */
        settings: column.settings
          ? JSON.stringify(column.settings)
          : GENERIC_COLUMN_SETTINGS,
        required: column.required === true,
        /* Only the row's own title is request-backed. Everything else is a cell,
           which is what makes it configurable and deletable like any column an
           admin adds by hand. */
        system: column.system === true,
        visible: true,
        pinned: false,
      })
      .onConflictDoNothing();
  }

  /*
   * One view tab, keyed `main`, because W02-07 asks a new section's page for
   * "views" and a board with no `board_views` row draws no tab strip at all.
   *
   * The key and the id follow `app/api/board/views/route.ts` exactly —
   * `seed-<org>-<board>-main`, `system: true`, `isDefault: true` — so the tab a
   * generated register starts with is the same Main table every other board
   * has, and `upgradeToMondayViews` can add the rest later if this board is
   * ever given monday's full strip. Deliberately ONE: the other ten are
   * maintenance-shaped (Fix Tracker, Form Response Viewer) and a register for
   * CCTV should not open holding tabs for a workflow it does not have.
   */
  await db
    .insert(boardViews)
    .values({
      id: `seed-${organisationId}-${boardKey}-main`,
      organisationId,
      boardId: boardKey,
      key: "main",
      name: "Main table",
      type: "table",
      icon: "grid",
      position: 0,
      isDefault: true,
      system: true,
    })
    .onConflictDoNothing();

  for (const [position, group] of GENERIC_BOARD_GROUPS.entries()) {
    await db
      .insert(maintenanceGroups)
      .values({
        id: `group-${organisationId}-${boardKey}-${group.key}`,
        organisationId,
        boardId: boardKey,
        name: group.name,
        color: group.colour,
        stageKey: null,
        position,
      })
      .onConflictDoNothing();
  }
}

/**
 * Create a board, with the structure that makes it a register rather than a row
 * in a table — W02-06.
 *
 * This had no callers at all until the section editor needed one: adding a
 * section bound it to an EXISTING screen, so two sections showed the same data
 * and "generate the same default page structure" was unmet by design. It is now
 * the one board-creation primitive, and it provisions structure as part of
 * creating a board so there is no way to call it and get an unusable board.
 */
export async function createBoard(
  db: Database,
  organisationId: string,
  input: {
    name: string;
    description?: string;
    itemNoun?: string;
    kind?: string;
    /**
     * An explicit key, for a caller that needs a well-known one. Absent — which
     * is every caller today — the key is GENERATED, never derived from the name.
     * See `newSectionBoardKey` for why that is the default rather than the
     * option: a name-derived key makes the display name an identifier, and the
     * name then cannot be reused after the board is gone.
     */
    key?: string;
  },
): Promise<BoardRecord> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("A board name is required.");

  const key = input.key ? slugifyKey(input.key) : newSectionBoardKey();
  if (!key) throw new Error("A board key is required.");
  const [clash] = await db
    .select({ id: boards.id })
    .from(boards)
    .where(and(eq(boards.organisationId, organisationId), eq(boards.key, key)));
  /* Named by KEY, not by name. Two boards may share a display name — that is
     the whole point of separating the two — so a clash here is an address
     collision and the message has to say so rather than blaming the name. */
  if (clash) throw new Error(`The board address "${key}" is already taken.`);

  const [tail] = await db
    .select({ maxPosition: sql<number>`COALESCE(MAX(${boards.position}), -1)` })
    .from(boards)
    .where(eq(boards.organisationId, organisationId));

  const record: BoardRecord = {
    id: newId(),
    key,
    name,
    description: input.description?.trim().slice(0, 240) || null,
    kind: input.kind?.trim() || "maintenance",
    itemNoun: input.itemNoun?.trim().slice(0, 24) || "Item",
    referencePrefix: derivePrefix(name),
    position: Number(tail?.maxPosition ?? -1) + 1,
    archived: false,
  };

  await db.insert(boards).values({ ...record, organisationId });
  await provisionDefaultStructure(db, organisationId, record.key);
  return record;
}

/**
 * A board's DISPLAY NAME, changed. Its key is not touched and cannot be.
 *
 * W2 R1 in one function. Renaming a section renames its register, so the
 * board's own heading follows the sidebar entry that opens it; the address the
 * rest of the product joins on stays exactly where it was, which is what makes
 * a rename free rather than a migration — and what frees the old name for the
 * next section that wants it.
 *
 * `referencePrefix` deliberately does NOT follow. It is baked into every
 * reference already issued (MS-2026-0001), so re-deriving it from a new name
 * would leave one register issuing two incompatible series.
 */
export async function renameBoard(
  db: Database,
  organisationId: string,
  boardKey: string,
  name: string,
) {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return;
  await db
    .update(boards)
    .set({ name: trimmed, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(boards.organisationId, organisationId), eq(boards.key, boardKey)));
}

/**
 * Everything a board owns, removed — used when a section that owns a board is
 * permanently deleted.
 *
 * CONFIGURATION AND PLACEMENT ONLY. The caller is responsible for having
 * established that the board holds no items; nothing here deletes a
 * `maintenance_requests` row, an attachment or any other record that exists
 * independently of this board. That distinction is the whole of the rule: a
 * register's columns, groups and views are its own, and the work filed on it is
 * not, so removing the register must never be a way to lose the work.
 *
 * IT HAS TO BE COMPLETE, AND IT WAS NOT.
 *
 * The first version removed four of the eight board-scoped tables, and the four
 * it missed were not cosmetic:
 *
 *  - `form_configurations` carries the PUBLIC share token. A form left behind
 *    still resolves at `/f/:token` and still accepts submissions, which would
 *    file rows onto a board that no longer exists — a live intake pointed at
 *    nothing, surviving the deliberate destruction of the thing it belonged to.
 *    Its unique index is (organisation, board, view), so it also silently
 *    refused any future form on a board that reused the key.
 *  - `board_automations` are rules that run on someone's behalf; a rule nobody
 *    can see or edit any more is worse than no rule.
 *  - `automation_runs` and `maintenance_board_options` are unreachable rows
 *    keyed on a board that is gone, and `maintenance_board_options` is unique
 *    on (organisation, board, column, value), so it too could refuse a later
 *    write under a reused key.
 *
 * The bar is the owner's own §29: after a permanent removal, NOTHING may block
 * reuse. Anything keyed by `board_id` that this function does not name is a hole
 * in that promise.
 */
export async function deleteBoardStructure(
  db: Database,
  organisationId: string,
  boardKey: string,
) {
  await db
    .delete(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, organisationId),
        eq(maintenanceBoardColumns.boardId, boardKey),
      ),
    );
  await db
    .delete(maintenanceBoardOptions)
    .where(
      and(
        eq(maintenanceBoardOptions.organisationId, organisationId),
        eq(maintenanceBoardOptions.boardId, boardKey),
      ),
    );
  await db
    .delete(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.organisationId, organisationId),
        eq(maintenanceGroups.boardId, boardKey),
      ),
    );
  await db
    .delete(boardViews)
    .where(
      and(eq(boardViews.organisationId, organisationId), eq(boardViews.boardId, boardKey)),
    );
  /* The form and its share token, then the rules and their history. Ordered
     token-first so the publicly reachable thing stops resolving before anything
     slower is attempted. */
  await db
    .delete(formConfigurations)
    .where(
      and(
        eq(formConfigurations.organisationId, organisationId),
        eq(formConfigurations.boardId, boardKey),
      ),
    );
  await db
    .delete(boardAutomations)
    .where(
      and(
        eq(boardAutomations.organisationId, organisationId),
        eq(boardAutomations.boardId, boardKey),
      ),
    );
  await db
    .delete(automationRuns)
    .where(
      and(
        eq(automationRuns.organisationId, organisationId),
        eq(automationRuns.boardId, boardKey),
      ),
    );
  await db
    .delete(boards)
    .where(and(eq(boards.organisationId, organisationId), eq(boards.key, boardKey)));
}

/** How many items are filed on a board. Zero is what makes it safe to destroy. */
export async function boardItemCount(
  db: Database,
  organisationId: string,
  boardKey: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`COUNT(*)` })
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.organisationId, organisationId),
        eq(maintenanceGroupItems.boardId, boardKey),
      ),
    );
  return Number(row?.value ?? 0);
}

/**
 * How many of a board's items are sitting in the recycle bin.
 *
 * Binning an item LIFTS its placement out of `maintenance_group_items` and
 * snapshots it into `recycle_bin.placement`, so `boardItemCount` answers zero
 * for a register whose every row is one click from coming back. Destroying the
 * board at that point would leave those rows restorable onto a board that no
 * longer exists — the bin's whole promise, broken by a menu entry being
 * removed. Counted separately from the live items so the refusal can say which
 * of the two is in the way and where to go and clear it.
 */
export async function boardBinCount(
  db: Database,
  organisationId: string,
  boardKey: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`COUNT(*)` })
    .from(recycleBin)
    .where(
      and(eq(recycleBin.organisationId, organisationId), eq(recycleBin.boardId, boardKey)),
    );
  return Number(row?.value ?? 0);
}

/**
 * Issues the next item reference — MS-2026-0001.
 *
 * The counter lives on the board row and is incremented in a single UPDATE so
 * two concurrent submissions cannot be handed the same number.
 */
export async function nextReference(
  db: Database,
  organisationId: string,
  boardId: string,
): Promise<string> {
  /*
   * Increment AND read the counter in ONE statement.
   *
   * This used to be an UPDATE `counter = counter + 1` followed by a SEPARATE
   * SELECT of the counter. The increment is atomic; reading it back in a second
   * statement is not, so two concurrent submissions could both run their UPDATE
   * and then both read the same post-increment value — the exact duplicate the
   * comment above promised was impossible. Proven against the running server: a
   * burst of ten simultaneous creates was handed three distinct references, one
   * of them shared by five jobs.
   *
   * `UPDATE … RETURNING` makes the write and the read one atomic step, so each
   * caller sees exactly the value its own increment produced. SQLite serialises
   * writers, so two concurrent callers get consecutive numbers, never the same
   * one.
   */
  const [row] = await db
    .update(boards)
    .set({
      referenceCounter: sql`${boards.referenceCounter} + 1`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(eq(boards.id, boardId), eq(boards.organisationId, organisationId)))
    .returning({
      prefix: boards.referencePrefix,
      counter: boards.referenceCounter,
    });

  const year = new Date().getUTCFullYear();
  const sequence = String(row?.counter ?? 1).padStart(4, "0");
  return `${row?.prefix ?? "MS"}-${year}-${sequence}`;
}
