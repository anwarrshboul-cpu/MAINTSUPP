/**
 * The board's own writes, as functions.
 *
 * These used to live inline in `POST/PATCH /api/board` — create an item, move
 * items to a group, duplicate items, set a cell, create a group — and nothing
 * else could reach them without an HTTP round trip to ourselves. The
 * automation engine (`app/lib/automations/`) needs exactly these operations
 * when a rule fires, and a second copy of each would be a second place for
 * the board's invariants to drift: the stage a group carries, the status chip
 * that stage implies, the id generator that must still see binned rows.
 *
 * So the route calls these and the engine calls these. Same tables, same
 * activity rows, same guards. Each takes the organisation as an explicit
 * argument and filters every statement on it, because the caller has already
 * resolved tenancy and nothing here may widen it.
 */

import { and, asc, eq, inArray, isNull, max, sql, type AnyColumn } from "drizzle-orm";
import { maintenanceGroups as maintenanceGroupSeeds } from "../../db/monday-board-spec";
import type { getDb } from "../../db";
import {
  activityLog,
  boards,
  maintenanceBoardCells,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  recycleBin,
} from "../../db/schema";
import type { RequestStage } from "./types";
import { statusForStage } from "./stage-status";
import { selectInChunks } from "./sql-batching";
import { PRIMARY_ORGANISATION_ID } from "./tenant-access";
import { unassignedSiteId } from "./site-reference";
import {
  JOB_REFERENCE_FLOOR,
  nextJobReferenceNumber,
} from "./job-reference";

export type BoardDatabase = Awaited<ReturnType<typeof getDb>>;

export type MutationActor = {
  email: string | null;
  displayName: string | null;
};

type GroupRow = typeof maintenanceGroups.$inferSelect;
type RequestRow = typeof maintenanceRequests.$inferSelect;
type ItemRow = typeof maintenanceGroupItems.$inferSelect;

/** The colours a group may be given. The seed's own, plus monday's palette. */
export const GROUP_COLORS = new Set([
  ...maintenanceGroupSeeds.map((group) => group.colour),
  "#579bfc",
  "#00c875",
  "#fdab3d",
  "#a25ddc",
  "#e2445c",
  "#0086c0",
  "#ff642e",
  "#037f4c",
]);

export function newItemTitle(boardId: string, itemNoun?: string | null) {
  /*
   * THE BOARD'S OWN NOUN FIRST, AND THE KEY ONLY AS A FALLBACK.
   *
   * This compared `boardId` against two literal keys, which is precisely the
   * isolation-by-route-string the section work exists to remove. It also got
   * the answer wrong the moment templates landed: a section created from the
   * Jobs template is a job board in every other respect - the same 27 columns,
   * the same lanes, the same stage routing - and its untitled rows came back
   * "New item" because its KEY is `sec-...` rather than `maintenance`.
   *
   * `boards.item_noun` is the fact being asked for, and `createBoard` sets it
   * from the template, so an instance answers the same as its source by
   * construction. The two literals survive underneath because the canonical
   * boards' stored nouns are "Job" and "Store" while their long-standing UI
   * strings are "New maintenance item" and "New store" - the board parity tests
   * read those exact strings, and a register created at runtime has no such
   * history to preserve.
   */
  if (boardId === "store-documentation") return "New store";
  if (boardId === "maintenance") return "New maintenance item";
  const noun = (itemNoun ?? "").trim();
  return noun ? `New ${noun.toLowerCase()}` : "New item";
}

/** The item noun a board carries, or null when the board has since gone. */
async function boardItemNoun(db: BoardDatabase, orgId: string, boardId: string) {
  const [row] = await db
    .select({ itemNoun: boards.itemNoun })
    .from(boards)
    .where(and(eq(boards.organisationId, orgId), eq(boards.key, boardId)));
  return row?.itemNoun ?? null;
}

/** Seed ids are bare on the primary organisation and suffixed elsewhere. */
export function tenantSeedId(base: string, orgId: string) {
  return orgId === PRIMARY_ORGANISATION_ID ? base : `${base}-${orgId}`;
}

/**
 * The next `MN-…` id.
 *
 * Stage 23 — DELIBERATELY UNFILTERED. Do not add `isNull(deletedAt)`. A job
 * sitting in the recycle bin still owns its id; excluding binned rows would
 * hand the same reference to a new job, and the collision would only surface
 * when somebody restored the old one — the worst possible moment.
 *
 * PRE-W14 — AND A JOB'S REFERENCE OUTLIVES THE JOB ROW.
 *
 * The `MAX` used to be taken over `maintenance_requests` alone, which is only
 * the table the reference is a PRIMARY KEY *of*. It is also the primary key of
 * `maintenance_group_items` and half of the unique key of `recycle_bin`, and a
 * row in either can outlive the request it names — a purge that removed the
 * request and left the placement, a bin entry whose job was later hard-deleted.
 * When that happens the MAX drops back below a reference that is still spoken
 * for, the allocator re-issues it, and the insert that collides is not the one
 * the retry below guards:
 *
 *   · a surviving placement  -> `create_item`  answers a bare 503
 *   · a surviving bin entry  -> `delete_items` answers a bare 503
 *
 * Both were observed on the dev estate: `maintenance_requests` topped out at
 * MN-1157 while placements held MN-1162, so no job could be created on the
 * board at all until the leftovers were removed by hand.
 *
 * So the floor is now the highest reference ANY of those tables still holds.
 * The product no longer depends on a cleanup script having been run, and
 * `scripts/repair-orphaned-placements.mjs` goes back to being what it should
 * always have been: a tidy-up, not a prerequisite.
 *
 * Scoped per organisation, like the read it replaces. `recycle_bin` is filtered
 * to `entity_type = 'job'` because its `entity_id` also carries group, column
 * and board-view ids, and those share no numbering with `MN-…`.
 */
async function nextItemNumber(db: BoardDatabase, orgId: string) {
  const digits = (column: AnyColumn) =>
    sql<number>`coalesce(max(cast(substr(${column}, 4) as integer)), ${JOB_REFERENCE_FLOOR})`;

  const [fromRequests] = await db
    .select({ maxNumber: digits(maintenanceRequests.id) })
    .from(maintenanceRequests)
    .where(eq(maintenanceRequests.organisationId, orgId));

  const [fromPlacements] = await db
    .select({ maxNumber: digits(maintenanceGroupItems.requestId) })
    .from(maintenanceGroupItems)
    .where(eq(maintenanceGroupItems.organisationId, orgId));

  const [fromBin] = await db
    .select({ maxNumber: digits(recycleBin.entityId) })
    .from(recycleBin)
    .where(
      and(eq(recycleBin.organisationId, orgId), eq(recycleBin.entityType, "job")),
    );

  /* The arithmetic lives in ./job-reference.ts so a test can RUN it; this
     function is only the three reads that feed it. */
  return nextJobReferenceNumber([
    fromRequests?.maxNumber,
    fromPlacements?.maxNumber,
    fromBin?.maxNumber,
  ]);
}

/**
 * How many consecutive ids `createBoardItem` will try before giving up.
 *
 * `nextItemNumber` reads a MAX rather than reserving from an atomic counter, so
 * simultaneous creates compute the same number and every insert after the first
 * loses the primary key. Rather than let that surface as a 503, the insert uses
 * `ON CONFLICT DO NOTHING` and walks to the next number when the row it wanted
 * was taken — so a burst of creates fans out across consecutive slots. Eight
 * covers far more simultaneous creators than a board ever has.
 */
const MAX_ITEM_ID_ATTEMPTS = 8;

async function nextPosition(db: BoardDatabase, orgId: string, groupId: string) {
  const [last] = await db
    .select({ value: max(maintenanceGroupItems.position) })
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.groupId, groupId),
        eq(maintenanceGroupItems.organisationId, orgId),
      ),
    );
  return Number(last.value ?? -1) + 1;
}

export async function findGroup(
  db: BoardDatabase,
  orgId: string,
  boardId: string,
  groupId: string,
): Promise<GroupRow | null> {
  const [group] = await db
    .select()
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.boardId, boardId),
        eq(maintenanceGroups.id, groupId),
        eq(maintenanceGroups.organisationId, orgId),
        isNull(maintenanceGroups.deletedAt),
      ),
    )
    .limit(1);
  return group ?? null;
}

/** Creates a group at the end of the board. */
export async function createBoardGroup(
  db: BoardDatabase,
  orgId: string,
  boardId: string,
  name: string,
  color?: string,
): Promise<GroupRow> {
  const [last] = await db
    .select({ value: max(maintenanceGroups.position) })
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.boardId, boardId),
        eq(maintenanceGroups.organisationId, orgId),
        isNull(maintenanceGroups.deletedAt),
      ),
    );
  const requested = (color ?? "").trim().toLowerCase();
  const [group] = await db
    .insert(maintenanceGroups)
    .values({
      id: `group-${crypto.randomUUID()}`,
      organisationId: orgId,
      boardId,
      name,
      color: GROUP_COLORS.has(requested) ? requested : "#579bfc",
      stageKey: null,
      position: Number(last.value ?? -1) + 1,
    })
    .returning();
  return group;
}

/**
 * The board's "Archived" group, created on first use.
 *
 * This is what "archive" means on this board: the item moves to a group named
 * Archived at the foot of the board. It is not a flag, and it is not the bin.
 */
export async function findOrCreateArchivedGroup(
  db: BoardDatabase,
  orgId: string,
  boardId: string,
): Promise<GroupRow> {
  const [existing] = await db
    .select()
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.boardId, boardId),
        eq(maintenanceGroups.name, "Archived"),
        eq(maintenanceGroups.organisationId, orgId),
        isNull(maintenanceGroups.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return existing;
  return createBoardGroup(db, orgId, boardId, "Archived", "#808080");
}

/**
 * A new item at the end of a group. The route's inline "+ New item".
 *
 * Returns null when the group is not on this board, which the route turns
 * into a 404 and the engine into a failed run.
 */
export async function createBoardItem(
  db: BoardDatabase,
  orgId: string,
  boardId: string,
  actor: MutationActor,
  groupId: string,
  options: { title?: string; parentId?: string | null } = {},
): Promise<{ request: RequestRow; item: ItemRow; group: GroupRow } | null> {
  const group = await findGroup(db, orgId, boardId, groupId);
  if (!group) return null;

  const position = await nextPosition(db, orgId, group.id);
  const requestedAt = new Date().toISOString();
  const stage = (group.stageKey as RequestStage | null) ?? ("Incoming" as const);
  const title =
    (options.title ?? "").trim().slice(0, 180) ||
    newItemTitle(boardId, await boardItemNoun(db, orgId, boardId));

  // Everything about the new row except its id, which is picked per attempt.
  const values = {
    organisationId: orgId,
    /*
     * No site, said as no site.
     *
     * This wrote the literal "site-unassigned" — an id referencing no row in
     * `sites`, or in any table, in any tenant. It had to be exempted by hand
     * from the cross-organisation check on the create route, it keyed a bucket
     * of its own in every rollup that grouped on `site_id`, and it read as a
     * real site id to anything that did not know the sentinel by name.
     * `unassignedSiteId` returns null wherever the column can hold one.
     */
    siteId: unassignedSiteId(),
    source: "Manual",
    title,
    description: title,
    /*
     * And no location either. "Choose a location" is a prompt, not a place: it
     * aggregated as a site name wherever a rollup fell back to the text, and
     * the board already draws the prompt itself where this field is empty.
     */
    location: "",
    requester: actor.displayName || actor.email || "Workspace",
    contact: "Not provided",
    category: "Other",
    engineer: "Handyman",
    tier: 3,
    priority: "Medium",
    stage,
    status: statusForStage(stage),
    contractor: null,
    assignee: null,
    parentId: options.parentId ?? null,
    requestedAt,
    dueAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    completedAt: null,
    nextUpdateAt: null,
    cost: null,
    attachmentCount: 0,
    issueAttachmentCount: 0,
    completedAttachmentCount: 0,
    generalAttachmentCount: 0,
    commentCount: 0,
    createdByEmail: actor.email,
  };

  /*
   * Pick an id and insert, walking PAST a concurrent create that took the same
   * number first. `base` is read once; each retry tries `base + attempt`
   * rather than re-reading the MAX, because a re-read can still see the losing
   * value before the winner's row is visible and hand back the same number
   * again. Walking a fixed offset means every attempt targets a definitively
   * different id, so N simultaneous creates fan out across N consecutive slots
   * instead of all queuing behind one. See `MAX_ITEM_ID_ATTEMPTS`.
   *
   * A taken id is detected with `onConflictDoNothing().returning()` — the
   * conflict becomes an empty result, never an exception — because that is how
   * every other writer in this codebase treats a lost insert race, and because
   * the D1 adapters do not guarantee a typed constraint error that could be
   * told apart from a real failure.
   */
  const base = await nextItemNumber(db, orgId);
  let created: RequestRow | undefined;
  let placement: ItemRow | undefined;
  let id = "";
  for (let attempt = 0; attempt < MAX_ITEM_ID_ATTEMPTS; attempt++) {
    id = `MN-${base + attempt}`;
    const [row] = await db
      .insert(maintenanceRequests)
      .values({ id, ...values })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;

    /*
     * THE PLACEMENT IS PART OF THE ALLOCATION, not a step after it.
     *
     * `nextItemNumber` now starts above every table that still holds a
     * reference, so this should not fire — but the retry is what makes the
     * guarantee not depend on that list being complete. The reference is a key
     * in more than one table, and a create is only safe once the row AND its
     * placement are both down. Inserting the request, declaring victory, and
     * discovering the placement was taken is exactly how `create_item` came to
     * answer a bare 503.
     *
     * `onConflictDoNothing` rather than a catch, for the reason the request
     * insert gives: the D1 adapters do not promise a typed constraint error
     * that could be told apart from a real failure. A genuine failure still
     * throws and is compensated below.
     */
    const [placed] = await db
      .insert(maintenanceGroupItems)
      .values({
        requestId: id,
        organisationId: orgId,
        boardId,
        groupId: group.id,
        position,
      })
      .onConflictDoNothing()
      .returning();

    if (placed) {
      created = row;
      placement = placed;
      break;
    }

    /*
     * The reference was free in `maintenance_requests` and taken in the
     * placements table. Undo the row we just made and walk on — leaving it
     * would strand an unplaced row, which the board files onto the default
     * board belonging to nobody. Best-effort, as below.
     */
    await db
      .delete(maintenanceRequests)
      .where(
        and(eq(maintenanceRequests.id, id), eq(maintenanceRequests.organisationId, orgId)),
      )
      .catch(() => undefined);
  }
  if (!created || !placement) {
    throw new Error("Could not allocate a job id; too many simultaneous creates.");
  }

  /*
   * THE PLACEMENT IS WHAT PUTS THE ROW ON A BOARD, so a row without one is not
   * a half-created item — it is an invisible row on somebody else's board.
   *
   * `maintenance_requests` carries no board id: a row's board comes from its
   * placement, and the board route deliberately files an UNPLACED row into the
   * default board's first group so nothing is ever stranded. A request row left
   * behind without one therefore does not vanish — it appears on the JOB BOARD,
   * belonging to nobody, under whatever title it was given. Six were produced
   * that way while W02-06 was being built, on a board carrying real work.
   *
   * There is still no transaction to lean on — D1 and the Postgres shim do not
   * give this code one — so the two inserts are paired inside the allocation
   * loop above instead, and every path that leaves a request without a
   * placement deletes it again before moving on. By here both are down.
   */
  const item = placement;

  await db.insert(activityLog).values({
    id: crypto.randomUUID(),
    organisationId: orgId,
    entityType: "maintenance_request",
    entityId: id,
    action: "request.created_inline",
    actorEmail: actor.email,
    detail: JSON.stringify({ groupId: group.id }),
  });
  return { request: created, item, group };
}

export type MoveOutcome = {
  group: GroupRow;
  items: ItemRow[];
  requests: RequestRow[];
  /** Status changes the move implied, for whoever is listening. */
  statusChanges: Array<{ requestId: string; from: string; to: string }>;
  /** Ids that actually changed group, as opposed to being re-appended. */
  movedFrom: Array<{ requestId: string; fromGroupId: string }>;
};

/**
 * Moves items to the end of a group, taking the group's stage with them.
 *
 * `archive` is the same operation aimed at the Archived group. A group with a
 * stage key sets the job's stage and — as the board has always done — the
 * status chip that stage implies.
 */
export async function moveItemsToGroup(
  db: BoardDatabase,
  orgId: string,
  boardId: string,
  actor: MutationActor,
  group: GroupRow,
  requestIds: string[],
  archive = false,
): Promise<MoveOutcome> {
  let position = await nextPosition(db, orgId, group.id);
  const items: ItemRow[] = [];
  const requests: RequestRow[] = [];
  const statusChanges: MoveOutcome["statusChanges"] = [];
  const movedFrom: MoveOutcome["movedFrom"] = [];

  for (const requestId of requestIds) {
    const [existing] = await db
      .select()
      .from(maintenanceGroupItems)
      .where(
        and(
          eq(maintenanceGroupItems.requestId, requestId),
          eq(maintenanceGroupItems.organisationId, orgId),
        ),
      )
      .limit(1);
    if (!existing) continue;
    if (existing.groupId !== group.id) {
      movedFrom.push({ requestId, fromGroupId: existing.groupId });
    }
    const [item] = await db
      .update(maintenanceGroupItems)
      .set({ groupId: group.id, position, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(maintenanceGroupItems.requestId, requestId),
          eq(maintenanceGroupItems.organisationId, orgId),
        ),
      )
      .returning();
    position += 1;
    items.push(item);

    if (group.stageKey) {
      const stage = group.stageKey as RequestStage;
      const [before] = await db
        .select({ status: maintenanceRequests.status })
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.id, requestId),
            eq(maintenanceRequests.organisationId, orgId),
          ),
        )
        .limit(1);
      const [updated] = await db
        .update(maintenanceRequests)
        .set({
          stage,
          status: statusForStage(stage),
          completedAt: stage === "Completed" ? new Date().toISOString() : null,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(maintenanceRequests.id, requestId),
            eq(maintenanceRequests.organisationId, orgId),
          ),
        )
        .returning();
      if (updated) {
        requests.push(updated);
        if (before && before.status !== updated.status) {
          statusChanges.push({ requestId, from: before.status, to: updated.status });
        }
      }
    }
    await db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: orgId,
      entityType: "maintenance_request",
      entityId: requestId,
      action: archive ? "request.archived" : "request.group_changed",
      actorEmail: actor.email,
      detail: JSON.stringify({ groupId: group.id, groupName: group.name }),
    });
  }
  return { group, items, requests, statusChanges, movedFrom };
}

export type DuplicateOutcome = {
  requests: RequestRow[];
  items: ItemRow[];
  cells: Array<{ requestId: string; columnId: string; value: string }>;
};

/**
 * Copies items into their own groups, cells included, evidence excluded.
 *
 * Stage 23 — a job in the recycle bin cannot be duplicated. Restore it first;
 * duplicating one would put a copy on the board while the original stayed
 * invisible in the bin.
 */
export async function duplicateBoardItems(
  db: BoardDatabase,
  orgId: string,
  boardId: string,
  actor: MutationActor,
  requestIds: string[],
): Promise<DuplicateOutcome> {
  const sourceRows = await selectInChunks(requestIds, (chunk) =>
    db
      .select()
      .from(maintenanceRequests)
      .where(
        and(
          inArray(maintenanceRequests.id, chunk),
          eq(maintenanceRequests.organisationId, orgId),
          isNull(maintenanceRequests.deletedAt),
        ),
      ),
  );
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const sourceItems = await selectInChunks(requestIds, (chunk) =>
    db
      .select()
      .from(maintenanceGroupItems)
      .where(
        and(
          inArray(maintenanceGroupItems.requestId, chunk),
          eq(maintenanceGroupItems.organisationId, orgId),
        ),
      ),
  );
  const itemByRequest = new Map(sourceItems.map((item) => [item.requestId, item]));
  const sourceCells = await selectInChunks(requestIds, (chunk) =>
    db
      .select()
      .from(maintenanceBoardCells)
      .where(
        and(
          inArray(maintenanceBoardCells.requestId, chunk),
          eq(maintenanceBoardCells.organisationId, orgId),
        ),
      ),
  );

  let nextNumber = await nextItemNumber(db, orgId);
  const nextPositions = new Map<string, number>();
  const requests: RequestRow[] = [];
  const items: ItemRow[] = [];
  const cells: DuplicateOutcome["cells"] = [];

  for (const sourceId of requestIds) {
    const source = sourceById.get(sourceId);
    if (!source) continue;
    const sourceItem = itemByRequest.get(sourceId);
    const groupId = sourceItem?.groupId ?? tenantSeedId("group-incoming", orgId);
    let position = nextPositions.get(groupId);
    if (position === undefined) position = await nextPosition(db, orgId, groupId);
    nextPositions.set(groupId, position + 1);
    const id = `MN-${nextNumber}`;
    nextNumber += 1;
    const now = new Date().toISOString();
    const [created] = await db
      .insert(maintenanceRequests)
      .values({
        id,
        organisationId: orgId,
        siteId: source.siteId,
        source: source.source,
        title: `${source.title} (copy)`.slice(0, 180),
        description: source.description,
        location: source.location,
        requester: source.requester,
        contact: source.contact,
        category: source.category,
        engineer: source.engineer,
        tier: source.tier,
        priority: source.priority,
        stage: source.stage,
        status: source.status,
        contractor: source.contractor,
        /*
         * The COPY inherits the original's contractor reference, not a
         * re-resolution of its name.
         *
         * `source` is the whole row, read under `eq(organisationId, orgId)`
         * above and re-inserted under the same `orgId`, so the id cannot cross
         * a tenant boundary here. Dropping it — which is what omitting the
         * column did — produced a duplicate whose text named a contractor and
         * whose reference named nobody, and after the register learned to read
         * the id (see app/lib/contractor-reference.ts) that copy would have
         * fallen out of its contractor's figures for a reason no screen shows.
         */
        contractorId: source.contractorId,
        assignee: source.assignee,
        parentId: source.parentId,
        requestedAt: source.requestedAt,
        dueAt: source.dueAt,
        completedAt: source.completedAt,
        nextUpdateAt: source.nextUpdateAt,
        cost: source.cost,
        approvedBy: source.approvedBy,
        invoice: source.invoice,
        attachmentCount: 0,
        issueAttachmentCount: 0,
        completedAttachmentCount: 0,
        generalAttachmentCount: 0,
        formUrl: null,
        publicUploadTokenHash: null,
        publicUploadTokenExpiresAt: null,
        commentCount: 0,
        createdByEmail: actor.email,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [item] = await db
      .insert(maintenanceGroupItems)
      .values({
        requestId: id,
        organisationId: orgId,
        boardId,
        groupId,
        position,
      })
      .returning();
    for (const sourceCell of sourceCells.filter((cell) => cell.requestId === sourceId)) {
      const [cell] = await db
        .insert(maintenanceBoardCells)
        .values({
          id: `cell-${crypto.randomUUID()}`,
          organisationId: orgId,
          boardId,
          requestId: id,
          columnId: sourceCell.columnId,
          value: sourceCell.value,
        })
        .returning();
      cells.push({ requestId: cell.requestId, columnId: cell.columnId, value: cell.value });
    }
    await db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: orgId,
      entityType: "maintenance_request",
      entityId: id,
      action: "request.duplicated",
      actorEmail: actor.email,
      detail: JSON.stringify({ sourceRequestId: sourceId, groupId }),
    });
    requests.push(created);
    items.push(item);
  }
  return { requests, items, cells };
}

/**
 * Writes one custom-column cell, or removes it when the value is empty.
 *
 * The value has already been normalised for the column's type by the caller —
 * this is storage, not validation. Returns the previous value so a caller can
 * tell a change from a rewrite of the same thing.
 */
export async function setBoardCell(
  db: BoardDatabase,
  orgId: string,
  boardId: string,
  requestId: string,
  columnId: string,
  value: string,
): Promise<{ before: string; after: string }> {
  const [existing] = await db
    .select({ value: maintenanceBoardCells.value })
    .from(maintenanceBoardCells)
    .where(
      and(
        eq(maintenanceBoardCells.boardId, boardId),
        eq(maintenanceBoardCells.requestId, requestId),
        eq(maintenanceBoardCells.columnId, columnId),
        eq(maintenanceBoardCells.organisationId, orgId),
      ),
    )
    .limit(1);
  const before = existing?.value ?? "";
  if (!value) {
    if (existing) {
      await db
        .delete(maintenanceBoardCells)
        .where(
          and(
            eq(maintenanceBoardCells.boardId, boardId),
            eq(maintenanceBoardCells.requestId, requestId),
            eq(maintenanceBoardCells.columnId, columnId),
            eq(maintenanceBoardCells.organisationId, orgId),
          ),
        );
    }
    return { before, after: "" };
  }
  const now = new Date().toISOString();
  await db
    .insert(maintenanceBoardCells)
    .values({
      id: `cell-${crypto.randomUUID()}`,
      organisationId: orgId,
      boardId,
      requestId,
      columnId,
      value,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        maintenanceBoardCells.organisationId,
        maintenanceBoardCells.boardId,
        maintenanceBoardCells.requestId,
        maintenanceBoardCells.columnId,
      ],
      set: { value, updatedAt: now },
    });
  return { before, after: value };
}

/** The group an item sits in, or null when it has no placement on this board. */
export async function placementOf(
  db: BoardDatabase,
  orgId: string,
  boardId: string,
  requestId: string,
): Promise<ItemRow | null> {
  const [row] = await db
    .select()
    .from(maintenanceGroupItems)
    .where(
      and(
        eq(maintenanceGroupItems.boardId, boardId),
        eq(maintenanceGroupItems.requestId, requestId),
        eq(maintenanceGroupItems.organisationId, orgId),
      ),
    )
    .orderBy(asc(maintenanceGroupItems.position))
    .limit(1);
  return row ?? null;
}
