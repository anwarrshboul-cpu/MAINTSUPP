"use client";

/**
 * THE INVOICE TRACKER'S LANDING TAB — §9's cash position and §8's unbilled work.
 *
 * ── WHAT SITS HIGHEST, AND WHY ────────────────────────────────────────────
 *
 * §15.1: unbilled work is "the highest-value item here". So it is the second
 * card on the page, in its own accented frame, with the total set at headline
 * size and a working drill-down to the jobs — not a count in a corner. The
 * cash position is above it only because §9 makes it the page's opening
 * question and because the unbilled figure is read against it: "£4,100 spent
 * and not charged out" means something different when the net position is
 * £60,000 than when it is £900.
 *
 * ── NOTHING ON THIS PAGE IS GUESSED ───────────────────────────────────────
 *
 * Four of the five cards read routes that land after this component does. Each
 * one degrades to a named notice rather than to a zero: a card that prints
 * "£0.00 outstanding" because its endpoint 404ed is a lie an operator will act
 * on, and the only figure worse than a missing one is a confident wrong one.
 *
 * The tempting fallback — reading `cashPosition` off `GET /api/finance/invoices`
 * — is deliberately NOT taken. That figure is composed from the balances of the
 * PAGE the ledger route just returned (fifty rows), so on a workspace with four
 * hundred invoices it is a page total wearing a whole-ledger label. §9's summary
 * has to be measured over everything or not shown.
 *
 * ── THE FORECAST IS WEEKLY, AND SAYS SO ───────────────────────────────────
 *
 * §9 asks for ninety days of expected in against expected out. Ninety daily
 * columns do not fit 380px at a legible tick, so they are summed into thirteen
 * weeks and the card says that in words. The aggregation loses no money — every
 * point lands in exactly one week — and the three figures the forecast cannot
 * plot (overdue, beyond the horizon, undated) are printed underneath rather
 * than folded in silently.
 */

import { useMemo, useState, type ReactNode } from "react";
import overviewCss from "../ops/overview.css?url";
import { Icon } from "../../../components";
import { formatPence } from "../../../lib/finance/model";
import { ChartFrame } from "../ops/overview-shared";
import { TimeSeries } from "../ops/overview-charts";
import { useQueryValue } from "../ops/ops-url-state";
import {
  AgeBadge,
  DegradedNotice,
  FinanceState,
  FinanceStatusChip,
  Money,
  plural,
  todayDay,
  dayText,
  daysUntil,
  useFinanceEndpoint,
} from "./finance-shared";
import { presentQuoteStatus } from "./finance-status";
import {
  readCashPosition,
  type LedgerPayload,
  type QuotePayload,
  type SummaryPayload,
  type UnbilledPayload,
} from "./finance-records";
import type { FinanceTabKey } from "./finance-tabs";

/** How many weeks thirteen 7-day buckets cover: §9's ninety days, rounded up. */
const FORECAST_WEEKS = 13;

/** §3's reminder fires seven days out; the card shows a fortnight, so nothing arrives unseen. */
const EXPIRY_HORIZON_DAYS = 14;

export function FinanceLanding({
  onSelectTab,
  onOpenJob,
  onNavigate,
}: {
  onSelectTab: (tab: FinanceTabKey) => void;
  onOpenJob: (id: string) => void;
  onNavigate: (section: string) => void;
}) {
  const today = todayDay();

  const summary = useFinanceEndpoint<SummaryPayload>("/api/finance/summary");
  const unbilled = useFinanceEndpoint<UnbilledPayload>("/api/finance/unbilled");
  const flagged = useFinanceEndpoint<LedgerPayload>("/api/finance/invoices", "unmatched=1&limit=25");
  const quotes = useFinanceEndpoint<QuotePayload>("/api/finance/quotes", "limit=100");

  /* The ledger's filters live in the URL, so a drill-down from here is a
     parameter write plus a tab change — the same link somebody could paste. */
  const [, setUnmatched] = useQueryValue("unmatched", "");
  const [, setOverdue] = useQueryValue("overdue", "");

  /* The figures are flat on the summary payload — see `SummaryPayload`. */
  const cash = readCashPosition(summary.data);
  const forecast = summary.data?.forecast ?? null;
  /* Either route may carry it; whichever answered first is the one that has it. */
  const unbilledReport = unbilled.data ?? summary.data?.unbilled ?? null;
  const flagsOpen = summary.data?.flagsOpen ?? null;
  const flagsOpenTotal = summary.data?.flagsOpenTotal ?? null;

  return (
    <>
      <link rel="stylesheet" href={overviewCss} precedence="default" />
      <div className="fin-stack">
        <CashPositionCard
          cash={cash}
          state={summary}
          onDrillOverdue={(direction) => {
            setOverdue("1");
            onSelectTab(direction);
          }}
        />

        <UnbilledCard
          report={unbilledReport}
          loading={unbilled.loading && summary.loading}
          unavailable={unbilled.unavailable && !unbilledReport}
          error={unbilled.error && !unbilledReport ? unbilled.error : null}
          onOpenJob={onOpenJob}
          onSelectTab={onSelectTab}
          onNavigate={onNavigate}
        />

        <ForecastCard forecast={forecast} state={summary} />

        <FlaggedCard
          payload={flagged.data}
          loading={flagged.loading}
          error={flagged.error}
          unavailable={flagged.unavailable}
          today={today}
          countedOpen={flagsOpen}
          countedTotalPence={flagsOpenTotal}
          onOpen={() => {
            setUnmatched("1");
            onSelectTab("payable");
          }}
        />

        <ExpiringQuotesCard
          payload={quotes.data}
          loading={quotes.loading}
          error={quotes.error}
          unavailable={quotes.unavailable}
          today={today}
          onSelectTab={onSelectTab}
          onOpenJob={onOpenJob}
        />
      </div>
    </>
  );
}

/* ── §9: the cash position ────────────────────────────────────────────────── */

function CashPositionCard({
  cash,
  state,
  onDrillOverdue,
}: {
  cash: ReturnType<typeof readCashPosition>;
  state: { loading: boolean; error: string | null; unavailable: boolean; reload: () => void };
  onDrillOverdue: (direction: "payable" | "receivable") => void;
}) {
  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Cash position</h2>
        <p className="fin-card__note">Everything still outstanding, both directions.</p>
      </div>
      <FinanceState
        loading={state.loading}
        error={state.error}
        unavailable={state.unavailable || (!state.loading && !state.error && !cash)}
        endpoint="/api/finance/summary"
        what="The cash position"
        onRetry={state.reload}
      >
        {cash ? (
          <>
            <div className="fin-tiles">
              <Tile
                label="Owed to you"
                pence={cash.receivableOutstandingPence}
                tone="var(--fin-approved)"
                foot={
                  <DrillFoot
                    pence={cash.receivableOverduePence}
                    label="overdue"
                    onDrill={() => onDrillOverdue("receivable")}
                    drillLabel="Show the overdue receivables"
                  />
                }
              />
              <Tile
                label="Owed by you"
                pence={cash.payableOutstandingPence}
                tone="var(--fin-review)"
                foot={
                  <DrillFoot
                    pence={cash.payableOverduePence}
                    label="overdue"
                    onDrill={() => onDrillOverdue("payable")}
                    drillLabel="Show the overdue payables"
                  />
                }
              />
              <Tile
                label="Net position"
                pence={cash.netPositionPence}
                tone={cash.netPositionPence < 0 ? "var(--fin-overdue-30)" : "var(--fin-paid)"}
                foot={
                  <span>
                    {cash.netPositionPence < 0
                      ? "More is owed by you than to you."
                      : "More is owed to you than by you."}
                  </span>
                }
              />
              <Tile
                label="Due in the next 7 days"
                pence={cash.due7.in - cash.due7.out}
                tone="var(--fin-due-soon)"
                foot={
                  <span>
                    <Money pence={cash.due7.in} /> in · <Money pence={cash.due7.out} /> out
                  </span>
                }
              />
            </div>
            <table className="fin-table" role="table">
              <caption className="fin-card__note">
                What falls due in each window, both directions. The windows nest: everything due in
                seven days is also due in thirty.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Window</th>
                  <th scope="col" className="th--number">
                    Coming in
                  </th>
                  <th scope="col" className="th--number">
                    Going out
                  </th>
                  <th scope="col" className="th--number">
                    Net
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Next 7 days", cash.due7] as const,
                  ["Next 14 days", cash.due14] as const,
                  ["Next 30 days", cash.due30] as const,
                ].map(([label, window]) => (
                  <tr key={label}>
                    <th scope="row" data-label="Window">
                      {label}
                    </th>
                    <td data-label="Coming in" className="td--number">
                      <Money pence={window.in} />
                    </td>
                    <td data-label="Going out" className="td--number">
                      <Money pence={window.out} />
                    </td>
                    <td data-label="Net" className="td--number">
                      <Money pence={window.in - window.out} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </FinanceState>
    </section>
  );
}

function Tile({
  label,
  pence,
  tone,
  foot,
}: {
  label: string;
  pence: number;
  tone: string;
  foot?: ReactNode;
}) {
  return (
    <div className="fin-tile">
      <span className="fin-tile__rule" style={{ background: tone }} aria-hidden="true" />
      <span className="fin-tile__label">{label}</span>
      <span className="fin-tile__value">
        <Money pence={pence} />
      </span>
      {foot ? <span className="fin-tile__foot">{foot}</span> : null}
    </div>
  );
}

function DrillFoot({
  pence,
  label,
  onDrill,
  drillLabel,
}: {
  pence: number;
  label: string;
  onDrill: () => void;
  drillLabel: string;
}) {
  if (pence <= 0) return <span>Nothing {label}.</span>;
  return (
    <>
      <Money pence={pence} /> {label} ·{" "}
      <button type="button" className="fin-link-button" onClick={onDrill} aria-label={drillLabel}>
        Show them
      </button>
    </>
  );
}

/* ── §8 and §15.1: unbilled work ──────────────────────────────────────────── */

/**
 * COMPLETED JOBS THAT COST MONEY AND HAVE BILLED NOBODY.
 *
 * The count and the total are the headline because they are the number somebody
 * repeats in a meeting; the list is underneath because the only useful next
 * action is opening one of the jobs. Eight rows, then a control to show the
 * rest — a fifty-row list on a landing page is a list nobody reads.
 */
function UnbilledCard({
  report,
  loading,
  unavailable,
  error,
  onOpenJob,
  onSelectTab,
  onNavigate,
}: {
  report: UnbilledPayload | null;
  loading: boolean;
  unavailable: boolean;
  error: string | null;
  onOpenJob: (id: string) => void;
  onSelectTab: (tab: FinanceTabKey) => void;
  onNavigate: (section: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = report?.rows ?? [];
  const shown = expanded ? rows : rows.slice(0, 8);

  return (
    <section className="fin-card fin-unbilled">
      <div className="fin-card__head">
        <h2>Unbilled work</h2>
        <p className="fin-card__note">
          Completed jobs carrying a supplier cost with no client invoice against them. Money already
          spent and not yet recovered.
        </p>
      </div>
      <FinanceState
        loading={loading}
        error={error}
        unavailable={unavailable}
        endpoint="/api/finance/unbilled"
        what="Unbilled work"
        empty={Boolean(report) && rows.length === 0}
        emptyLabel="Every completed job with a supplier cost has been charged out. Nothing is sitting unrecovered."
      >
        {report ? (
          <>
            <p className="fin-unbilled__headline">
              <span className="fin-unbilled__total">
                <Money pence={report.totalPence} />
              </span>
              <span className="fin-unbilled__count">
                across {plural(report.count, "completed job")}
              </span>
            </p>
            <ul className="fin-unbilled__list">
              {shown.map((row) => (
                <li className="fin-unbilled__job" key={row.requestId}>
                  <span>
                    <strong>{row.reference ?? row.requestId}</strong>
                    {row.title ? ` · ${row.title}` : ""}
                    {row.siteName ? ` · ${row.siteName}` : ""}
                    {row.completedAt ? ` · completed ${dayText(row.completedAt)}` : ""}
                  </span>
                  <span>
                    <Money pence={row.costInPence} />{" "}
                    <button
                      type="button"
                      className="fin-link-button"
                      onClick={() => onOpenJob(row.requestId)}
                      aria-label={`Open job ${row.reference ?? row.requestId}`}
                    >
                      Open job
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="fin-actions">
              {rows.length > 8 ? (
                <button
                  type="button"
                  className="fin-button"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? "Show the eight largest only" : `Show all ${rows.length}`}
                </button>
              ) : null}
              {/* §12: a receivable is RAISED in Module 4 and appears in this
                  ledger on finalisation, so the primary action leaves for the
                  generator rather than opening a form that would be re-entry. */}
              <button
                type="button"
                className="fin-button fin-button--primary"
                onClick={() => onNavigate("reports")}
              >
                Raise a client invoice
              </button>
              <button type="button" className="fin-button" onClick={() => onSelectTab("receivable")}>
                Open the receivable ledger
              </button>
            </div>
          </>
        ) : null}
      </FinanceState>
    </section>
  );
}

/* ── §9: ninety days of expected in against expected out ──────────────────── */

function ForecastCard({
  forecast,
  state,
}: {
  forecast: SummaryPayload["forecast"] | null;
  state: { loading: boolean; error: string | null; unavailable: boolean; reload: () => void };
}) {
  const weeks = useMemo(() => weeklyBuckets(forecast?.points ?? []), [forecast]);

  const unplotted = forecast
    ? forecast.beyondHorizonInPence
      + forecast.beyondHorizonOutPence
      + forecast.undatedInPence
      + forecast.undatedOutPence
    : 0;

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Cash-flow forecast, 90 days</h2>
        <p className="fin-card__note">
          Every outstanding balance plotted on its due date, summed into weeks. Anything already
          overdue is expected now and sits in the first week.
        </p>
      </div>
      {state.unavailable || (!state.loading && !forecast && !state.error) ? (
        <DegradedNotice
          endpoint="/api/finance/summary"
          what="The 90-day forecast"
          fallback="The cash position above answers the same question for the next 30 days when it loads."
        />
      ) : (
        <ChartFrame
          loading={state.loading}
          error={state.error}
          onRetry={state.reload}
          empty={weeks.length === 0 || weeks.every((week) => week.in === 0 && week.out === 0)}
          emptyLabel="Nothing is outstanding with a due date in the next ninety days."
          minHeight={220}
          table={{
            caption: "Expected receipts and payments by week over the next ninety days",
            head: ["Week beginning", "Expected in", "Expected out", "Net"],
            rows: weeks.map((week) => [
              week.start,
              formatPence(week.in),
              formatPence(week.out),
              formatPence(week.in - week.out),
            ]),
          }}
        >
          <TimeSeries
            label="Expected receipts and payments by week"
            buckets={weeks.map((week) => ({
              label: week.label,
              start: week.start,
              endInclusive: week.endInclusive,
            }))}
            columns={[
              {
                key: "in",
                label: "Expected in",
                colour: "var(--fin-paid)",
                values: weeks.map((week) => week.in),
              },
              {
                key: "out",
                label: "Expected out",
                colour: "var(--fin-overdue-30)",
                values: weeks.map((week) => week.out),
              },
            ]}
            formatValue={(value) => formatPence(value)}
          />
        </ChartFrame>
      )}
      {forecast && unplotted > 0 ? (
        <p className="fin-card__note">
          Not in the chart:{" "}
          <Money pence={forecast.beyondHorizonInPence + forecast.beyondHorizonOutPence} /> falls due
          beyond ninety days and{" "}
          <Money pence={forecast.undatedInPence + forecast.undatedOutPence} /> is on invoices with no
          due date at all, which cannot be plotted anywhere.
        </p>
      ) : null}
    </section>
  );
}

interface Week {
  label: string;
  start: string;
  endInclusive: string;
  in: number;
  out: number;
}

/**
 * Ninety-one daily points folded into thirteen weeks.
 *
 * Written as a `reduce` into a pre-built array rather than an accumulator
 * mutated from inside a `map`: the React Compiler treats the second as an
 * error, and it is right to — a `map` that carries a running total is a loop
 * pretending to be a projection.
 */
function weeklyBuckets(
  points: readonly { day: string; inPence: number; outPence: number }[],
): Week[] {
  if (points.length === 0) return [];
  const weeks: Week[] = [];
  for (let index = 0; index < FORECAST_WEEKS; index += 1) {
    const slice = points.slice(index * 7, index * 7 + 7);
    if (slice.length === 0) break;
    const start = slice[0].day;
    weeks.push({
      label: index === 0 ? "This week" : weekLabel(start),
      start,
      endInclusive: slice[slice.length - 1].day,
      in: slice.reduce((sum, point) => sum + (point.inPence || 0), 0),
      out: slice.reduce((sum, point) => sum + (point.outPence || 0), 0),
    });
  }
  return weeks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekLabel(day: string): string {
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (!Number.isFinite(month) || !Number.isFinite(date)) return day;
  return `${date} ${MONTHS[Math.min(11, Math.max(0, month - 1))]}`;
}

/* ── §7: what the match engine is still objecting to ──────────────────────── */

function FlaggedCard({
  payload,
  loading,
  error,
  unavailable,
  today,
  countedOpen,
  countedTotalPence,
  onOpen,
}: {
  payload: LedgerPayload | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  today: string;
  /** The whole-ledger count from `/summary`, which is not the page below. */
  countedOpen: number | null;
  countedTotalPence: number | null;
  onOpen: () => void;
}) {
  const rows = payload?.invoices ?? [];
  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Open match flags</h2>
        <p className="fin-card__note">
          Invoices the three-way match is still objecting to. A blocking flag stops the invoice
          being approved for payment until it is cleared or waived with a typed reason.
          {countedOpen !== null ? (
            <>
              {" "}
              {plural(countedOpen, "invoice")} across the whole ledger
              {countedTotalPence !== null ? (
                <>
                  , <Money pence={countedTotalPence} /> in total
                </>
              ) : null}
              . The eight below are the most recent.
            </>
          ) : null}
        </p>
      </div>
      <FinanceState
        loading={loading}
        error={error}
        unavailable={unavailable}
        endpoint="/api/finance/invoices?unmatched=1"
        what="Open match flags"
        empty={Boolean(payload) && rows.length === 0}
        emptyLabel="The match engine has nothing open against any invoice."
      >
        <ul className="fin-unbilled__list">
          {rows.slice(0, 8).map((row) => {
            const open = row.flags.filter((entry) => entry.status === "open");
            return (
              <li className="fin-unbilled__job" key={row.id}>
                <span>
                  <strong>{row.internalRef ?? row.invoiceNumber ?? row.id}</strong>
                  {row.counterpartyName ? ` · ${row.counterpartyName}` : ""} ·{" "}
                  {plural(open.length, "open flag")}
                </span>
                <span>
                  <Money pence={row.grossPence ?? 0} />{" "}
                  <AgeBadge dueDay={row.dueAt} today={today} />
                </span>
              </li>
            );
          })}
        </ul>
        <div className="fin-actions">
          <button type="button" className="fin-button" onClick={onOpen}>
            Open the ledger, filtered to these
          </button>
        </div>
      </FinanceState>
    </section>
  );
}

/* ── §3: quotes about to lapse ────────────────────────────────────────────── */

/**
 * "An expired quote on an unstarted job is money quietly leaking." §3.
 *
 * The fortnight window is computed here from `valid_until` rather than asked
 * for with `?expired=1`, because that filter answers the opposite question —
 * quotes that have ALREADY lapsed. The card therefore says how many quotes it
 * looked at, since a workspace with more than a hundred live quotes would have
 * a page boundary between it and the truth.
 */
function ExpiringQuotesCard({
  payload,
  loading,
  error,
  unavailable,
  today,
  onSelectTab,
  onOpenJob,
}: {
  payload: QuotePayload | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  today: string;
  onSelectTab: (tab: FinanceTabKey) => void;
  onOpenJob: (id: string) => void;
}) {
  const expiring = useMemo(() => {
    const quotes = payload?.quotes ?? [];
    return quotes
      .filter((quote) => {
        const key = quote.statusKey ?? quote.status;
        if (["approved", "rejected", "superseded"].includes(String(key))) return false;
        const days = daysUntil(quote.validUntil, today);
        return days !== null && days <= EXPIRY_HORIZON_DAYS;
      })
      .sort((a, b) => dayText(a.validUntil).localeCompare(dayText(b.validUntil)));
  }, [payload, today]);

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Quotes expiring</h2>
        <p className="fin-card__note">
          Live quotes lapsing within a fortnight, and any already lapsed
          {payload ? `, out of the ${payload.quotes.length} most recent` : ""}.
        </p>
      </div>
      <FinanceState
        loading={loading}
        error={error}
        unavailable={unavailable}
        endpoint="/api/finance/quotes"
        what="Expiring quotes"
        empty={Boolean(payload) && expiring.length === 0}
        emptyLabel="No live quote lapses in the next fortnight."
      >
        <ul className="fin-unbilled__list">
          {expiring.slice(0, 8).map((quote) => (
            <li className="fin-unbilled__job" key={quote.id}>
              <span>
                <strong>{quote.internalRef ?? quote.supplierRef ?? quote.id}</strong> ·{" "}
                <button
                  type="button"
                  className="fin-link-button"
                  onClick={() => onOpenJob(quote.requestId)}
                  aria-label={`Open the job this quote is against, ${quote.requestId}`}
                >
                  {quote.requestId}
                </button>
              </span>
              <span>
                <FinanceStatusChip
                  presentation={presentQuoteStatus(quote.statusKey ?? quote.status)}
                  size="small"
                />{" "}
                <Money pence={quote.grossPence ?? 0} />{" "}
                <AgeBadge dueDay={quote.validUntil} today={today} kind="expiry" />
              </span>
            </li>
          ))}
        </ul>
        <div className="fin-actions">
          <button type="button" className="fin-button" onClick={() => onSelectTab("quotes")}>
            <Icon name="document" size={14} aria-hidden="true" /> Open quotes
          </button>
        </div>
      </FinanceState>
    </section>
  );
}
