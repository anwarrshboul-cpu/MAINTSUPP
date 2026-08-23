"use client";

/**
 * A group's "…" menu, on the shared anchored popover.
 *
 * Moved out of `live-board.tsx` — which `stage-eight-board-split` holds under
 * 6,000 lines — when the menu moved from an absolute child of the group
 * header to the portalled layer in overlay/anchored.tsx. Nothing about its
 * entries changed: every button calls the board's own handler through a prop,
 * and the board still decides what each one does. What changed is WHERE it
 * paints: in viewport coordinates, flipped above the trigger when there is no
 * room below, never under the toolbar or the "+ Add new group" bar, and never
 * sliced by a deferred group's paint containment.
 */

import type { CSSProperties, RefObject } from "react";
import { Icon } from "../../../components";
import type { MaintenanceGroup } from "../../../lib/types";
import { AnchoredPopover } from "./anchored";

export function GroupActionMenu({
  open,
  anchorRef,
  onClose,
  group,
  rowCount,
  colors,
  isCollapsed,
  allCollapsed,
  isFirst,
  isLast,
  storeDocumentation,
  canExport,
  canDelete,
  saving,
  busy,
  addItemLabel,
  onToggleCollapse,
  onToggleCollapseAll,
  onSelectAll,
  onRename,
  onDuplicate,
  onAddGroup,
  onColor,
  onSort,
  onMoveGroup,
  onExport,
  onAddItem,
  onApps,
  onArchiveItems,
  onDelete,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  group: MaintenanceGroup;
  rowCount: number;
  colors: readonly string[];
  isCollapsed: boolean;
  allCollapsed: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** Store Documentation groups are fixed: no rename, colour, sort or move. */
  storeDocumentation: boolean;
  canExport: boolean;
  canDelete: boolean;
  saving: boolean;
  busy: boolean;
  addItemLabel: string;
  onToggleCollapse: () => void;
  onToggleCollapseAll: () => void;
  onSelectAll: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onAddGroup: () => void;
  onColor: (color: string) => void;
  onSort: (order: "alphabetical" | "newest") => void;
  onMoveGroup: (direction: "up" | "down") => void;
  onExport: () => void;
  onAddItem: () => void;
  onApps: () => void;
  onArchiveItems: () => void;
  onDelete: () => void;
}) {
  // Every entry closes the menu first, then acts — as the row menu does.
  const act = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      placement="bottom-start"
      label={`Actions for ${group.name}`}
    >
      <div className="sheet-group__menu" data-board-drag-ignore>
        <button type="button" onClick={act(onToggleCollapse)}>
          <Icon name="chevron" size={15} />
          {isCollapsed ? "Expand group" : "Collapse group"}
        </button>
        <button type="button" onClick={act(onToggleCollapseAll)}>
          <Icon name="grid" size={15} />
          {allCollapsed ? "Expand all groups" : "Collapse all groups"}
        </button>
        <button type="button" onClick={act(onSelectAll)}>
          <Icon name="check" size={15} />
          Select all items in group
        </button>
        {!storeDocumentation && (
          <>
            <button type="button" onClick={act(onRename)}>
              <Icon name="settings" size={15} />
              Rename group
            </button>
            <button type="button" disabled={saving} onClick={() => onDuplicate()}>
              <Icon name="grid" size={15} />
              Copy group and items
            </button>
            <button type="button" onClick={act(onAddGroup)}>
              <Icon name="plus" size={15} />
              Add group
            </button>
            <div className="sheet-group__colors">
              <span>Group color</span>
              <div>
                {colors.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Use ${color} for ${group.name}`}
                    aria-pressed={group.color === color}
                    style={{ "--group-choice": color } as CSSProperties}
                    onClick={() => onColor(color)}
                  />
                ))}
              </div>
            </div>
            <button type="button" onClick={() => onSort("alphabetical")}>
              <Icon name="activity" size={15} />
              Sort items A–Z
            </button>
            <button type="button" onClick={() => onSort("newest")}>
              <Icon name="activity" size={15} />
              Sort newest first
            </button>
            <button type="button" disabled={isFirst} onClick={() => onMoveGroup("up")}>
              <Icon name="arrow" size={15} />
              Move group up
            </button>
            <button type="button" disabled={isLast} onClick={() => onMoveGroup("down")}>
              <Icon name="arrow" size={15} />
              Move group down
            </button>
          </>
        )}
        {canExport && (
          <button type="button" onClick={act(onExport)}>
            <Icon name="download" size={15} />
            Export group
          </button>
        )}
        <button type="button" onClick={act(onAddItem)}>
          <Icon name="plus" size={15} />
          {addItemLabel}
        </button>
        <button type="button" onClick={act(onApps)}>
          <Icon name="settings" size={15} />
          Apps
        </button>
        <button
          type="button"
          disabled={rowCount === 0 || busy}
          onClick={act(onArchiveItems)}
        >
          <Icon name="folder" size={15} />
          Archive group items
        </button>
        <button
          className="is-danger"
          type="button"
          disabled={!canDelete}
          onClick={() => onDelete()}
        >
          <Icon name="close" size={15} />
          Delete group
        </button>
      </div>
    </AnchoredPopover>
  );
}
