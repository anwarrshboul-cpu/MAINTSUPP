/**
 * The recycle bin — Stage 23.
 *
 * THIS FILE EXISTS BECAUSE A PREVIOUS DECISION WAS REVERSED, ON INSTRUCTION.
 *
 * Until Stage 23 this product had no bin and said so. No table carried a
 * `deleted_at`, every delete was a real `DELETE FROM`, and the Trash screen led
 * with "Nothing here can be restored" rather than offering a Restore button
 * that could not work. A test failed the moment a soft-delete column landed, so
 * the claim could not quietly rot into a lie.
 *
 * The owner asked for the opposite: "when someone deleted something we should
 * have backup for 30 days and where he can find also the deleted section —
 * check monday.com". That is an instruction about what the product should do,
 * and the old comment was only ever a description of what it did. So the
 * column landed, the test now guards the new invariant instead of the old one,
 * and this module is what makes Restore truthful.
 *
 * WHAT MONDAY DOES, which is the specification here:
 *   · deleted items go to a Trash, per board;
 *   · anything in it can be restored to where it came from;
 *   · it empties automatically after 30 days;
 *   · deleting from the Trash is permanent;
 *   · an admin sees a workspace-wide bin.
 *
 * THE ONE STRUCTURAL DECISION worth understanding before changing anything
 * here: a soft-deleted job KEEPS its row, its cells, its attachments and its
 * history, but LOSES its `maintenance_group_items` placement. The placement is
 * lifted into `recycle_bin.placement` as JSON first.
 *
 * That asymmetry is deliberate. Roughly twenty board reads join through
 * `maintenance_group_items` to decide what a board contains; if the placement
 * survived, every one of them would have needed a new predicate and any one
 * that was missed would keep a deleted job on the board. Deleting the placement
 * makes all of them correct without being touched, and the snapshot is what
 * lets restore put the row back in its group AND at its position rather than
 * merely un-deleting it.
 *
 * The reads that go straight at `maintenance_requests` — counts, feeds, the
 * dashboards — do have to exclude `deleted_at IS NOT NULL`, and they were
 * enumerated and changed rather than guessed at. Three were deliberately left
 * alone; see `DELIBERATELY UNFILTERED` at the bottom of this file.
 */

import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "../../db";
import {
  boardViews,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  recycleBin,
} from "../../db/schema";
import { chunkIds } from "./sql-batching";

type Database = Awaited<ReturnType<typeof getDb>>;

/** What the screen promises, and the only place the number is written down. */
export const RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Timestamps are written from JS as ISO-8601 UTC, never `CURRENT_TIMESTAMP`.
 *
 * This schema has two timestamp formats in it already: SQLite's own
 * `YYYY-MM-DD HH:MM:SS` and the ISO strings the newer routes write. That is
 * survivable for columns nobody compares, but `expires_at` is compared — the
 * sweep is a range scan over it — and a table holding both formats would sort
 * every ISO row after every SQLite-format row regardless of date. So both
 * `deleted_at` and `expires_at` are always written here, in one format.
 */
export function nowIso() {
  return new Date().toISOString();
}

export function expiryFrom(deletedAt: string) {
  return new Date(new Date(deletedAt).getTime() + RETENTION_DAYS * DAY_MS).toISOString();
}

/** Days left before automatic purge; 0 once it is due. Never negative. */
export function daysUntil(expiresAt: string, from = Date.now()) {
  const remaining = new Date(expiresAt).getTime() - from;
  return remaining <= 0 ? 0 : Math.ceil(remaining / DAY_MS);
}

function newId() {
  return `bin_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** What a job's placement snapshot holds, so restore can be exact. */
export type JobPlacement = {
  groupId: string;
  groupName?: string | null;
  position: number;
  boardId: string;
};

export type BinActor = {
  email?: string | null;
  displayName?: string | null;
};

/* ── Sending things to the bin ──────────────────────────────────────────── */

/**
 * Soft-delete jobs and record where each one was sitting.
 *
 * Returns the ids actually binned — a caller passing an id from another
 * workspace, or one already in the bin, gets it back missing rather than an
 * error, because the delete of an already-deleted row is not a failure.
 *
 * Chunked for the same reason every other bulk path here is: "select all" on a
 * board carrying several hundred items exceeds D1's bound-variable limit.
 */
export async function sendJobsToBin(
  db: Database,
  orgId: string,
  actor: BinActor,
  requestIds: string[],
): Promise<string[]> {
  if (!requestIds.length) return [];

  const deletedAt = nowIso();
  const expiresAt = expiryFrom(deletedAt);
  const binned: string[] = [];

  for (const chunk of chunkIds(requestIds)) {
    /*
     * Only live rows. `isNull(deletedAt)` is what makes a second delete of the
     * same job a no-op instead of a unique-constraint failure on
     * `recycle_bin_entity_idx`.
     */
    const rows = await db
      .select({
        id: maintenanceRequests.id,
        title: maintenanceRequests.title,
        reference: maintenanceRequests.reference,
        stage: maintenanceRequests.stage,
      })
      .from(maintenanceRequests)
      .where(
        and(
          inArray(maintenanceRequests.id, chunk),
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
        ),
      );
    if (!rows.length) continue;

    const ids = rows.map((row) => row.id);

    // The placement, read BEFORE it is deleted. This is the whole reason a
    // restore can be exact rather than approximate.
    const placements = await db
      .select({
        requestId: maintenanceGroupItems.requestId,
        groupId: maintenanceGroupItems.groupId,
        position: maintenanceGroupItems.position,
        boardId: maintenanceGroupItems.boardId,
        groupName: maintenanceGroups.name,
      })
      .from(maintenanceGroupItems)
      .leftJoin(
        maintenanceGroups,
        eq(maintenanceGroups.id, maintenanceGroupItems.groupId),
      )
      .where(
        and(
          inArray(maintenanceGroupItems.requestId, ids),
          eq(maintenanceGroupItems.organisationId, orgId),
        ),
      );
    const placementById = new Map(placements.map((row) => [row.requestId, row]));

    await db.insert(recycleBin).values(
      rows.map((row) => {
        const placement = placementById.get(row.id);
        return {
          id: newId(),
          organisationId: orgId,
          entityType: "job",
          entityId: row.id,
          boardId: placement?.boardId ?? null,
          title: row.title,
          summary: row.reference ? `${row.reference} · ${row.stage}` : row.stage,
          placement: placement
            ? JSON.stringify({
                groupId: placement.groupId,
                groupName: placement.groupName,
                position: placement.position,
                boardId: placement.boardId,
              } satisfies JobPlacement)
            : null,
          deletedByEmail: actor.email ?? null,
          deletedByName: actor.displayName ?? null,
          deletedAt,
          expiresAt,
        };
      }),
    );

    /*
     * The placement goes, the row stays.
     *
     * This is the line that takes the job off the board for every read that
     * joins through `maintenance_group_items` — which is all of them — without
     * those reads being changed. The snapshot above is what makes it reversible.
     */
    await db
      .delete(maintenanceGroupItems)
      .where(
        and(
          inArray(maintenanceGroupItems.requestId, ids),
          eq(maintenanceGroupItems.organisationId, orgId),
        ),
      );

    await db
      .update(maintenanceRequests)
      .set({ deletedAt, deletedBy: actor.email ?? null })
      .where(
        and(
          inArray(maintenanceRequests.id, ids),
          eq(maintenanceRequests.organisationId, orgId),
        ),
      );

    binned.push(...ids);
  }

  return binned;
}

/** Soft-delete one board group, remembering the slot it occupied. */
export async function sendGroupToBin(
  db: Database,
  orgId: string,
  actor: BinActor,
  groupId: string,
): Promise<boolean> {
  const [group] = await db
    .select()
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.id, groupId),
        eq(maintenanceGroups.organisationId, orgId),
        isNull(maintenanceGroups.deletedAt),
      ),
    );
  if (!group) return false;

  const deletedAt = nowIso();

  await db.insert(recycleBin).values({
    id: newId(),
    organisationId: orgId,
    entityType: "group",
    entityId: group.id,
    boardId: group.boardId,
    title: group.name,
    summary: group.description ?? null,
    placement: JSON.stringify({
      position: group.position,
      color: group.color,
      stageKey: group.stageKey,
      boardId: group.boardId,
    }),
    deletedByEmail: actor.email ?? null,
    deletedByName: actor.displayName ?? null,
    deletedAt,
    expiresAt: expiryFrom(deletedAt),
  });

  /*
   * The group's position is vacated as well as flagged.
   *
   * `maintenance_groups_board_position_idx` is UNIQUE on
   * (organisation_id, board_id, position), so a binned group holding onto its
   * slot would block the next group created at that position. It is parked at a
   * negative position — outside the range any live group uses — and the real
   * position is kept in the snapshot for restore to read back.
   */
  await db
    .update(maintenanceGroups)
    .set({
      deletedAt,
      deletedBy: actor.email ?? null,
      position: -Math.abs(group.position) - 1000,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(eq(maintenanceGroups.id, group.id), eq(maintenanceGroups.organisationId, orgId)),
    );

  return true;
}

/**
 * Send a board view to the bin instead of deleting it outright.
 *
 * WHY THIS ONE, AND NOT EVERY STRUCTURE ON THE BOARD. W13-06 asks for
 * recoverable archiving "where possible", which is a resource-by-resource
 * question rather than a blanket rule. A view is the case where the answer is
 * unambiguous: the whole thing is one small configuration row — its name, type,
 * icon, saved filters, saved sort, position — so a complete snapshot fits in
 * the `placement` column that already exists, and putting it back is a single
 * insert. Nothing else has to change and no migration is involved.
 *
 * A COLUMN was the case where the answer was no, and it is the case this
 * correction settles. The reasoning above was right — its data is the cells, and
 * there are 8,565 of them on the live board, far too many to snapshot into this
 * table — so it took the other half of that sentence: a `deleted_at` on
 * `maintenance_board_columns` with the cells retained behind it. See
 * `sendColumnToBin`. The audit event now records `recoverable: true`, and it is
 * true.
 *
 * Unlike a job or a group, the row does NOT survive: `board_views` has a UNIQUE
 * index on (organisation, board, key), and a soft-deleted row would hold that
 * key against a view somebody creates in the meantime. The snapshot is the
 * whole record, so nothing is lost by removing it.
 */
export async function sendBoardViewToBin(
  db: Database,
  orgId: string,
  actor: BinActor,
  viewId: string,
): Promise<boolean> {
  const [view] = await db
    .select()
    .from(boardViews)
    .where(and(eq(boardViews.id, viewId), eq(boardViews.organisationId, orgId)));
  if (!view) return false;

  const deletedAt = nowIso();
  await db.insert(recycleBin).values({
    id: newId(),
    organisationId: orgId,
    entityType: "board_view",
    entityId: view.id,
    boardId: view.boardId,
    title: view.name,
    summary: `${view.type} view`,
    placement: JSON.stringify({
      boardId: view.boardId,
      key: view.key,
      name: view.name,
      type: view.type,
      icon: view.icon,
      filters: view.filters,
      sort: view.sort,
      settings: view.settings,
      position: view.position,
      createdBy: view.createdBy,
    }),
    deletedByEmail: actor.email ?? null,
    deletedByName: actor.displayName ?? null,
    deletedAt,
    expiresAt: expiryFrom(deletedAt),
  });

  await db
    .delete(boardViews)
    .where(and(eq(boardViews.id, view.id), eq(boardViews.organisationId, orgId)));
  return true;
}

/**
 * Send a board column to the bin, keeping every value it holds.
 *
 * WHY THIS ONE IS A FLAG AND THE VIEW WAS A SNAPSHOT.
 *
 * A view is a configuration row; its whole self fits in `placement`. A column's
 * self is its CELLS — 8,565 of them on the live board, plus whatever files hang
 * off a file column — and no JSON blob in this table is going to hold those. So
 * the row stays where it is and one nullable field decides whether the board
 * can see it, which is the same answer jobs and groups already use.
 *
 * The consequence is that every read of `maintenance_board_columns` that draws,
 * exports or mutates a column has to exclude the binned ones, and those were
 * enumerated rather than guessed — see `DELIBERATELY UNFILTERED` below for the
 * two that must NOT be, and why leaving them alone is what makes a restore a
 * month later safe.
 *
 * The snapshot in `placement` is still written, and it still matters: it is what
 * restore reads to put the column back at the position, width, pin state and
 * summary function it had, rather than merely un-hiding it at whatever the
 * board looks like now.
 */
export async function sendColumnToBin(
  db: Database,
  orgId: string,
  actor: BinActor,
  columnId: string,
): Promise<{ ok: true; title: string; values: number } | { ok: false; error: string }> {
  const [column] = await db
    .select()
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.id, columnId),
        eq(maintenanceBoardColumns.organisationId, orgId),
        isNull(maintenanceBoardColumns.deletedAt),
      ),
    );
  if (!column) return { ok: false, error: "Column not found." };
  if (column.system) {
    return { ok: false, error: "System columns cannot be deleted. Hide it instead." };
  }

  // Only for the line the bin shows. The values are kept either way.
  const [filled] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(maintenanceBoardCells)
    .where(
      and(
        eq(maintenanceBoardCells.organisationId, orgId),
        eq(maintenanceBoardCells.columnId, columnId),
        sql`${maintenanceBoardCells.value} <> ''`,
      ),
    );
  const values = Number(filled?.total ?? 0);

  const deletedAt = nowIso();
  await db.insert(recycleBin).values({
    id: newId(),
    organisationId: orgId,
    entityType: "column",
    entityId: column.id,
    boardId: column.boardId,
    title: column.title,
    summary: `${column.type} column · ${values} value${values === 1 ? "" : "s"} kept`,
    /*
     * Everything a restore has to put back that is not the cells. The cells do
     * not move, so they are not listed; the arrangement does, and it is the
     * half that a person notices is wrong.
     */
    placement: JSON.stringify({
      boardId: column.boardId,
      key: column.key,
      title: column.title,
      type: column.type,
      position: column.position,
      width: column.width,
      settings: column.settings,
      visible: column.visible,
      pinned: column.pinned,
      required: column.required,
      summary: column.summary,
      optionSetKey: column.optionSetKey,
      description: column.description,
    }),
    deletedByEmail: actor.email ?? null,
    deletedByName: actor.displayName ?? null,
    deletedAt,
    expiresAt: expiryFrom(deletedAt),
  });

  /*
   * The position is NOT vacated, unlike a group's.
   *
   * `maintenance_board_columns_position_idx` is a plain index, not a unique
   * one, so a binned column holding its slot blocks nothing — and holding it is
   * what lets restore put the column back among the neighbours it had rather
   * than at the end of the board.
   */
  await db
    .update(maintenanceBoardColumns)
    .set({
      deletedAt,
      deletedBy: actor.email ?? null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(maintenanceBoardColumns.id, column.id),
        eq(maintenanceBoardColumns.organisationId, orgId),
      ),
    );

  return { ok: true, title: column.title, values };
}

/* ── Restoring ─────────────────────────────────────────────────────────── */

export type RestoreOutcome =
  | { ok: true; entityType: string; entityId: string; message: string }
  | { ok: false; error: string; status: number };

/**
 * Put one thing back where it came from.
 *
 * "Where it came from" is load-bearing. For a job it means the group it was in
 * and the position it held in that group, not merely clearing a flag — a job
 * that comes back at the bottom of the wrong group has not been restored, it
 * has been re-created.
 */
export async function restoreFromBin(
  db: Database,
  orgId: string,
  entryId: string,
): Promise<RestoreOutcome> {
  const [entry] = await db
    .select()
    .from(recycleBin)
    .where(and(eq(recycleBin.id, entryId), eq(recycleBin.organisationId, orgId)));

  if (!entry) {
    return { ok: false, error: "That item is no longer in the bin.", status: 404 };
  }

  if (entry.entityType === "job") return restoreJob(db, orgId, entry);
  if (entry.entityType === "group") return restoreGroup(db, orgId, entry);
  if (entry.entityType === "board_view") return restoreBoardView(db, orgId, entry);
  if (entry.entityType === "column") return restoreColumn(db, orgId, entry);

  return {
    ok: false,
    error: `Nothing here knows how to restore a "${entry.entityType}".`,
    status: 409,
  };
}

type BinRow = typeof recycleBin.$inferSelect;

async function restoreJob(
  db: Database,
  orgId: string,
  entry: BinRow,
): Promise<RestoreOutcome> {
  const [job] = await db
    .select({ id: maintenanceRequests.id, title: maintenanceRequests.title })
    .from(maintenanceRequests)
    .where(
      and(
        eq(maintenanceRequests.id, entry.entityId),
        eq(maintenanceRequests.organisationId, orgId),
      ),
    );

  if (!job) {
    /*
     * The bin row outlived the row it describes. Recoverable state, not a
     * crash: drop the stale entry and say so, rather than reporting a success
     * that put nothing back.
     */
    await db.delete(recycleBin).where(eq(recycleBin.id, entry.id));
    return {
      ok: false,
      error: "That job's row has already been removed, so there is nothing to restore.",
      status: 410,
    };
  }

  const placement = parsePlacement(entry.placement);
  const boardId = placement?.boardId ?? entry.boardId ?? "maintenance";

  /*
   * The group has to still exist, and still be live.
   *
   * If someone deleted the group while the job sat in the bin, restoring into
   * it would put the job somewhere invisible. Falling back to the board's first
   * live group is the honest recovery — the response says which group was used,
   * so the restore is never silently wrong about where the row went.
   */
  let groupId = placement?.groupId ?? null;
  let fellBack = false;

  if (groupId) {
    const [group] = await db
      .select({ id: maintenanceGroups.id })
      .from(maintenanceGroups)
      .where(
        and(
          eq(maintenanceGroups.id, groupId),
          eq(maintenanceGroups.organisationId, orgId),
          isNull(maintenanceGroups.deletedAt),
        ),
      );
    if (!group) groupId = null;
  }

  if (!groupId) {
    const [fallback] = await db
      .select({ id: maintenanceGroups.id })
      .from(maintenanceGroups)
      .where(
        and(
          eq(maintenanceGroups.organisationId, orgId),
          eq(maintenanceGroups.boardId, boardId),
          eq(maintenanceGroups.archived, false),
          isNull(maintenanceGroups.deletedAt),
        ),
      )
      .orderBy(asc(maintenanceGroups.position))
      .limit(1);
    if (!fallback) {
      return {
        ok: false,
        error: "This board has no group to restore into. Create a group first.",
        status: 409,
      };
    }
    groupId = fallback.id;
    fellBack = true;
  }

  await db
    .update(maintenanceRequests)
    .set({ deletedAt: null, deletedBy: null, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(maintenanceRequests.id, entry.entityId),
        eq(maintenanceRequests.organisationId, orgId),
      ),
    );

  /*
   * The placement comes back at its remembered position.
   *
   * Positions among items are not unique — only groups have a unique position
   * index — so putting the row back at position 7 when something else has since
   * taken 7 is legal and reads correctly: the two sort adjacently. Trying to
   * renumber the whole group instead would move rows the person did not touch.
   */
  await db
    .insert(maintenanceGroupItems)
    .values({
      requestId: entry.entityId,
      organisationId: orgId,
      boardId,
      groupId,
      position: placement?.position ?? 0,
    })
    .onConflictDoUpdate({
      target: maintenanceGroupItems.requestId,
      set: { groupId, boardId, position: placement?.position ?? 0 },
    });

  await db.delete(recycleBin).where(eq(recycleBin.id, entry.id));

  return {
    ok: true,
    entityType: "job",
    entityId: entry.entityId,
    message: fellBack
      ? `"${job.title}" is back on the board. Its original group had gone, so it was restored into the first group instead.`
      : `"${job.title}" is back in ${placement?.groupName ?? "its group"}, at the position it held.`,
  };
}

async function restoreGroup(
  db: Database,
  orgId: string,
  entry: BinRow,
): Promise<RestoreOutcome> {
  const [group] = await db
    .select({ id: maintenanceGroups.id, name: maintenanceGroups.name })
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.id, entry.entityId),
        eq(maintenanceGroups.organisationId, orgId),
      ),
    );

  if (!group) {
    await db.delete(recycleBin).where(eq(recycleBin.id, entry.id));
    return {
      ok: false,
      error: "That group's row has already been removed, so there is nothing to restore.",
      status: 410,
    };
  }

  const snapshot = parsePlacement(entry.placement);
  const boardId = snapshot?.boardId ?? entry.boardId ?? "maintenance";

  /*
   * The old slot may have been taken while the group sat in the bin, and the
   * position index is UNIQUE — so restoring onto an occupied position would
   * fail the write. The group goes back at its remembered position if that is
   * free, and at the end of the board if it is not.
   */
  const wanted = typeof snapshot?.position === "number" ? snapshot.position : 0;
  const occupied = await db
    .select({ position: maintenanceGroups.position })
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.organisationId, orgId),
        eq(maintenanceGroups.boardId, boardId),
        isNull(maintenanceGroups.deletedAt),
      ),
    );
  const taken = new Set(occupied.map((row) => row.position));
  const position = taken.has(wanted)
    ? Math.max(0, ...occupied.map((row) => row.position)) + 1
    : wanted;

  await db
    .update(maintenanceGroups)
    .set({
      deletedAt: null,
      deletedBy: null,
      position,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(maintenanceGroups.id, entry.entityId),
        eq(maintenanceGroups.organisationId, orgId),
      ),
    );

  await db.delete(recycleBin).where(eq(recycleBin.id, entry.id));

  return {
    ok: true,
    entityType: "group",
    entityId: entry.entityId,
    message:
      position === wanted
        ? `"${group.name}" is back on the board at its original position.`
        : `"${group.name}" is back on the board. Its original slot was taken, so it was placed at the end.`,
  };
}

/**
 * Put a deleted board view back on its tab strip.
 *
 * The snapshot is the whole row, so this is an insert rather than a flag flip.
 * Two things can have changed while it sat in the bin and both are handled
 * rather than allowed to fail the write: its `key` may have been taken by a new
 * view (the index is UNIQUE on organisation + board + key), and its position
 * may now belong to something else — a tab strip's positions are not unique, so
 * the second is cosmetic and the view simply sorts beside whatever took its
 * place.
 */
/**
 * Put a column back on the board, with every value it was holding.
 *
 * The cells never went anywhere, so this is not a re-creation: clearing
 * `deleted_at` makes eight thousand existing rows visible again, at the same
 * item and the same column, with the same values. What has to be put back
 * deliberately is the ARRANGEMENT — position, width, pin, visibility, summary
 * function — because a column that returns at the far right of the board, 160
 * pixels wide and unpinned, has not been restored so much as re-added.
 *
 * The board is renumbered afterwards. Positions are 1,000 apart and a column
 * that spent a month in the bin may find its old number taken; sorting by
 * position and rewriting the sequence puts it back among the neighbours it had
 * without leaving two columns claiming one slot.
 */
async function restoreColumn(
  db: Database,
  orgId: string,
  entry: BinRow,
): Promise<RestoreOutcome> {
  const [column] = await db
    .select()
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.id, entry.entityId),
        eq(maintenanceBoardColumns.organisationId, orgId),
      ),
    );
  if (!column) {
    return {
      ok: false,
      error: "That column is no longer in the database, so there is nothing to restore.",
      status: 410,
    };
  }

  let snapshot: Record<string, unknown> = {};
  try {
    snapshot = entry.placement
      ? (JSON.parse(entry.placement) as Record<string, unknown>)
      : {};
  } catch {
    // A snapshot that will not parse costs the arrangement, not the data. The
    // column comes back as it was left, which is far better than refusing.
    snapshot = {};
  }

  const number = (value: unknown, fallback: number) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;
  const flag = (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback;

  await db
    .update(maintenanceBoardColumns)
    .set({
      deletedAt: null,
      deletedBy: null,
      position: number(snapshot.position, column.position),
      width: number(snapshot.width, column.width),
      settings: typeof snapshot.settings === "string" ? snapshot.settings : column.settings,
      visible: flag(snapshot.visible, column.visible),
      pinned: flag(snapshot.pinned, column.pinned),
      required: flag(snapshot.required, column.required),
      summary:
        typeof snapshot.summary === "string" || snapshot.summary === null
          ? (snapshot.summary as string | null)
          : column.summary,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(maintenanceBoardColumns.id, column.id),
        eq(maintenanceBoardColumns.organisationId, orgId),
      ),
    );

  /*
   * Renumber the board so the restored column has a slot of its own. Ordered by
   * position with the restored column winning a tie, which is what puts it
   * BEFORE the column that took its number rather than after it.
   */
  const live = await db
    .select({ id: maintenanceBoardColumns.id, position: maintenanceBoardColumns.position })
    .from(maintenanceBoardColumns)
    .where(
      and(
        eq(maintenanceBoardColumns.organisationId, orgId),
        eq(maintenanceBoardColumns.boardId, column.boardId),
        isNull(maintenanceBoardColumns.deletedAt),
      ),
    );
  live.sort((left, right) => {
    if (left.position !== right.position) return left.position - right.position;
    if (left.id === column.id) return -1;
    if (right.id === column.id) return 1;
    return 0;
  });
  for (const [index, row] of live.entries()) {
    const position = index * 1000;
    if (row.position === position) continue;
    await db
      .update(maintenanceBoardColumns)
      .set({ position })
      .where(
        and(
          eq(maintenanceBoardColumns.id, row.id),
          eq(maintenanceBoardColumns.organisationId, orgId),
        ),
      );
  }

  await db.delete(recycleBin).where(eq(recycleBin.id, entry.id));

  const place = live.findIndex((row) => row.id === column.id) + 1;
  return {
    ok: true,
    entityType: "column",
    entityId: column.id,
    message: `"${column.title}" is back on the board in position ${place}, with every value it was holding.`,
  };
}

async function restoreBoardView(
  db: Database,
  orgId: string,
  entry: BinRow,
): Promise<RestoreOutcome> {
  let snapshot: Record<string, unknown> | null = null;
  try {
    snapshot = entry.placement ? (JSON.parse(entry.placement) as Record<string, unknown>) : null;
  } catch {
    snapshot = null;
  }
  if (!snapshot) {
    return {
      ok: false,
      error: "That view's snapshot could not be read, so there is nothing to restore.",
      status: 410,
    };
  }

  const boardId = String(snapshot.boardId ?? entry.boardId ?? "maintenance");
  const existing = await db
    .select({ key: boardViews.key })
    .from(boardViews)
    .where(and(eq(boardViews.organisationId, orgId), eq(boardViews.boardId, boardId)));
  const taken = new Set(existing.map((row) => row.key));

  const wantedKey = String(snapshot.key ?? "view");
  let key = wantedKey;
  let suffix = 2;
  while (taken.has(key)) key = `${wantedKey}-${suffix++}`;

  await db.insert(boardViews).values({
    id: entry.entityId,
    organisationId: orgId,
    boardId,
    key,
    name: String(snapshot.name ?? entry.title),
    type: String(snapshot.type ?? "table"),
    icon: typeof snapshot.icon === "string" ? snapshot.icon : null,
    filters: typeof snapshot.filters === "string" ? snapshot.filters : "[]",
    sort: typeof snapshot.sort === "string" ? snapshot.sort : "[]",
    settings: typeof snapshot.settings === "string" ? snapshot.settings : "{}",
    position: Number.isFinite(Number(snapshot.position)) ? Number(snapshot.position) : 0,
    // A restored view is never the board's default and never a system row: both
    // are properties of the strip as it stands now, not of the row that left it.
    isDefault: false,
    system: false,
    createdBy: typeof snapshot.createdBy === "string" ? snapshot.createdBy : null,
  });

  await db.delete(recycleBin).where(eq(recycleBin.id, entry.id));

  return {
    ok: true,
    entityType: "board_view",
    entityId: entry.entityId,
    message:
      key === wantedKey
        ? `"${entry.title}" is back on the board's view strip, with its saved filters and sort.`
        : `"${entry.title}" is back on the board's view strip. Another view had taken its key, so it was restored under "${key}".`,
  };
}

function parsePlacement(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<JobPlacement> & {
      position?: number;
      color?: string;
      stageKey?: string | null;
    };
  } catch {
    // A snapshot we cannot read is not a reason to refuse the restore; the
    // caller falls back to the board's first group and says so.
    return null;
  }
}

/* ── Expiry ────────────────────────────────────────────────────────────── */

/**
 * WHAT SWEEPS THE 30 DAYS — read this before changing where it is called from.
 *
 * There is no cron in this project. Cloudflare Workers can run a scheduled
 * handler, but nothing in this repository registers one, and inventing a
 * deployment dependency to make a screen honest would be the wrong trade. So
 * expiry is swept opportunistically, and the honest description is: **the bin
 * empties when somebody uses the app**, not at midnight.
 *
 * It is NOT on the boot path. `db/init.ts` is memoised per isolate but still
 * issues several hundred statements per cold start, and a sweep bolted onto it
 * would add a write to every cold start — including the ones serving a marketing
 * page. This is called from the bin's own read and write routes instead, which
 * is where somebody is already thinking about deleted things.
 *
 * Three bounds, so it can never become the expensive thing on a request:
 *
 *   1. SAMPLED. It runs on roughly one call in `SWEEP_CHANCE`, the same
 *      technique `recordSignInFailure` uses to prune `sign_in_failures`.
 *   2. INDEXED. The candidate query is a range scan over
 *      `recycle_bin_expiry_idx`, so it reads expired rows and nothing else.
 *      It never touches `maintenance_requests` to find its work.
 *   3. CAPPED. At most `SWEEP_LIMIT` entries per pass. A bin holding ten
 *      thousand expired rows drains over several passes rather than stalling
 *      one request; nothing is lost, because the ones left behind are still
 *      expired and still first in line next time.
 *
 * Failures are swallowed. A sweep that cannot run must not take the screen that
 * triggered it down with it — the rows stay expired and the next pass retries.
 */
const SWEEP_CHANCE = 0.1;
const SWEEP_LIMIT = 50;

export async function maybeSweepRecycleBin(db: Database, purge: PurgeFn) {
  if (Math.random() > SWEEP_CHANCE) return 0;
  return sweepRecycleBin(db, purge).catch(() => 0);
}

/** The unsampled sweep. Exported so a test can drive it deterministically. */
export async function sweepRecycleBin(db: Database, purge: PurgeFn) {
  const due = await db
    .select({
      id: recycleBin.id,
      organisationId: recycleBin.organisationId,
      entityType: recycleBin.entityType,
      entityId: recycleBin.entityId,
    })
    .from(recycleBin)
    .where(lte(recycleBin.expiresAt, nowIso()))
    .orderBy(asc(recycleBin.expiresAt))
    .limit(SWEEP_LIMIT);

  if (!due.length) return 0;

  let swept = 0;
  for (const entry of due) {
    /*
     * The bin row is removed only when the purge actually happened.
     *
     * Deleting it unconditionally would be the worst outcome available: the
     * entity stays flagged `deleted_at` with nothing left pointing at it, which
     * is a row that is invisible on every screen and unreachable from the bin —
     * gone, without anyone having deleted it. A purge that declines leaves its
     * entry alone and is retried on the next pass.
     */
    const purged = await purge(entry.organisationId, entry.entityType, entry.entityId);
    if (!purged) continue;
    await db.delete(recycleBin).where(eq(recycleBin.id, entry.id));
    swept += 1;
  }
  return swept;
}

/**
 * How a thing is destroyed for good. Returns whether it was.
 *
 * Passed in rather than implemented here because purging a job has to delete
 * its files from R2, and R2 arrives through `cloudflare:workers` — an import
 * that only resolves inside the Worker. Keeping this module free of it is what
 * lets a test drive `sweepRecycleBin` with a stub.
 */
export type PurgeFn = (
  organisationId: string,
  entityType: string,
  entityId: string,
) => Promise<boolean>;

/* ── Reading the bin ───────────────────────────────────────────────────── */

export async function listBin(db: Database, orgId: string) {
  const rows = await db
    .select()
    .from(recycleBin)
    .where(eq(recycleBin.organisationId, orgId))
    .orderBy(sql`${recycleBin.deletedAt} DESC`)
    .limit(500);

  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    boardId: row.boardId,
    title: row.title,
    summary: row.summary,
    group: parsePlacement(row.placement)?.groupName ?? null,
    deletedBy: row.deletedByName || row.deletedByEmail || null,
    deletedByEmail: row.deletedByEmail,
    deletedAt: row.deletedAt,
    expiresAt: row.expiresAt,
    daysLeft: daysUntil(row.expiresAt, now),
    expired: daysUntil(row.expiresAt, now) === 0,
  }));
}

/*
 * DELIBERATELY UNFILTERED — three reads that must keep seeing binned rows.
 *
 * Each of these was checked rather than missed, and filtering any of them would
 * introduce a bug rather than fix one:
 *
 *   · `app/api/board/route.ts` — the `MAX(CAST(SUBSTR(id, 4) AS INTEGER))`
 *     that generates the next `MN-…` reference, in both `create_item` and
 *     `duplicate_items`. A binned job still owns its id. Excluding it would
 *     hand the same reference to a new job and collide on restore.
 *
 *   · `app/api/import/route.ts` — the identity map keyed on `external_id` and
 *     title that decides insert-versus-update on a monday re-import. Excluding
 *     binned rows would make the importer create a duplicate of every job
 *     sitting in the bin. Leaving them in means a re-import updates the binned
 *     row in place; it stays in the bin, which is the lesser of the two and is
 *     the behaviour a person deleting a job would expect.
 *
 *   · `app/api/board/route.ts` — `seedRequestsIfEmpty`'s `COUNT(*)`. It exists
 *     to decide whether a workspace has ever had data. A workspace whose jobs
 *     are all in the bin has had data, and re-seeding sample rows underneath a
 *     recoverable bin would be worse than showing an empty board.
 */
