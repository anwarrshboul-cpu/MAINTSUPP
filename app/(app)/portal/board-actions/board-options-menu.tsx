"use client";

/**
 * The board's ⋯ menu — "Board options" — with its three submenus.
 *
 * Every item either goes to a screen that exists, opens a surface this batch
 * built, or is disabled WITH ITS REASON. Nothing is listed that the product
 * cannot do: there is no board-level archive or delete, so those two say so
 * rather than opening a confirmation for an action that would not happen;
 * Power-Ups, AI suggestions, Convert to project, templates and reports are
 * not listed at all.
 *
 * Submenus are their own `AnchoredPopover` on the `submenu` layer, anchored
 * to their parent item with `right-start` placement — the positioning hook
 * flips them to the left when the right edge of the viewport is close.
 * ArrowRight opens the focused parent's submenu, ArrowLeft closes it, and
 * Escape anywhere closes the lot.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { useCapability } from "../../../lib/client-capabilities";
import { AnchoredPopover } from "../overlay/anchored";
import { ActionIcon, type ActionIconName } from "./board-icons";
import { BOARD_ROUTES, navigateTo } from "./board-link";

type Item = {
  key: string;
  label: string;
  icon: ActionIconName;
  onSelect?: () => void;
  disabled?: boolean;
  reason?: string;
  destructive?: boolean;
  submenu?: Item[];
};

/** The items that open a submenu, and so need an anchor. */
const SUBMENU_KEYS = ["settings", "more", "view-archive"];

/** The whole board as CSV — `POST /api/board/csv` with no row list means every row. */
async function exportWholeBoard(boardId: string) {
  const response = await fetch("/api/board/csv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ board: boardId }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || "The board could not be exported.");
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  const disposition = response.headers.get("content-disposition");
  link.download = /filename="([^"]+)"/.exec(disposition ?? "")?.[1] ?? `maintsupp-${boardId}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

/**
 * Opens the portal's notifications panel.
 *
 * The panel and its button live in `portal-app.tsx`, which this batch does
 * not edit, so two routes are taken: a `maintsupp:open-notifications` event
 * for the listener that file carries, and — for any screen that has the
 * button but not the listener — a press on the top bar's own Notifications
 * button, found by the accessible name it already carries.
 *
 * THE TWO ROUTES MUST NOT BOTH RUN. The listener does `setOpen(true)`; the
 * button's own handler TOGGLES (`setOpen((open) => !open)`). Fired in the
 * same tick, React applies them in order against one state — true, then
 * !true — and the panel is opened and shut again in a single batch, which
 * is exactly the "the item does nothing" defect this replaces. So the event
 * goes first, and the button is pressed on the NEXT macrotask only if the
 * panel is still shut, which `aria-expanded` reports honestly.
 */
function openNotifications(): boolean {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]")).find((node) =>
    /^Notifications\b/.test(node.getAttribute("aria-label") ?? ""),
  );
  window.dispatchEvent(new Event("maintsupp:open-notifications"));
  if (!button) return false;
  window.setTimeout(() => {
    if (button.getAttribute("aria-expanded") !== "true") button.click();
  }, 0);
  return true;
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
  } else {
    void document.documentElement.requestFullscreen?.();
  }
}

function MenuItem({
  item,
  onActivate,
  submenuOpen,
  onOpenSubmenu,
  anchorRef,
}: {
  item: Item;
  onActivate: (item: Item) => void;
  submenuOpen: boolean;
  onOpenSubmenu: (key: string | null) => void;
  anchorRef?: (node: HTMLButtonElement | null) => void;
}) {
  const disabled = Boolean(item.disabled);
  return (
    <>
      <button
        type="button"
        role="menuitem"
        ref={anchorRef}
        className={`ba-menu__item${item.destructive ? " is-destructive" : ""}`}
        aria-disabled={disabled || undefined}
        aria-haspopup={item.submenu ? "menu" : undefined}
        aria-expanded={item.submenu ? submenuOpen : undefined}
        data-menu-key={item.key}
        title={disabled ? item.reason : undefined}
        onClick={() => {
          if (disabled) return;
          if (item.submenu) onOpenSubmenu(submenuOpen ? null : item.key);
          else onActivate(item);
        }}
        onKeyDown={(event) => {
          if (item.submenu && event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            onOpenSubmenu(item.key);
          }
        }}
        onMouseEnter={() => {
          if (item.submenu && !disabled) onOpenSubmenu(item.key);
        }}
      >
        <ActionIcon name={item.icon} size={16} />
        <span>{item.label}</span>
        {item.submenu && <ActionIcon name="chevron-right" size={14} />}
      </button>
      {disabled && item.reason && <small className="ba-menu__reason">{item.reason}</small>}
    </>
  );
}

function Submenu({
  parent,
  anchorRef,
  open,
  onClose,
  onActivate,
}: {
  parent: Item;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  onActivate: (item: Item) => void;
}) {
  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      layer="submenu"
      placement="right-start"
      offset={2}
      label={parent.label}
      restoreFocus
    >
      <div
        className="ba-menu ba-menu--sub"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="ba-menu__title">{parent.label}</div>
        {(parent.submenu ?? []).map((item) => (
          <MenuItem key={item.key} item={item} onActivate={onActivate} submenuOpen={false} onOpenSubmenu={() => undefined} />
        ))}
      </div>
    </AnchoredPopover>
  );
}

export function BoardOptionsMenu({
  open,
  anchorRef,
  onClose,
  boardId,
  boardName,
  canEditSettings,
  onDiscussion,
  onRename,
  onTerminology,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  boardId: string;
  boardName: string;
  canEditSettings: boolean | null;
  onDiscussion: () => void;
  onRename: () => void;
  onTerminology: () => void;
}) {
  const [submenu, setSubmenu] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /*
   * One stable RefObject per menu item, for the submenu to anchor to. A Map
   * made once with useMemo rather than a ref holding a Map, because the map
   * is read during render to hand the right object to the right item and a
   * ref's `.current` is not for reading in render.
   */
  const itemRefs = useMemo(
    () => new Map<string, RefObject<HTMLButtonElement | null>>(SUBMENU_KEYS.map((key) => [key, { current: null }])),
    [],
  );
  const refFor = (key: string): RefObject<HTMLButtonElement | null> => itemRefs.get(key) ?? { current: null };
  const canReadAudit = useCapability("audit.read");
  const canEditRoles = useCapability("roles.edit");
  const canExport = useCapability("data.export");

  // Forget the open submenu and any notice once the menu has closed — on a
  // later tick, the way portal-app.tsx defers its own resets.
  useEffect(() => {
    if (open) return undefined;
    const timer = window.setTimeout(() => {
      setSubmenu(null);
      setNotice(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const closeAll = useCallback(() => {
    setSubmenu(null);
    onClose();
  }, [onClose]);

  const activate = useCallback(
    (item: Item) => {
      if (!item.onSelect) return;
      item.onSelect();
    },
    [],
  );

  const settingsReason =
    canEditSettings === false ? "Only roles with the settings.edit permission can change board settings." : undefined;

  const items: Item[] = [
    {
      key: "activity",
      label: "Activity log",
      icon: "activity",
      disabled: canReadAudit === false,
      reason: canReadAudit === false ? "Your role cannot read the activity log (audit.read)." : undefined,
      onSelect: () => navigateTo(BOARD_ROUTES.activityLog),
    },
    { key: "discussion", label: "Discussion", icon: "bubble", onSelect: () => { closeAll(); onDiscussion(); } },
    {
      key: "notifications",
      label: "Notifications",
      icon: "bell",
      onSelect: () => {
        closeAll();
        if (!openNotifications()) setNotice("The notifications panel is not on this screen.");
      },
    },
    {
      key: "permissions",
      label: "Permissions",
      icon: "shield",
      disabled: canEditRoles === false,
      reason: canEditRoles === false ? "Only roles with the roles.edit permission can open the capability matrix." : undefined,
      onSelect: () => navigateTo(BOARD_ROUTES.permissions),
    },
    {
      key: "settings",
      label: "Settings",
      icon: "settings",
      submenu: [
        { key: "rename", label: "Rename board", icon: "edit", disabled: canEditSettings === false, reason: settingsReason, onSelect: () => { closeAll(); onRename(); } },
        { key: "terminology", label: "Change item terminology", icon: "text", disabled: canEditSettings === false, reason: settingsReason, onSelect: () => { closeAll(); onTerminology(); } },
        { key: "archived-history", label: "Archived history", icon: "archive", onSelect: () => navigateTo(BOARD_ROUTES.archive) },
      ],
    },
    {
      key: "more",
      label: "More actions",
      icon: "more",
      submenu: [
        {
          key: "export",
          label: "Export board",
          icon: "export",
          disabled: canExport === false,
          reason: canExport === false ? "Your role cannot export (data.export)." : undefined,
          onSelect: () => {
            closeAll();
            void exportWholeBoard(boardId).catch((cause) => {
              window.alert(cause instanceof Error ? cause.message : "The board could not be exported.");
            });
          },
        },
        { key: "import", label: "Import items", icon: "import", onSelect: () => navigateTo(BOARD_ROUTES.importItems) },
        {
          key: "fullscreen",
          label: fullscreen ? "Exit full screen" : "Full screen",
          icon: "fullscreen",
          onSelect: () => {
            closeAll();
            toggleFullscreen();
          },
        },
      ],
    },
    {
      key: "archive-board",
      label: "Archive board",
      icon: "archive",
      disabled: true,
      reason: "Boards cannot be archived in this product. Items can — from the item menu or an automation.",
    },
    {
      key: "delete-board",
      label: "Delete board",
      icon: "trash",
      destructive: true,
      disabled: true,
      reason: "Boards cannot be deleted in this product. Items go to the recycle bin instead.",
    },
    {
      key: "view-archive",
      label: "View archive / trash",
      icon: "trash",
      submenu: [
        { key: "archive", label: "Archive", icon: "archive", onSelect: () => navigateTo(BOARD_ROUTES.archive) },
        { key: "trash", label: "Trash", icon: "trash", onSelect: () => navigateTo(BOARD_ROUTES.trash) },
      ],
    },
  ];

  const parent = items.find((item) => item.key === submenu) ?? null;

  return (
    <>
      <AnchoredPopover open={open} anchorRef={anchorRef} onClose={closeAll} placement="bottom-end" label="Board options" className="ba-options">
        <div
          className="ba-menu ba-menu--board"
          onKeyDown={(event) => {
            // ArrowLeft closes an open submenu from wherever focus is — the
            // parent item, if the submenu has not taken focus yet, included.
            if (event.key === "ArrowLeft" && submenu) {
              event.preventDefault();
              setSubmenu(null);
            }
          }}
        >
          <div className="ba-menu__title">
            Board options <span className="ba-menu__board">{boardName}</span>
          </div>
          {items.map((item) => (
            <Wrap key={item.key} separatorBefore={item.key === "settings" || item.key === "archive-board"}>
              <MenuItem
                item={item}
                onActivate={activate}
                submenuOpen={submenu === item.key}
                onOpenSubmenu={setSubmenu}
                anchorRef={(node) => {
                  refFor(item.key).current = node;
                }}
              />
            </Wrap>
          ))}
          {notice && (
            <p className="ba-hint" role="status">
              {notice}
            </p>
          )}
        </div>
      </AnchoredPopover>
      {parent && (
        <Submenu
          // Keyed so moving from one submenu to another remounts the popover,
          // which is what puts focus on the new submenu's first item.
          key={parent.key}
          parent={parent}
          anchorRef={refFor(parent.key)}
          open={open && submenu === parent.key}
          onClose={() => setSubmenu(null)}
          onActivate={activate}
        />
      )}
    </>
  );
}

function Wrap({ separatorBefore, children }: { separatorBefore: boolean; children: ReactNode }) {
  return (
    <>
      {separatorBefore && <div className="ba-menu__sep" />}
      {children}
    </>
  );
}
