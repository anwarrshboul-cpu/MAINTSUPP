/**
 * §9's CASH POSITION AND THE 90-DAY FORECAST.
 *
 * "Total receivable outstanding, and how much of it is overdue. Total payable
 * outstanding … Net position. Due in the next 7, 14 and 30 days, both
 * directions. Cash flow forecast chart over 90 days, plotting expected in
 * against expected out on due dates. That last chart is what tells you whether
 * you can commit to a project next month."
 *
 * ── THE ONE ARITHMETIC HAZARD IN THIS FILE, NAMED ──────────────────────────
 *
 * §6 allows one payment to cover several invoices. A forecast built by walking
 * PAYMENTS and subtracting each from every invoice it touches counts the same
 * money twice: a £300 payment split £100/£200 across two £500 invoices would
 * take £300 off each and report £400 outstanding where £700 is owed.
 *
 * Nothing here walks payments. Every function below consumes a per-invoice
 * BALANCE that `app/lib/finance/balance.ts` has already computed with one
 * `GROUP BY` over `payment_alloc` — so a split payment has been apportioned
 * exactly once, to the invoice it was allocated to, before this file sees it.
 * That is the whole defence, it is one sentence, and the test suite pins it
 * from both ends: a pure case over hand-built balances and a live case that
 * splits a real payment across two real invoices.
 *
 * ── WHY `cashSummary` IS NOT `cashPosition` FROM `./balance.ts` ────────────
 *
 * It is the same figure and this does NOT recompute it. `balance.ts` already
 * answers the six headline numbers and this file calls it — see the route.
 * What is added here is the part `balance.ts` deliberately does not carry: the
 * ninety-day series, and §9's landing-page companions (unbilled, open flags,
 * expiring quotes) which are counts from other tables entirely.
 *
 * ── DAY ARITHMETIC, IN JAVASCRIPT, FROM ONE SERVER `now` ───────────────────
 *
 * `shiftDay` and `daysBetweenDays` from `./model.ts`, for the reason stated in
 * that file's header: `db/sqlite-to-postgres.ts` refuses `julianday(` by name
 * and there is no expression that computes a day difference in both dialects.
 */

import { daysBetweenDays, shiftDay, type InvoiceDirection } from "./model";
import { signedForCashPosition } from "./rules";

/** §9's forecast horizon. "over 90 days". */
export const FORECAST_DAYS = 90;

/** One invoice, reduced to what a cash figure needs. */
export interface CashRow {
  direction: InvoiceDirection;
  /** `YYYY-MM-DD`, or null where the invoice carries no due date. */
  dueDay: string | null;
  /** `gross − paid − credited`, from `./balance.ts`. Never recomputed here. */
  balancePence: number;
  /** Whole days past due, from `ageingFor`. Zero on the due day itself. */
  daysOverdue: number;
}

export interface DueWindow {
  in: number;
  out: number;
}

export interface ForecastPoint {
  /** `YYYY-MM-DD`. */
  day: string;
  inPence: number;
  outPence: number;
}

export interface CashSummary {
  receivableOutstandingPence: number;
  receivableOverduePence: number;
  payableOutstandingPence: number;
  payableOverduePence: number;
  /** Receivable minus payable. Positive means more is owed to you than by you. */
  netPositionPence: number;
  due7: DueWindow;
  due14: DueWindow;
  due30: DueWindow;
}

/**
 * §9's six headline figures and the three due windows.
 *
 * OVER-PAID ROWS ARE SKIPPED, not netted off. A negative balance is an invoice
 * that has been paid twice — §7's whole reason for existing — and letting it
 * reduce the outstanding total would hide the evidence inside a smaller number.
 * `cashPosition()` in `./balance.ts` takes the same decision and says so.
 *
 * THE DUE WINDOWS ARE FORWARD-LOOKING AND EXCLUDE OVERDUE MONEY. "Due in the
 * next 7, 14 and 30 days" is a question about what is coming, and an invoice
 * that was due in March is not due in the next seven days. It is already
 * counted, in full, in the overdue figure above.
 *
 * They NEST: everything in `due7` is also in `due14` and `due30`, because "due
 * in the next 30 days" plainly includes next week. A UI wanting three exclusive
 * bands subtracts; a UI wanting three headline numbers reads them directly.
 */
export function cashSummary(rows: Iterable<CashRow>, todayDay: string): CashSummary {
  const summary: CashSummary = {
    receivableOutstandingPence: 0,
    receivableOverduePence: 0,
    payableOutstandingPence: 0,
    payableOverduePence: 0,
    netPositionPence: 0,
    due7: { in: 0, out: 0 },
    due14: { in: 0, out: 0 },
    due30: { in: 0, out: 0 },
  };

  for (const row of rows) {
    const balancePence = Math.trunc(row.balancePence || 0);
    if (balancePence <= 0) continue;

    const receivable = row.direction === "receivable";
    if (receivable) {
      summary.receivableOutstandingPence += balancePence;
      if (row.daysOverdue > 0) summary.receivableOverduePence += balancePence;
    } else {
      summary.payableOutstandingPence += balancePence;
      if (row.daysOverdue > 0) summary.payableOverduePence += balancePence;
    }
    summary.netPositionPence += signedForCashPosition(row.direction, balancePence);

    if (!row.dueDay || row.dueDay < todayDay) continue;
    const horizon = daysBetweenDays(todayDay, row.dueDay);
    const side = receivable ? "in" : "out";
    if (horizon <= 7) summary.due7[side] += balancePence;
    if (horizon <= 14) summary.due14[side] += balancePence;
    if (horizon <= 30) summary.due30[side] += balancePence;
  }

  return summary;
}

/**
 * §9's chart: expected in against expected out, on due dates, over 90 days.
 *
 * EVERY DAY IN THE HORIZON IS PRESENT, including the empty ones. A series that
 * only carries the days money moves draws a chart whose x-axis is not time, and
 * a fortnight with nothing due renders as a single step rather than as the
 * fortnight it is. Ninety-one points (today plus ninety) is small enough to
 * send and simple enough to plot without the client filling gaps itself.
 *
 * MONEY ALREADY OVERDUE LANDS ON DAY ZERO. It is expected now, not on the day
 * it was contracted for, and plotting it in the past would put it outside the
 * chart entirely — which is the one thing a cash-flow chart must not do with
 * money you are already owed. The `overdueIn`/`overdueOut` totals are reported
 * separately so a caller can render day zero differently, and they are also the
 * amount the caller would otherwise have to reconcile by hand.
 */
export interface Forecast {
  points: ForecastPoint[];
  /** The overdue receivable balance folded into day zero. */
  overdueInPence: number;
  /** The overdue payable balance folded into day zero. */
  overdueOutPence: number;
  /** Balances due beyond the horizon, reported rather than silently dropped. */
  beyondHorizonInPence: number;
  beyondHorizonOutPence: number;
  /** No due date at all. Cannot be plotted, so it is stated instead. */
  undatedInPence: number;
  undatedOutPence: number;
}

export function cashForecast(
  rows: Iterable<CashRow>,
  todayDay: string,
  horizonDays: number = FORECAST_DAYS,
): Forecast {
  const days = Math.max(0, Math.trunc(horizonDays));
  const points: ForecastPoint[] = [];
  const index = new Map<string, ForecastPoint>();
  for (let offset = 0; offset <= days; offset += 1) {
    const point: ForecastPoint = { day: shiftDay(todayDay, offset), inPence: 0, outPence: 0 };
    points.push(point);
    index.set(point.day, point);
  }

  const forecast: Forecast = {
    points,
    overdueInPence: 0,
    overdueOutPence: 0,
    beyondHorizonInPence: 0,
    beyondHorizonOutPence: 0,
    undatedInPence: 0,
    undatedOutPence: 0,
  };

  const lastDay = points.length > 0 ? points[points.length - 1].day : todayDay;

  for (const row of rows) {
    const balancePence = Math.trunc(row.balancePence || 0);
    if (balancePence <= 0) continue;
    const receivable = row.direction === "receivable";

    if (!row.dueDay) {
      if (receivable) forecast.undatedInPence += balancePence;
      else forecast.undatedOutPence += balancePence;
      continue;
    }

    if (row.dueDay > lastDay) {
      if (receivable) forecast.beyondHorizonInPence += balancePence;
      else forecast.beyondHorizonOutPence += balancePence;
      continue;
    }

    /* Anything at or before today is expected NOW. */
    const target = row.dueDay < todayDay ? index.get(todayDay) : index.get(row.dueDay);
    if (!target) continue;
    if (row.dueDay < todayDay) {
      if (receivable) forecast.overdueInPence += balancePence;
      else forecast.overdueOutPence += balancePence;
    }
    if (receivable) target.inPence += balancePence;
    else target.outPence += balancePence;
  }

  return forecast;
}

/**
 * The running cash line, for a caller that wants the cumulative view.
 *
 * Not part of §9's contract and not sent by `/api/finance/summary`; exported
 * because "can I commit to a project next month" is a cumulative question and
 * the alternative is every consumer writing the same three-line loop, one of
 * which will get the sign wrong.
 */
export function cumulativeNet(points: readonly ForecastPoint[]): number[] {
  let running = 0;
  return points.map((point) => {
    running += point.inPence - point.outPence;
    return running;
  });
}
