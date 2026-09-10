"use client";

/**
 * QUOTES — §3. Where cost control actually happens, and the comparison view.
 *
 * ── WHY THE COMPARISON IS THE POINT OF THIS TAB ───────────────────────────
 *
 * §3: "Three quotes on a £6,500 project is a very different conversation with a
 * client than one." So a job with more than one quote is drawn as a row of
 * cards side by side — amount, date, validity, status, each one's own approve
 * and reject — rather than as three lines in a list a reader has to hold in
 * their head. The cheapest is marked, and marked as an observation rather than
 * as a recommendation: the cheapest quote is frequently the wrong one, and the
 * screen's job is to make the difference visible, not to make the decision.
 *
 * ── APPROVING ONE REJECTS THE OTHERS, AND THE REASON IS TYPED ONCE ────────
 *
 * `POST /api/finance/quotes/[id]/actions {action:"approve"}` approves the
 * winner and rejects every sibling with the reason it is given, recording
 * `superseded_by_id` on each — so the comparison can be reconstructed a year
 * later. The reason box above the cards is that one reason. Left blank, the
 * server writes "<ref> was approved for this job instead", which is true but
 * says nothing about WHY, so the field asks for it.
 *
 * ── EXPIRY IS ON EVERY CARD ───────────────────────────────────────────────
 *
 * "An expired quote on an unstarted job is money quietly leaking." The badge is
 * the same one the ledger uses for a due date — same arithmetic, same four
 * colour bands — re-worded through `kind="expiry"`, because a quote was never
 * owed and "40 days overdue" is the wrong sentence for one.
 */

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import { formatPence, QUOTE_STATUS_KEYS } from "../../../lib/finance/model";
import { useQueryValue } from "../ops/ops-url-state";
import {
  AgeBadge,
  Confirmation,
  Field,
  FinanceState,
  FinanceStatusChip,
  Money,
  MoneyField,
  Refusal,
  dayText,
  fieldPence,
  plural,
  todayDay,
  useFinanceEndpoint,
  useFinanceWrite,
} from "./finance-shared";
import { presentQuoteStatus } from "./finance-status";
import type { QuotePayload, QuoteRecord } from "./finance-records";

export function FinanceQuotes({
  onOpenJob,
  onNotify,
}: {
  onOpenJob: (id: string) => void;
  onNotify: (message: string) => void;
}) {
  const today = todayDay();
  const [job, setJob] = useQueryValue("qjob", "");
  const [status, setStatus] = useQueryValue("qstatus", "");
  const [expired, setExpired] = useQueryValue("qexpired", "");
  const [search, setSearch] = useQueryValue("qq", "");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", "100");
    if (job) params.set("job", job);
    if (status) params.append("status", status);
    if (expired === "1") params.set("expired", "1");
    if (search) params.set("q", search);
    return params.toString();
  }, [expired, job, search, status]);

  const quotes = useFinanceEndpoint<QuotePayload>("/api/finance/quotes", query);
  const write = useFinanceWrite();
  const [done, setDone] = useState<string | null>(null);

  const rows = useMemo(() => quotes.data?.quotes ?? [], [quotes.data]);
  const jobs = useMemo(() => groupByJob(rows), [rows]);
  const compared = jobs.filter((group) => group.quotes.length > 1);

  const act = async (id: string, body: Record<string, unknown>, said: string) => {
    const result = await write.run(`/api/finance/quotes/${id}/actions`, { method: "POST", body });
    if (!result.ok) return result;
    setDone(said);
    onNotify(said);
    quotes.reload();
    return result;
  };

  return (
    <div className="fin-stack">
      <section className="fin-card">
        <div className="fin-card__head">
          <h2>Quotes</h2>
          <p className="fin-card__note">
            Quotes come before invoices and are where cost control happens. Every one is a record
            against a job, never an attachment on it.
          </p>
        </div>

        <div className="fin-filters">
          <div className="fin-filters__row">
            <Field label="Search" hint="Internal reference, supplier reference or description.">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Job">
              <input
                type="text"
                value={job}
                onChange={(event) => setJob(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Status">
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">Any status</option>
                {QUOTE_STATUS_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {presentQuoteStatus(key).label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="fin-filters__row">
            <button
              type="button"
              className="fin-toggle"
              aria-pressed={expired === "1"}
              onClick={() => setExpired(expired === "1" ? "" : "1")}
            >
              <Icon name="clock" size={13} aria-hidden="true" /> Already lapsed only
            </button>
          </div>
        </div>

        <Refusal message={write.error} />
        <Confirmation message={done} />
      </section>

      <section className="fin-card">
        <div className="fin-card__head">
          <h2>Comparison</h2>
          <p className="fin-card__note">
            {compared.length === 0
              ? "No job in this set has more than one quote against it."
              : `${plural(compared.length, "job")} with competing quotes. Approving one rejects the others and records why on each.`}
          </p>
        </div>
        <FinanceState
          loading={quotes.loading}
          error={quotes.error}
          unavailable={quotes.unavailable}
          endpoint="/api/finance/quotes"
          what="Quotes"
          empty={compared.length === 0}
          emptyLabel="Nothing to compare: every job here has a single quote. The list below has all of them."
          onRetry={quotes.reload}
        >
          {compared.map((group) => (
            <QuoteComparison
              key={group.requestId}
              group={group}
              today={today}
              busy={write.busy}
              onOpenJob={onOpenJob}
              onAct={act}
            />
          ))}
        </FinanceState>
      </section>

      <section className="fin-card">
        <div className="fin-card__head">
          <h2>Every quote</h2>
          <p className="fin-card__note">{plural(rows.length, "quote")} in this filter.</p>
        </div>
        <FinanceState
          loading={quotes.loading}
          error={quotes.error}
          unavailable={quotes.unavailable}
          endpoint="/api/finance/quotes"
          what="Quotes"
          empty={Boolean(quotes.data) && rows.length === 0}
          emptyLabel="No quote matches those filters."
          onRetry={quotes.reload}
        >
          <div className="fin-table-wrap">
            <table className="fin-table" role="table">
              <caption className="visually-hidden">Quotes, {plural(rows.length, "row")}</caption>
              <thead>
                <tr role="row">
                  <th scope="col" role="columnheader">
                    Reference
                  </th>
                  <th scope="col" role="columnheader">
                    Job
                  </th>
                  <th scope="col" role="columnheader">
                    Status
                  </th>
                  <th scope="col" role="columnheader">
                    Valid until
                  </th>
                  <th scope="col" role="columnheader" className="th--number">
                    Gross
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((quote) => (
                  <tr role="row" key={quote.id}>
                    <th scope="row" role="rowheader" data-label="Reference">
                      <span className="fin-cell__ref">
                        {quote.internalRef ?? quote.supplierRef ?? quote.id}
                      </span>
                      {quote.description ? (
                        <span className="fin-cell__sub">{quote.description}</span>
                      ) : null}
                    </th>
                    <td role="cell" data-label="Job">
                      <button
                        type="button"
                        className="fin-link-button"
                        onClick={() => onOpenJob(quote.requestId)}
                        aria-label={`Open job ${quote.requestId}`}
                      >
                        {quote.requestId}
                      </button>
                    </td>
                    <td role="cell" data-label="Status">
                      <FinanceStatusChip
                        presentation={presentQuoteStatus(quote.statusKey ?? quote.status)}
                        size="small"
                      />
                      {quote.approvedBy ? (
                        <span className="fin-cell__sub">
                          approved by {quote.approvedBy} on {dayText(quote.approvedAt)}
                        </span>
                      ) : null}
                      {quote.rejectedReason ? (
                        <span className="fin-cell__sub">rejected: {quote.rejectedReason}</span>
                      ) : null}
                    </td>
                    <td role="cell" data-label="Valid until">
                      <span className="fin-cell__ref">{dayText(quote.validUntil)}</span>
                      <AgeBadge dueDay={quote.validUntil} today={today} kind="expiry" />
                    </td>
                    <td role="cell" data-label="Gross" className="td--number">
                      <Money pence={quote.grossPence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </FinanceState>
      </section>

      <CreateQuoteCard
        onNotify={onNotify}
        onCreated={() => {
          quotes.reload();
        }}
      />
    </div>
  );
}

/* ── The comparison ───────────────────────────────────────────────────────── */

interface JobGroup {
  requestId: string;
  quotes: QuoteRecord[];
}

function groupByJob(rows: readonly QuoteRecord[]): JobGroup[] {
  const groups = new Map<string, QuoteRecord[]>();
  for (const quote of rows) {
    const existing = groups.get(quote.requestId);
    if (existing) existing.push(quote);
    else groups.set(quote.requestId, [quote]);
  }
  return [...groups.entries()]
    .map(([requestId, quotes]) => ({ requestId, quotes }))
    .sort((a, b) => b.quotes.length - a.quotes.length || a.requestId.localeCompare(b.requestId));
}

function QuoteComparison({
  group,
  today,
  busy,
  onOpenJob,
  onAct,
}: {
  group: JobGroup;
  today: string;
  busy: boolean;
  onOpenJob: (id: string) => void;
  onAct: (
    id: string,
    body: Record<string, unknown>,
    said: string,
  ) => Promise<{ ok: boolean }>;
}) {
  const [reason, setReason] = useState("");

  const amounts = group.quotes
    .map((quote) => quote.grossPence ?? 0)
    .filter((amount) => amount > 0);
  const cheapest = amounts.length > 0 ? Math.min(...amounts) : null;
  const dearest = amounts.length > 0 ? Math.max(...amounts) : null;
  const spread = cheapest !== null && dearest !== null ? dearest - cheapest : 0;

  return (
    <div className="fin-panel__section">
      <h3 className="fin-section-title">
        <button
          type="button"
          className="fin-link-button"
          onClick={() => onOpenJob(group.requestId)}
          aria-label={`Open job ${group.requestId}`}
        >
          {group.requestId}
        </button>{" "}
        · {plural(group.quotes.length, "quote")}
        {spread > 0 ? ` · ${formatPence(spread)} between the highest and the lowest` : ""}
      </h3>

      <Field
        label="Why this one"
        hint="Written onto every quote this decision rejects, so the choice can be read back later."
      >
        <input
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          autoComplete="off"
        />
      </Field>

      <div className="fin-compare">
        {group.quotes.map((quote) => {
          const key = quote.statusKey ?? quote.status;
          const approved = key === "approved";
          const rejected = key === "rejected" || key === "superseded";
          return (
            <article
              className={`fin-compare__card${approved ? " fin-compare__card--approved" : ""}${
                rejected ? " fin-compare__card--rejected" : ""
              }${cheapest !== null && (quote.grossPence ?? 0) === cheapest ? " fin-compare__card--cheapest" : ""}`}
              key={quote.id}
            >
              <FinanceStatusChip presentation={presentQuoteStatus(key)} size="small" />
              <span className="fin-compare__amount">
                <Money pence={quote.grossPence} />
              </span>
              <span className="fin-card__note">
                {quote.internalRef ?? quote.id}
                {quote.supplierRef ? ` · their ref ${quote.supplierRef}` : ""}
                {quote.contractorId ? ` · ${quote.contractorId}` : ""}
              </span>
              <span className="fin-card__note">
                Quoted {dayText(quote.quoteDate)} · valid until {dayText(quote.validUntil)}
              </span>
              <AgeBadge dueDay={quote.validUntil} today={today} kind="expiry" />
              {quote.description ? <p className="fin-card__note">{quote.description}</p> : null}
              {quote.clientApprovalRequired ? (
                <p className="fin-card__note">
                  {quote.clientApprovedBy
                    ? `Client sign-off recorded: ${quote.clientApprovedBy}, ${dayText(quote.clientApprovedAt)}.`
                    : "Needs the client's sign-off before it can be approved."}
                </p>
              ) : null}
              {quote.approvedBy ? (
                <p className="fin-card__note">
                  Approved by {quote.approvedBy} on {dayText(quote.approvedAt)}.
                </p>
              ) : null}
              {quote.rejectedReason ? (
                <p className="fin-card__note">Rejected: {quote.rejectedReason}</p>
              ) : null}

              <div className="fin-actions">
                <button
                  type="button"
                  className="fin-button fin-button--primary"
                  disabled={busy || approved || rejected}
                  onClick={() =>
                    void onAct(
                      quote.id,
                      { action: "approve", reason: reason.trim() || undefined },
                      `Approved ${quote.internalRef ?? "the quote"} and rejected the others on ${group.requestId}.`,
                    )
                  }
                >
                  <Icon name="check" size={14} aria-hidden="true" /> Approve this one
                </button>
                <button
                  type="button"
                  className="fin-button"
                  disabled={busy || rejected || reason.trim().length === 0}
                  onClick={() =>
                    void onAct(
                      quote.id,
                      { action: "reject", reason: reason.trim() },
                      `Rejected ${quote.internalRef ?? "the quote"}.`,
                    )
                  }
                >
                  Reject
                </button>
                {quote.clientApprovalRequired && !quote.clientApprovedBy ? (
                  <button
                    type="button"
                    className="fin-button"
                    disabled={busy}
                    onClick={() =>
                      void onAct(
                        quote.id,
                        { action: "client_approve" },
                        "Client sign-off recorded.",
                      )
                    }
                  >
                    Record the client sign-off
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      <p className="fin-card__note">
        Rejecting needs a reason and approving records who and when. The cheapest is marked because
        the difference is worth seeing, not because it is the right answer.
      </p>
    </div>
  );
}

/* ── §3: logging a quote ──────────────────────────────────────────────────── */

function CreateQuoteCard({
  onNotify,
  onCreated,
}: {
  onNotify: (message: string) => void;
  onCreated: () => void;
}) {
  const write = useFinanceWrite();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [job, setJob] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [contractorId, setContractorId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [description, setDescription] = useState("");
  const [net, setNet] = useState("");
  const [vat, setVat] = useState("");
  const [quoteDate, setQuoteDate] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [clientApproval, setClientApproval] = useState(false);

  const netPence = fieldPence(net);

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Log a quote</h2>
        <p className="fin-card__note">
          A quote has to name a job — one with no job is an orphan and no cost control can attach to
          it. A new quote is never saved as approved: approval needs a name and a time, and both
          come from the session.
        </p>
      </div>
      <Refusal message={write.error} />
      <Confirmation message={done} />
      {!open ? (
        <div className="fin-actions">
          <button
            type="button"
            className="fin-button fin-button--primary"
            onClick={() => setOpen(true)}
          >
            <Icon name="plus" size={14} aria-hidden="true" /> New quote
          </button>
        </div>
      ) : (
        <div className="fin-form">
          <div className="fin-form__grid">
            <Field label="Job" hint="Required.">
              <input
                type="text"
                value={job}
                onChange={(event) => setJob(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Quote reference" hint="The supplier's own reference.">
              <input
                type="text"
                value={supplierRef}
                onChange={(event) => setSupplierRef(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Contractor">
              <input
                type="text"
                value={contractorId}
                onChange={(event) => setContractorId(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Site" hint="Inherited from the job when left blank.">
              <input
                type="text"
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <MoneyField label="Net" value={net} onChange={setNet} />
            <MoneyField label="VAT" value={vat} onChange={setVat} />
            <Field label="Quote date">
              <input
                type="date"
                value={quoteDate}
                onChange={(event) => setQuoteDate(event.target.value)}
              />
            </Field>
            <Field label="Valid until" hint="Drives the reminder seven days out.">
              <input
                type="date"
                value={validUntil}
                onChange={(event) => setValidUntil(event.target.value)}
              />
            </Field>
            <Field label="Description of works">
              <textarea
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </div>
          <label className="fin-select">
            <input
              type="checkbox"
              checked={clientApproval}
              onChange={(event) => setClientApproval(event.target.checked)}
            />
            <span>The client has to sign this off before we commit</span>
          </label>
          <div className="fin-actions fin-actions--end">
            <button type="button" className="fin-button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="fin-button fin-button--primary"
              disabled={write.busy || !job.trim() || netPence === null}
              onClick={() => {
                void write
                  .run("/api/finance/quotes", {
                    method: "POST",
                    body: {
                      requestId: job.trim(),
                      supplierRef: supplierRef || undefined,
                      contractorId: contractorId || undefined,
                      siteId: siteId || undefined,
                      description: description || undefined,
                      netPence,
                      vatPence: fieldPence(vat) ?? 0,
                      quoteDate: quoteDate || undefined,
                      validUntil: validUntil || undefined,
                      clientApprovalRequired: clientApproval,
                    },
                  })
                  .then((result) => {
                    if (!result.ok) return;
                    const said = `Logged ${String(result.payload?.internalRef ?? "the quote")} against ${job.trim()}.`;
                    setDone(said);
                    onNotify(said);
                    setOpen(false);
                    onCreated();
                  });
              }}
            >
              Log the quote
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
