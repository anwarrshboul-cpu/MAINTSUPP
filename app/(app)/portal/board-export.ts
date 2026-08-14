"use client";

/**
 * The board as a CSV.
 *
 * Lifted out of `live-board.tsx`, which is held to 6,000 lines by
 * `stage-eight-board-split.test.mjs`. It is a good seam independently:
 * producing a file has nothing to do with drawing a grid, it is the one piece
 * of the board a `data.export` capability gates, and it is the piece somebody
 * reads when a column comes out in the wrong order.
 */

import { columnLabels } from "./board-model";
import { boardItemName } from "./board-ordering";
import {
  customCellDisplay,
  customCellKey,
  dateInputValue,
} from "./board-format";
import { toCsv } from "../../lib/csv";
import type {
  MaintenanceBoardColumn,
  MaintenanceRequest,
} from "../../lib/types";

export function downloadBoardCsv(
  boardId: string,
  requests: MaintenanceRequest[],
  customColumns: MaintenanceBoardColumn[] = [],
  customCells: Record<string, string> = {},
  customFileCounts: Record<string, number> = {},
) {
  const headers = [
    ...columnLabels.slice(0, -1).map((column) => column.label),
    ...customColumns.map((column) => column.title),
  ];
  const nameColumn = customColumns.find((column) => column.key === "name");
  const rows = requests.map((request) => [
    `${boardItemName(
      request,
      boardId,
      nameColumn ? customCells[customCellKey(request.id, nameColumn.id)] : undefined,
    )}${
      request.commentCount ? ` (${request.commentCount} updates)` : ""
    }`,
    request.location,
    request.description,
    `Tier ${request.tier}`,
    request.engineer,
    request.priority,
    request.category,
    request.status,
    request.contractor ?? "",
    request.assignee ?? "",
    dateInputValue(request.requestedAt),
    dateInputValue(request.completedAt),
    `${dateInputValue(request.requestedAt)} to ${dateInputValue(request.dueAt)}`,
    request.requester,
    dateInputValue(request.nextUpdateAt),
    request.issueAttachmentCount ??
      Math.max(
        request.attachmentCount -
          (request.completedAttachmentCount ?? 0) -
          (request.generalAttachmentCount ?? 0),
        0,
      ),
    request.completedAttachmentCount ?? 0,
    request.cost ?? "",
    request.approvedBy ?? "",
    request.invoice ?? "",
    request.attachmentCount,
    request.contact,
    request.location,
    request.formUrl ?? "",
    ...customColumns.map((column) =>
      column.type === "files"
        ? customFileCounts[customCellKey(request.id, column.id)] ?? 0
        : customCellDisplay(
            column,
            customCells[customCellKey(request.id, column.id)] ?? "",
          ),
    ),
  ]);
  const escape = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [headers, ...rows]
    .map((row) => row.map(escape).join(","))
    .join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  link.download = `maintsupp-live-board-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Copy to the clipboard, with the pre-`navigator.clipboard` fallback.
 *
 * Exported alongside the CSV because both are "get this out of the board" —
 * one to a file, one to the clipboard — and both have to cope with a browser
 * that refuses the modern API over plain http.
 */
export async function copyBoardText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable.");
}

/**
 * Which board this grid is bound to.
 *
 * Defaults to maintenance so every existing mount keeps working untouched. The
 * board reaches the API as a query param; routing it through one helper rather
 * than editing 26 call sites is what stops a single missed URL quietly reading
 * or writing the wrong board's rows.
 */
