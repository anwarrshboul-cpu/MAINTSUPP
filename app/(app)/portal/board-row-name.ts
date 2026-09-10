/**
 * WHAT A ROW ON A BOARD IS CALLED.
 *
 * Split out of `board-ordering.ts`, whose 200-line ceiling this pushed past —
 * the same reason `board-view-types.ts` and `board-view-writes.ts` came out of
 * `board-chrome.tsx`. It is not an arbitrary slice: that file's own docstring
 * says it is about "how rows sort, and where a dragged row lands", and naming
 * is neither. It grew here because the rule turned out to be wrong in three
 * places at once and the account of why is longer than the code.
 *
 * Pure, and importing only types, so it can be read by the grid, the phone,
 * the drawer, the CSV export, the sort and the filter without a cycle.
 */
import type { MaintenanceRequest } from "../../lib/types";

/** How the Name column reads: monday shows the form a job arrived through. */
export function displaySource(source: MaintenanceRequest["source"]) {
  return source === "Manual" ? "Manual" : "Incoming form answer";
}

/**
 * What a row is called when its Name cell is empty.
 *
 * ── THE FAULT ─────────────────────────────────────────────────────────────
 *
 * This read `if (boardId !== "maintenance" && request.title?.trim())`, so on
 * the JOB board it never consulted the title at all and every row fell through
 * to `displaySource`. The result was the whole board reading "Incoming form
 * answer", row after row, while `maintenance_requests.title` held a real,
 * distinct description of each job the entire time — `requestTitle` in the
 * public submit route, in `/api/report-job` and in `request-fields.ts` all
 * compute one from the first line of the description. A board where every row
 * has the same name is unusable whatever columns are on it, and two views
 * already worked around this by reading `name` themselves rather than asking
 * (`views/parity-views.tsx`, `views/fix-tracker.tsx`).
 *
 * The exclusion was there for monday parity — monday's Name column does show
 * which form a job arrived through. But the guard was the wrong shape for that
 * intent, because the parity case takes care of ITSELF: a row imported from
 * monday carries "Incoming form answer" in `title`, put there by
 * `monday-import.ts` mapping monday's Name column onto it. So preferring the
 * title changes nothing for an imported row and everything for a job this
 * product created. Parity is preserved by the DATA rather than by a board-key
 * comparison, which is the same lesson `seedViews` and this file's own
 * `boardId !== "store-documentation"` history record.
 *
 * `displaySource` therefore now means what it says: the label for a row with no
 * Name cell AND no title of its own.
 *
 * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
 *
 * It does not retitle anything. Rows whose stored title IS "Incoming form
 * answer" still read that way, honestly, because that is the only name their
 * data holds — a backfill from their stored answers is proposed separately and
 * deliberately not run here.
 *
 * The Name cell still wins where one exists — renaming a store in the grid
 * writes a cell, and that edit must survive. Pinned by
 * `tests/audit-s1-rename.test.mjs`.
 */
export function boardItemName(request: MaintenanceRequest, cellValue?: string) {
  const edited = cellValue?.trim();
  if (edited) return edited;
  const title = request.title?.trim();
  if (title) return title;
  return displaySource(request.source);
}
