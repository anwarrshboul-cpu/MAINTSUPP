/**
 * The board as rows of text — one definition, used by the server that exports it.
 *
 * WHY THIS IS ON THE SERVER AT ALL
 *
 * The board's CSV used to be built entirely in the browser: `downloadBoardCsv`
 * took the rows React was already holding, joined them with commas and handed
 * the result to a `Blob`. Nothing ever asked whether the person was allowed to
 * export. `data.export` — "Download boards, sites and reports as CSV" — gated
 * the site register and gated nothing on the board, so a role with the
 * capability withdrawn kept the Export button and kept the file. Hiding the
 * button would not have fixed that, because the file was being produced from
 * data already in the page by code the person could call themselves.
 *
 * So the file is produced by `POST /api/board/csv`, which holds the capability
 * check, and this module is the part of it that is worth reading: how a column
 * becomes a header and a row becomes a line.
 *
 * WHAT IT PRESERVES
 *
 * The caller sends the columns it is drawing, in the order it is drawing them,
 * and the rows it is drawing, in the order they appear on screen. So exporting
 * a filtered, sorted, partly-hidden board gives back exactly what is on the
 * screen — which is the behaviour the client-side version had and the reason it
 * was written that way. The server decides *whether*, never *what*.
 *
 * WHAT IT FIXES ON THE WAY
 *
 * The old headers were `columnLabels.slice(0, -1)` — the 25 monday columns plus
 * MAINTSUPP's Group control, minus the last one — while the values were a
 * hand-written array of 24. `subitems` sits nineteenth in the column list and
 * had no value in the array, so every column from "Approved by" onwards was
 * printed under the heading of the one before it: the Subitems column carried
 * the invoice number, Invoice carried the file count, and Form View was blank.
 * Pairing header and value in one table per column is what makes that class of
 * bug unrepresentable rather than fixed.
 */

import type {
  MaintenanceBoardColumn,
  MaintenanceRequest,
} from "./types";
import {
  customCellDisplay,
  customCellKey,
  parseBoardDateMetadata,
} from "../(app)/portal/board-format";
import { formatDate } from "./format-date";
import { boardItemName } from "../(app)/portal/board-ordering";

export type BoardCsvColumn = {
  /** The system column's stable key, or null for a workspace-added column. */
  key: string | null;
  /** The column row, for its title, type and id. */
  column: MaintenanceBoardColumn;
};

export type BoardCsvInput = {
  boardId: string;
  columns: BoardCsvColumn[];
  requests: MaintenanceRequest[];
  /** `${requestId}::${columnId}` → stored value. */
  cells: Record<string, string>;
  /** `${requestId}::${columnId}` → how many files that cell holds. */
  fileCounts: Record<string, number>;
  /**
   * requestId → how many children it has.
   *
   * Counted by the caller rather than derived here, because an export of a
   * selection or one group does not carry the children whose parent it is
   * exporting, and counting from a subset would under-report. Absent means the
   * caller does not know, which prints 0.
   */
  subitemCounts?: Record<string, number>;
};

/**
 * A date as this product writes one: en-GB, `24/11/2026`.
 *
 * The export used to print the raw `YYYY-MM-DD` the field stores, because it
 * reused `dateInputValue` — the helper that feeds `<input type="date">`, which
 * REQUIRES ISO and must keep getting it. A spreadsheet is not a date input: a
 * UK reader opening this file saw the American-looking form of every date in a
 * product whose whole date doctrine (format-date.ts) is "en-GB, everywhere".
 *
 * The fallback is an empty string rather than format-date's em dash: a missing
 * value in a spreadsheet is an empty cell, not a character to strip out later.
 * Nothing on the wire changes — this is the file a person reads.
 */
function csvDate(value: string | null | undefined) {
  return formatDate(value, { fallback: "" });
}

/**
 * What one system column prints for one row.
 *
 * Every branch reads the request, never a cell, because a system column's value
 * IS the field on the job — that is what makes it a system column. The two
 * exceptions are Name, which a workspace may override with a cell, and the date
 * columns, which carry an optional icon and time in a cell alongside the field.
 * Neither changes what the CSV says the value is.
 */
function systemCsvValue(
  key: string,
  request: MaintenanceRequest,
  input: BoardCsvInput,
  column: MaintenanceBoardColumn,
): string | number {
  switch (key) {
    case "name": {
      const name = boardItemName(
        request,
        input.boardId,
        input.cells[customCellKey(request.id, column.id)],
      );
      return request.commentCount
        ? `${name} (${request.commentCount} updates)`
        : name;
    }
    case "location":
    case "storeLocation":
      return request.location;
    case "description":
      return request.description;
    case "tier":
      return `Tier ${request.tier}`;
    case "engineer":
      return request.engineer;
    case "priority":
      return request.priority;
    case "label":
      return request.category;
    case "status":
      return request.status;
    case "contractor":
      return request.contractor ?? "";
    case "assignee":
      return request.assignee ?? "";
    case "requested":
      return csvDate(request.requestedAt);
    case "completed":
      return csvDate(request.completedAt);
    case "dueDate":
      return csvDate(request.dueAt);
    case "timeline":
      return `${csvDate(request.requestedAt)} to ${csvDate(request.dueAt)}`;
    case "requester":
      return request.requester;
    case "nextUpdate":
      return csvDate(request.nextUpdateAt);
    case "issuePictures":
      return (
        request.issueAttachmentCount ??
        Math.max(
          request.attachmentCount -
            (request.completedAttachmentCount ?? 0) -
            (request.generalAttachmentCount ?? 0),
          0,
        )
      );
    case "completedPictures":
      return request.completedAttachmentCount ?? 0;
    case "cost":
      return request.cost ?? "";
    case "approvedBy":
      return request.approvedBy ?? "";
    case "subitems":
      // The Subitems column shows how many children a job has, so that is what
      // it exports. Previously it exported nothing at all — see the header note.
      return input.subitemCounts?.[request.id] ?? 0;
    case "invoice":
      return request.invoice ?? "";
    case "files":
      return request.attachmentCount;
    case "number":
      return request.contact;
    case "formView":
      return request.formUrl ?? "";
    case "move":
      return request.stage;
    default:
      // A system key this build does not know. Empty rather than "undefined":
      // a blank cell is honest, a printed keyword is not.
      return "";
  }
}

/** Headers and rows, paired column by column so the two cannot drift. */
export function boardCsvTable(input: BoardCsvInput) {
  const headers = input.columns.map((entry) => entry.column.title);
  const rows = input.requests.map((request) =>
    input.columns.map((entry) => {
      if (entry.key) return systemCsvValue(entry.key, request, input, entry.column);
      const cellKey = customCellKey(request.id, entry.column.id);
      if (entry.column.type === "files") return input.fileCounts[cellKey] ?? 0;
      const stored = input.cells[cellKey] ?? "";
      /*
       * A workspace-added date column holds the same ISO the system ones do,
       * and `customCellDisplay` hands it back unchanged because that string
       * feeds a date INPUT on the board. The file gets the written form
       * instead, with the cell's optional time of day kept beside it.
       */
      if (entry.column.type === "date") {
        const metadata = parseBoardDateMetadata(stored);
        if (!metadata.date) return "";
        return metadata.time
          ? `${csvDate(metadata.date)} ${metadata.time}`
          : csvDate(metadata.date);
      }
      if (entry.column.type === "timeline") {
        try {
          const timeline = JSON.parse(stored) as { start?: string; end?: string };
          const span = [timeline.start, timeline.end].filter(Boolean).map(csvDate);
          return span.length ? span.join(" to ") : "";
        } catch {
          return stored;
        }
      }
      return customCellDisplay(entry.column, stored);
    }),
  );
  return { headers, rows };
}
