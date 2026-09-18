"use client";

/**
 * The three writes behind a board column's label editor: add, rename/recolour,
 * delete.
 *
 * Lifted out of `live-board.tsx` when Store Location Name was given the editor
 * the other option columns already had. They are pure network + state writers —
 * their only dependencies are the board they belong to, the setter for the
 * option list and the toast — so they are exactly the kind of thing that has no
 * business living inside a 5,600-line component, and the file has a hard size
 * ceiling that says so (`tests/stage-eight-board-split.test.mjs`, and the
 * tighter one in `tests/workstream-seven-official-document-ui.test.mjs`).
 *
 * WHY A FACTORY RATHER THAN A HOOK. Nothing here holds state of its own or
 * subscribes to anything; it closes over the three things it is given. A hook
 * would add a dependency array to get wrong for no benefit, and these are
 * called from event handlers rather than from render.
 *
 * THE SERVER DECIDES WHAT A RENAME MEANS. `update_option` is one action, and
 * `app/api/board/route.ts` routes it by the option's identity: a stored chip is
 * updated in `maintenance_board_options`, while a `site-option-…` id is the
 * site register's and is renamed there under `sites.edit`. That branch is
 * deliberately NOT mirrored here — a client that decides which table a write
 * lands in is a client that can be asked to decide wrongly.
 */

import type { BoardColumnOption, BoardOptionColumn } from "../../lib/types";

export type BoardOptionWriters = {
  createOption: (
    columnKey: BoardOptionColumn,
    label: string,
    color: string,
  ) => Promise<void>;
  updateOption: (
    optionId: string,
    changes: { label?: string; color?: string; active?: boolean },
  ) => Promise<void>;
  deleteOption: (optionId: string) => Promise<void>;
};

export function boardOptionWriters({
  boardUrl,
  setBoardOptions,
  onNotify,
}: {
  /** `/api/board`, already carrying this board's id. See `boardUrl` in live-board. */
  boardUrl: (path: string) => string;
  setBoardOptions: (
    update: (current: BoardColumnOption[]) => BoardColumnOption[],
  ) => void;
  onNotify: (message: string) => void;
}): BoardOptionWriters {
  return {
    createOption: async (columnKey, label, color) => {
      const response = await fetch(boardUrl("/api/board"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_option", columnKey, label, color }),
      });
      const payload = (await response.json()) as {
        option?: BoardColumnOption;
        error?: string;
      };
      if (!response.ok || !payload.option) {
        throw new Error(payload.error || "The label could not be created.");
      }
      const created = payload.option;
      setBoardOptions((current) => [...current, created]);
      onNotify(`${created.label} added.`);
    },

    updateOption: async (optionId, changes) => {
      const response = await fetch(boardUrl("/api/board"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_option", optionId, ...changes }),
      });
      const payload = (await response.json()) as {
        option?: BoardColumnOption;
        error?: string;
      };
      if (!response.ok || !payload.option) {
        throw new Error(payload.error || "The label could not be updated.");
      }
      const updated = payload.option;
      /*
       * Matched on the id the SERVER answered with, not the one that was sent.
       * Renaming a store location renames the site, and the option the board
       * draws for a site is `site-option-<site id>` — an id that is stable
       * across the rename precisely because it is the site's, not the label's.
       */
      setBoardOptions((current) =>
        current.map((option) => (option.id === updated.id ? updated : option)),
      );
      onNotify(`${updated.label} updated.`);
    },

    deleteOption: async (optionId) => {
      const response = await fetch(boardUrl("/api/board"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_option", optionId }),
      });
      const payload = (await response.json()) as {
        deleted?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.deleted) {
        throw new Error(payload.error || "The label could not be deleted.");
      }
      setBoardOptions((current) =>
        current.filter((option) => option.id !== optionId),
      );
      onNotify("Label deleted.");
    },
  };
}
