"use client";

/**
 * ANALYSIS — §8's margin, §9's ageing, and the four §15 reports that turn a
 * ledger into a decision.
 *
 * ── MARGIN IS THE NUMBER THE BUSINESS RUNS ON ─────────────────────────────
 *
 * §8: cost in, charged out, margin and margin % for every job, rolled up six
 * ways. The grouping is a URL parameter rather than component state, so "show
 * me margin by contractor" is a link — and the drill-through from a job row
 * opens the job itself, because the next question after "this one lost money"
 * is always "what happened on it".
 *
 * ── AGEING DRILLS THROUGH TO THE LEDGER, NOT TO A DEAD END ────────────────
 *
 * §9 asks for aged debtors and creditors "by counterparty, with drill-down to
 * the invoices". The drill-down writes the counterparty into the ledger's own
 * URL filter and switches tab, so it lands on the real ledger with the real
 * filters — one screen for invoices, reachable from everywhere, rather than a
 * second half-built list living inside a report.
 *
 * ── EVERY CARD HERE READS A ROUTE THAT LANDS AFTER IT ─────────────────────
 *
 * Margin, ageing, the scorecard, statements and the accounting exports are all
 * later routes. Each degrades to its own named notice: one missing endpoint
 * takes out one card and says which, rather than emptying the tab.
 */

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import { MARGIN_GROUPINGS, type MarginGrouping } from "../../../lib/finance/margin";
import { EXPORT_FORMATS, type ExportFormat } from "../../../lib/finance/exports";
import { formatPence, penceFromInput } from "../../../lib/finance/model";
import { useQueryValue } from "../ops/ops-url-state";
import {
  Confirmation,
  DegradedNotice,
  Field,
  FinanceState,
  Money,
  Refusal,
  fetchDownload,
  plural,
  useFinanceEndpoint,
  useFinanceWrite,
} from "./finance-shared";
import type { AgeingPayload, MarginPayload } from "./finance-records";
import type { FinanceTabKey } from "./finance-tabs";

interface ScorecardRow {
  id: string;
  name: string;
  jobs: number;
  invoices: number;
  spendPence: number;
  avgCostPerJobPence: number | null;
  quoteToInvoiceVariancePercent: number | null;
  disputeRate: number | null;
  onTimePercent: number | null;
}

interface ScorecardPayload {
  contractors: ScorecardRow[];
  note: string | null;
}

interface StatementLine {
  id?: string;
  supplierRef: string | null;
  invoiceDate: string | null;
  amountPence: number;
  matchedInvoiceId: string | null;
  matchState: string;
  note: string | null;
}

interface StatementPayload {
  id?: string;
  counterpartyName?: string | null;
  claimedTotalPence?: number;
  ledgerTotalPence?: number;
  /** What the conversation is actually about: theirs minus ours. */
  differencePence?: number;
  summary?: {
    matched: number;
    amountDiffers: number;
    supplierOnly: number;
    ledgerOnly: number;
  };
  lines?: StatementLine[];
}

const MATCH_WORDS: Record<string, string> = {
  matched: "Matched",
  supplier_only: "They have it, we do not",
  ledger_only: "We have it, they do not",
  amount_differs: "Both have it, the amounts differ",
};

const GROUPING_WORDS: Record<MarginGrouping, string> = {
  job: "Job",
  site: "Site",
  client: "Client",
  category: "Category",
  contractor: "Contractor",
  period: "Period",
};

export function FinanceAnalysis({
  onOpenJob,
  onSelectTab,
}: {
  onOpenJob: (id: string) => void;
  onSelectTab: (tab: FinanceTabKey) => void;
}) {
  const [groupBy, setGroupBy] = useQueryValue("groupBy", "job");
  const [, setParty] = useQueryValue("party", "");
  const grouping = (MARGIN_GROUPINGS as readonly string[]).includes(groupBy)
    ? (groupBy as MarginGrouping)
    : "job";

  const margin = useFinanceEndpoint<MarginPayload>("/api/finance/margin", `groupBy=${grouping}`);
  const debtors = useFinanceEndpoint<AgeingPayload>("/api/finance/ageing", "direction=receivable");
  const creditors = useFinanceEndpoint<AgeingPayload>("/api/finance/ageing", "direction=payable");
  const scorecard = useFinanceEndpoint<ScorecardPayload>("/api/finance/scorecard");

  const drill = (direction: FinanceTabKey, counterpartyId: string) => {
    setParty(counterpartyId);
    onSelectTab(direction);
  };

  return (
    <div className="fin-stack">
      <section className="fin-card">
        <div className="fin-card__head">
          <h2>Margin</h2>
          <p className="fin-card__note">
            Cost in is what suppliers invoiced against the job; charged out is what the client was
            invoiced for it. The difference is the margin, and a job with cost and nothing charged
            out is unbilled work — it is on the overview with its own total.
          </p>
        </div>
        <div className="fin-filters__row">
          <Field label="Roll up by">
            <select value={grouping} onChange={(event) => setGroupBy(event.target.value)}>
              {MARGIN_GROUPINGS.map((option) => (
                <option key={option} value={option}>
                  {GROUPING_WORDS[option]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <FinanceState
          loading={margin.loading}
          error={margin.error}
          unavailable={margin.unavailable}
          endpoint="/api/finance/margin"
          what="Margin"
          empty={Boolean(margin.data) && (margin.data?.rows.length ?? 0) === 0}
          emptyLabel="Nothing has been allocated to a job yet, so there is no margin to roll up."
          onRetry={margin.reload}
        >
          {margin.data ? (
            <>
              <div className="fin-tiles">
                <Figure label="Cost in" pence={margin.data.totals.costInPence} />
                <Figure label="Charged out" pence={margin.data.totals.chargedOutPence} />
                <Figure label="Margin" pence={margin.data.totals.marginPence} />
                <Figure
                  label="Recovery rate"
                  text={
                    margin.data.totals.recoveryRatePercent === null
                      ? "Not measurable"
                      : `${margin.data.totals.recoveryRatePercent}%`
                  }
                />
              </div>
              <div className="fin-table-wrap">
                <table className="fin-table" role="table">
                  <caption className="visually-hidden">
                    Margin by {GROUPING_WORDS[grouping].toLowerCase()}
                  </caption>
                  <thead>
                    <tr role="row">
                      <th scope="col" role="columnheader">
                        {GROUPING_WORDS[grouping]}
                      </th>
                      <th scope="col" role="columnheader" className="th--number">
                        Cost in
                      </th>
                      <th scope="col" role="columnheader" className="th--number">
                        Charged out
                      </th>
                      <th scope="col" role="columnheader" className="th--number">
                        Margin
                      </th>
                      <th scope="col" role="columnheader" className="th--number">
                        Margin %
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {margin.data.rows.map((row) => (
                      <tr role="row" key={row.key}>
                        <th scope="row" role="rowheader" data-label={GROUPING_WORDS[grouping]}>
                          {grouping === "job" ? (
                            <button
                              type="button"
                              className="fin-link-button"
                              onClick={() => onOpenJob(row.key)}
                              aria-label={`Open ${row.label}`}
                            >
                              {row.label}
                            </button>
                          ) : (
                            <span className="fin-cell__ref">{row.label}</span>
                          )}
                          <span className="fin-cell__sub">
                            {plural(row.jobs, "job")}
                            {row.lossMaking ? " · loss-making" : ""}
                            {row.jobsCharged < row.jobs
                              ? ` · ${row.jobs - row.jobsCharged} not charged out`
                              : ""}
                          </span>
                        </th>
                        <td role="cell" data-label="Cost in" className="td--number">
                          <Money pence={row.costInPence} />
                        </td>
                        <td role="cell" data-label="Charged out" className="td--number">
                          <Money pence={row.chargedOutPence} />
                        </td>
                        <td role="cell" data-label="Margin" className="td--number">
                          <Money pence={row.marginPence} />
                        </td>
                        <td role="cell" data-label="Margin %" className="td--number">
                          {row.marginPercent === null ? "—" : `${row.marginPercent}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="fin-card__note">
                A row with no charged-out figure has no margin percentage — that is not a margin of
                nought, and it is never printed as one.
              </p>
            </>
          ) : null}
        </FinanceState>
      </section>

      <AgeingCard
        title="Aged debtors"
        blurb="What clients owe you, by how late it is."
        endpoint="/api/finance/ageing?direction=receivable"
        state={debtors}
        onDrill={(id) => drill("receivable", id)}
      />

      <AgeingCard
        title="Aged creditors"
        blurb="What you owe suppliers, by how late it is."
        endpoint="/api/finance/ageing?direction=payable"
        state={creditors}
        onDrill={(id) => drill("payable", id)}
      />

      <section className="fin-card">
        <div className="fin-card__head">
          <h2>Contractor scorecard</h2>
          <p className="fin-card__note">
            Average cost per job, quote-to-invoice variance, dispute rate and on-time completion.
            Payment data turned into a procurement decision.
          </p>
        </div>
        <FinanceState
          loading={scorecard.loading}
          error={scorecard.error}
          unavailable={scorecard.unavailable}
          endpoint="/api/finance/scorecard"
          what="The contractor scorecard"
          empty={Boolean(scorecard.data) && (scorecard.data?.contractors.length ?? 0) === 0}
          emptyLabel="No supplier has enough invoiced work behind them to score yet."
          onRetry={scorecard.reload}
        >
          <div className="fin-table-wrap">
            <table className="fin-table" role="table">
              <caption className="visually-hidden">Contractor scorecard</caption>
              <thead>
                <tr role="row">
                  <th scope="col" role="columnheader">
                    Contractor
                  </th>
                  <th scope="col" role="columnheader" className="th--number">
                    Spend
                  </th>
                  <th scope="col" role="columnheader" className="th--number">
                    Cost per job
                  </th>
                  <th scope="col" role="columnheader" className="th--number">
                    Quote variance
                  </th>
                  <th scope="col" role="columnheader" className="th--number">
                    Disputes
                  </th>
                  <th scope="col" role="columnheader" className="th--number">
                    On time
                  </th>
                </tr>
              </thead>
              <tbody>
                {(scorecard.data?.contractors ?? []).map((row) => (
                  <tr role="row" key={row.id}>
                    <th scope="row" role="rowheader" data-label="Contractor">
                      <span className="fin-cell__ref">{row.name}</span>
                      <span className="fin-cell__sub">
                        {plural(row.jobs, "job")} · {plural(row.invoices, "invoice")}
                      </span>
                    </th>
                    <td role="cell" data-label="Spend" className="td--number">
                      <Money pence={row.spendPence} />
                    </td>
                    <td role="cell" data-label="Cost per job" className="td--number">
                      {row.avgCostPerJobPence === null ? (
                        "—"
                      ) : (
                        <Money pence={row.avgCostPerJobPence} />
                      )}
                    </td>
                    <td role="cell" data-label="Quote variance" className="td--number">
                      {row.quoteToInvoiceVariancePercent === null
                        ? "—"
                        : `${row.quoteToInvoiceVariancePercent}%`}
                    </td>
                    <td role="cell" data-label="Disputes" className="td--number">
                      {row.disputeRate === null ? "—" : `${row.disputeRate}%`}
                    </td>
                    <td role="cell" data-label="On time" className="td--number">
                      {row.onTimePercent === null ? "—" : `${row.onTimePercent}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {scorecard.data?.note ? (
            <p className="fin-card__note">{scorecard.data.note}</p>
          ) : null}
        </FinanceState>
      </section>

      <StatementCard />

      <ExportCard />
    </div>
  );
}

function Figure({ label, pence, text }: { label: string; pence?: number; text?: string }) {
  return (
    <div className="fin-tile">
      <span className="fin-tile__label">{label}</span>
      <span className="fin-tile__value">
        {text !== undefined ? text : <Money pence={pence ?? 0} />}
      </span>
    </div>
  );
}

/* ── §9: the ladder, with a drill-through ─────────────────────────────────── */

function AgeingCard({
  title,
  blurb,
  endpoint,
  state,
  onDrill,
}: {
  title: string;
  blurb: string;
  endpoint: string;
  state: {
    data: AgeingPayload | null;
    loading: boolean;
    error: string | null;
    unavailable: boolean;
    reload: () => void;
  };
  onDrill: (counterpartyId: string) => void;
}) {
  const rows = state.data?.counterparties ?? [];
  const totals = state.data?.totals ?? null;

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>{title}</h2>
        <p className="fin-card__note">{blurb}</p>
      </div>
      <FinanceState
        loading={state.loading}
        error={state.error}
        unavailable={state.unavailable}
        endpoint={endpoint}
        what={title}
        empty={Boolean(state.data) && rows.length === 0}
        emptyLabel="Nothing is outstanding on this side."
        onRetry={state.reload}
      >
        <div className="fin-table-wrap">
          <table className="fin-table" role="table">
            <caption className="visually-hidden">{title} by counterparty</caption>
            <thead>
              <tr role="row">
                <th scope="col" role="columnheader">
                  Counterparty
                </th>
                <th scope="col" role="columnheader" className="th--number">
                  Current
                </th>
                <th scope="col" role="columnheader" className="th--number">
                  1–30
                </th>
                <th scope="col" role="columnheader" className="th--number">
                  31–60
                </th>
                <th scope="col" role="columnheader" className="th--number">
                  61–90
                </th>
                <th scope="col" role="columnheader" className="th--number">
                  90+
                </th>
                <th scope="col" role="columnheader" className="th--number">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr role="row" key={row.id}>
                  <th scope="row" role="rowheader" data-label="Counterparty">
                    <button
                      type="button"
                      className="fin-ageing__drill"
                      onClick={() => onDrill(row.id)}
                      aria-label={`Show the ${row.invoiceCount} invoices behind ${row.name}`}
                    >
                      {row.name}
                    </button>
                    <span className="fin-cell__sub">{plural(row.invoiceCount, "invoice")}</span>
                  </th>
                  <td role="cell" data-label="Current" className="td--number">
                    <Money pence={row.current} />
                  </td>
                  <td role="cell" data-label="1–30" className="td--number">
                    <Money pence={row.b1_30} />
                  </td>
                  <td role="cell" data-label="31–60" className="td--number">
                    <Money pence={row.b31_60} />
                  </td>
                  <td role="cell" data-label="61–90" className="td--number">
                    <Money pence={row.b61_90} />
                  </td>
                  <td role="cell" data-label="90+" className="td--number">
                    <Money pence={row.b90} />
                  </td>
                  <td role="cell" data-label="Total" className="td--number">
                    <Money pence={row.totalPence} />
                  </td>
                </tr>
              ))}
            </tbody>
            {totals ? (
              <tfoot>
                <tr role="row">
                  <th scope="row" role="rowheader" data-label="Counterparty">
                    Everything
                  </th>
                  <td role="cell" data-label="Current" className="td--number">
                    <Money pence={totals.current} />
                  </td>
                  <td role="cell" data-label="1–30" className="td--number">
                    <Money pence={totals.b1_30} />
                  </td>
                  <td role="cell" data-label="31–60" className="td--number">
                    <Money pence={totals.b31_60} />
                  </td>
                  <td role="cell" data-label="61–90" className="td--number">
                    <Money pence={totals.b61_90} />
                  </td>
                  <td role="cell" data-label="90+" className="td--number">
                    <Money pence={totals.b90} />
                  </td>
                  <td role="cell" data-label="Total" className="td--number">
                    <Money pence={totals.totalPence} />
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </FinanceState>
    </section>
  );
}

/* ── §15.4: what they think you owe ───────────────────────────────────────── */

/**
 * A SUPPLIER'S STATEMENT, PASTED, AGAINST THE LEDGER.
 *
 * §15.4: "list what they think you owe that you have no record of. Catches lost
 * invoices before they become a dispute." Pasting is deliberate — a statement
 * arrives as a PDF or in the body of an email far more often than as a file
 * anybody can upload, and asking for a CSV would mean it never gets done.
 */
/**
 * ONE PASTED LINE PER INVOICE, TURNED INTO THE ROWS THE ROUTE ASKS FOR.
 *
 * `POST /api/finance/statements` takes `lines: [{ supplierRef, invoiceDate,
 * amount }]`, not a blob of text — quite rightly, since a server that parsed
 * free text would be guessing on behalf of somebody who cannot see the guess.
 * So the splitting happens here, in front of the person who pasted it, and the
 * card prints how many lines it read BEFORE anything is sent. A statement that
 * arrives as twelve lines and parses as three is a mis-paste, and it is only
 * catchable at the moment it is still on screen.
 *
 * Commas and tabs both split, because a statement copied out of a PDF is
 * tab-separated and one copied out of a spreadsheet is not.
 */
export function parseStatementLines(
  text: string,
): Array<{ supplierRef: string; invoiceDate: string; amount: string }> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      /*
       * A THOUSANDS SEPARATOR IS NOT A COLUMN SEPARATOR.
       *
       * Splitting "INV-1001, 2026-08-01, 1,250.00" on commas produces a last
       * field of "250.00", and the statement then reconciles against a figure a
       * thousand pounds short — silently, because £250 is a perfectly plausible
       * invoice. So every comma sitting between a digit and a three-digit group
       * is hidden behind a placeholder before the split and restored after it.
       * This was a real defect, caught by the test that now pins it.
       */
      const guarded = line.replace(THOUSANDS, `$1${COMMA_HOLD}`);
      const parts = guarded
        .split(/[\t,;]+/)
        .map((part) => part.split(COMMA_HOLD).join(",").trim());
      /* The AMOUNT is the last field that reads as money, wherever it sits: a
         statement's columns are in nobody's fixed order. */
      const amountAt = parts.map((part) => MONEY.test(part)).lastIndexOf(true);
      const dateAt = parts.findIndex((part) => DAY.test(part));
      return {
        supplierRef: parts.find((part, index) => index !== amountAt && index !== dateAt) ?? "",
        invoiceDate: dateAt >= 0 ? parts[dateAt] : "",
        amount: amountAt >= 0 ? parts[amountAt] : "",
      };
    })
    .filter((row) => row.supplierRef || row.amount);
}

const MONEY = /^[-+]?[\u00a3$\u20ac]?\s*\d[\d,]*(\.\d{1,2})?$/;
/** A comma between a digit and a three-digit group: a separator, not a column. */
const THOUSANDS = /(\d),(?=\d{3}(\D|$))/g;
/** A private-use character no supplier statement will ever contain. */
const COMMA_HOLD = "\ue000";
const DAY = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})$/;

function StatementCard() {
  const write = useFinanceWrite();
  const [counterparty, setCounterparty] = useState("");
  const [statementDate, setStatementDate] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<StatementPayload | null>(null);
  const [missing, setMissing] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const parsed = useMemo(() => parseStatementLines(text), [text]);

  const groups = useMemo(() => {
    const lines = result?.lines ?? [];
    const byState = new Map<string, StatementLine[]>();
    for (const line of lines) {
      const existing = byState.get(line.matchState);
      if (existing) existing.push(line);
      else byState.set(line.matchState, [line]);
    }
    return [...byState.entries()];
  }, [result]);

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Statement reconciliation</h2>
        <p className="fin-card__note">
          Paste a supplier&rsquo;s statement and it is matched against the ledger, line by line. The
          rows that matter are the ones they have and you do not.
        </p>
      </div>
      <Refusal message={write.error} />
      <Confirmation message={done} />
      {missing ? (
        <DegradedNotice endpoint="/api/finance/statements" what="Statement reconciliation" />
      ) : null}
      <div className="fin-form">
        <div className="fin-form__grid">
          <Field label="Supplier">
            <input
              type="text"
              value={counterparty}
              onChange={(event) => setCounterparty(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Statement date">
            <input
              type="date"
              value={statementDate}
              onChange={(event) => setStatementDate(event.target.value)}
            />
          </Field>
        </div>
        <Field
          label="The statement"
          hint="One line per invoice: their reference, the date, the amount. Commas or tabs."
        >
          <textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
        <p className="fin-card__note">
          {text.trim().length === 0
            ? "Nothing pasted yet."
            : `Read as ${plural(parsed.length, "line")}, coming to ${formatPence(
                parsed.reduce((sum, row) => sum + (penceFromInput(row.amount) ?? 0), 0),
              )}. Check that against the total on their statement before reconciling.`}
        </p>
        <div className="fin-actions fin-actions--end">
          <button
            type="button"
            className="fin-button fin-button--primary"
            disabled={
              write.busy
              || parsed.length === 0
              || counterparty.trim().length === 0
              || statementDate.length === 0
            }
            onClick={() => {
              void write
                .run("/api/finance/statements", {
                  method: "POST",
                  body: {
                    counterpartyName: counterparty.trim(),
                    statementDate,
                    lines: parsed,
                    sourceFilename: "pasted",
                  },
                })
                .then((response) => {
                  if (!response.ok) {
                    setMissing(response.error?.includes("(404)") === true);
                    return;
                  }
                  setResult(response.payload as StatementPayload);
                  setDone("Matched against the ledger.");
                });
            }}
          >
            Reconcile
          </button>
        </div>
      </div>
      {result?.differencePence !== undefined ? (
        <div className="fin-tiles">
          <Figure label="They say you owe" pence={result.claimedTotalPence ?? 0} />
          <Figure label="The ledger says" pence={result.ledgerTotalPence ?? 0} />
          <Figure label="Difference" pence={result.differencePence} />
          <Figure
            label="They have, you do not"
            text={String(result.summary?.supplierOnly ?? 0)}
          />
        </div>
      ) : null}
      {groups.map(([state, lines]) => (
        <div key={state}>
          <h3 className="fin-section-title">
            {MATCH_WORDS[state] ?? state} · {plural(lines.length, "line")}
          </h3>
          <ul className="fin-unbilled__list">
            {lines.map((line, index) => (
              <li className="fin-unbilled__job" key={line.id ?? `${state}-${index}`}>
                <span>
                  {line.supplierRef ?? "no reference"}
                  {line.invoiceDate ? ` · ${line.invoiceDate}` : ""}
                  {line.note ? ` · ${line.note}` : ""}
                </span>
                <Money pence={line.amountPence} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/* ── §15.6: the export your bookkeeper needs ──────────────────────────────── */

function ExportCard() {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [direction, setDirection] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const run = (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    const params = new URLSearchParams({ format });
    if (direction) params.set("direction", direction);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    void fetchDownload(`/api/finance/exports?${params.toString()}`, {
      filename: `${format}-${from || "all"}.csv`,
    }).then((result) => {
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(`The ${format} file has been downloaded.`);
    });
  };

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Accounting export</h2>
        <p className="fin-card__note">
          A mapped CSV for Xero, QuickBooks or Sage. An API integration can come later; without the
          export your bookkeeper does everything twice.
        </p>
      </div>
      <Refusal message={error} />
      <Confirmation message={done} />
      <div className="fin-form__grid">
        <Field label="Direction">
          <select value={direction} onChange={(event) => setDirection(event.target.value)}>
            <option value="">Both</option>
            <option value="payable">Payable</option>
            <option value="receivable">Receivable</option>
          </select>
        </Field>
        <Field label="From">
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
      </div>
      <div className="fin-actions">
        {EXPORT_FORMATS.map((format) => (
          <button
            type="button"
            key={format}
            className="fin-button"
            disabled={busy !== null}
            onClick={() => run(format)}
          >
            <Icon name="download" size={14} aria-hidden="true" />{" "}
            {format === "xero" ? "Xero" : format === "quickbooks" ? "QuickBooks" : "Sage"}
          </button>
        ))}
      </div>
      <p className="fin-card__note">
        Amounts are exported in pounds, dates in the format each package reads, and every cell that
        could be read as a formula is neutralised — {formatPence(123456)} leaves as a number, an
        invoice number beginning with an equals sign does not leave as a spreadsheet function.
      </p>
    </section>
  );
}
