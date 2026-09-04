"use client";

/**
 * The Generated Documents tab — every document raised for this workspace.
 *
 * WHAT A VIEWER SEES, AND WHY THE ANSWER IS "WHATEVER THE SERVER SENT"
 *
 * The owner's rule is that a Viewer sees and downloads permitted finals and
 * cannot edit or finalise. Half of that is enforced here by drawing fewer
 * buttons — but the half that matters is not: `GET /api/reports/documents`
 * narrows a caller without `board.edit` to `status = 'Finalised'` in the QUERY,
 * so a draft never reaches this component to be hidden. This screen therefore
 * does not filter the list at all. Filtering it here would be a second,
 * weaker copy of a rule that already holds, and the day the two disagreed the
 * weaker one would be the one a person could see round.
 *
 * The controls are hidden on the same three-valued capability read the rest of
 * the product uses: `null` means "not answered yet", and a control whose
 * absence is safer stays hidden while the answer is in flight.
 *
 * DOWNLOADS ARE LINKS, NOT FETCHES
 *
 * `<a href>` to `/api/reports/exports`, so the browser's own download machinery
 * handles the file — including a session that expired between the page loading
 * and the click, where a `fetch` + blob would cheerfully download a file
 * containing the sign-in page.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../../../components";
import { useCapability } from "../../../lib/client-capabilities";
import type { DocumentListRow, ExportFormat, InvoiceStatus } from "../../../lib/reporting/contract";
import { EXPORT_FORMATS } from "../../../lib/reporting/contract";
import { formatInstant, formatIsoDate, formatMoney } from "../../../lib/exports/format";
import {
  exportUrl,
  fetchDocuments,
  runDocumentAction,
  saveDraft,
} from "./reports-client";

const FORMAT_LABEL: Record<ExportFormat, string> = {
  docx: "Word",
  pdf: "PDF",
  xlsx: "Excel",
};

function statusTone(status: InvoiceStatus): string {
  if (status === "Finalised") return "good";
  if (status === "Approved") return "info";
  if (status === "Voided") return "blocking";
  if (status === "Ready for Review") return "warning";
  return "draft";
}

export function GeneratedDocuments({
  onOpenGenerator,
}: {
  /**
   * "View" hands the document back to the generator tab, which is where a
   * document is read and worked on. A second read-only viewer would be a
   * second place the preview is rendered, and the whole point of
   * `document-model.ts` is that there is one.
   */
  onOpenGenerator: (invoiceId: string) => void;
}) {
  const canEdit = useCapability("board.edit");
  const canSettle = useCapability("settings.edit");
  const canExport = useCapability("data.export");

  const [rows, setRows] = useState<DocumentListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | InvoiceStatus>("all");

  const load = useCallback(async () => {
    const result = await fetchDocuments();
    if (!result.ok) {
      setError(result.error);
      setRows([]);
      return;
    }
    setError(null);
    setRows(result.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!rows) return [];
    return statusFilter === "all"
      ? rows
      : rows.filter((row) => row.status === statusFilter);
  }, [rows, statusFilter]);

  const duplicate = async (row: DocumentListRow) => {
    setBusy(`duplicate-${row.invoiceId}`);
    const result = await saveDraft({
      periodStart: row.period.start,
      periodEnd: row.period.end,
      preset: "range",
      invoiceDate: row.invoiceDate,
      dueAt: row.dueAt,
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNotice(
      `A new draft was created from ${row.invoiceNumber ?? "this document"}. Open the Invoice & Report Generator to edit it.`,
    );
    await load();
  };

  const voidDocument = async (row: DocumentListRow) => {
    const reason = window.prompt(
      `Void ${row.invoiceNumber ?? "this document"}. Why? This is recorded against your name.`,
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError("Voiding a document needs a reason.");
      return;
    }
    setBusy(`void-${row.invoiceId}`);
    const result = await runDocumentAction(row.invoiceId, "void", reason.trim());
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load();
  };

  return (
    <section className="reports-card" aria-labelledby="documents-heading">
      <header className="reports-card__head">
        <h2 id="documents-heading">
          <Icon name="folder" size={17} />
          Generated documents
        </h2>
        <p>
          Every invoice and maintenance report raised for this workspace, and the files produced
          from each. Downloading records who took a copy.
        </p>
        <label className="reports-field reports-field--inline">
          <span>Status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "all" | InvoiceStatus)}
          >
            <option value="all">All statuses</option>
            <option value="Draft">Draft</option>
            <option value="Ready for Review">Ready for Review</option>
            <option value="Approved">Approved</option>
            <option value="Finalised">Finalised</option>
            <option value="Voided">Voided</option>
          </select>
        </label>
        <button type="button" className="reports-button" onClick={() => void load()}>
          <Icon name="refresh" size={15} />
          Refresh
        </button>
      </header>

      {notice && (
        <p className="reports-alert reports-alert--ok" role="status">
          <Icon name="check" size={15} />
          {notice}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </p>
      )}
      {error && (
        <p className="reports-alert reports-alert--blocking" role="status">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}

      <div className="reports-table-scroll" tabIndex={0} role="region" aria-label="Generated documents">
        <table className="reports-table reports-table--documents">
          <thead>
            <tr>
              <th scope="col">Invoice #</th>
              <th scope="col">Client</th>
              <th scope="col">Period</th>
              <th scope="col">Invoice date</th>
              <th scope="col">Due date</th>
              <th scope="col" className="is-right">Active sites</th>
              <th scope="col" className="is-right">Invoice total</th>
              <th scope="col" className="is-right">Maintenance spend</th>
              <th scope="col">Status</th>
              <th scope="col">Created by</th>
              <th scope="col">Created</th>
              <th scope="col">Approved by</th>
              <th scope="col">Finalised</th>
              <th scope="col">Formats</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={15} className="reports-empty">
                  Reading the document register…
                </td>
              </tr>
            )}
            {rows !== null && !visible.length && (
              <tr>
                <td colSpan={15} className="reports-empty">
                  {statusFilter === "all"
                    ? "No document has been raised for this workspace yet."
                    : `No document is currently ${statusFilter}.`}
                </td>
              </tr>
            )}
            {visible.map((row) => (
              <tr key={row.invoiceId}>
                <td data-label="Invoice #">
                  <strong>{row.invoiceNumber ?? "Draft"}</strong>
                </td>
                <td data-label="Client">{row.clientName}</td>
                <td data-label="Period">
                  {formatIsoDate(row.period.start, "—")} to {formatIsoDate(row.period.end, "—")}
                  <small>{row.period.label}</small>
                </td>
                <td data-label="Invoice date">{formatIsoDate(row.invoiceDate, "—")}</td>
                <td data-label="Due date">{formatIsoDate(row.dueAt, "—")}</td>
                <td data-label="Active sites" className="is-right">{row.activeSitesBilled}</td>
                <td data-label="Invoice total" className="is-right">
                  {formatMoney(row.invoiceTotalPence)}
                </td>
                <td data-label="Maintenance spend" className="is-right">
                  {formatMoney(row.maintenanceSpendPence)}
                </td>
                <td data-label="Status">
                  <span className={`reports-status reports-status--${statusTone(row.status)}`}>
                    {row.status}
                  </span>
                </td>
                <td data-label="Created by">{row.createdByEmail ?? "—"}</td>
                <td data-label="Created">{formatInstant(row.createdAt, "—")}</td>
                <td data-label="Approved by">{row.approvedByEmail ?? "—"}</td>
                <td data-label="Finalised">{formatInstant(row.finalisedAt, "—")}</td>
                <td data-label="Formats">
                  {row.formats?.length
                    ? row.formats.map((format) => FORMAT_LABEL[format] ?? format).join(", ")
                    : "None yet"}
                </td>
                <td data-label="Actions">
                  <div className="reports-rowactions">
                    <button
                      type="button"
                      className="reports-linkish"
                      onClick={() => onOpenGenerator(row.invoiceId)}
                    >
                      View
                    </button>
                    {canExport !== false &&
                      EXPORT_FORMATS.map((format) => (
                        <a
                          key={format}
                          className="reports-linkish"
                          href={exportUrl(row.invoiceId, format)}
                        >
                          <Icon name="download" size={13} />
                          {FORMAT_LABEL[format]}
                        </a>
                      ))}
                    {canEdit === true && (
                      <button
                        type="button"
                        className="reports-linkish"
                        disabled={busy === `duplicate-${row.invoiceId}`}
                        onClick={() => void duplicate(row)}
                      >
                        Duplicate
                      </button>
                    )}
                    {canSettle === true && row.status !== "Voided" && (
                      <button
                        type="button"
                        className="reports-linkish reports-linkish--danger"
                        disabled={busy === `void-${row.invoiceId}`}
                        onClick={() => void voidDocument(row)}
                      >
                        Void
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit === false && (
        <p className="reports-card__foot">
          <Icon name="shield" size={14} />
          <span>
            Your role reads finalised documents and downloads the files. Editing, approving and
            finalising are not available to it.
          </span>
        </p>
      )}
    </section>
  );
}
