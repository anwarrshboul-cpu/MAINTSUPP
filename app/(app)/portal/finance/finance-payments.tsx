"use client";

/**
 * PAYMENTS — §6 — AND PAYMENT RUNS — §13.
 *
 * ── A PAYMENT IS A RECORD, NOT A FIELD ON AN INVOICE ──────────────────────
 *
 * §6: "One invoice can have several payments; one payment can cover several
 * invoices." So the form below is a payment with a list of invoices under it,
 * and the shares are forced to sum to the payment by the same
 * `allocationState` the server refuses with — the number under the form and the
 * number in the 409 come out of one function and cannot disagree.
 *
 * ── THE CANDIDATES ARE INVOICES WITH SOMETHING STILL OWING ────────────────
 *
 * Money out settles payables and money in settles receivables — that is
 * `settlingDirection`, and reading it rather than hard-coding the pairing is
 * what stops a receipt being offered a supplier's bill to pay off. Settled
 * invoices are left out of the list: allocating to one is not an error the UI
 * should make easy, and an over-payment is exactly what §7's duplicate check
 * exists to prevent.
 *
 * ── PAYMENT RUNS ──────────────────────────────────────────────────────────
 *
 * §13: "Nobody should pay 30 invoices one at a time." Select the approved
 * payables, group them into a run with a date, export the bank file, mark the
 * batch scheduled. Those routes land after this component, so the whole card
 * degrades to one named notice rather than to a row of dead buttons.
 */

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import {
  PAYMENT_METHODS,
  formatPence,
  settlingDirection,
  type InvoiceDirection,
} from "../../../lib/finance/model";
import { uploadEvidenceFile } from "../../../lib/client-upload";
import {
  AllocationEditor,
  Confirmation,
  DegradedNotice,
  Field,
  FinanceState,
  Money,
  MoneyField,
  Refusal,
  dayText,
  draftState,
  fetchDownload,
  fieldPence,
  plural,
  todayDay,
  useFinanceEndpoint,
  useFinanceWrite,
  type AllocationDraft,
} from "./finance-shared";
import {
  recordBalance,
  type LedgerPayload,
  type LedgerRow,
  type PaymentRecord,
} from "./finance-records";

interface PaymentsPayload {
  rows: PaymentRecord[];
  total: number;
  totalPence: number;
  limit: number;
  offset: number;
}

interface PaymentRun {
  id: string;
  reference: string;
  paymentDate: string;
  status: string;
  totalPence: number;
  invoiceCount: number;
  exportedAt: string | null;
  exportFilename: string | null;
}

/** A payable already approved, with what is still outstanding on it. */
interface RunCandidate {
  id: string;
  internalRef: string | null;
  invoiceNumber: string | null;
  counterpartyName: string | null;
  dueAt: string | null;
  grossPence: number | null;
  balancePence: number;
}

interface PaymentRunsPayload {
  runs?: PaymentRun[];
  paymentRuns?: PaymentRun[];
  /*
   * The route sends the eligible payables ALONGSIDE the runs, which is why
   * this card does not run its own `?status=approved` query: "eligible" is a
   * server-side judgement (approved, not voided, balance still outstanding)
   * and a second definition of it here would eventually offer a settled
   * invoice for a batch that then refuses it.
   */
  candidates?: RunCandidate[];
  today?: string;
}

interface PaymentSource {
  id: string;
  label: string;
  accountingReference?: string | null;
}

interface SettingsPayload {
  paymentSources?: PaymentSource[];
}

export function FinancePayments({ onNotify }: { onNotify: (message: string) => void }) {
  const payments = useFinanceEndpoint<PaymentsPayload>("/api/finance/payments", "limit=50");
  const settings = useFinanceEndpoint<SettingsPayload>("/api/finance/settings");

  return (
    <div className="fin-stack">
      <RecordPaymentCard
        accounts={settings.data?.paymentSources ?? []}
        accountsUnavailable={settings.unavailable}
        onNotify={onNotify}
        onRecorded={payments.reload}
      />

      <section className="fin-card">
        <div className="fin-card__head">
          <h2>Payments recorded</h2>
          <p className="fin-card__note">
            {payments.data
              ? `${plural(payments.data.total, "payment")}, ${formatPence(payments.data.totalPence)} in total.`
              : "Money in and money out, newest first."}
          </p>
        </div>
        <FinanceState
          loading={payments.loading}
          error={payments.error}
          unavailable={payments.unavailable}
          endpoint="/api/finance/payments"
          what="Payments"
          empty={Boolean(payments.data) && (payments.data?.rows.length ?? 0) === 0}
          emptyLabel="No payment has been recorded yet."
          onRetry={payments.reload}
        >
          <div className="fin-table-wrap">
            <table className="fin-table" role="table">
              <caption className="visually-hidden">Payments, newest first</caption>
              <thead>
                <tr role="row">
                  <th scope="col" role="columnheader">
                    Reference
                  </th>
                  <th scope="col" role="columnheader">
                    Date
                  </th>
                  <th scope="col" role="columnheader">
                    Direction
                  </th>
                  <th scope="col" role="columnheader">
                    Method
                  </th>
                  <th scope="col" role="columnheader" className="th--number">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {(payments.data?.rows ?? []).map((payment) => (
                  <tr role="row" key={payment.id}>
                    <th scope="row" role="rowheader" data-label="Reference">
                      <span className="fin-cell__ref">{payment.reference ?? payment.id}</span>
                      {payment.attachmentId ? (
                        <span className="fin-cell__sub">Remittance attached</span>
                      ) : null}
                    </th>
                    <td role="cell" data-label="Date">
                      {dayText(payment.paymentDate)}
                    </td>
                    <td role="cell" data-label="Direction">
                      {payment.direction === "in" ? "Receipt in" : "Payment out"}
                    </td>
                    <td role="cell" data-label="Method">
                      {payment.method.replace(/_/g, " ")}
                    </td>
                    <td role="cell" data-label="Amount" className="td--number">
                      <Money pence={payment.amountPence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </FinanceState>
      </section>

      <PaymentRunsCard onNotify={onNotify} />
    </div>
  );
}

/* ── §6: recording one ────────────────────────────────────────────────────── */

function RecordPaymentCard({
  accounts,
  accountsUnavailable,
  onNotify,
  onRecorded,
}: {
  accounts: PaymentSource[];
  accountsUnavailable: boolean;
  onNotify: (message: string) => void;
  onRecorded: () => void;
}) {
  const write = useFinanceWrite();
  const today = todayDay();

  const [direction, setDirection] = useState<"in" | "out">("out");
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(today);
  const [method, setMethod] = useState<string>("bank_transfer");
  const [reference, setReference] = useState("");
  const [paymentSourceId, setPaymentSourceId] = useState("");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<AllocationDraft[]>([
    { key: "pay-1", targetId: "", amount: "" },
  ]);
  const [remittance, setRemittance] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  /* Money out settles payables, money in settles receivables — read from
     `settlingDirection` rather than restated, so the pairing has one home. */
  const settles: InvoiceDirection = settlingDirection("payable") === direction
    ? "payable"
    : "receivable";
  const candidates = useFinanceEndpoint<LedgerPayload>(
    "/api/finance/invoices",
    `direction=${settles}&limit=100`,
  );

  const open = useMemo(() => {
    const invoices = candidates.data?.invoices ?? [];
    return invoices.filter((invoice) => recordBalance(invoice).balancePence > 0);
  }, [candidates.data]);

  const options = open.map((invoice) => ({
    value: invoice.id,
    label: `${invoice.internalRef ?? invoice.invoiceNumber ?? invoice.id} · ${
      invoice.counterpartyName ?? "no counterparty"
    } · ${formatPence(recordBalance(invoice).balancePence)} outstanding`,
  }));

  const amountPence = fieldPence(amount);
  const state = draftState(amountPence ?? 0, rows);
  const ready = amountPence !== null && state.balanced && rows.every((row) => row.targetId !== "");

  const submit = async () => {
    if (amountPence === null) return;
    setBusy(true);
    setWarning(null);
    try {
      /*
       * THE REMITTANCE IS UPLOADED FIRST, and only when it can be anchored.
       *
       * §15.12 wants proof of payment against the payment record. The upload
       * route requires a job, site, unit or contractor to file the document
       * against — a payment on its own has none, so the anchor is taken from
       * the invoices this payment settles. With no anchor available the file is
       * refused here with a reason rather than sent to be refused with a 400.
       */
      let attachmentId: string | null = null;
      if (remittance) {
        const anchor = anchorFor(open, rows);
        if (!anchor) {
          setWarning(
            "A remittance has to be filed against a job or a site, and none of the invoices on "
              + "this payment names one. Record the payment and attach the remittance to the "
              + "invoice's job instead.",
          );
          setBusy(false);
          return;
        }
        const uploaded = await uploadEvidenceFile({
          file: remittance,
          kind: "general",
          ...anchor,
          title: `Remittance ${reference || paymentDate}`,
          documentType: "remittance",
        });
        attachmentId = uploaded.file?.id ?? null;
      }

      const result = await write.run("/api/finance/payments", {
        method: "POST",
        body: {
          direction,
          amountPence,
          paymentDate,
          method,
          reference: reference || undefined,
          paymentSourceId: paymentSourceId || undefined,
          note: note || undefined,
          attachmentId: attachmentId ?? undefined,
          allocations: rows.map((row) => ({
            invoiceId: row.targetId,
            amountPence: fieldPence(row.amount) ?? 0,
          })),
        },
      });
      if (!result.ok) return;

      const said = `Recorded ${formatPence(amountPence)} across ${plural(rows.length, "invoice")}.`;
      setDone(said);
      onNotify(said);
      setAmount("");
      setReference("");
      setNote("");
      setRows([{ key: `pay-${Date.now()}`, targetId: "", amount: "" }]);
      setRemittance(null);
      onRecorded();
      candidates.reload();

      /*
       * DID THE REMITTANCE ACTUALLY LAND? Read the payment back and look.
       *
       * `POST /api/finance/payments` does not carry `attachmentId` through to
       * the row today. Rather than show "remittance attached" on the strength
       * of having sent one, the record is re-read and the operator is told
       * plainly when the file did not stick — an unattached remittance
       * discovered six weeks later during a dispute is the expensive version of
       * this.
       */
      const id = typeof result.payload?.id === "string" ? result.payload.id : null;
      if (attachmentId && id) {
        const check = await fetch(`/api/finance/payments/${id}`, {
          headers: { Accept: "application/json" },
        });
        const payload = (await check.json().catch(() => null)) as
          | { payment?: { attachmentId?: string | null } }
          | null;
        if (check.ok && !payload?.payment?.attachmentId) {
          setWarning(
            "The payment was recorded, but the remittance was not stored against it: "
              + "POST /api/finance/payments does not accept an attachment yet. The document "
              + "itself is safe and is filed against the job.",
          );
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Record a payment</h2>
        <p className="fin-card__note">
          One payment, one or many invoices. The shares have to come to the payment exactly.
        </p>
      </div>
      <Refusal message={write.error} />
      {warning ? (
        <div className="fin-notice fin-notice--admin" role="note">
          <p>{warning}</p>
        </div>
      ) : null}
      <Confirmation message={done} />

      <div className="fin-form">
        <div className="fin-filters__row">
          <button
            type="button"
            className="fin-toggle"
            aria-pressed={direction === "out"}
            onClick={() => setDirection("out")}
          >
            Payment out — settles a payable
          </button>
          <button
            type="button"
            className="fin-toggle"
            aria-pressed={direction === "in"}
            onClick={() => setDirection("in")}
          >
            Receipt in — settles a receivable
          </button>
        </div>

        <div className="fin-form__grid">
          <MoneyField label="Amount" value={amount} onChange={setAmount} />
          <Field label="Payment date">
            <input
              type="date"
              value={paymentDate}
              onChange={(event) => setPaymentDate(event.target.value)}
            />
          </Field>
          <Field label="Method">
            <select value={method} onChange={(event) => setMethod(event.target.value)}>
              {PAYMENT_METHODS.map((option) => (
                <option key={option} value={option}>
                  {option.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reference">
            <input
              type="text"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Bank account"
            hint="From settings. Account details are never held in code."
          >
            {accountsUnavailable || accounts.length === 0 ? (
              <input
                type="text"
                value={paymentSourceId}
                onChange={(event) => setPaymentSourceId(event.target.value)}
                autoComplete="off"
                placeholder="No accounts configured"
              />
            ) : (
              <select
                value={paymentSourceId}
                onChange={(event) => setPaymentSourceId(event.target.value)}
              >
                <option value="">Not recorded</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Remittance advice" hint="Proof of payment, filed against the job.">
            <input
              type="file"
              onChange={(event) => setRemittance(event.target.files?.[0] ?? null)}
            />
          </Field>
          <Field label="Note">
            <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        </div>

        <h3 className="fin-section-title">Allocate it</h3>
        {candidates.unavailable ? (
          <DegradedNotice endpoint="/api/finance/invoices" what="The list of open invoices" />
        ) : open.length === 0 && !candidates.loading ? (
          <p className="fin-card__note">
            Nothing on the {settles} side has a balance outstanding, so there is nothing for this
            payment to settle.
          </p>
        ) : null}
        <AllocationEditor
          rows={rows}
          targetPence={amountPence ?? 0}
          targetLabel="Payment"
          rowLabel="Invoice"
          options={options}
          disabled={busy}
          onChange={setRows}
        />

        <div className="fin-actions fin-actions--end">
          <button
            type="button"
            className="fin-button fin-button--primary"
            disabled={busy || !ready}
            onClick={() => void submit()}
          >
            <Icon name="check" size={14} aria-hidden="true" /> Record the payment
          </button>
        </div>
        {!ready && amountPence !== null ? (
          <p className="fin-card__note">
            {state.balanced
              ? "Every line needs an invoice."
              : "The shares have to come to the payment before it can be recorded."}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The job or site the remittance can be filed against, from the invoices it settles. */
function anchorFor(
  invoices: readonly LedgerRow[],
  rows: readonly AllocationDraft[],
): { requestId?: string; siteId?: string } | null {
  for (const row of rows) {
    const invoice = invoices.find((entry) => entry.id === row.targetId);
    if (invoice?.requestId) return { requestId: invoice.requestId };
    if (invoice?.siteId) return { siteId: invoice.siteId };
  }
  return null;
}

/* ── §13: payment runs ────────────────────────────────────────────────────── */

function PaymentRunsCard({ onNotify }: { onNotify: (message: string) => void }) {
  const runs = useFinanceEndpoint<PaymentRunsPayload>("/api/finance/payment-runs");
  const write = useFinanceWrite();
  const [chosen, setChosen] = useState<string[]>([]);
  const [paymentDate, setPaymentDate] = useState(todayDay());
  const [done, setDone] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const rows = runs.data?.candidates ?? [];
  const list = runs.data?.runs ?? runs.data?.paymentRuns ?? [];
  const selectedTotal = rows
    .filter((row) => chosen.includes(row.id))
    .reduce((sum, row) => sum + row.balancePence, 0);

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Payment runs</h2>
        <p className="fin-card__note">
          Approved payables grouped into one batch with a payment date, exported as a bank-ready
          CSV and marked scheduled. Nobody should pay thirty invoices one at a time.
        </p>
      </div>
      <Refusal message={write.error} />
      <Refusal message={exportError} />
      <Confirmation message={done} />

      {runs.unavailable ? (
        <DegradedNotice
          endpoint="/api/finance/payment-runs"
          what="Payment runs"
          fallback="Each approved payable can still be scheduled one at a time from its own panel in the ledger."
        />
      ) : (
        <>
          <FinanceState
            loading={runs.loading}
            error={runs.error}
            unavailable={runs.unavailable}
            endpoint="/api/finance/payment-runs"
            what="Approved payables"
            empty={Boolean(runs.data) && rows.length === 0}
            emptyLabel="Nothing is approved for payment, so there is nothing to batch."
          >
            <ul className="fin-unbilled__list">
              {rows.map((row) => (
                <li className="fin-unbilled__job" key={row.id}>
                  <label className="fin-select">
                    <input
                      type="checkbox"
                      checked={chosen.includes(row.id)}
                      onChange={() =>
                        setChosen((current) =>
                          current.includes(row.id)
                            ? current.filter((id) => id !== row.id)
                            : [...current, row.id],
                        )
                      }
                    />
                    <span>
                      {row.internalRef ?? row.invoiceNumber ?? row.id} ·{" "}
                      {row.counterpartyName ?? "no counterparty"} · due {dayText(row.dueAt)}
                    </span>
                  </label>
                  <Money pence={row.balancePence} />
                </li>
              ))}
            </ul>
            <div className="fin-form__grid">
              <Field label="Payment date">
                <input
                  type="date"
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                />
              </Field>
            </div>
            <p className="fin-card__note">
              {plural(chosen.length, "invoice")} selected, <Money pence={selectedTotal} /> in total.
            </p>
            <div className="fin-actions fin-actions--end">
              <button
                type="button"
                className="fin-button fin-button--primary"
                disabled={write.busy || chosen.length === 0 || !paymentDate}
                onClick={() => {
                  void write
                    .run("/api/finance/payment-runs", {
                      method: "POST",
                      body: { paymentDate, invoiceIds: chosen },
                    })
                    .then((result) => {
                      if (!result.ok) return;
                      const said = `Grouped ${plural(chosen.length, "invoice")} into a run for ${paymentDate}.`;
                      setDone(said);
                      onNotify(said);
                      setChosen([]);
                      runs.reload();
                    });
                }}
              >
                Group into a run
              </button>
            </div>
          </FinanceState>

          <h3 className="fin-section-title">Runs</h3>
          {list.length === 0 ? (
            <p className="fin-card__note">No run has been created yet.</p>
          ) : (
            <ul className="fin-unbilled__list">
              {list.map((run) => (
                <li className="fin-unbilled__job" key={run.id}>
                  <span>
                    <strong>{run.reference}</strong> · {dayText(run.paymentDate)} · {run.status} ·{" "}
                    {plural(run.invoiceCount, "invoice")}
                    {run.exportedAt ? ` · exported ${dayText(run.exportedAt)}` : ""}
                  </span>
                  <span>
                    <Money pence={run.totalPence} />{" "}
                    <button
                      type="button"
                      className="fin-link-button"
                      disabled={exporting !== null}
                      onClick={() => {
                        setExporting(run.id);
                        setExportError(null);
                        void fetchDownload(`/api/finance/payment-runs/${run.id}/export`, {
                          method: "POST",
                          filename: `${run.reference}.csv`,
                        }).then((result) => {
                          setExporting(null);
                          if (!result.ok) {
                            setExportError(result.error);
                            return;
                          }
                          const said = `Exported ${run.reference} and marked the batch scheduled.`;
                          setDone(said);
                          onNotify(said);
                          runs.reload();
                        });
                      }}
                    >
                      Export the bank file
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
