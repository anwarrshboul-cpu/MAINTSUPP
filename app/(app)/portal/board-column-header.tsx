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
 *   · REORDER is a POINTER DRAG ON THE CELL, with a movement threshold. It was
 *     `draggable` on the title, which never fired: the title is an absolutely
 *     positioned centring overlay with `pointer-events: none` — see the note in
 *     board-column-drag.ts — so it could not receive the `mousedown` a drag
 *     begins with.
 *
 *     THE WHOLE CELL IS THE GRAB AREA, THE SORT ARROW AND THE `…` INCLUDED.
 *     Excluding them was tried and is wrong: they sit at the right of a flex row
 *     with `margin-left: auto`, so on a 127px column they cover the middle of
 *     the header — measured, a press at the exact centre of "Tier Level" landed
 *     on the sort arrow. A drag surface with a hole in the middle of it is not
 *     one a person can use. So a press on either button still starts a drag, and
 *     a drag that actually happens swallows the click that would have followed;
 *     a press that does not move is a click and does exactly what the button
 *     says. Only the RESIZE HANDLE and an open MENU are excluded, because both
 *     already own the horizontal drag gesture themselves;
 *   · the MENU is the keyboard and touch route to everything drag offers, so
 *     "move left" and "move right" are listed there rather than drag being the
 *     only way to reorder a board.
 */

import {
  useContext,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
import { AnchoredPopover } from "./overlay/anchored";

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
  /** True while this column is the one being dragged. */
  dragging: boolean;
  /** Which edge of this header the drop indicator sits on, if any. */
  dropSide: "before" | "after" | null;
  onMenuToggle: () => void;
  /** Closes the menu outright — the popover's dismissal, not a toggle. */
  onMenuClose: () => void;
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
  /**
   * The whole pointer sequence for a header drag.
   *
   * All four land on the CELL because that is what takes the pointer capture:
   * once captured, every later move and the release are dispatched here even
   * when the pointer is over a different column, which is what lets a drag
   * cross the board. The board decides whether a press becomes a drag — only it
   * can see the other columns.
   */
  onColumnPointerDown: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  onColumnPointerMove: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  onColumnPointerUp: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  onColumnPointerCancel: (event: ReactPointerEvent<HTMLTableCellElement>) => void;
  /** Swallows the click that follows a completed drag. See the cell below. */
  onColumnClickCapture: (event: ReactMouseEvent<HTMLTableCellElement>) => void;
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
  dragging,
  dropSide,
  onMenuToggle,
  onMenuClose,
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
  onColumnPointerDown,
  onColumnPointerMove,
  onColumnPointerUp,
  onColumnPointerCancel,
  onColumnClickCapture,
}: ColumnHeaderProps) {
  /* The "…" the options menu hangs off — measured live by the popover. */
  const moreRef = useRef<HTMLButtonElement | null>(null);
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
        dragging ? "is-column-dragging" : "",
        dropSide === "before" ? "is-column-drop-before" : "",
        dropSide === "after" ? "is-column-drop-after" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      /* The drag measures the headers in this row to work out which gap the
         pointer is over, and it finds them by this attribute. */
      data-column-id={column.id}
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
      onPointerDown={onColumnPointerDown}
      onPointerMove={onColumnPointerMove}
      onPointerUp={onColumnPointerUp}
      onPointerCancel={onColumnPointerCancel}
      /*
       * Capture, so it runs before the sort arrow's or the menu button's own
       * handler. A drag that began on one of them ends with a `click` the
       * browser dispatches anyway; this is where that click is swallowed. A
       * press that never became a drag leaves the flag clear and the click
       * through, which is what keeps a plain click on the arrow a plain sort.
       */
      onClickCapture={onColumnClickCapture}
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
        {/*
          NOT the drag handle, and it cannot be: this element is absolutely
          positioned across the cell with `pointer-events: none` so the label
          stays centred without swallowing the controls beneath it. The cell
          above carries the drag. See board-column-drag.ts.
        */}
        <strong title={`${column.title} — drag the header to move this column`}>
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
          ref={moreRef}
          className="custom-column-header__more"
          type="button"
          aria-label={`Actions for ${column.title}`}
          aria-expanded={menuOpen}
          onClick={onMenuToggle}
        >
          <Icon name="more" size={15} />
        </button>
        {/*
          On the shared layer (overlay/anchored.tsx): portalled, anchored to the
          "…" button's live rect, flipped and clamped inside the viewport — the
          old absolute box ran 85px past a 768px-tall window on the last rows.
          The popover's own dismissal (Escape, outside press) calls `onMenuClose`,
          which sets the board's menu state to null — idempotent, so it cannot
          race the board's own outside-press closer the way a toggle would
          (close + toggle = reopened). The layer host carries
          `data-board-popover`, so a press inside the menu is "inside" to both.
        */}
        <AnchoredPopover
          open={menuOpen}
          anchorRef={moreRef}
          onClose={onMenuClose}
          placement="bottom-end"
          role="dialog"
          label={`Options for ${column.title}`}
        >
          <div className="custom-column-menu" data-column-drag-ignore>
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
        </AnchoredPopover>
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
      data-column-drag-ignore
      aria-label={`Resize ${column.title} column`}
      title="Resize column"
      onPointerDown={startResize}
    />
  );
}
