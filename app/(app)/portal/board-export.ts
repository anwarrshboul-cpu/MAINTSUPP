"use client";

/**
 * The board as a CSV, and the clipboard helper beside it.
 *
 * WHAT MOVED, AND WHY
 *
 * This file used to BUILD the CSV: it took the rows React was holding, joined
 * them with commas and handed the result to a `Blob`. That made the export a
 * purely local act, which is why `data.export` — "Download boards, sites and
 * reports as CSV" — gated the site register and gated nothing here. Hiding the
 * Export button would not have closed it either, because the file was produced
 * from data already in the page.
 *
 * So the file now comes from `POST /api/board/csv`, which holds the capability
 * check. What is exported is still decided here — the caller passes the rows it
 * is showing in the order it is showing them, and the columns it is drawing —
 * so a filtered, sorted, partly-hidden board still exports as what is on the
 * screen. The server decides *whether*, and re-reads every value from the
 * database rather than trusting the payload.
 *
 * A DENIED EXPORT SAYS SO. The 403 carries the capability's own sentence
 * ("Your role (Client) does not have the "data.export" permission…"), which is
 * surfaced to the operator rather than swallowed into a generic failure — a
 * download that silently does nothing is the worst of the three outcomes.
 */

import type {
  MaintenanceBoardColumn,
  MaintenanceRequest,
} from "../../lib/types";

export type BoardExportRequest = {
  boardId: string;
  /** The rows on screen, in the order they appear. */
  requests: MaintenanceRequest[];
  /** The columns being drawn, in the order they are drawn. */
  columns: MaintenanceBoardColumn[];
};

/**
 * Ask the server for the file and hand it to the browser.
 *
 * Rejects with the server's own message when the export is refused or fails, so
 * every call site can report it with the notifier it already has.
 */
export async function downloadBoardCsv({
  boardId,
  requests,
  columns,
}: BoardExportRequest) {
  const response = await fetch("/api/board/csv", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      board: boardId,
      requestIds: requests.map((request) => request.id),
      columnIds: columns.map((column) => column.id),
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      payload.error ||
        (response.status === 403
          ? "Your role does not have permission to export this board."
          : "The board could not be exported."),
    );
  }

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download =
    filenameFrom(response.headers.get("content-disposition")) ??
    `maintsupp-${boardId}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  // Revoked on the next frame rather than immediately: Safari has not always
  // finished reading the object URL by the time `click()` returns.
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

/** The server's chosen filename, if it sent one in the usual header shape. */
function filenameFrom(disposition: string | null) {
  if (!disposition) return null;
  const match = /filename="([^"]+)"/.exec(disposition);
  return match?.[1] ?? null;
}

/**
 * Copy to the clipboard, with the pre-`navigator.clipboard` fallback.
 *
 * Kept alongside the CSV because both are "get this out of the board" — one to
 * a file, one to the clipboard — and both have to cope with a browser that
 * refuses the modern API over plain http.
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
