import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState, serverFetch } from "../../../../lib/session";
import {
  canSeeMoney,
  formatMoney,
  type MonthlySummary,
} from "../../../../lib/portal";
import { STAGE_ORDER } from "../../../../lib/job-stages";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Monthly summary" };

/** "2026-08" → "Aug 2026". Built from the string, never re-parsed as a date. */
function monthLabel(month: string): string {
  const [year, index] = month.split("-");
  const names = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${names[Number(index) - 1] ?? month} ${year}`;
}

export default async function SummaryPage() {
  const state = await getViewerState();
  if (state.kind !== "ok") return null;

  // Contractors are refused by the API; this only decides whether they see a
  // refusal or the board, which is theirs.
  if (!canSeeMoney(state.viewer.actor)) redirect("/portal/dashboard");

  const result = await serverFetch<MonthlySummary>("/jobs/summary/monthly");

  if (!result.ok) {
    return (
      <div className="card card--empty">
        <h1>Monthly summary</h1>
        <p className="muted">{result.error}</p>
      </div>
    );
  }

  const { months, openByStage, totals } = result.data;
  /*
   * The scale for the little bars. Taken across raised AND completed so the two
   * columns are comparable — scaling each to its own maximum would draw a month
   * with 2 completed jobs the same width as one with 40.
   */
  const peak = Math.max(
    1,
    ...months.map((row) => Math.max(row.raised, row.completed)),
  );
  const openTotal = totals.open;

  return (
    <>
      <h1 className="p-h1">Monthly summary</h1>
      <p className="p-lede">
        The last twelve months of your maintenance, and what is open right now.
      </p>

      <section className="p-panel">
        <h2>The year so far</h2>
        <dl className="p-facts">
          <div>
            <dt>Jobs raised</dt>
            <dd>{totals.raised}</dd>
          </div>
          <div>
            <dt>Jobs completed</dt>
            <dd>{totals.completed}</dd>
          </div>
          <div>
            <dt>Spend</dt>
            <dd>{formatMoney(totals.spendPence) ?? "£0.00"}</dd>
          </div>
          <div>
            <dt>Open now</dt>
            <dd>{openTotal}</dd>
          </div>
        </dl>
        {/*
          The denominator, said out loud. "Spend" is a word people read as
          whatever they already believed it meant, and a figure whose definition
          is not on the page is one nobody can reconcile with an invoice.
        */}
        <p className="p-note">
          Spend counts the cost of works recorded against jobs{" "}
          <em>completed</em> in that month — or the approved quote where no cost
          has been written down — so a job raised in March and finished in May
          lands in May. Months with no activity are shown as zero rather than
          left out.
        </p>
      </section>

      <section className="p-panel">
        <h2>Month by month</h2>
        {/* The table scrolls inside its own box; the page never does. */}
        <div className="p-tablewrap">
          <table className="p-table">
            <thead>
              <tr>
                <th scope="col" className="p-sticky">
                  Month
                </th>
                <th scope="col">Raised</th>
                <th scope="col">Completed</th>
                <th scope="col" className="p-num">
                  Spend
                </th>
              </tr>
            </thead>
            <tbody>
              {months.map((row) => (
                <tr key={row.month}>
                  <th scope="row" className="p-sticky">
                    {monthLabel(row.month)}
                  </th>
                  <td>
                    {row.raised}
                    {/* Decorative: the number beside it IS the value, so the
                        bar carries nothing a screen reader needs to hear. Not
                        drawn at all for a zero — a stub of colour on an empty
                        month reads as "some", and the whole point of keeping
                        empty months in the series is that they say none. */}
                    {row.raised > 0 ? (
                      <span
                        className="p-mbar"
                        aria-hidden="true"
                        style={{ width: `${Math.round((row.raised / peak) * 100)}%` }}
                      />
                    ) : null}
                  </td>
                  <td>
                    {row.completed}
                    {row.completed > 0 ? (
                      <span
                        className="p-mbar p-mbar--done"
                        aria-hidden="true"
                        style={{ width: `${Math.round((row.completed / peak) * 100)}%` }}
                      />
                    ) : null}
                  </td>
                  <td className="p-num">
                    {row.spendPence ? formatMoney(row.spendPence) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="p-sticky">
                  Total
                </th>
                <td>{totals.raised}</td>
                <td>{totals.completed}</td>
                <td className="p-num">{formatMoney(totals.spendPence) ?? "£0.00"}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="p-panel">
        <h2>Open by stage</h2>
        {openTotal === 0 ? (
          <p className="p-note">Nothing is open. Every job is closed.</p>
        ) : (
          <dl className="p-facts">
            {STAGE_ORDER.filter((stage) => stage !== "Done").map((stage) => (
              <div key={stage}>
                <dt>{stage}</dt>
                <dd>{openByStage[stage] ?? 0}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="p-note">
          Counted from the board, not from this month — these are jobs that are
          still waiting on somebody, whenever they were raised.
        </p>
      </section>
    </>
  );
}
