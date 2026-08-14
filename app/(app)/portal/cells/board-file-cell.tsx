"use client";

/**
 * A board file cell, with its count and thumbnails looked up for it.
 *
 * Four places on the board render a file column — the three monday system
 * columns (Pictures of Maintenance Issue, Picture of completed works, Files)
 * and the generic custom-column path — and all four were repeating the same
 * two `customCellKey` lookups inline. That repetition is how the three system
 * columns came to read a denormalised counter on the request while the custom
 * path counted real rows: the same cell, told two different numbers.
 *
 * One place to ask "how many files are in this cell, and what do the first few
 * look like", so the four cannot drift apart again. It lives here rather than
 * in live-board.tsx because that file is under a 6,000-line cap from Stage 8,
 * and because a lookup wrapper is exactly the kind of thing the cells folder
 * is for.
 */

import { FileHoverPreview } from "../evidence-manager";
import { customCellKey } from "../board-format";
import type { MaintenanceBoardFilePreview } from "../../../lib/types";

export function BoardFileCell({
  requestId,
  columnId,
  columnTitle,
  counts,
  previews,
  mondayMediaStyle = false,
  onOpen,
}: {
  requestId: string;
  columnId: string;
  /**
   * The column's own title, carried through to the cell's accessible name.
   *
   * A maintenance row has two photo columns — "Pictures of Maintenance Issue"
   * and "Picture of completed works" — and both cells announced themselves as
   * the same "3 files". Optional so the four call sites can adopt it one at a
   * time; without it the cell keeps the name it had.
   */
  columnTitle?: string;
  counts: Record<string, number>;
  previews: Record<string, MaintenanceBoardFilePreview[]>;
  /** Draws monday's thumbnail strip. Off for the plain "Files" column. */
  mondayMediaStyle?: boolean;
  onOpen: () => void;
}) {
  const key = customCellKey(requestId, columnId);
  return (
    <FileHoverPreview
      requestId={requestId}
      columnId={columnId}
      columnTitle={columnTitle}
      mondayMediaStyle={mondayMediaStyle}
      count={counts[key] ?? 0}
      preview={previews[key] ?? []}
      onOpen={onOpen}
    />
  );
}
