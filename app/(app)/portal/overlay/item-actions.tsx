"use client";

/**
 * An item's actions, reachable from the item itself.
 *
 * monday's item screen keeps the item verbs behind a vertical "⋮" at the top
 * right, beside Close. The board's row menu offers the same verbs from a "…"
 * in the row gutter, which a phone has no room for — so on a phone the gutter
 * trigger is gone (see the 760px rules in globals.css) and the verbs live
 * here instead. RELOCATED, not dropped: every entry below calls the SAME
 * handler the row menu calls, which `live-board.tsx` publishes through
 * `buildBoardItemActions` so nothing here talks to `/api/board` on its own or
 * mutates a private copy of the board.
 */

import { useRef, useState } from "react";
import { Icon } from "../../../components";
import type { MaintenanceGroup, MaintenanceRequest } from "../../../lib/types";
import { AnchoredPopover } from "./anchored";

/**
 * What the board hands over. Read through a getter on every call, because the
 * board's handlers are closures over its latest state and are rebuilt on every
 * render — the facade is published once, the sources are refreshed each time.
 */
export type BoardItemActionSources = {
  groups: MaintenanceGroup[];
  storeDocumentation: boolean;
  groupIdFor: (request: MaintenanceRequest) => string;
  groupRows: (groupId: string) => MaintenanceRequest[];
  subitemCount: (requestId: string) => number;
  openItemInNewTab: (request: MaintenanceRequest) => void;
  copyItemLink: (request: MaintenanceRequest) => Promise<void>;
  createItemBelow: (request: MaintenanceRequest, groupId: string) => Promise<void>;
  addSubitem: (parent: MaintenanceRequest, title: string) => Promise<void>;
  convertToSubitem: (request: MaintenanceRequest, groupId: string) => Promise<void>;
  moveItem: (request: MaintenanceRequest, groupId: string) => Promise<void>;
  runBulkAction: (
    action: "duplicate_items" | "archive_items" | "delete_items",
    requestIds: string[],
  ) => Promise<void>;
};

/** The board's item verbs, as the drawer sees them. */
export type BoardItemActions = {
  boardId: string;
  groups: () => MaintenanceGroup[];
  groupIdFor: (request: MaintenanceRequest) => string | null;
  /** Subitems are a Jobs-board concept; a store has none. */
  supportsSubitems: boolean;
  canConvertToSubitem: (request: MaintenanceRequest) => boolean;
  openInNewTab: (request: MaintenanceRequest) => void;
  copyLink: (request: MaintenanceRequest) => Promise<void>;
  duplicate: (request: MaintenanceRequest) => Promise<void>;
  createBelow: (request: MaintenanceRequest) => Promise<void>;
  addSubitem: (request: MaintenanceRequest, title: string) => Promise<void>;
  convertToSubitem: (request: MaintenanceRequest) => Promise<void>;
  moveToGroup: (request: MaintenanceRequest, groupId: string) => Promise<void>;
  archive: (request: MaintenanceRequest) => Promise<void>;
  remove: (request: MaintenanceRequest) => Promise<void>;
};

const NO_SOURCES = () => Promise.resolve();

/**
 * One stable facade over the board's ever-changing closures. `read` returns
 * the latest sources, or null before the board has rendered once.
 */
export function buildBoardItemActions(
  boardId: string,
  read: () => BoardItemActionSources | null,
): BoardItemActions {
  const groupIdFor = (request: MaintenanceRequest) =>
    read()?.groupIdFor(request) ?? null;
  return {
    boardId,
    groups: () => read()?.groups ?? [],
    groupIdFor,
    supportsSubitems: !(read()?.storeDocumentation ?? boardId === "store-documentation"),
    canConvertToSubitem: (request) => {
      const sources = read();
      if (!sources || sources.storeDocumentation) return false;
      const rows = sources.groupRows(sources.groupIdFor(request));
      const index = rows.findIndex((entry) => entry.id === request.id);
      return index > 0 && sources.subitemCount(request.id) === 0;
    },
    openInNewTab: (request) => read()?.openItemInNewTab(request),
    copyLink: (request) => read()?.copyItemLink(request) ?? NO_SOURCES(),
    duplicate: (request) =>
      read()?.runBulkAction("duplicate_items", [request.id]) ?? NO_SOURCES(),
    createBelow: (request) => {
      const sources = read();
      return sources
        ? sources.createItemBelow(request, sources.groupIdFor(request))
        : NO_SOURCES();
    },
    addSubitem: (request, title) => read()?.addSubitem(request, title) ?? NO_SOURCES(),
    convertToSubitem: (request) => {
      const sources = read();
      return sources
        ? sources.convertToSubitem(request, sources.groupIdFor(request))
        : NO_SOURCES();
    },
    moveToGroup: (request, groupId) =>
      read()?.moveItem(request, groupId) ?? NO_SOURCES(),
    archive: (request) =>
      read()?.runBulkAction("archive_items", [request.id]) ?? NO_SOURCES(),
    remove: (request) =>
      read()?.runBulkAction("delete_items", [request.id]) ?? NO_SOURCES(),
  };
}

/** monday's vertical kebab. `app/components.tsx` only has the horizontal one. */
export function KebabIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

/**
 * The "Move to" row the row menu and the drawer menu share: a menu item that
 * opens the groups as a submenu beside it.
 *
 * It used to be a <select> inside the menu. A select is a combobox, which a
 * `role="menu"` may not own (axe: aria-required-children), and the menu's
 * arrow keys had to step around it. A submenu is what monday does, and it is
 * the nested case the layer primitive exists for: it opens on the "submenu"
 * tier beside the item, flips to the other side at the right edge, and a
 * press inside it is not "outside" the menu that opened it.
 *
 * `layer` lets a menu that is itself raised (the drawer's "⋮", which must
 * out-rank the drawer) put its submenu on the same tier, where a later layer
 * paints above an earlier one.
 */
export function MoveToGroupSelect({
  label,
  groups,
  value,
  onChange,
  layer = "submenu",
}: {
  label: string;
  groups: MaintenanceGroup[];
  value: string;
  onChange: (groupId: string) => void;
  layer?: "submenu" | "popover-raised";
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="item-actions-menu__submenu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="arrow" size={15} />
        {label}
        <span className="item-actions-menu__submenu-caret" aria-hidden="true">
          ›
        </span>
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        placement="right-start"
        layer={layer}
        label={`${label} group`}
        className="item-actions-submenu"
      >
        <div className="sheet-row-menu item-actions-menu__groups" data-board-drag-ignore>
          {groups.map((group) => {
            const current = group.id === value;
            return (
              <button
                key={group.id}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                disabled={current}
                onClick={() => {
                  setOpen(false);
                  onChange(group.id);
                }}
              >
                <span
                  className="item-actions-menu__swatch"
                  style={{ background: group.color ?? undefined }}
                  aria-hidden="true"
                />
                {group.name}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </>
  );
}

/** Why "Convert to subitem" is, or is not, available — monday's wording. */
export function convertToSubitemTitle(can: boolean) {
  return can
    ? "Make this a child of the item above it"
    : "There is no item above this one to become its parent";
}

/**
 * The drawer's "⋮": a trigger and the menu it opens, carrying the row menu's
 * verbs for the item on screen. Shown wherever the drawer is — phone or
 * desktop — because the verbs belong to the item, not to the viewport.
 */
export function ItemActionsMenu({
  request,
  actions,
}: {
  request: MaintenanceRequest;
  actions: BoardItemActions;
}) {
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [subitemTitle, setSubitemTitle] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = () => {
    setOpen(false);
    setComposing(false);
    setSubitemTitle("");
  };
  const run = (action: () => void | Promise<void>) => {
    close();
    void action();
  };

  const groups = open ? actions.groups() : [];
  const currentGroupId = open ? (actions.groupIdFor(request) ?? "") : "";
  const canConvert = open && actions.canConvertToSubitem(request);

  return (
    <>
      <button
        ref={triggerRef}
        className="icon-button detail-drawer__more"
        type="button"
        aria-label={`Actions for ${request.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Item actions"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <KebabIcon />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onClose={close}
        placement="bottom-end"
        /* The drawer that holds the trigger is on the drawer tier; a menu
           opened from inside it has to out-rank the drawer or it is painted
           behind the drawer and its taps land on the drawer instead. */
        layer="popover-raised"
        label={`Actions for ${request.id}`}
      >
        <div className="sheet-row-menu item-actions-menu" data-board-drag-ignore>
          <button type="button" onClick={() => run(() => actions.openInNewTab(request))}>
            <Icon name="upload" size={15} />
            Open in new tab
          </button>
          <button type="button" onClick={() => run(() => actions.copyLink(request))}>
            <Icon name="paperclip" size={15} />
            Copy item link
          </button>
          <button type="button" onClick={() => run(() => actions.duplicate(request))}>
            <Icon name="grid" size={15} />
            Duplicate item
          </button>
          <button type="button" onClick={() => run(() => actions.createBelow(request))}>
            <Icon name="plus" size={15} />
            Create new item below
          </button>
          {actions.supportsSubitems && !composing && (
            <button type="button" onClick={() => setComposing(true)}>
              <Icon name="list" size={15} />
              Add subitem
            </button>
          )}
          {actions.supportsSubitems && composing && (
            <form
              className="item-actions-menu__add"
              onSubmit={(event) => {
                event.preventDefault();
                const title = subitemTitle.trim();
                if (!title) return;
                run(() => actions.addSubitem(request, title));
              }}
            >
              <input
                autoFocus
                aria-label="Subitem name"
                placeholder="Subitem name"
                value={subitemTitle}
                onChange={(event) => setSubitemTitle(event.target.value)}
              />
              <button type="submit" disabled={!subitemTitle.trim()}>
                Add
              </button>
            </form>
          )}
          {actions.supportsSubitems && (
            <button
              type="button"
              disabled={!canConvert}
              title={convertToSubitemTitle(canConvert)}
              onClick={() => run(() => actions.convertToSubitem(request))}
            >
              <Icon name="arrow" size={15} />
              Convert to subitem
            </button>
          )}
          <MoveToGroupSelect
            label="Move to"
            groups={groups}
            value={currentGroupId}
            layer="popover-raised"
            onChange={(groupId) => run(() => actions.moveToGroup(request, groupId))}
          />
          <button type="button" onClick={() => run(() => actions.archive(request))}>
            <Icon name="folder" size={15} />
            Archive item
          </button>
          <button
            className="is-danger"
            type="button"
            onClick={() => run(() => actions.remove(request))}
          >
            <Icon name="close" size={15} />
            Delete item
          </button>
        </div>
      </AnchoredPopover>
    </>
  );
}
