"use client";

/**
 * One column heading, and everything its `...` menu offers.
 *
 * Lifted whole out of live-board.tsx, which is held under 6,000 lines by
 * `stage-eight-board-split.test.mjs`. It is a good seam on its own terms: the
 * heading takes every input as a prop and reaches for nothing in the board's
 * closure, and it is where five separate features meet — sort, filter, pin,
 * reorder and resize — so it is the file somebody opens when one of them
 * behaves oddly.
 *
 * FIVE CONTROLS ON ONE 35-PIXEL ROW, and the rules that keep them apart:
 *
 *   · the SORT ARROW is invisible at rest and appears on hover, except on a
 *     column that is sorted, where it stays put — "which column is this board
 *     ordered by" has to be answerable without waving a mouse over 26 headers.
 *     When the board carries more than one sort rule it also carries its rank,
 *     because a subsort nobody can see the shape of gets fought with;
 *   · the RESIZE HANDLE is a button with its own pointer capture, and it stops
 *     propagation, so a drag on it is a resize and never a reorder;
 *   · REORDER is `draggable` on the TITLE only, not on the whole cell. That is
 *     what keeps it clear of the resize handle, the sort arrow and the menu
 *     button — each of which is a real control a person aims at — while still
 *     giving a wide, obvious grab area;
 *   · the MENU is the keyboard and touch route to everything drag offers, so
 *     "move left" and "move right" are listed there rather than drag being the
 *     only way to reorder a board.
 */

import { useContext, type CSSProperties, type DragEvent } from "react";
import { Icon } from "../../components";
import type { BoardColumnType, MaintenanceBoardColumn } from "../../lib/types";
import { columnSettingsActionLabel } from "./board-column-settings";
import {
  type BoardDisplayColumn,
  type ColumnKey,
  columnTypeDefinitions,
} from "./board-model";
import { displayedBoardColumnWidth } from "./board-format";
import { MobileBoardContext } from "./board-primitives";
import { stickyZIndex, type StickyColumn } from "./board-pinning";

/** How a summary function reads to a person. Server vocabulary, human words. */
const SUMMARY_LABELS: Record<string, string> = {
  sum: "Sum",
  average: "Average",
  min: "Earliest / lowest",
  max: "Latest / highest",
  count: "Count",
  median: "Median",
  battery: "Distribution bar",
};

export type ColumnHeaderProps = {
  kind: BoardDisplayColumn["kind"];
  systemKey?: ColumnKey;
  column: MaintenanceBoardColumn;
  menuOpen: boolean;
  /** This column's direction in the board's sort, or null if it is not in it. */
  sortDirection: "asc" | "desc" | null;
  /** 1-based place in the sort. Drawn only when the board has more than one rule. */
  sortRank: number | null;
  /** Whether a filter rule is narrowing the board by this column. */
  filtered: boolean;
  pinned: boolean;
  /** Where this column is frozen, when it is. Absent means it scrolls. */
  sticky?: StickyColumn;
  /** Summary functions the server will accept for this column's type. */
  summaries: readonly string[];
  canMoveLeft: boolean;
  canMoveRight: boolean;
  /** True while a column is being dragged over this one. */
  dropTarget: boolean;
  onMenuToggle: () => void;
  onConfigure?: () => void;
  onRename: () => void;
  onToggleWrap: () => void;
  /** Sort by this column ALONE — the fast path a header click takes. */
  onSort: (direction: "asc" | "desc") => void;
  /** Append this column to the sort as the next tie-breaker. */
  onAddSort: (direction: "asc" | "desc") => void;
  onFilter: () => void;
  onTogglePin: () => void;
  onMove: (delta: -1 | 1) => void;
  onSummary: (summary: string) => void;
  onAddRight: () => void;
  onDuplicate?: () => void;
  onClear?: () => void;
  onHide: () => void;
  onDelete?: () => void;
  /** Retype a custom column. System columns refuse — the board reads them. */
  onChangeType?: (type: BoardColumnType) => void;
  onCollapse: () => void;
  onGroupBy: () => void;
  collapsed: boolean;
  groupedByThis: boolean;
  onResizePreview: (width: number) => void;
  onResizeCommit: (width: number) => void;
  onDragStartColumn: () => void;
  onDragOverColumn: () => void;
  onDropColumn: () => void;
  onDragEndColumn: () => void;
};

export function BoardColumnHeader({
  kind,
  systemKey,
  column,
  menuOpen,
  sortDirection,
  sortRank,
  filtered,
  pinned,
  sticky,
  summaries,
  canMoveLeft,
  canMoveRight,
  dropTarget,
  onMenuToggle,
  onConfigure,
  onRename,
  onToggleWrap,
  onSort,
  onAddSort,
  onFilter,
  onTogglePin,
  onMove,
  onSummary,
  onAddRight,
  onDuplicate,
  onClear,
  onHide,
  onDelete,
  onChangeType,
  onCollapse,
  onGroupBy,
  collapsed,
  groupedByThis,
  onResizePreview,
  onResizeCommit,
  onDragStartColumn,
  onDragOverColumn,
  onDropColumn,
  onDragEndColumn,
}: ColumnHeaderProps) {
  const mobile = useContext(MobileBoardContext);
  const displayedWidth = displayedBoardColumnWidth(column, mobile);
  const definition =
    columnTypeDefinitions.find((item) => item.type === column.type) ??
    columnTypeDefinitions[2];
  const className =
    kind === "system" && systemKey
      ? `sheet-column--${systemKey}`
      : "sheet-column--custom";
  const style: CSSProperties = {
    width: displayedWidth,
    minWidth: displayedWidth,
    maxWidth: displayedWidth,
  };
  if (sticky) {
    style.left = sticky.left;
    style.zIndex = stickyZIndex(sticky.order, true);
  }

  return (
    <th
      className={[
        className,
        column.settings.wrap ? "is-column-wrapped" : "",
        // Only a PINNED column takes the class. The Items column is sticky
        // through its own long-standing rules and would fight this one for a
        // background; `sticky` still carries its offset so the run stays
        // contiguous when a pinned column sits beside it.
        pinned ? "is-pinned-column" : "",
        dropTarget ? "is-column-drop-target" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      /* Announced, not just drawn: a screen reader reads the sort off the
         column header the same way a sighted reader reads the arrow. */
      aria-sort={
        sortDirection === "asc"
          ? "ascending"
          : sortDirection === "desc"
            ? "descending"
            : "none"
      }
      style={style}
      onDragOver={(event: DragEvent<HTMLTableCellElement>) => {
        // Without preventDefault the browser refuses the drop and the cursor
        // shows "no entry" over every valid target.
        event.preventDefault();
        onDragOverColumn();
      }}
      onDrop={(event: DragEvent<HTMLTableCellElement>) => {
        event.preventDefault();
        onDropColumn();
      }}
    >
      <div className="custom-column-header" data-board-popover>
        {kind === "custom" && (
          <span
            className="custom-column-header__type"
            style={{ background: definition.color }}
          >
            <Icon name={definition.icon} size={13} />
          </span>
        )}
        <strong
          title={`${column.title} — drag to move this column`}
          draggable
          onDragStart={(event: DragEvent<HTMLElement>) => {
            // The id travels in the payload as well as in the board's own
            // state: a drag that starts here and ends somewhere unexpected is
            // then still identifiable rather than silently moving whatever the
            // last drag touched.
            event.dataTransfer.setData("text/plain", column.id);
            event.dataTransfer.effectAllowed = "move";
            onDragStartColumn();
          }}
          onDragEnd={onDragEndColumn}
        >
          {column.title}
        </strong>
        {filtered && (
          <span
            className="column-filter-indicator"
            title={`${column.title} is filtered`}
            aria-label={`${column.title} is filtered`}
          >
            <Icon name="filter" size={12} />
          </span>
        )}
        {/*
          QUICK SORT, monday-style: the control is always here, not conditional
          on the column already being sorted.

          At rest on an unsorted column it is invisible (CSS, on hover and
          focus-within) so 26 headers do not turn into 26 buttons; the moment a
          column IS sorted its arrow stays put.

          It drives the SAME `onSort` the `...` menu calls, so there is one sort
          state and the two controls cannot disagree. First click sorts
          ascending, the next reverses — `sortDirection` is the board's, not a
          second copy kept in here. Clicking REPLACES the sort rather than
          adding to it, because the common case is one column; the menu's "add
          as a tie-breaker" is the deliberate way to build a subsort.
        */}
        <button
          className={`column-sort-indicator${sortDirection ? " is-active" : ""}`}
          type="button"
          title={
            sortDirection
              ? `Sorted ${sortDirection === "asc" ? "ascending" : "descending"} — click to reverse`
              : `Sort ${column.title} ascending`
          }
          aria-label={
            sortDirection === "asc"
              ? `Sort ${column.title} descending`
              : `Sort ${column.title} ascending`
          }
          onClick={() => onSort(sortDirection === "asc" ? "desc" : "asc")}
        >
          <Icon
            name={
              sortDirection === "asc"
                ? "sortAsc"
                : sortDirection === "desc"
                  ? "sortDesc"
                  : "sortNone"
            }
            size={13}
          />
          {sortRank !== null && (
            <span className="column-sort-rank" aria-hidden="true">
              {sortRank}
            </span>
          )}
        </button>
        <button
          className="custom-column-header__more"
          type="button"
          aria-label={`Actions for ${column.title}`}
          onClick={onMenuToggle}
        >
          <Icon name="more" size={15} />
        </button>
        {menuOpen && (
          <div className="custom-column-menu">
            <small>{kind === "system" ? "Board" : definition.label} column</small>
            {onConfigure && (
              <button type="button" onClick={onConfigure}>
                <Icon name="settings" size={15} />
                {columnSettingsActionLabel(column.type)}
              </button>
            )}
            <button type="button" onClick={onRename}>
              <Icon name="settings" size={15} />
              Rename column
            </button>
            <button type="button" onClick={onToggleWrap}>
              <Icon name="list" size={15} />
              {column.settings.wrap ? "Unwrap text" : "Wrap text"}
            </button>
            <button type="button" onClick={() => onSort("asc")}>
              <Icon name="sortAsc" size={15} />
              Sort ascending
            </button>
            <button type="button" onClick={() => onSort("desc")}>
              <Icon name="sortDesc" size={15} />
              Sort descending
            </button>
            {/*
              The deliberate multi-sort action. Separate from the two above so a
              quick sort stays a quick sort: adding silently would leave an
              operator with an ordering they did not ask for and no obvious way
              back to one column.
            */}
            <button type="button" onClick={() => onAddSort("asc")}>
              <Icon name="activity" size={15} />
              {sortDirection ? "Change this sort rule" : "Add as a tie-breaker"}
            </button>
            <button type="button" onClick={onFilter}>
              <Icon name="filter" size={15} />
              {filtered ? "Edit this column's filter" : "Filter this column"}
            </button>
            <button type="button" onClick={onTogglePin}>
              <Icon name="grid" size={15} />
              {pinned ? "Unfreeze column" : "Freeze column to the left"}
            </button>
            <button type="button" disabled={!canMoveLeft} onClick={() => onMove(-1)}>
              <Icon name="arrow" size={15} />
              Move column left
            </button>
            <button type="button" disabled={!canMoveRight} onClick={() => onMove(1)}>
              <Icon name="arrow" size={15} />
              Move column right
            </button>
            {summaries.length > 0 && (
              <label className="custom-column-menu__type">
                <span>
                  <Icon name="chart" size={15} />
                  Summarise by
                </span>
                <select
                  value={column.summary ?? ""}
                  onChange={(event) => onSummary(event.target.value)}
                >
                  <option value="">Default for this column</option>
                  {summaries.map((summary) => (
                    <option key={summary} value={summary}>
                      {SUMMARY_LABELS[summary] ?? summary}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" onClick={onAddRight}>
              <Icon name="plus" size={15} />
              Add column to the right
            </button>
            {onDuplicate && (
              <button type="button" onClick={onDuplicate}>
                <Icon name="grid" size={15} />
                Duplicate column
              </button>
            )}
            {onClear && (
              <button type="button" onClick={onClear}>
                <Icon name="close" size={15} />
                Clear column
              </button>
            )}
            <button type="button" onClick={onCollapse}>
              <Icon name="chevron" size={15} />
              {collapsed ? "Expand column" : "Collapse column"}
            </button>
            <button type="button" onClick={onGroupBy}>
              <Icon name="grid" size={15} />
              {groupedByThis ? "Stop grouping by this" : "Group by this column"}
            </button>
            {onChangeType && (
              <label className="custom-column-menu__type">
                <span>
                  <Icon name="settings" size={15} />
                  Change column type
                </span>
                <select
                  value={column.type}
                  onChange={(event) =>
                    onChangeType(event.target.value as BoardColumnType)
                  }
                >
                  {columnTypeDefinitions.map((item) => (
                    <option key={item.type} value={item.type}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" onClick={onHide}>
              <Icon name="list" size={15} />
              Hide column
            </button>
            {onDelete && (
              <button className="is-danger" type="button" onClick={onDelete}>
                <Icon name="close" size={15} />
                Delete column
              </button>
            )}
          </div>
        )}
        <ColumnResizeHandle
          column={column}
          displayedWidth={displayedWidth}
          minimum={systemKey === "name" ? (mobile ? 150 : 220) : 90}
          onPreview={onResizePreview}
          onCommit={onResizeCommit}
        />
      </div>
    </th>
  );
}

function ColumnResizeHandle({
  column,
  displayedWidth,
  minimum,
  onPreview,
  onCommit,
}: {
  column: MaintenanceBoardColumn;
  displayedWidth: number;
  minimum: number;
  onPreview: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = displayedWidth;
    let latestWidth = startWidth;
    document.body.classList.add("is-resizing-board-column");
    const move = (moveEvent: PointerEvent) => {
      latestWidth = Math.max(
        minimum,
        Math.min(600, Math.round(startWidth + moveEvent.clientX - startX)),
      );
      onPreview(latestWidth);
    };
    const finish = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-board-column");
      if (latestWidth !== startWidth) onCommit(latestWidth);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish, { once: true });
    document.addEventListener("pointercancel", finish, { once: true });
  };
  return (
    <button
      className="column-resize-handle"
      type="button"
      aria-label={`Resize ${column.title} column`}
      title="Resize column"
      onPointerDown={startResize}
    />
  );
}
