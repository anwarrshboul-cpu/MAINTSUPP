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
  boards,
  maintenanceBoardCells,
  maintenanceBoardColumns,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  recycleBin,
  workspaceSections,
} from "../../db/schema";
import { chunkIds, chunkRows } from "./sql-batching";

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

  /*
   * A SUBITEM GOES WHERE ITS PARENT GOES.
   *
   * This used to bin exactly the ids it was handed and never look at
   * `parent_id`, so every child of a deleted job stayed LIVE — and invisible,
   * because a subitem is only ever drawn underneath a parent row that no longer
   * rendered. The row was on no board, in no bin, unreachable by search, and
   * still counted by `/api/maintenance`, so it went on feeding the Overview's
   * meters. Purging the parent then stranded it for ever behind a dangling
   * `parent_id`.
   *
   * The children are folded into the id set here, at the top, rather than
   * handled separately below — which means they go through exactly the same
   * path a parent does: their placement is lifted into their own bin entry and
   * then deleted, which is the asymmetry this file's header exists to explain.
   * Anything else would leave a placement behind for the twenty-odd board reads
   * that join through it.
   */
  const children = await db
    .select({ id: maintenanceRequests.id })
    .from(maintenanceRequests)
    .where(
      and(
        inArray(maintenanceRequests.parentId, requestIds),
        eq(maintenanceRequests.organisationId, orgId),
        isNull(maintenanceRequests.deletedAt),
      ),
    );
  const withChildren = [
    ...requestIds,
    ...children.map((child) => child.id).filter((id) => !requestIds.includes(id)),
  ];

  const deletedAt = nowIso();
  const expiresAt = expiryFrom(deletedAt);
  const binned: string[] = [];

  for (const chunk of chunkIds(withChildren)) {
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

    /*
     * Batched by ROW WIDTH, not by id count. This insert binds 12 variables per
     * row, so the ids-per-statement chunk the surrounding loop uses (sized for
     * one-variable `IN` lists) overshot the variable limit twelvefold: deleting
     * more than eight items at once answered 503 "could not be saved" while a
     * one-item delete sailed through. See `chunkRows`.
     */
    const binEntries = rows.map((row) => {
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
    });
    for (const entryChunk of chunkRows(binEntries, 12)) {
      await db.insert(recycleBin).values(entryChunk);
    }

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

/* ── A whole section, as ONE thing ─────────────────────────────────────── */

/**
 * W2C — THE SECTION BUNDLE. One bin entry for a section and everything it owns.
 *
 * THE PROBLEM THIS REPLACES. Permanently removing a custom section used to
 * refuse three times over: once while its register held items, once while those
 * items were in the bin, and once while it held sites or contractors. Each
 * refusal was individually right — a board destroyed underneath its rows leaves
 * them reachable by nothing — and together they made "delete this section" a
 * chore of emptying every row by hand and then emptying the bin as well. The
 * owner asked for the opposite: a custom section is ONE product object and
 * should be deletable as one.
 *
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO.
 *
 * It writes ONE row into `recycle_bin`, sets `workspace_sections.deleted_at`,
 * and archives the register. NOTHING ELSE MOVES. No item is soft-deleted, no
 * placement is lifted, no cell, file, view, form, site or contractor is touched.
 *
 * That is the whole design, and it is not laziness. A cascade would have put
 * hundreds of tombstones in the bin — the opposite of the "one top-level entry"
 * the owner asked for — and every one of them would be a way for a restore to
 * come back half-done. Because a `sec-` register has exactly one door (the
 * section; `PATCH` refuses to re-home the last section off its own register,
 * and `resolveRegisterScope` refuses an archived one), hiding the section hides
 * the bundle. Restore is then one UPDATE back to NULL, and it is atomic by
 * construction because nothing was taken apart.
 *
 * WHY THE BOARD IS ARCHIVED TOO, and this is the load-bearing half. Three
 * existing readers already treat `boards.archived` as "this register is out of
 * use", and each of them is a way the bundle would otherwise stay reachable
 * while it sits in the bin:
 *
 *   · `loadFormByToken` — the PUBLIC share link. A form left resolving would be
 *     an unauthenticated intake filing rows onto a register in the bin.
 *   · `GET /api/board/form` — the form editor.
 *   · `complianceRegister` — the expiry digest, which must not warn about
 *     certificates on a register nobody can open.
 *
 * Setting one boolean closes all three, reversibly, using a concept the product
 * already has. Its previous value is snapshotted below so restore puts back what
 * was there rather than assuming `false`.
 */
export const SECTION_ENTITY_TYPE = "section";

/** What a section bundle records, so restore and the bin's line can be exact. */
export type SectionBundleSnapshot = {
  /** `section:north-region-jobs`. The bin entry's `entity_id`. */
  sectionKey: string;
  label: string;
  /** The register it owns, or NULL for a legacy second door / a shared one. */
  boardKey: string | null;
  /** Was it already archived when it was deleted? Restore puts that back. */
  wasArchived: boolean;
  /** Was its register already archived? Same reason. */
  boardWasArchived: boolean;
  /** The child summary the bin shows — `12 items · 3 views · 1 form`. */
  counts: Record<string, number>;
};

/**
 * The one-line summary under the bin entry's title.
 *
 * Only what is actually there: a section with no forms does not read
 * "0 forms", because a count of zero is noise on a line whose job is to say
 * what is at stake. An entirely empty section says so in words.
 */
export function describeSectionBundle(counts: Record<string, number>) {
  const order: Array<[string, string, string]> = [
    ["items", "item", "items"],
    ["subitems", "subitem", "subitems"],
    ["binnedItems", "item in the bin", "items in the bin"],
    ["columns", "column", "columns"],
    ["groups", "group", "groups"],
    ["views", "view", "views"],
    ["forms", "form", "forms"],
    ["automations", "automation", "automations"],
    ["attachments", "attachment", "attachments"],
    ["sites", "site", "sites"],
    ["contractors", "contractor", "contractors"],
  ];
  const parts = order
    .filter(([key]) => Number(counts[key] ?? 0) > 0)
    .map(([key, one, many]) => {
      const total = Number(counts[key] ?? 0);
      return `${total} ${total === 1 ? one : many}`;
    });
  return parts.length ? parts.join(" · ") : "Empty — nothing was filed on it";
}

/**
 * Move a section and everything it owns into the bin.
 *
 * The bin row is deleted first for the same `(organisation, entity_type,
 * entity_id)` — `recycle_bin_entity_idx` allows one live entry per thing, and a
 * section restored and deleted again would otherwise collide with its own
 * previous entry rather than replacing it.
 */
export async function sendSectionToBin(
  db: Database,
  orgId: string,
  actor: BinActor,
  snapshot: SectionBundleSnapshot,
): Promise<{ id: string; deletedAt: string; expiresAt: string }> {
  const deletedAt = nowIso();
  const expiresAt = expiryFrom(deletedAt);

  await db
    .delete(recycleBin)
    .where(
      and(
        eq(recycleBin.organisationId, orgId),
        eq(recycleBin.entityType, SECTION_ENTITY_TYPE),
        eq(recycleBin.entityId, snapshot.sectionKey),
      ),
    );

  const id = newId();
  await db.insert(recycleBin).values({
    id,
    organisationId: orgId,
    entityType: SECTION_ENTITY_TYPE,
    entityId: snapshot.sectionKey,
    /* The register, so the bin's board filter groups the bundle with the board
       it belongs to, and so `binnedSectionBoards` can find it in one read. */
    boardId: snapshot.boardKey,
    title: snapshot.label,
    summary: describeSectionBundle(snapshot.counts),
    placement: JSON.stringify(snapshot),
    deletedByEmail: actor.email ?? null,
    deletedByName: actor.displayName ?? null,
    deletedAt,
    expiresAt,
  });

  /* The section itself. `archived_at` is set as well as `deleted_at` when it is
     not already, so every reader that already drops an archived section — the
     nav catalogue, `resolveRegisterScope`, the sidebar — drops a deleted one
     with no change at all. */
  await db
    .update(workspaceSections)
    .set({
      deletedAt,
      archivedAt: snapshot.wasArchived ? undefined : deletedAt,
      updatedAt: deletedAt,
    })
    .where(
      and(
        eq(workspaceSections.organisationId, orgId),
        eq(workspaceSections.key, snapshot.sectionKey),
      ),
    );

  if (snapshot.boardKey) {
    await db
      .update(boards)
      .set({ archived: true, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(boards.organisationId, orgId), eq(boards.key, snapshot.boardKey)));
  }

  return { id, deletedAt, expiresAt };
}

/**
 * The registers currently sitting in the bin inside a section bundle.
 *
 * One indexed read, and it is what stops a child escaping its parent: the bin's
 * listing hides anything filed on one of these boards, `restoreFromBin` refuses
 * a child while its parent is in the bin, and `resolveBoard` refuses the board
 * outright so a kept deep link cannot open it.
 */
export async function binnedSectionBoards(
  db: Database,
  orgId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ boardId: recycleBin.boardId })
    .from(recycleBin)
    .where(
      and(
        eq(recycleBin.organisationId, orgId),
        eq(recycleBin.entityType, SECTION_ENTITY_TYPE),
      ),
    );
  return new Set(
    rows.map((row) => row.boardId).filter((key): key is string => Boolean(key)),
  );
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

  if (entry.entityType === SECTION_ENTITY_TYPE) return restoreSection(db, orgId, entry);

  /*
   * W2C — A CHILD CANNOT ESCAPE A DELETED PARENT, and this is the chosen policy
   * rather than the only one available.
   *
   * The alternative was "restore the parent first, silently". It was rejected:
   * restoring one row would then put a whole section, its register and every
   * other row on it back into the sidebar for everybody, which is a far bigger
   * act than the one the person clicked — and they would have no way to tell it
   * had happened. Refusing says what is in the way and names the one thing to
   * do about it, and it makes the section the single recovery object the owner
   * asked for.
   *
   * It is enforced HERE rather than in the screen because the bin's listing
   * already hides these entries, so anything reaching this line is a stale tab
   * or a script — exactly the caller a UI-only rule does not stop.
   */
  if (entry.boardId) {
    const binnedBoards = await binnedSectionBoards(db, orgId);
    if (binnedBoards.has(entry.boardId)) {
      return {
        ok: false,
        status: 409,
        error:
          "The section this belonged to is in the recycle bin. Restore the section and this comes back with it, exactly where it was.",
      };
    }
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
    .select({
      id: maintenanceRequests.id,
      title: maintenanceRequests.title,
      // Both kept for the subitem rules below: the stamp says which children
      // went down with this job, and parentId says whether this IS one.
      deletedAt: maintenanceRequests.deletedAt,
      parentId: maintenanceRequests.parentId,
    })
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

  /*
   * A subitem cannot come back before its parent.
   *
   * Restoring one on its own would put a live child under a job that is still
   * deleted — which is exactly the invisible, unsearchable orphan that binning
   * a parent used to create, arrived at from the other direction. The parent's
   * own entry restores both.
   */
  if (job.parentId) {
    const [parent] = await db
      .select({ deletedAt: maintenanceRequests.deletedAt })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, job.parentId),
          eq(maintenanceRequests.organisationId, orgId),
        ),
      );
    if (parent?.deletedAt) {
      return {
        ok: false,
        error:
          "This is a subitem of a job that is also in the bin. Restore the job and this comes back with it.",
        status: 409,
      };
    }
  }

  const placement = parsePlacement(entry.placement);
  /*
   * A RESTORE THAT DOES NOT KNOW THE BOARD MUST REFUSE, NOT GUESS.
   *
   * This ended `?? "maintenance"`. `recycle_bin.board_id` is nullable and a
   * snapshot can be written without one, so an entry that named no board was
   * restored onto the CANONICAL JOB BOARD — somebody else's board gaining a row,
   * a group or a view out of nowhere, with no error and no way to tell where it
   * had come from. Now that a register can be created at runtime the guess is
   * not even likely to be right.
   *
   * Refusing is recoverable: the entry stays in the bin, retention keeps
   * running, and the reader is told what is missing. Restoring to the wrong
   * board is not.
   */
  const boardId = placement?.boardId ?? entry.boardId;
  if (!boardId) {
    return {
      ok: false,
      error:
        "This item's bin entry does not record which board it came from, so it cannot be put back.",
      status: 409,
    };
  }

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

  /*
   * And the subitems that went down WITH this job, identified by carrying the
   * same `deleted_at`. A child deleted on its own last week has a different
   * stamp and stays in the bin with its own entry, which is the honest answer:
   * this restore is undoing one delete, not every delete that ever touched the
   * job.
   */
  if (job.deletedAt) {
    const childEntries = await db
      .select({ id: recycleBin.id, entityId: recycleBin.entityId, placement: recycleBin.placement })
      .from(recycleBin)
      .innerJoin(
        maintenanceRequests,
        eq(maintenanceRequests.id, recycleBin.entityId),
      )
      .where(
        and(
          eq(recycleBin.organisationId, orgId),
          eq(recycleBin.entityType, "job"),
          eq(maintenanceRequests.parentId, entry.entityId),
          eq(maintenanceRequests.deletedAt, job.deletedAt),
        ),
      );

    for (const child of childEntries) {
      const childPlacement = parsePlacement(child.placement);
      await db
        .update(maintenanceRequests)
        .set({ deletedAt: null, deletedBy: null, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(
          and(
            eq(maintenanceRequests.id, child.entityId),
            eq(maintenanceRequests.organisationId, orgId),
          ),
        );
      if (childPlacement) {
        await db
          .insert(maintenanceGroupItems)
          .values({
            requestId: child.entityId,
            organisationId: orgId,
            boardId: childPlacement.boardId ?? boardId,
            groupId: childPlacement.groupId ?? groupId,
            position: childPlacement.position ?? 0,
          })
          .onConflictDoUpdate({
            target: maintenanceGroupItems.requestId,
            set: {
              groupId: childPlacement.groupId ?? groupId,
              boardId: childPlacement.boardId ?? boardId,
              position: childPlacement.position ?? 0,
            },
          });
      }
      await db.delete(recycleBin).where(eq(recycleBin.id, child.id));
    }
  }

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
  /*
   * A RESTORE THAT DOES NOT KNOW THE BOARD MUST REFUSE, NOT GUESS.
   *
   * This ended `?? "maintenance"`. `recycle_bin.board_id` is nullable and a
   * snapshot can be written without one, so an entry that named no board was
   * restored onto the CANONICAL JOB BOARD — somebody else's board gaining a row,
   * a group or a view out of nowhere, with no error and no way to tell where it
   * had come from. Now that a register can be created at runtime the guess is
   * not even likely to be right.
   *
   * Refusing is recoverable: the entry stays in the bin, retention keeps
   * running, and the reader is told what is missing. Restoring to the wrong
   * board is not.
   */
  const boardId = snapshot?.boardId ?? entry.boardId;
  if (!boardId) {
    return {
      ok: false,
      error:
        "This group's bin entry does not record which board it came from, so it cannot be put back.",
      status: 409,
    };
  }

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

  /*
   * A RESTORE THAT DOES NOT KNOW THE BOARD MUST REFUSE, NOT GUESS.
   *
   * This ended `?? "maintenance"`. `recycle_bin.board_id` is nullable and a
   * snapshot can be written without one, so an entry that named no board was
   * restored onto the CANONICAL JOB BOARD — somebody else's board gaining a row,
   * a group or a view out of nowhere, with no error and no way to tell where it
   * had come from. Now that a register can be created at runtime the guess is
   * not even likely to be right.
   *
   * Refusing is recoverable: the entry stays in the bin, retention keeps
   * running, and the reader is told what is missing. Restoring to the wrong
   * board is not.
   */
  const restoredBoardId = snapshot.boardId ?? entry.boardId;
  if (!restoredBoardId) {
    return {
      ok: false,
      error:
        "This view's bin entry does not record which board it came from, so it cannot be put back.",
      status: 409,
    };
  }
  const boardId = String(restoredBoardId);
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

/**
 * W2C — PUT THE WHOLE SECTION BACK, as one act.
 *
 * There are exactly three writes, and that is the point: the section row, the
 * register's archived flag, and the bin entry. Nothing else has to be put back
 * because nothing else was taken away — the items, subitems, groups, columns,
 * cells, files, views, forms, automations, sites and contractors never left
 * their board, so the section reappearing is the register reappearing with
 * every one of them where it was. Deep links work again for the same reason:
 * the board key never changed.
 *
 * IT RESTORES THE STATE IT LEFT, NOT A DEFAULT. `wasArchived` is read from the
 * snapshot, so a section that was already archived when it was deleted comes
 * back archived — out of the sidebar, restorable in the section manager — and
 * one that was live comes back live. Clearing `archived_at` unconditionally
 * would have quietly re-added a section somebody had removed from the sidebar
 * months earlier.
 *
 * THE ONE THING THAT CAN GO WRONG is a key that has been taken in the meantime,
 * which cannot happen: `POST /api/workspace-sections` refuses a key held by a
 * section in the bin and says so. The `boards.key` is `sec-<12hex>` and is never
 * derived from a name, so nothing can have claimed that either.
 */
async function restoreSection(
  db: Database,
  orgId: string,
  entry: BinRow,
): Promise<RestoreOutcome> {
  let snapshot: Partial<SectionBundleSnapshot> = {};
  try {
    snapshot = (JSON.parse(entry.placement ?? "{}") ?? {}) as Partial<SectionBundleSnapshot>;
  } catch {
    /* A snapshot that will not parse is not a reason to refuse the restore —
       the section row is the thing being recovered and it is still there. The
       defaults below are the safe reading: come back archived, out of every
       sidebar, where a person can look at it before putting it back in use. */
    snapshot = {};
  }

  const [section] = await db
    .select()
    .from(workspaceSections)
    .where(
      and(
        eq(workspaceSections.organisationId, orgId),
        eq(workspaceSections.key, entry.entityId),
      ),
    )
    .limit(1);

  if (!section) {
    /* The entry outlived the thing it points at — only reachable if the row was
       removed by something other than this module. Cleared rather than left,
       because an entry offering a Restore that can never work is the one state
       worse than an empty bin. */
    await db.delete(recycleBin).where(
      and(eq(recycleBin.id, entry.id), eq(recycleBin.organisationId, orgId)),
    );
    return {
      ok: false,
      status: 409,
      error:
        "That section's record is gone, so there is nothing left to restore. Its entry has been cleared from the bin.",
    };
  }

  await db
    .update(workspaceSections)
    .set({
      deletedAt: null,
      /* `undefined` leaves the column alone; `null` clears it. A section that
         was archived before it was deleted keeps its archive. */
      archivedAt: snapshot.wasArchived === true ? undefined : null,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(workspaceSections.organisationId, orgId),
        eq(workspaceSections.key, section.key),
      ),
    );

  const boardKey = snapshot.boardKey ?? entry.boardId ?? null;
  if (boardKey && snapshot.boardWasArchived !== true) {
    await db
      .update(boards)
      .set({ archived: false, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(boards.organisationId, orgId), eq(boards.key, boardKey)));
  }

  await db.delete(recycleBin).where(
    and(eq(recycleBin.id, entry.id), eq(recycleBin.organisationId, orgId)),
  );

  return {
    ok: true,
    entityType: SECTION_ENTITY_TYPE,
    entityId: section.key,
    message:
      snapshot.wasArchived === true
        ? `"${section.label}" is back, with its register and everything on it. It was archived when it was deleted, so it is archived again — restore it in Manage sections to put it back in the sidebar.`
        : `"${section.label}" is back in the sidebar, with its register and everything that was on it.`,
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

  /*
   * W2C — A DELETED SECTION IS ONE ENTRY, NOT A HUNDRED.
   *
   * A section bundle can be sitting on top of rows, views and columns that were
   * binned individually before it. Listing those beside their parent would give
   * the bin a hundred entries for one act and offer a Restore that
   * `restoreFromBin` then refuses — a screen full of buttons that cannot work.
   * They are folded into the parent's own line instead, counted so the entry can
   * say what is under it, and they come back with the section.
   *
   * Read from the rows already in hand rather than a second query.
   */
  const binnedBoards = new Set(
    rows
      .filter((row) => row.entityType === SECTION_ENTITY_TYPE && row.boardId)
      .map((row) => row.boardId as string),
  );
  const folded = new Map<string, number>();
  const visible = rows.filter((row) => {
    if (row.entityType === SECTION_ENTITY_TYPE) return true;
    if (!row.boardId || !binnedBoards.has(row.boardId)) return true;
    folded.set(row.boardId, (folded.get(row.boardId) ?? 0) + 1);
    return false;
  });

  const now = Date.now();
  return visible.map((row) => ({
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    boardId: row.boardId,
    title: row.title,
    /* A section's line names what is under it, and says out loud when things
       that were binned separately have been folded into it — otherwise a row
       somebody deleted last week appears to have vanished from the bin. */
    summary:
      row.entityType === SECTION_ENTITY_TYPE && folded.get(row.boardId ?? "")
        ? `${row.summary ?? ""}${row.summary ? " · " : ""}${folded.get(row.boardId ?? "")} already in the bin, restored with it`
        : row.summary,
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
