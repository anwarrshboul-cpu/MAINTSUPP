/**
 * THE COMPACT BOARD WIRE FORMAT — its types and its decoder.
 *
 * Split out of `board-model.ts` because that file has an enforced 600-line
 * ceiling (`tests/stage-eight-board-split.test.mjs`) and carrying a sixth slot
 * through this encoding took it past 600. The cap's own message says "split it
 * further", so it is split rather than having its reasoning trimmed to fit: the
 * comments here are the record of why a positional format may only grow at the
 * end, which is the part a future change most needs and the part a line budget
 * most tempts you to delete.
 *
 * The encoder is `compactBoard` in app/api/board/route.ts. The two are one
 * change and must move together.
 */
import type {
  BoardColumnOption,
  MaintenanceBoardColumn,
  MaintenanceGroup,
} from "../../lib/types";
import type { BoardResponse } from "./board-model";

/*
 * The board payload with its repeated identifiers sent once.
 *
 * `GET /api/board?compact=1` replaces every repeated id with an index into a
 * table sent once, and every row object with a positional array. On the live
 * maintenance board that is the difference between 3,131 KB and 686 KB, almost
 * all of it in `cells`: 8,565 rows whose median VALUE is ten characters, each
 * previously carrying a 57-character column id, a 36-character request id and
 * the property names `requestId`/`columnId`/`value` spelt out again.
 *
 * See `compactBoard` in app/api/board/route.ts for the encoder. The two are one
 * change and must move together.
 */
export type CompactFilePreview = [
  id: string,
  mimeIndex: number,
  originalName: string,
  byteSize: number,
  createdAt: string,
  /**
   * The document's title, present only when it has one.
   *
   * A POSITIONAL WIRE FORMAT GROWS AT THE END, AND ONLY OPTIONALLY. Almost no
   * attachment on the maintenance board has been given a title, and this list
   * is the widest thing the payload sends — a trailing `null` on every preview
   * row would be paid for by every row to describe a field almost none of them
   * use, which is the exact cost this encoding exists to avoid. The encoder in
   * `compactBoard` (app/api/board/route.ts) emits a five-element tuple when
   * there is no title and a six-element one when there is.
   *
   * It degrades in both directions without a `compact` marker bump: an older
   * decoder names five slots and ignores a sixth, and this decoder reading a
   * cached older payload gets `undefined` — which `documentName` already
   * treats as "no title", falling back to the filename.
   */
  title?: string | null,
];

export type CompactBoardResponse = {
  compact?: number;
  groups?: MaintenanceGroup[];
  options?: BoardColumnOption[];
  columns?: MaintenanceBoardColumn[];
  notRequired?: unknown;
  rowIds?: string[];
  columnIds?: string[];
  groupIds?: string[];
  mimeTypes?: string[];
  items?: Array<[rowIndex: number, groupIndex: number, position: number]>;
  cells?: Array<[rowIndex: number, columnIndex: number, value: string]>;
  fileCounts?: Array<
    [rowIndex: number, columnIndex: number, count: number, preview: CompactFilePreview[]]
  >;
};
/**
 * Rebuilds the objects the uncompacted payload used to send.
 *
 * Deliberately lossless and deliberately dull: every field the legacy shape
 * carried comes back with the same value, so the grid below this function
 * cannot tell which encoding it was served and a rendered board can be compared
 * row for row against one drawn before the change.
 *
 * A response without the `compact` marker is returned as-is. That is not
 * defensive clutter — a cached response, or a client that reaches this code
 * before the route it is paired with has deployed, is a real way to arrive here
 * holding the old shape, and decoding one as the other would silently produce a
 * board of `undefined` ids.
 */
export function decodeBoardResponse(payload: CompactBoardResponse & BoardResponse): BoardResponse {
  if (payload.compact !== 1) return payload as BoardResponse;
  const rowIds = payload.rowIds ?? [];
  const columnIds = payload.columnIds ?? [];
  const groupIds = payload.groupIds ?? [];
  const mimeTypes = payload.mimeTypes ?? [];
  const compact = payload as CompactBoardResponse;
  return {
    groups: compact.groups,
    options: compact.options,
    columns: compact.columns,
    items: (compact.items ?? []).map(([row, group, position]) => ({
      requestId: rowIds[row],
      groupId: groupIds[group],
      position,
    })),
    cells: (compact.cells ?? []).map(([row, column, value]) => ({
      requestId: rowIds[row],
      columnId: columnIds[column],
      value,
    })),
    fileCounts: (compact.fileCounts ?? []).map(([row, column, count, preview]) => ({
      requestId: rowIds[row],
      columnId: columnIds[column],
      count,
      preview: preview.map(([id, mime, originalName, byteSize, createdAt, title]) => ({
        id,
        contentType: mimeTypes[mime] ?? "",
        originalName,
        /*
         * Normalised to null rather than left `undefined`, so the decoded
         * object is the same shape whichever tuple length arrived. "Lossless
         * and deliberately dull" is this function's whole contract: a board
         * drawn from a compact response has to be comparable row for row with
         * one drawn from the uncompacted shape, and two different spellings of
         * "no title" would be a difference a caller could see.
         */
        title: title ?? null,
        byteSize,
        createdAt,
      })),
    })),
  };
}
