/**
 * Turning a write into events.
 *
 * Every route that changes a job row calls `requestFieldEvents` with the row
 * before and after, and gets back one `column_changed` per board column that
 * moved — named by the board's column key, so a rule reading "When Status
 * changes" matches a Status change and nothing else. Routes that change a
 * custom cell build the event by hand with `cellChangedEvent`.
 */

import { SYSTEM_FIELD_BY_KEY, fieldAsText } from "../request-fields";
import type { AutomationEvent } from "./types";

type RowLike = Record<string, unknown>;

export function requestFieldEvents(
  boardId: string,
  before: RowLike | null | undefined,
  after: RowLike,
): AutomationEvent[] {
  const requestId = typeof after.id === "string" ? after.id : null;
  if (!requestId) return [];
  const parentId = typeof after.parentId === "string" ? after.parentId : null;
  const events: AutomationEvent[] = [];
  for (const [key, entry] of Object.entries(SYSTEM_FIELD_BY_KEY)) {
    const from = fieldAsText(before?.[entry.field]);
    const to = fieldAsText(after[entry.field]);
    if (from === to) continue;
    events.push({
      type: "column_changed",
      boardId,
      requestId,
      parentId,
      column: key,
      columnType: entry.type,
      from,
      to,
      summary: `${key}: ${from || "(empty)"} → ${to || "(empty)"}`,
    });
  }
  return events;
}

export function cellChangedEvent(
  boardId: string,
  requestId: string,
  parentId: string | null,
  columnId: string,
  columnType: string,
  from: string,
  to: string,
): AutomationEvent | null {
  if (from === to) return null;
  return {
    type: "column_changed",
    boardId,
    requestId,
    parentId,
    column: columnId,
    columnType,
    from,
    to,
    summary: `column ${columnId}: ${from || "(empty)"} → ${to || "(empty)"}`,
  };
}

export function itemCreatedEvent(
  boardId: string,
  requestId: string,
  parentId: string | null,
  groupId?: string | null,
): AutomationEvent {
  return {
    type: "item_created",
    boardId,
    requestId,
    parentId,
    groupId: groupId ?? null,
    summary: parentId ? `subitem ${requestId} created under ${parentId}` : `item ${requestId} created`,
  };
}

export function itemMovedEvent(
  boardId: string,
  requestId: string,
  parentId: string | null,
  groupId: string,
  groupName?: string | null,
): AutomationEvent {
  return {
    type: "item_moved",
    boardId,
    requestId,
    parentId,
    groupId,
    summary: `item ${requestId} moved to ${groupName ?? groupId}`,
  };
}

export function updateCreatedEvent(
  boardId: string,
  requestId: string,
  parentId: string | null,
): AutomationEvent {
  return {
    type: "update_created",
    boardId,
    requestId,
    parentId,
    summary: `update posted on ${requestId}`,
  };
}
