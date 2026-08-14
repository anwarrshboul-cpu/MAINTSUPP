"use client";

/**
 * The board on a phone — one card per job, the way monday does it.
 *
 * Until now a 390px screen got the grid: 783 rows and every column, at column
 * widths narrowed a little. Everything was there and nothing was reachable —
 * reading one job meant panning sideways across eleven columns, and the row you
 * were reading drifted out from under your thumb on the way back. monday does
 * not do this; on a phone it turns each item into a card carrying the primary
 * column and a handful of key values, and opens the item on tap.
 *
 * WHAT A CARD SHOWS, and why these fields. An engineer standing in a shop is
 * answering one of two questions — "which job is this" and "what do I do next"
 * — so the card carries the title, where it is, what state it is in, how urgent
 * it is, when it was raised, who has it, and whether photographs exist. That is
 * the same set the desktop board leads with; nothing here is invented for the
 * small screen.
 *
 * THE GRID IS NOT REMOVED. A toggle switches back to it, because a coordinator
 * on a tablet may genuinely want the table, and because a mobile view that
 * cannot be escaped is its own trap. The choice is remembered per board, in the
 * same `localStorage` the board already uses for collapsed groups.
 *
 * It lives in its own file because `live-board.tsx` is held to 6,000 lines by
 * `stage-eight-board-split.test.mjs` and sits ten lines under it.
 */

import { useMemo } from "react";
import { Icon } from "../../components";
import type { MaintenanceGroup, MaintenanceRequest } from "../../lib/types";
// The key format belongs to one place. Writing `${id}::${columnId}` here as
// well is how two halves of a lookup come to disagree.
import { customCellKey } from "./board-format";

export type MobileListGroup = {
  group: MaintenanceGroup;
  rows: MaintenanceRequest[];
};

/** The stage colours the board already uses, so the two views agree. */
const STAGE_TONE: Record<string, string> = {
  Completed: "done",
  "In progress": "active",
  Scheduled: "active",
  Blocked: "risk",
  Cancelled: "muted",
};

function stageTone(stage: string) {
  return STAGE_TONE[stage] ?? "open";
}

/**
 * "Today", "Yesterday", "3 days ago", then a date.
 *
 * Relative for the recent past because that is how somebody reads a job list on
 * site — "raised today" is the thing that matters, not the 9th of August. Past
 * a week it becomes a date, because "23 days ago" is arithmetic nobody wants to
 * do backwards.
 */
function whenRaised(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) return "—";
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(parsed)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days} days ago`;
  if (days < 0) return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(parsed);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: parsed.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(parsed);
}

export function BoardMobileList({
  groups,
  collapsed,
  onToggleGroup,
  onOpenItem,
  photoCountFor,
  emptyLabel,
}: {
  groups: MobileListGroup[];
  /** Group ids the reader has collapsed — shared with the grid. */
  collapsed: ReadonlySet<string>;
  onToggleGroup: (groupId: string) => void;
  onOpenItem: (request: MaintenanceRequest) => void;
  /** Photographs filed against this job, across both picture columns. */
  photoCountFor: (request: MaintenanceRequest) => number;
  emptyLabel: string;
}) {
  const total = useMemo(
    () => groups.reduce((sum, entry) => sum + entry.rows.length, 0),
    [groups],
  );

  if (!total) {
    return <p className="board-mobile__empty">{emptyLabel}</p>;
  }

  return (
    <div className="board-mobile">
      {groups.map(({ group, rows }) => {
        const isCollapsed = collapsed.has(group.id);
        return (
          <section className="board-mobile__group" key={group.id}>
            <button
              type="button"
              className="board-mobile__group-head"
              onClick={() => onToggleGroup(group.id)}
              aria-expanded={!isCollapsed}
              style={{ borderInlineStartColor: group.color ?? undefined }}
            >
              <Icon
                name="chevron"
                size={16}
                className={isCollapsed ? "" : "is-open"}
              />
              <strong>{group.name}</strong>
              <span>{rows.length}</span>
            </button>

            {!isCollapsed && (
              <ul className="board-mobile__rows">
                {rows.map((request) => {
                  const photos = photoCountFor(request);
                  return (
                    <li key={request.id}>
                      <button
                        type="button"
                        className="board-mobile__card"
                        onClick={() => onOpenItem(request)}
                      >
                        <span className="board-mobile__title">
                          {request.title || request.id}
                        </span>

                        <span className="board-mobile__meta">
                          <span
                            className={`board-mobile__chip is-${stageTone(request.stage)}`}
                          >
                            {request.stage}
                          </span>
                          {request.priority === "Urgent" ? (
                            <span className="board-mobile__chip is-urgent">Urgent</span>
                          ) : null}
                          {photos > 0 ? (
                            <span className="board-mobile__photos">
                              <Icon name="image" size={14} />
                              {photos}
                            </span>
                          ) : null}
                        </span>

                        <span className="board-mobile__facts">
                          <span>
                            <Icon name="store" size={14} />
                            {request.location || "Unassigned site"}
                          </span>
                          <span>
                            <Icon name="clock" size={14} />
                            {whenRaised(request.requestedAt)}
                          </span>
                          {request.contractor ? (
                            <span>
                              <Icon name="tool" size={14} />
                              {request.contractor}
                            </span>
                          ) : null}
                        </span>

                        <Icon name="chevron" size={16} className="board-mobile__go" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The whole phone-only section: the layout switch and the cards beneath it.
 *
 * `live-board.tsx` is held to 6,000 lines and delegating the block rather than
 * only the list keeps the switch beside the thing it switches — they are one
 * decision, and reading them in two files was how the earlier version drifted.
 *
 * `photoColumns` is passed as ids rather than a callback so this file does not
 * need the board's column model; the count is a lookup either way.
 */
export function BoardMobileSection({
  layout,
  onChooseLayout,
  groups,
  collapsed,
  onToggleGroup,
  onOpenItem,
  photoColumns,
  fileCounts,
  searching,
}: {
  layout: "cards" | "grid";
  onChooseLayout: (layout: "cards" | "grid") => void;
  groups: MobileListGroup[];
  collapsed: ReadonlySet<string>;
  onToggleGroup: (groupId: string) => void;
  onOpenItem: (request: MaintenanceRequest) => void;
  /** The two picture columns, by id. */
  photoColumns: string[];
  /** `customFileCounts`, keyed the way the board keys it. */
  fileCounts: Record<string, number>;
  searching: boolean;
}) {
  return (
    <>
      {/*
        Above the board rather than in the toolbar, so it is the first thing
        under the thumb and cannot be scrolled past — somebody who lands on the
        wrong layout needs to leave it immediately, not hunt for a control.
      */}
      <div className="board-mobile__switch" role="group" aria-label="Board layout">
        <button
          type="button"
          className={layout === "cards" ? "is-on" : ""}
          aria-pressed={layout === "cards"}
          onClick={() => onChooseLayout("cards")}
        >
          <Icon name="list" size={16} />
          Cards
        </button>
        <button
          type="button"
          className={layout === "grid" ? "is-on" : ""}
          aria-pressed={layout === "grid"}
          onClick={() => onChooseLayout("grid")}
        >
          <Icon name="grid" size={16} />
          Table
        </button>
      </div>

      {layout === "cards" ? (
        <BoardMobileList
          groups={groups}
          collapsed={collapsed}
          onToggleGroup={onToggleGroup}
          onOpenItem={onOpenItem}
          photoCountFor={(request) =>
            photoColumns.reduce(
              (sum, columnId) => sum + (fileCounts[customCellKey(request.id, columnId)] ?? 0),
              0,
            )
          }
          emptyLabel={
            searching ? "No job matches that search." : "Nothing on this board yet."
          }
        />
      ) : null}
    </>
  );
}
