"use client";

/**
 * ONE INVOICE, EVERYTHING HANGING OFF IT, AND EVERY ACTION §5 ALLOWS.
 *
 * Payable and receivable both open this panel; the words change through
 * `DIRECTION_WORDS` and nothing else does, which is §1's requirement stated in
 * code rather than in a comment.
 *
 * ── A REFUSAL IS EXPLAINED, NEVER JUST GREYED ─────────────────────────────
 *
 * Two things on this panel can be impossible, and both of them say why in a
 * sentence before they say no with a disabled control:
 *
 *   · EDITING A FINALISED INVOICE. §15.14 makes the accounting facts immutable
 *     after finalisation and the server enforces it with a 409 naming the
 *     fields. A greyed-out form teaches nothing; the panel prints the date it
 *     was finalised, the reason corrections go through credit notes, and puts
 *     the credit-note control next to the sentence — because that is the thing
 *     the operator actually came to do.
 *
 *   · APPROVING WITH A BLOCKING FLAG OPEN. §7 and §16: an invoice over its
 *     quote, or a possible duplicate, cannot be approved until the flag is
 *     cleared or waived with a typed reason. The panel names the flags that are
 *     blocking, in words, above the button — and the waiver control is in the
 *     flag list a few inches up the same panel.
 *
 * Both explanations are ALSO backed by the server: the buttons here are a
 * courtesy, and `fetch` from a console is bound by the route, not by this file.
 *
 * ── NOTHING HERE COMPUTES A BALANCE ───────────────────────────────────────
 *
 * §6. `recordBalance` hands the server's three measured figures to
 * `invoiceBalance`, and the payments list beside it is evidence, not an input.
 */

import { useCallback, useMemo, useState } from "react";
import { Icon } from "../../../components";
import { formatPence } from "../../../lib/finance/model";
import { SkeletonRow } from "../ops/ops-primitives";
import {
  AgeBadge,
  AllocationEditor,
  Confirmation,
  Facts,
  Field,
  FlagList,
  Money,
  MoneyField,
  FinanceStatusChip,
  PanelSection,
  Refusal,
  SidePanel,
  dayText,
  fieldPence,
  openBlockingCount,
  plural,
  todayDay,
  useFinanceEndpoint,
  useFinanceWrite,
  type AllocationDraft,
  type UiFlag,
} from "./finance-shared";
import { DIRECTION_WORDS, flagName, presentStatus, type StatusMapEntry } from "./finance-status";
import {
  directionOf,
  recordBalance,
  type FlagRecord,
  type InvoiceDetail,
} from "./finance-records";

export function InvoicePanel({
  invoiceId,
  statusMap,
  onClose,
  onChanged,
  onOpenJob,
  onNotify,
}: {
  invoiceId: string;
  statusMap?: readonly StatusMapEntry[] | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenJob: (id: string) => void;
  onNotify: (message: string) => void;
}) {
  const detail = useFinanceEndpoint<InvoiceDetail>(`/api/finance/invoices/${invoiceId}`);
  const write = useFinanceWrite();
  const [done, setDone] = useState<string | null>(null);
  const today = todayDay();

  const invoice = detail.data?.invoice ?? null;
  const direction = directionOf(invoice?.direction);
  const words = DIRECTION_WORDS[direction];
  const flags: UiFlag[] = useMemo(
    () => (detail.data?.flags ?? []).map(asUiFlag),
    [detail.data],
  );
  const blocking = openBlockingCount(flags);

  /** Every write goes through here, so the reload and the toast are not five copies. */
  const act = useCallback(
    async (path: string, init: { method: string; body?: unknown }, said: string) => {
      const result = await write.run(path, init);
      if (!result.ok) return result;
      setDone(said);
      onNotify(said);
      detail.reload();
      onChanged();
      return result;
    },
    [detail, onChanged, onNotify, write],
  );

  const title = invoice
    ? `${invoice.internalRef ?? invoice.invoiceNumber ?? "Invoice"}`
    : "Invoice";

  return (
    <SidePanel
      title={title}
      subtitle={
        invoice ? (
          <>
            {words.title} · {invoice.counterpartyName ?? "no counterparty recorded"}
          </>
        ) : null
      }
      onClose={onClose}
    >
      {detail.loading && !invoice ? <SkeletonRow lines={4} height={120} /> : null}
      {detail.error && !invoice ? <Refusal message={detail.error} /> : null}
      <Refusal message={write.error} />
      <Confirmation message={done} />

      {invoice ? (
        <>
          <PanelSection title="The record">
            <p className="fin-card__head">
              <FinanceStatusChip presentation={presentStatus(invoice.status, statusMap)} />{" "}
              <AgeBadge dueDay={invoice.dueAt} today={today} />
            </p>
            <Facts
              rows={[
                [words.numberLabel, invoice.invoiceNumber],
                ["Internal reference", invoice.internalRef],
                [words.counterparty, invoice.counterpartyName],
                [
                  words.departmentLabel,
                  direction === "payable" ? invoice.fromDepartment : invoice.toDepartment,
                ],
                ["FAO", invoice.faoContact],
                ["Invoice date", dayText(invoice.invoiceDate)],
                [
                  words.dateLabel,
                  dayText(direction === "payable" ? invoice.receivedDate : invoice.sentDate),
                ],
                ["Due date", dayText(invoice.dueAt)],
                [
                  "Payment terms",
                  invoice.paymentTermsDays === null
                    ? null
                    : invoice.paymentTermsDays === 0
                      ? "On receipt"
                      : `${invoice.paymentTermsDays} days`,
                ],
                ["Net", <Money key="net" pence={invoice.netPence} currency={invoice.currency ?? undefined} />],
                ["VAT", <Money key="vat" pence={invoice.vatPence} currency={invoice.currency ?? undefined} />],
                ["Gross", <Money key="gross" pence={invoice.grossPence} currency={invoice.currency ?? undefined} />],
                ["Category", invoice.category],
                ["Cost centre", invoice.costCentre],
                ["Site", invoice.siteId],
                ["Quote", invoice.quoteId],
                ["PO number", invoice.poNumber],
                ["Currency", invoice.currency],
                ["Recorded by", invoice.createdBy],
              ]}
            />
            {invoice.notes ? <p className="fin-card__note">{invoice.notes}</p> : null}
          </PanelSection>

          <BalanceSection detail={detail.data} />

          <EditSection
            detail={detail.data}
            busy={write.busy}
            onSave={(body) =>
              act(`/api/finance/invoices/${invoiceId}`, { method: "PATCH", body }, "Saved.")
            }
          />

          <PanelSection title="Job allocations">
            <AllocationSection
              detail={detail.data}
              busy={write.busy}
              onOpenJob={onOpenJob}
              onSave={(allocations) =>
                act(
                  `/api/finance/invoices/${invoiceId}/allocations`,
                  { method: "PUT", body: { allocations } },
                  "Allocations saved.",
                )
              }
            />
          </PanelSection>

          <PanelSection title="Three-way match">
            <FlagList
              flags={flags}
              busy={write.busy}
              onWaive={(flag, reason) =>
                void act(
                  `/api/finance/invoices/${invoiceId}/flags`,
                  { method: "POST", body: { action: "waive", flagId: flag.id, reason } },
                  `Waived the ${flagName(flag.flagType)} flag.`,
                )
              }
              onClear={(flag) =>
                void act(
                  `/api/finance/invoices/${invoiceId}/flags`,
                  { method: "POST", body: { action: "clear", flagId: flag.id } },
                  `Cleared the ${flagName(flag.flagType)} flag.`,
                )
              }
            />
            <div className="fin-actions">
              <button
                type="button"
                className="fin-button"
                disabled={write.busy}
                onClick={() =>
                  void act(
                    `/api/finance/invoices/${invoiceId}/actions`,
                    { method: "POST", body: { action: "rematch" } },
                    "The three-way match has been run again.",
                  )
                }
              >
                <Icon name="refresh" size={14} aria-hidden="true" /> Run the match again
              </button>
            </div>
          </PanelSection>

          <PaymentsSection detail={detail.data} />

          <CreditNoteSection
            detail={detail.data}
            busy={write.busy}
            onIssue={(body) =>
              act("/api/finance/credit-notes", { method: "POST", body }, "Credit note issued.")
            }
          />

          <PanelSection title="What can happen next">
            <ActionSection
              detail={detail.data}
              blocking={blocking}
              flags={flags}
              busy={write.busy}
              onAct={(body, said) =>
                act(`/api/finance/invoices/${invoiceId}/actions`, { method: "POST", body }, said)
              }
            />
          </PanelSection>

          <PanelSection title="History">
            <HistorySection detail={detail.data} statusMap={statusMap} />
          </PanelSection>
        </>
      ) : null}
    </SidePanel>
  );
}

/* ── §6: the balance, computed ────────────────────────────────────────────── */

function BalanceSection({ detail }: { detail: InvoiceDetail | null }) {
  if (!detail) return null;
  const balance = recordBalance({
    grossPence: detail.invoice.grossPence,
    balance: detail.balance,
  });
  return (
    <PanelSection title="Balance">
      <Facts
        rows={[
          ["Gross", <Money key="g" pence={balance.grossPence} />],
          ["Paid", <Money key="p" pence={balance.paidPence} />],
          ["Credited", <Money key="c" pence={balance.creditedPence} />],
          [
            "Outstanding",
            <strong key="b">
              <Money pence={balance.balancePence} />
            </strong>,
          ],
        ]}
      />
      <p className="fin-card__note">
        Gross less what has been allocated to it in payments, less credit notes. Computed here and
        on the server by the same function, and stored nowhere.
        {balance.overpaidPence > 0 ? (
          <>
            {" "}
            <strong>
              This invoice has been over-paid by {formatPence(balance.overpaidPence)}.
            </strong>{" "}
            That is what a duplicate payment looks like — check the payments below before doing
            anything else.
          </>
        ) : null}
      </p>
    </PanelSection>
  );
}

/* ── §15.14: the edit path, which explains itself ─────────────────────────── */

/**
 * WHAT CAN STILL BE CHANGED, AND WHY THE REST CANNOT.
 *
 * A finalised invoice keeps exactly one editable field — `notes` — because the
 * server keeps exactly one, and for the reason it gives: refusing commentary
 * pushes people into editing the figures in order to write something down.
 * Everything else is refused with the date, the rule and the remedy, in that
 * order, ABOVE the form rather than as a tooltip on a dead control.
 */
function EditSection({
  detail,
  busy,
  onSave,
}: {
  detail: InvoiceDetail | null;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<{ ok: boolean }>;
}) {
  const invoice = detail?.invoice ?? null;
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [gross, setGross] = useState("");

  /* Seeded from the record when the form is OPENED, not on every render: a
     controlled input reset from props while somebody is typing in it is the
     bug that eats the last two characters of every entry. */
  const start = () => {
    if (!invoice) return;
    setNotes(invoice.notes ?? "");
    setInvoiceNumber(invoice.invoiceNumber ?? "");
    setCounterparty(invoice.counterpartyName ?? "");
    setDueDate(dayText(invoice.dueAt) === "—" ? "" : dayText(invoice.dueAt));
    setGross(invoice.grossPence === null ? "" : String(invoice.grossPence));
    setOpen(true);
  };

  if (!invoice) return null;
  const frozen = Boolean(invoice.finalisedAt);
  const voided = Boolean(invoice.voidedAt);

  return (
    <PanelSection title="Edit">
      {voided ? (
        <div className="fin-notice fin-notice--refused" role="note">
          <p>
            This invoice was voided
            {invoice.voidedAt ? ` on ${dayText(invoice.voidedAt)}` : ""}
            {invoice.voidReason ? `: ${invoice.voidReason}` : "."} A voided invoice keeps the
            figures it was issued with, because that is the evidence it was issued. Nothing on it
            can be changed, including its notes.
          </p>
        </div>
      ) : frozen ? (
        <div className="fin-notice fin-notice--admin" role="note">
          <p>
            <strong>
              This invoice was finalised on {dayText(invoice.finalisedAt)}
              {invoice.finalisedBy ? ` by ${invoice.finalisedBy}` : ""}, so its accounting fields
              can no longer be edited.
            </strong>{" "}
            The amounts, dates, counterparty, quote, site, category and cost centre are the
            accounting record from that moment on. A correction is a credit note against this
            invoice, never an edit to it — so that what was sent to the counterparty and what the
            ledger holds can never quietly differ.
          </p>
          <p>
            Its notes can still be changed. A note moves no figure, and refusing one only pushes
            people into editing the fields that matter in order to record something.
          </p>
        </div>
      ) : null}

      {!open ? (
        <div className="fin-actions">
          <button type="button" className="fin-button" disabled={voided} onClick={start}>
            <Icon name="edit" size={14} aria-hidden="true" />{" "}
            {frozen ? "Edit the notes" : "Edit this invoice"}
          </button>
        </div>
      ) : (
        <div className="fin-form">
          <div className="fin-form__grid">
            {!frozen ? (
              <>
                <Field label="Invoice number">
                  <input
                    type="text"
                    value={invoiceNumber}
                    onChange={(event) => setInvoiceNumber(event.target.value)}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Counterparty">
                  <input
                    type="text"
                    value={counterparty}
                    onChange={(event) => setCounterparty(event.target.value)}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Due date" hint="YYYY-MM-DD.">
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(event) => setDueDate(event.target.value)}
                  />
                </Field>
                <MoneyField label="Gross" value={gross} onChange={setGross} />
              </>
            ) : null}
            <Field label="Notes">
              <textarea
                value={notes}
                rows={3}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </div>
          <div className="fin-actions fin-actions--end">
            <button type="button" className="fin-button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="fin-button fin-button--primary"
              disabled={busy}
              onClick={() => {
                const body: Record<string, unknown> = { notes };
                if (!frozen) {
                  body.invoiceNumber = invoiceNumber;
                  body.counterpartyName = counterparty;
                  if (dueDate) body.dueDate = dueDate;
                  const parsed = fieldPence(gross);
                  if (parsed !== null) body.grossPence = parsed;
                }
                void onSave(body).then((result) => {
                  if (result.ok) setOpen(false);
                });
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </PanelSection>
  );
}

/* ── §4: the split, forced to sum ─────────────────────────────────────────── */

function AllocationSection({
  detail,
  busy,
  onOpenJob,
  onSave,
}: {
  detail: InvoiceDetail | null;
  busy: boolean;
  onOpenJob: (id: string) => void;
  onSave: (allocations: Array<{ requestId: string; amountPence: number }>) => Promise<{ ok: boolean }>;
}) {
  const invoice = detail?.invoice ?? null;
  const allocations = useMemo(() => detail?.allocations ?? [], [detail]);
  const [rows, setRows] = useState<AllocationDraft[] | null>(null);

  /*
   * The draft is derived from the server's rows until somebody edits it, and
   * `null` is what "nobody has edited it" looks like. Deriving it in an effect
   * with `setRows` would be a synchronous state write inside an effect, which
   * the React Compiler rules make an error — and it would also fight the user
   * every time the panel refetched.
   */
  const draft: AllocationDraft[] = rows
    ?? allocations.map((row, index) => ({
      key: `alloc-${row.id ?? index}`,
      targetId: row.requestId,
      amount: String(row.amountPence),
      note: row.note ?? undefined,
    }));
  const editable = draft.length > 0
    ? draft
    : [{ key: "alloc-new", targetId: invoice?.requestId ?? "", amount: "" }];

  if (!invoice) return null;
  const target = invoice.netPence ?? invoice.grossPence ?? 0;
  const frozen = Boolean(invoice.finalisedAt || invoice.voidedAt);

  return (
    <>
      <p className="fin-card__note">
        A contractor invoice covering four jobs splits across those four jobs, and the shares have
        to come to the invoice net of {formatPence(target)} exactly. The server refuses a
        finalisation that does not balance, so the difference is shown live below rather than
        discovered at the end.
      </p>
      {allocations.length > 0 ? (
        <ul className="fin-unbilled__list">
          {allocations.map((row) => (
            <li className="fin-unbilled__job" key={row.id}>
              <button
                type="button"
                className="fin-link-button"
                onClick={() => onOpenJob(row.requestId)}
                aria-label={`Open job ${row.requestId}`}
              >
                {row.requestId}
              </button>
              <Money pence={row.amountPence} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="fin-card__note">
          Nothing is allocated yet, so no cost from this invoice lands on any job.
        </p>
      )}

      {frozen ? (
        <p className="fin-card__note">
          The allocations decide which job carries which cost, so they are part of the accounting
          record and are frozen with the rest of it. A correction goes through a credit note.
        </p>
      ) : (
        <>
          <AllocationEditor
            rows={editable}
            targetPence={target}
            targetLabel="Invoice net"
            rowLabel="Job"
            disabled={busy}
            onChange={setRows}
          />
          <div className="fin-actions fin-actions--end">
            <button
              type="button"
              className="fin-button fin-button--primary"
              disabled={busy}
              onClick={() => {
                void onSave(
                  editable
                    .filter((row) => row.targetId.trim() !== "")
                    .map((row) => ({
                      requestId: row.targetId.trim(),
                      amountPence: fieldPence(row.amount) ?? 0,
                    })),
                ).then((result) => {
                  if (result.ok) setRows(null);
                });
              }}
            >
              Save the split
            </button>
          </div>
        </>
      )}
    </>
  );
}

/* ── §6: payments and credit notes, as evidence ───────────────────────────── */

function PaymentsSection({ detail }: { detail: InvoiceDetail | null }) {
  const payments = detail?.payments ?? [];
  return (
    <PanelSection title="Payments">
      {payments.length === 0 ? (
        <p className="fin-card__note">No payment has been allocated to this invoice.</p>
      ) : (
        <ul className="fin-unbilled__list">
          {payments.map((payment) => (
            <li className="fin-unbilled__job" key={payment.id}>
              <span>
                {dayText(payment.paymentDate)} · {payment.method.replace(/_/g, " ")}
                {payment.reference ? ` · ${payment.reference}` : ""}
                {payment.attachmentId ? " · remittance attached" : ""}
              </span>
              <Money pence={payment.amountPence} />
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}

function CreditNoteSection({
  detail,
  busy,
  onIssue,
}: {
  detail: InvoiceDetail | null;
  busy: boolean;
  onIssue: (body: Record<string, unknown>) => Promise<{ ok: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const notes = detail?.creditNotes ?? [];

  if (!detail) return null;
  return (
    <PanelSection title="Credit notes">
      {notes.length === 0 ? (
        <p className="fin-card__note">
          None. A credit note is how a finalised invoice is corrected: it reduces the balance
          without editing a figure anybody has already been sent.
        </p>
      ) : (
        <ul className="fin-unbilled__list">
          {notes.map((note) => (
            <li className="fin-unbilled__job" key={note.id}>
              <span>
                <strong>{note.reference ?? note.id}</strong> · {dayText(note.issuedDate)} ·{" "}
                {note.reason}
              </span>
              <Money pence={note.amountPence} />
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <div className="fin-form">
          <div className="fin-form__grid">
            <MoneyField
              label="Credit amount"
              value={amount}
              onChange={setAmount}
              hint="Positive. What it does to the balance is decided by the ledger."
            />
            <Field
              label="Reason"
              hint="Recorded on the credit note. An unexplained reduction is the hardest thing to answer for later."
            >
              <input
                type="text"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="fin-actions fin-actions--end">
            <button type="button" className="fin-button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="fin-button fin-button--primary"
              disabled={busy || fieldPence(amount) === null || reason.trim().length < 4}
              onClick={() => {
                void onIssue({
                  invoiceId: detail.invoice.id,
                  amountPence: fieldPence(amount),
                  reason: reason.trim(),
                }).then((result) => {
                  if (result.ok) {
                    setOpen(false);
                    setAmount("");
                    setReason("");
                  }
                });
              }}
            >
              Issue the credit note
            </button>
          </div>
        </div>
      ) : (
        <div className="fin-actions">
          <button type="button" className="fin-button" onClick={() => setOpen(true)}>
            <Icon name="reply" size={14} aria-hidden="true" /> Raise a credit note
          </button>
        </div>
      )}
    </PanelSection>
  );
}

/* ── §5 and §13: the transitions ──────────────────────────────────────────── */

function ActionSection({
  detail,
  blocking,
  flags,
  busy,
  onAct,
}: {
  detail: InvoiceDetail | null;
  blocking: number;
  flags: readonly UiFlag[];
  busy: boolean;
  onAct: (body: Record<string, unknown>, said: string) => Promise<{ ok: boolean }>;
}) {
  const [reason, setReason] = useState("");
  const [paymentDate, setPaymentDate] = useState("");

  if (!detail) return null;
  const invoice = detail.invoice;
  const direction = directionOf(invoice.direction);
  const words = DIRECTION_WORDS[direction];
  const progress = detail.approvalProgress;
  const voided = Boolean(invoice.voidedAt);
  const blockingNames = flags
    .filter((flag) => flag.status === "open" && flag.severity === "blocking")
    .map((flag) => flagName(flag.flagType));

  return (
    <>
      {progress ? (
        <p className="fin-card__note">
          {progress.band
            ? `This amount falls in the band needing ${plural(progress.required, "approver")}; ${progress.held} recorded so far.`
            : "No approval band covers this amount, so the server will refuse an approval until the ladder in Settings is filled in."}
          {progress.band?.requiresClient
            ? " The client's sign-off has to be recorded against the quote as well."
            : ""}
        </p>
      ) : null}

      {blocking > 0 ? (
        <div className="fin-notice fin-notice--admin" role="note">
          <p>
            <strong>
              {words.approveLabel} is blocked while {plural(blocking, "flag")}{" "}
              {blocking === 1 ? "is" : "are"} open: {blockingNames.join(", ")}.
            </strong>{" "}
            The three-way match raised {blocking === 1 ? "it" : "them"} against this invoice, and a
            duplicate payment is the most expensive routine failure there is in accounts payable.
            Clear {blocking === 1 ? "it" : "them"} in the match section above, or waive{" "}
            {blocking === 1 ? "it" : "them"} with a typed reason that will be recorded against the
            invoice with your name.
          </p>
        </div>
      ) : null}

      <Field
        label="Reason"
        hint="Required to raise a query, dispute or void. Recorded with your name and the time."
      >
        <input
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          autoComplete="off"
        />
      </Field>

      <div className="fin-actions">
        <button
          type="button"
          className="fin-button"
          disabled={busy || voided}
          onClick={() => void onAct({ action: "submit" }, "Submitted for review.")}
        >
          Submit for review
        </button>

        <button
          type="button"
          className="fin-button fin-button--primary"
          disabled={busy || voided || blocking > 0}
          onClick={() => void onAct({ action: "approve" }, `${words.approveLabel} recorded.`)}
        >
          <Icon name="check" size={14} aria-hidden="true" /> {words.approveLabel}
        </button>

        <button
          type="button"
          className="fin-button"
          disabled={busy || voided || reason.trim().length === 0}
          onClick={() =>
            void onAct({ action: "reject", reason: reason.trim() }, "Query raised.")
          }
        >
          Raise a query
        </button>

        <button
          type="button"
          className="fin-button"
          disabled={busy || voided || reason.trim().length === 0}
          onClick={() => void onAct({ action: "dispute", reason: reason.trim() }, "Dispute logged.")}
        >
          Dispute
        </button>

        <button
          type="button"
          className="fin-button"
          disabled={busy || voided}
          onClick={() =>
            void onAct(
              { action: "finalise", reason: reason.trim() || undefined },
              "Finalised. The accounting fields are now immutable.",
            )
          }
        >
          Finalise
        </button>

        <button
          type="button"
          className="fin-button fin-button--danger"
          disabled={busy || voided || reason.trim().length === 0}
          onClick={() => void onAct({ action: "void", reason: reason.trim() }, "Voided.")}
        >
          Void
        </button>
      </div>

      <div className="fin-form__grid">
        <Field label="Payment date" hint="The day the money is going out. Scheduling needs one.">
          <input
            type="date"
            value={paymentDate}
            onChange={(event) => setPaymentDate(event.target.value)}
          />
        </Field>
      </div>
      <div className="fin-actions">
        <button
          type="button"
          className="fin-button"
          disabled={busy || voided || !paymentDate}
          onClick={() =>
            void onAct({ action: "schedule", paymentDate }, `Scheduled for ${paymentDate}.`)
          }
        >
          <Icon name="calendar" size={14} aria-hidden="true" /> Schedule the payment
        </button>
      </div>

      {detail.disputes.filter((dispute) => dispute.status === "open").length > 0 ? (
        <div className="fin-actions">
          <button
            type="button"
            className="fin-button"
            disabled={busy || reason.trim().length === 0}
            onClick={() =>
              void onAct(
                { action: "resolve_dispute", resolution: reason.trim() },
                "Dispute resolved.",
              )
            }
          >
            Resolve the dispute with that reason
          </button>
        </div>
      ) : null}
    </>
  );
}

/* ── §2: the audit trail, which is the point of the module ────────────────── */

function HistorySection({
  detail,
  statusMap,
}: {
  detail: InvoiceDetail | null;
  statusMap?: readonly StatusMapEntry[] | null;
}) {
  const history = detail?.history ?? [];
  const disputes = detail?.disputes ?? [];
  return (
    <>
      {history.length === 0 ? (
        <p className="fin-card__note">Nothing has happened to this invoice since it was recorded.</p>
      ) : (
        <ol className="fin-trail">
          {history.map((entry) => (
            <li key={entry.id}>
              <span>
                <FinanceStatusChip
                  presentation={presentStatus(entry.toStatus, statusMap)}
                  size="small"
                />
                {entry.fromStatus ? ` from ${entry.fromStatus.replace(/_/g, " ")}` : ""}
              </span>
              <span className="fin-trail__who">
                {dayText(entry.createdAt)} · {entry.actorEmail ?? "unattributed"}
                {entry.reason ? ` · ${entry.reason}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
      {disputes.length > 0 ? (
        <>
          <h4 className="fin-section-title">Disputes</h4>
          <ol className="fin-trail">
            {disputes.map((dispute) => (
              <li key={dispute.id}>
                <span>
                  {dispute.status === "open" ? "Open" : "Resolved"} · {dispute.reason}
                </span>
                <span className="fin-trail__who">
                  raised {dayText(dispute.raisedAt)} by {dispute.raisedBy ?? "somebody"}
                  {dispute.resolution ? ` · ${dispute.resolution}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </>
  );
}

/* ── Small ────────────────────────────────────────────────────────────────── */

function asUiFlag(flag: FlagRecord): UiFlag {
  return {
    id: flag.id,
    flagType: flag.flagType,
    severity: flag.severity === "warning" ? "warning" : "blocking",
    status: flag.status === "waived" ? "waived" : flag.status === "cleared" ? "cleared" : "open",
    detail: flag.detail,
    waivedBy: flag.waivedBy,
    waiveReason: flag.waiveReason,
  };
}
