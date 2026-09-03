"use client";

/**
 * The three menus on the view strip — a tab's own "…", the "All" jump list
 * and the "+" add-a-view list — drawn through `AnchoredPopover` so they sit
 * on the shared layer like every other menu on the board.
 *
 * They were `position: absolute` children of the strip (`.board-views__menu`),
 * which the strip's own `overflow-x: auto` and the chrome's `position: sticky`
 * could clip. Anchored to the button that opened them and positioned in
 * viewport coordinates, they flip and clamp like the rest. The strip's
 * wrappers still carry `data-board-popover`, and so does the layer host, so
 * `useDismissOnOutside` in board-chrome treats a press in a menu as inside.
 *
 * Kept out of `board-chrome.tsx`, which is held to 500 lines.
 */

import type { RefObject } from "react";
import { Icon } from "../../../components";
import { iconFor } from "../board-tab-glyph";
import { AnchoredPopover } from "../overlay/anchored";

type MenuView = { id: string; key: string; name: string; system: boolean };
type MenuType = { key: string; label: string; icon: string; built: boolean };

export function ViewTabMenu({
  view,
  open,
  anchorRef,
  onClose,
  onRename,
  onSetDefault,
  onSetLanding,
  onDelete,
}: {
  view: MenuView;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onRename: () => void;
  onSetDefault: () => void;
  onSetLanding: () => void;
  onDelete: () => void;
}) {
  return (
    <AnchoredPopover open={open} anchorRef={anchorRef} onClose={onClose} placement="bottom-end" label={`Options for ${view.name}`}>
      <div className="ba-menu ba-menu--views">
        <button type="button" role="menuitem" className="ba-menu__item" onClick={onRename}>
          <span>Rename</span>
        </button>
        <button type="button" role="menuitem" className="ba-menu__item" onClick={onSetDefault}>
          <span>Set as default</span>
        </button>
        {/* monday distinguishes the two: the board's default, and the view
            everyone lands on in THIS section. The second is what an owner
            adding a section actually wants. */}
        <button type="button" role="menuitem" className="ba-menu__item" onClick={onSetLanding}>
          <span>Set as the view everyone lands on</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="ba-menu__item is-destructive"
          disabled={view.system}
          aria-disabled={view.system || undefined}
          title={view.system ? "The main table cannot be removed" : undefined}
          onClick={onDelete}
        >
          <span>Delete</span>
        </button>
      </div>
    </AnchoredPopover>
  );
}

export function ViewOverflowMenu({
  views,
  open,
  anchorRef,
  onClose,
  onPick,
}: {
  views: MenuView[];
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onPick: (view: MenuView) => void;
}) {
  return (
    <AnchoredPopover open={open} anchorRef={anchorRef} onClose={onClose} placement="bottom-end" label="All views">
      <div className="ba-menu ba-menu--views">
        {views.map((view) => (
          <button key={view.id} type="button" role="menuitem" className="ba-menu__item" onClick={() => onPick(view)}>
            <span>{view.name}</span>
          </button>
        ))}
      </div>
    </AnchoredPopover>
  );
}

export function AddViewMenu({
  types,
  open,
  anchorRef,
  onClose,
  onAdd,
}: {
  types: MenuType[];
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onAdd: (type: MenuType) => void;
}) {
  return (
    <AnchoredPopover open={open} anchorRef={anchorRef} onClose={onClose} placement="bottom-end" label="Add a view">
      <div className="ba-menu ba-menu--views">
        {/*
          AN ENTRY THAT CANNOT MAKE A WORKING VIEW IS DISABLED, NOT CLICKABLE.

          Every type was offered as a live choice with a "soon" tag beside the
          unbuilt ones, so picking Timeline wrote a real `board_views` row, drew
          a real tab and opened a panel reading "Timeline is not built yet" —
          a clickable no-op that left a dead tab on the board somebody then had
          to find and delete. The tag stays, because hiding the type would say
          the product has no plans for it; what goes is the click.
          `POST /api/board/views` refuses the same types with a 409, so this is
          the courtesy and the route is the rule.
        */}
        {types.map((type) => (
          <button
            key={type.key}
            type="button"
            role="menuitem"
            className="ba-menu__item"
            disabled={!type.built}
            aria-disabled={type.built ? undefined : true}
            title={type.built ? undefined : `${type.label} is not built yet`}
            onClick={() => onAdd(type)}
          >
            <Icon name={iconFor(type.icon)} size={15} />
            <span>{type.label}</span>
            {!type.built && <em className="board-views__soon">soon</em>}
          </button>
        ))}
      </div>
    </AnchoredPopover>
  );
}
