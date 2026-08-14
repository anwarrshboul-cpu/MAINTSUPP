"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../../lib/api";
import { acceptAttribute, uploadFile, useUploadLimits } from "../../../../lib/uploads";
import { SignedFileButton } from "../../../../components/signed-media";
import {
  formatDate,
  formatMoney,
  invoiceChipClass,
  INVOICE_STATUS_LABELS,
  poundsToPence,
  type InvoicePage,
  type InvoiceRow,
  type Organisation,
} from "../../../../lib/portal";

/**
 * The ledger: filters, the list, and — for staff — recording one.
 *
 * MONEY IS INTEGER PENCE. The only place a decimal point exists is the input
 * below, and `poundsToPence` turns it into an integer by parsing two whole
 * numbers rather than multiplying a float by a hundred. `12.10 * 100` is
 * 1209.9999999999998, and a rounding that happens to work today is not a
 * property of the code. What is sent is `amountPence`, and the API refuses
 * anything that is not a whole number.
 *
 * STATUS IS NOT STORED. "Overdue" is what unpaid becomes when the due date
 * passes, so it is derived by the API on every read. Filtering by it therefore
 * has to happen server-side — a client-side filter over one page would silently
 * describe the page rather than the ledger.
 */

const FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "outstanding", label: "Outstanding" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
];

export default function InvoiceLedger({
  initial,
  canRecord,
  organisations,
}: {
  initial: InvoicePage;
  canRecord: boolean;
  organisations: Organisation[];
}) {
  const router = useRouter();
  const [page, setPage] = useState<InvoicePage>(initial);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const reload = useCallback(
    async (nextStatus = status, nextQuery = query) => {
      setBusy(true);
      const params = new URLSearchParams({ limit: "100" });
      if (nextStatus) params.set("status", nextStatus);
      if (nextQuery.trim()) params.set("q", nextQuery.trim());
      const result = await api<InvoicePage>(`/invoices?${params}`);
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPage(result.data);
      // The totals panel above is server-rendered from /invoices/summary.
      router.refresh();
    },
    [status, query, router],
  );

  async function act(
    id: string,
    path: string,
    body: Record<string, unknown> | undefined,
    success: string,
  ) {
    setError(null);
    setNotice(null);
    setBusy(true);
    const result = await api(`/invoices/${id}${path}`, {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNotice(success);
    await reload();
  }

  return (
    <>
      <div className="p-section">
        <div className="p-section-head">
          <h2>Recorded invoices</h2>
          <span className="p-muted p-small">
            {page.total} {page.total === 1 ? "invoice" : "invoices"} ·{" "}
            {formatMoney(page.totals.outstandingPence)} outstanding in this view
          </span>
        </div>

        <div className="p-queues" role="group" aria-label="Filter invoices">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={`p-queue${status === filter.value ? " is-on" : ""}`}
              aria-pressed={status === filter.value}
              onClick={() => {
                setStatus(filter.value);
                void reload(filter.value, query);
              }}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <form
          className="p-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            void reload(status, query);
          }}
        >
          <label className="p-field">
            <span>Search</span>
            <input
              className="p-input"
              type="search"
              value={query}
              placeholder="Invoice number, job reference or client"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="p-field">
            <span>&nbsp;</span>
            <button type="submit" className="p-btn p-btn--ghost" disabled={busy}>
              {busy ? "Loading…" : "Search"}
            </button>
          </div>
          {canRecord ? (
            <div className="p-field">
              <span>&nbsp;</span>
              <button
                type="button"
                className="p-btn"
                onClick={() => setShowForm((open) => !open)}
              >
                {showForm ? "Close" : "Record an invoice"}
              </button>
            </div>
          ) : null}
        </form>

        <div aria-live="polite" aria-atomic="true">
          {error ? (
            <p className="alert alert--bad" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? <p className="alert alert--good">{notice}</p> : null}
        </div>

        {canRecord && showForm ? (
          <RecordForm
            organisations={organisations}
            onDone={async (message) => {
              setNotice(message);
              setShowForm(false);
              await reload();
            }}
            onError={setError}
          />
        ) : null}

        {page.invoices.length === 0 ? (
          <div className="card card--empty">
            <p className="muted">
              {status
                ? "Nothing matches that filter."
                : "No invoices are recorded yet."}
            </p>
          </div>
        ) : (
          <ul className="p-list">
            {page.invoices.map((invoice) => (
              <InvoiceCard
                key={invoice.id}
                invoice={invoice}
                canRecord={canRecord}
                busy={busy}
                onAct={act}
                onUploaded={async () => {
                  setNotice("Document attached.");
                  await reload();
                }}
                onError={setError}
              />
            ))}
          </ul>
        )}

        {page.hasMore ? (
          <p className="p-note">
            Showing the first {page.invoices.length} of {page.total}. Narrow it
            with a filter or a search.
          </p>
        ) : null}
      </div>
    </>
  );
}

/* -------------------------------------------------------------- one row -- */

function InvoiceCard({
  invoice,
  canRecord,
  busy,
  onAct,
  onUploaded,
  onError,
}: {
  invoice: InvoiceRow;
  canRecord: boolean;
  busy: boolean;
  onAct: (
    id: string,
    path: string,
    body: Record<string, unknown> | undefined,
    success: string,
  ) => Promise<void>;
  onUploaded: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const limits = useUploadLimits();
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const late = invoice.status === "overdue";

  return (
    <li className="p-row">
      <div className="p-row-head">
        <h3 className="p-mono">{invoice.invoice_number}</h3>
        <span className={invoiceChipClass(invoice.status)}>
          {INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status}
        </span>
        <span className="p-row-when p-mono">{formatMoney(invoice.amount_pence)}</span>
      </div>

      <p className="p-small p-muted">
        {invoice.organisation_name}
        {invoice.job_reference ? (
          <>
            {" · "}
            {invoice.job_reference} {invoice.job_title}
          </>
        ) : (
          " · account level"
        )}
        {invoice.contractor_name ? ` · ${invoice.contractor_name}` : ""}
      </p>

      <dl className="p-facts">
        <div>
          <dt>Issued</dt>
          <dd className="p-mono">{formatDate(invoice.issued_at) ?? "—"}</dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd className={`p-mono${late ? " p-bad" : ""}`}>
            {formatDate(invoice.due_at) ?? "—"}
            {invoice.days_to_due !== null && invoice.status !== "paid" &&
            invoice.status !== "cancelled" ? (
              <span className="p-small">
                {" "}
                {invoice.days_to_due < 0
                  ? `· ${Math.abs(invoice.days_to_due)} days late`
                  : `· in ${invoice.days_to_due} days`}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Paid</dt>
          <dd className="p-mono">{formatDate(invoice.paid_at) ?? "—"}</dd>
        </div>
        <div>
          <dt>Document</dt>
          <dd>
            {invoice.attachment_id ? (
              // Money-gated: /uploads/:id/url cannot serve an invoice
              // attachment, so this is the only route to the bytes.
              <SignedFileButton
                path={`/invoices/${invoice.id}/pdf`}
                name={`${invoice.invoice_number}`}
                size="md"
              />
            ) : (
              <span className="p-muted p-small">none</span>
            )}
          </dd>
        </div>
      </dl>

      {invoice.notes ? <p className="p-note">{invoice.notes}</p> : null}

      {!canRecord ? null : (
        <>
          <div className="p-btnrow" style={{ marginTop: 10 }}>
            {invoice.status !== "paid" && invoice.status !== "cancelled" ? (
              <button
                type="button"
                className="p-btn"
                disabled={busy}
                onClick={() => onAct(invoice.id, "/paid", {}, `${invoice.invoice_number} marked paid.`)}
              >
                Mark paid
              </button>
            ) : null}

            {invoice.status !== "paid" && invoice.status !== "cancelled" ? (
              <button
                type="button"
                className="p-btn p-btn--ghost p-btn--danger"
                disabled={busy}
                onClick={() => setCancelling((open) => !open)}
              >
                Cancel
              </button>
            ) : null}

            <label className="p-btn p-btn--ghost" style={{ position: "relative", overflow: "hidden" }}>
              {sending ? "Attaching…" : invoice.attachment_id ? "Replace document" : "Attach document"}
              <input
                type="file"
                accept={acceptAttribute(limits)}
                disabled={sending || busy}
                /* Visually inside the button and exactly its size, so the tap
                   target IS the 44px button rather than the browser's smaller
                   default file control sitting inside it. 16px for the same
                   reason every other input in the portal carries it. */
                style={{
                  position: "absolute",
                  /* -1px, not 0: `inset: 0` covers the PADDING box, which is
                     42px inside a 44px bordered button — a tap target that
                     measures short of the minimum for no visible reason. */
                  inset: -1,
                  /* No width/height: an absolutely positioned box that sets
                     BOTH offsets and a size is over-constrained, and the size
                     wins — `height: 100%` measured 42px inside the 44px button
                     the insets were there to cover. */
                  fontSize: 16,
                  opacity: 0,
                  cursor: "pointer",
                }}
                onChange={async (event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  setSending(true);
                  const result = await uploadFile(`/invoices/${invoice.id}/pdf`, file);
                  setSending(false);
                  if (!result.ok) {
                    onError(result.error);
                    return;
                  }
                  await onUploaded();
                }}
              />
            </label>
          </div>

          {cancelling ? (
            <div className="p-grid2" style={{ marginTop: 8 }}>
              <label className="p-field">
                <span>Cancelled because</span>
                <input
                  className="p-input"
                  type="text"
                  value={reason}
                  maxLength={300}
                  placeholder="Raised against the wrong client"
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <div className="p-field">
                <span>&nbsp;</span>
                <button
                  type="button"
                  className="p-btn p-btn--ghost p-btn--danger"
                  disabled={busy || reason.trim().length === 0}
                  onClick={async () => {
                    await onAct(
                      invoice.id,
                      "/cancel",
                      { reason },
                      `${invoice.invoice_number} cancelled and taken out of the totals.`,
                    );
                    setCancelling(false);
                    setReason("");
                  }}
                >
                  Confirm cancellation
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}

/* ------------------------------------------------------------ recording -- */

function RecordForm({
  organisations,
  onDone,
  onError,
}: {
  organisations: Organisation[];
  onDone: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [organisationId, setOrganisationId] = useState("");
  const [jobReference, setJobReference] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="p-panel"
      style={{ marginBottom: 12 }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;

        const amountPence = poundsToPence(amount);
        if (amountPence === null) {
          onError("Enter the amount in pounds, like 450 or 450.75.");
          return;
        }
        if (!jobReference.trim() && !organisationId) {
          onError("Choose a client, or give the job reference it was raised for.");
          return;
        }

        setSaving(true);
        const result = await api("/invoices", {
          method: "POST",
          body: JSON.stringify({
            invoiceNumber,
            amountPence,
            ...(jobReference.trim()
              ? { jobReference: jobReference.trim() }
              : { organisationId }),
            ...(issuedAt ? { issuedAt } : {}),
            ...(dueAt ? { dueAt } : {}),
            ...(notes.trim() ? { notes } : {}),
          }),
        });
        setSaving(false);

        if (!result.ok) {
          onError(result.error);
          return;
        }
        setInvoiceNumber("");
        setAmount("");
        setNotes("");
        await onDone(`Invoice ${invoiceNumber} recorded.`);
      }}
    >
      <div className="p-section-head">
        <h2>Record an invoice</h2>
      </div>
      <p className="p-note" style={{ marginTop: 0 }}>
        The number is transcribed from the document — nothing here issues or
        numbers an invoice. Give a job reference to file it against a job, or
        pick a client for an account-level one.
      </p>

      <div className="p-grid2">
        <label className="p-field">
          <span>Invoice number</span>
          <input
            className="p-input"
            type="text"
            required
            maxLength={60}
            value={invoiceNumber}
            placeholder="INV-1042"
            onChange={(event) => setInvoiceNumber(event.target.value)}
          />
        </label>
        <label className="p-field">
          <span>Amount (£)</span>
          <input
            className="p-input"
            type="text"
            inputMode="decimal"
            required
            value={amount}
            placeholder="450.00"
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
      </div>

      <div className="p-grid2">
        <label className="p-field">
          <span>Job reference</span>
          <input
            className="p-input"
            type="text"
            maxLength={20}
            value={jobReference}
            placeholder="MS-00042"
            onChange={(event) => setJobReference(event.target.value)}
          />
        </label>
        <label className="p-field">
          <span>or client</span>
          <select
            className="p-select"
            value={organisationId}
            disabled={jobReference.trim().length > 0}
            onChange={(event) => setOrganisationId(event.target.value)}
          >
            <option value="">Choose a client…</option>
            {organisations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="p-grid2">
        <label className="p-field">
          <span>Issued</span>
          <input
            className="p-input"
            type="date"
            value={issuedAt}
            onChange={(event) => setIssuedAt(event.target.value)}
          />
        </label>
        <label className="p-field">
          <span>Due</span>
          <input
            className="p-input"
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </label>
      </div>

      <label className="p-field" style={{ marginTop: 10 }}>
        <span>Notes</span>
        <textarea
          className="p-textarea"
          rows={2}
          maxLength={1000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>

      <div className="p-btnrow" style={{ marginTop: 10 }}>
        <button type="submit" className="p-btn" disabled={saving}>
          {saving ? "Recording…" : "Record invoice"}
        </button>
      </div>
    </form>
  );
}
