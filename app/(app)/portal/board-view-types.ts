/**
 * WHAT `/api/board/views` HANDS BACK — one description of it, for everything
 * that reads the tab strip.
 *
 * WHY THIS IS ITS OWN FILE. `board-chrome.tsx` is held to 500 lines and these
 * shapes pushed it over, exactly as the pane, the write path, the tab glyph and
 * the strip menus did before them — see `board-view-pane.tsx`,
 * `board-view-writes.ts`, `board-tab-glyph.tsx` and
 * `board-actions/view-menus.tsx`. It is a move, not a rewrite: the chrome
 * re-exports `BoardView` so `live-board.tsx` and `board-tab-glyph.tsx` keep
 * importing it from where they always have.
 *
 * IT IS ALSO THE RIGHT PLACE FOR THEM. Four files now read this payload — the
 * chrome, the pane, the tab glyph and the "+" menu — and the endpoint that
 * produces it (`app/api/board/views/route.ts`) is the single author of every
 * field. Describing it once means a field added there cannot be understood two
 * different ways on the way down.
 */

/** A saved tab on a board's strip, as the endpoint serialises it. */
export type BoardView = {
  id: string;
  key: string;
  name: string;
  type: string;
  icon: string | null;
  position: number;
  isDefault: boolean;
  system: boolean;
  /**
   * Whether THIS BOARD can draw this type — not whether the product has built
   * it. `typesFor` in the views route narrows the product's answer per board,
   * because a Form tab on a register with no form of its own would render the
   * canonical job board's questions and file the answers onto the job board.
   */
  built: boolean;
  /**
   * Why this board cannot draw this type, in the words the server chose.
   *
   * Only ever set alongside `built: false`, and only for a type the product HAS
   * built that this board cannot serve. `/api/board/views` is the single author
   * of the sentence, so the tab's tooltip, the "+" menu and the pane all print
   * the same one instead of each guessing at a reason. Absent means the honest
   * fallback, "not built yet" — which is what a stored row naming a type this
   * build no longer offers gets, and the only case left where that phrase is
   * true.
   */
  unavailable?: string;
  /** Saved view settings. `glyph` carries monday's tab decoration. */
  settings?: { glyph?: "pin" | "app" };
};

/**
 * One entry in the "+ Add view" menu.
 *
 * `built` and `unavailable` mean exactly what they mean on `BoardView` above,
 * and are answered by the same function on the server, so the strip and the
 * menu cannot disagree about what this board can do. A type the product has no
 * renderer for is not in this list at all — it is not offered, not greyed and
 * not clickable, which is the owner's §8 rule for something that does not
 * exist.
 */
export type ViewType = {
  key: string;
  label: string;
  icon: string;
  built: boolean;
  unavailable?: string;
};

/** The board the strip belongs to, as the same payload reports it. */
export type BoardSummary = {
  id: string;
  key: string;
  name: string;
  itemNoun: string;
};
