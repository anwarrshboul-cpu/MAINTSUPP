/**
 * Board ordering — how rows sort, and where a dragged row lands.
 *
 * Split out of board-model.ts, which holds types, option seeds and column
 * definitions. These four are behaviour over that model rather than part of it,
 * and they are the only board logic the tests exercise directly, so they are
 * worth having somewhere that can be read without the 400-line column table
 * above them. Pure like the model: no JSX, no hooks, no side effects.
 */
import type { ColumnKey } from "./board-model";
import type {
  MaintenanceGroupItem,
  MaintenanceRequest,
} from "../../lib/types";
import { displaySource } from "./board-row-name";

/* Re-exported from where they have always been imported. Six modules take
   these off this file; a move must not be a rename for every caller. The same
   arrangement `board-chrome.tsx` uses for `BoardView`. */
export { boardItemName, displaySource } from "./board-row-name";

/**
 * Where a row lands when it is dragged into a group — H1, moved out of
 * live-board.tsx.
 *
 * Returns a whole new placement list rather than mutating: the board applies it
 * optimistically before the API answers, and a mutated array would leave no
 * previous state to roll back to when the save fails. Both the group the row
 * left and the group it joined are re-indexed from zero, so positions stay
 * dense and a later drag cannot land on a gap.
 */
export function moveBoardItemPlacement(
  items: MaintenanceGroupItem[],
  requestId: string,
  targetGroupId: string,
  beforeRequestId: string | null,
) {
  const moving = items.find((item) => item.requestId === requestId);
  const sourceGroupId = moving?.groupId ?? null;
  const affectedGroups = new Set(
    [sourceGroupId, targetGroupId].filter(
      (groupId): groupId is string => Boolean(groupId),
    ),
  );
  const unaffected = items.filter(
    (item) =>
      item.requestId !== requestId && !affectedGroups.has(item.groupId),
  );
  const sourceItems =
    sourceGroupId && sourceGroupId !== targetGroupId
      ? items
          .filter(
            (item) =>
              item.groupId === sourceGroupId && item.requestId !== requestId,
          )
          .sort((left, right) => left.position - right.position)
          .map((item, position) => ({ ...item, position }))
      : [];
  const targetItems = items
    .filter(
      (item) =>
        item.groupId === targetGroupId && item.requestId !== requestId,
    )
    .sort((left, right) => left.position - right.position);
  const requestedIndex = beforeRequestId
    ? targetItems.findIndex((item) => item.requestId === beforeRequestId)
    : targetItems.length;
  const insertAt = requestedIndex < 0 ? targetItems.length : requestedIndex;
  targetItems.splice(insertAt, 0, {
    requestId,
    groupId: targetGroupId,
    position: insertAt,
  });
  const reindexedTarget = targetItems.map((item, position) => ({
    ...item,
    groupId: targetGroupId,
    position,
  }));
  return [...unaffected, ...sourceItems, ...reindexedTarget];
}

/**
 * The value a system column sorts on.
 *
 * Dates come back as epoch milliseconds and counts as numbers so that
 * `compareBoardValues` orders them numerically; everything else is the string
 * the cell displays. A missing date sorts to the bottom in either direction
 * rather than to the top of a descending sort.
 */
export function systemColumnSortValue(
  request: MaintenanceRequest,
  key: ColumnKey,
): string | number {
  switch (key) {
    /*
     * PROVENANCE, NOT THE TITLE — and this is deliberately NOT the same answer
     * `boardItemName` now gives, so a reader who notices the difference finds
     * the reason here rather than assuming one of them was missed.
     *
     * SORTING never reaches this arm: `board-sort.ts` answers `name` through
     * `boardItemName` before it asks, so the column sorts by what it displays.
     * What DOES reach it is "Group by → Name" (`live-board.tsx`), and there the
     * two answers are not interchangeable — grouping by a free-text job title
     * produces one group per row, which is not a grouping. Grouping by how the
     * work arrived is the question somebody is actually asking.
     */
    case "name":
      return displaySource(request.source);
    case "location":
    case "storeLocation":
      return request.location;
    case "description":
      return request.description;
    case "tier":
      return request.tier;
    case "engineer":
      return request.engineer;
    case "priority":
      return request.priority;
    case "label":
      return request.category;
    case "status":
      return request.status;
    case "contractor":
      return request.contractor ?? "";
    case "assignee":
      return request.assignee ?? "";
    case "requested":
      return new Date(request.requestedAt).getTime();
    case "completed":
      return request.completedAt
        ? new Date(request.completedAt).getTime()
        : Number.NEGATIVE_INFINITY;
    case "timeline":
    // Due Date and Timeline read the same field; only what they draw differs,
    // so they must order rows identically.
    case "dueDate":
      return request.dueAt
        ? new Date(request.dueAt).getTime()
        : Number.NEGATIVE_INFINITY;
    case "requester":
      return request.requester;
    case "nextUpdate":
      return request.nextUpdateAt
        ? new Date(request.nextUpdateAt).getTime()
        : Number.NEGATIVE_INFINITY;
    case "issuePictures":
      return request.issueAttachmentCount ?? 0;
    case "completedPictures":
      return request.completedAttachmentCount ?? 0;
    case "cost":
      return request.cost ?? Number.NEGATIVE_INFINITY;
    case "approvedBy":
      return request.approvedBy ?? "";
    case "invoice":
      return request.invoice ?? "";
    case "files":
      return request.attachmentCount;
    case "number":
      return request.contact;
    case "formView":
      return request.formUrl ?? "";
    case "move":
      return request.stage;
    case "subitems":
      // Sorting a board by its Subitems column orders by how many children a
      // job has, which is what monday does.
      return 0;
  }
}

/**
 * Orders two cell values.
 *
 * Numbers compare numerically; strings use a numeric-aware, case-insensitive
 * collation so "Unit 2" precedes "Unit 10" and casing never splits a group.
 */
export function compareBoardValues(left: string | number, right: string | number) {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
