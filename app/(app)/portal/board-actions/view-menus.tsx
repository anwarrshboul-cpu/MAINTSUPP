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
type MenuType = {
  key: string;
  label: string;
  icon: string;
  built: boolean;
  /** See `ViewType.unavailable` in `../board-view-types.ts`. */
  unavailable?: string;
};

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
          THREE STATES, AND THE MIDDLE ONE IS THE POINT — owner §8/§26.

          Every type was once offered as a live choice with a "soon" tag beside
          the unbuilt ones, so picking Timeline wrote a real `board_views` row,
          drew a real tab and opened a panel reading "Timeline is not built
          yet" — a clickable no-op that left a dead tab on the board somebody
          then had to find and delete.

          The owner's rule sorts a type into one of three places, and this menu
          now shows all three:

            · SUPPORTED — clickable, and it makes a working view.
            · NOT SUPPORTED BY THE ORIGINAL — not in `types` at all. Timeline is
              gone from `VIEW_TYPES`, so there is no entry to grey out. "Must
              not be offered at all — not greyed, not a no-op."
            · REQUIRES CONFIGURATION — drawn WITH THE REASON, and not clickable
              until the reason is gone. A Form tab on a register with no form of
              its own is this: the product built the renderer, the board has not
              been set up for it, and once it is the same entry works. Hiding it
              would tell an operator the product cannot do something it does
              every day on the board next door; a bare greyed row with a "soon"
              pill would say it has not been written yet, which is untrue.

          The sentence is the SERVER's — `typesFor` in `app/api/board/views/
          route.ts` is its only author, and `POST` refuses the same type with
          the same words. This menu does not compose a reason of its own, so it
          cannot drift from the one the operator gets if they reach the endpoint
          another way.
        */}
        {types.map((type) => (
          <button
            key={type.key}
            type="button"
            role="menuitem"
            className={`ba-menu__item${type.unavailable ? " is-unconfigured" : ""}`}
            disabled={!type.built}
            aria-disabled={type.built ? undefined : true}
            title={type.built ? undefined : type.unavailable ?? `${type.label} is not built yet`}
            onClick={() => onAdd(type)}
          >
            <Icon name={iconFor(type.icon)} size={15} />
            <span>{type.label}</span>
            {!type.built && !type.unavailable && (
              <em className="board-views__soon">soon</em>
            )}
            {type.unavailable && <small>{type.unavailable}</small>}
          </button>
        ))}
      </div>
    </AnchoredPopover>
  );
}
