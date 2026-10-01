"use client";

/**
 * The board's "nothing matched" state for the search box.
 *
 * QA: searching the Jobs board for something that matched nothing left every
 * group drawn empty and said nothing — indistinguishable from a board that had
 * failed to load. This says what happened and offers the one way back.
 *
 * Its own file because live-board.tsx sits a few dozen lines under the 5,600
 * guard in tests/workstream-seven-official-document-ui.test.mjs; the board adds
 * one line to draw it. The phone's card list has its own wording for the same
 * state (board-mobile-list.tsx), and the grid is hidden while cards show, so
 * the two never appear together.
 */

import "./board-search-empty.css";

export function BoardSearchEmpty({
  query,
  matches,
  noun,
  onClear,
}: {
  query: string;
  matches: number;
  /** "jobs", "stores" — what the board holds. */
  noun: string;
  onClear: () => void;
}) {
  const searched = query.trim();
  if (!searched || matches > 0) return null;
  return (
    <div className="board-search-empty" role="status">
      <p>
        No {noun} match &ldquo;{searched}&rdquo;
      </p>
      <button className="secondary-button" type="button" onClick={onClear}>
        Clear search
      </button>
    </div>
  );
}
