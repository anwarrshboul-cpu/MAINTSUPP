import type { Metadata } from "next";
import Link from "next/link";
import { getViewerState, serverFetch } from "../../../../lib/session";
import {
  formatMoney,
  priorityChipClass,
  type AnalyticsOverview,
  type ComplianceDue,
  type ContractorScore,
  type MixSlice,
  type WaitingJob,
} from "../../../../lib/portal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Analytics" };

/**
 * The analytics screen.
 *
 * Everything here is server-rendered from ONE request to `/analytics/overview`,
 * and there is no charting library: bars are divs with a width, the spend
 * matrix is a table with shaded cells. A dashboard is the last place to ship
 * 90KB of JavaScript to draw seven rectangles, and this product is read on a
 * phone in a shop corridor.
 *
 * COLOUR. Every chart on this page shows ORDERED data — stages run New to Done,
 * ageing runs young to old, months run left to right, spend runs small to large
 * — so each one takes a single hue in steps and the order is visible in the
 * colour itself. Identity colours appear only as the status chips, which are
 * capped at three hues and always carry their word: no reader ever has to know
 * what amber means.
 *
 * Every bar carries its number, so the chart is readable in greyscale, in
 * forced-colours mode, and by somebody who simply cannot judge a length.
 */

/** Which of the seven ramp steps a bar at `index` of `count` takes. */
function step(index: number, count: number): number {
  if (count <= 1) return 4;
  return Math.min(7, Math.max(1, 1 + Math.round((index * 6) / (count - 1))));
}

/** Which of the five heat steps a cell takes. 0 is "nothing here", not "least". */
function heat(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil((value / max) * 5)));
}

/** "2026-08" → "Aug 26". Parsed by hand: `new Date("2026-08")` is UTC-shifted. */
function monthLabel(month: string): string {
  const [year, index] = month.split("-").map(Number);
  if (!year || !index) return month;
  return new Date(year, index - 1, 1).toLocaleDateString("en-GB", {
    month: "short",
    year: "2-digit",
  });
}

/**
 * Money for a chart cell: rounded to the pound, and thousands abbreviated.
 *
 * The exact figure is always available — row and column totals below use
 * `formatMoney`, which does not round — so nothing here is the only place a
 * number appears. A grid of £12,345.67 at six columns wide is unreadable on a
 * phone, and a reader who needs the pence is reading the job, not the heatmap.
 */
function shortMoney(pence: number): string {
  if (pence <= 0) return "—";
  const pounds = pence / 100;
  if (pounds >= 1000) return `£${(pounds / 1000).toFixed(1)}k`;
  return `£${Math.round(pounds)}`;
}

/** A horizontal bar chart. One series, ordered, so no legend box is needed. */
function BarChart({
  rows,
  unit,
  format,
}: {
  rows: MixSlice[];
  unit: string;
  format?: (value: number) => string;
}) {
  // Scaled to the largest bar, not to the total: at a 40/1/1 split the two
  // small bars would otherwise be invisible slivers.
  const max = Math.max(...rows.map((row) => row.jobs), 1);

  return (
    <dl className="p-chart">
      {rows.map((row, index) => (
        <div className="p-chart-row" key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            <div className="p-track">
              <div
                className={`p-fill p-step-${step(index, rows.length)}`}
                style={{ width: `${(row.jobs / max) * 100}%` }}
              />
            </div>
          </dd>
          <dd className="p-chart-value">
            {format ? format(row.jobs) : row.jobs}
            <span className="sr-only"> {unit}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The ramp, explained once per chart that uses it. */
function RampLegend({ low, high, steps }: { low: string; high: string; steps: number }) {
  return (
    <p className="p-legend">
      <span>{low}</span>
      <span className="p-legend-scale" aria-hidden="true">
        {Array.from({ length: steps }, (_, index) => (
          <span key={index} className={`p-swatch p-step-${step(index, steps)}`} />
        ))}
      </span>
      <span>{high}</span>
    </p>
  );
}

function complianceChip(status: string): string {
  switch (status) {
    case "Valid":
      return "chip p-chip--good";
    case "Expiring":
      return "chip chip--medium";
    case "Expired":
    case "Missing":
      return "chip chip--urgent";
    default:
      return "chip chip--low";
  }
}

export default async function AnalyticsPage() {
  const state = await getViewerState();
  // The shell has already turned away anyone who is not active; this only
  // narrows the type so the page never renders actor-less.
  if (state.kind !== "ok") return null;

  const result = await serverFetch<AnalyticsOverview>("/analytics/overview");

  if (!result.ok) {
    return (
      <div className="card card--empty">
        <h1>Analytics</h1>
        <p className="muted">{result.error}</p>
      </div>
    );
  }

  const { jobs, ageing, compliance, contractors, spend, money } = result.data;
  const spendMax = spend
    ? Math.max(...spend.sites.flatMap((site) => site.monthly), 0)
    : 0;

  return (
    <>
      <h1 className="p-h1">Analytics</h1>
      <p className="p-lede">
        Everything below is your own view of the portfolio — the same rows the
        board would show you, counted.
      </p>

      <dl className="p-stats">
        <div className="p-stat">
          <dt>Jobs you can see</dt>
          <dd>{jobs.total}</dd>
        </div>
        <div className="p-stat">
          <dt>Still open</dt>
          <dd>{jobs.open}</dd>
          <p className="p-stat-note">{jobs.completed} completed</p>
        </div>
        <div className="p-stat">
          <dt>Certificates expired</dt>
          <dd>{compliance.expired}</dd>
          <p className="p-stat-note">{compliance.dueWithin.days30} due within 30 days</p>
        </div>
        {spend ? (
          <div className="p-stat">
            <dt>Cost of works, 6 months</dt>
            <dd>{formatMoney(spend.totalPence) ?? "—"}</dd>
            {/* Counts SITES, not table rows: `spend.sites` ends with an
                "Other sites (n)" rollup, so its length read 13 while the
                money spanned 26 stores. */}
            <p className="p-stat-note">Across {spend.siteCount} sites</p>
          </div>
        ) : null}
      </dl>

      {/* ------------------------------------------------------ job mix -- */}

      <section className="p-section">
        <div className="p-section-head">
          <h2>Where the work is</h2>
        </div>

        <div className="p-grid2">
          <div className="p-panel">
            <h3 className="p-small p-muted">Jobs by stage</h3>
            <BarChart rows={jobs.byStage} unit="jobs" />
            <RampLegend low="New" high="Done" steps={jobs.byStage.length} />
          </div>

          <div className="p-panel">
            <h3 className="p-small p-muted">Jobs by priority</h3>
            <BarChart rows={jobs.byPriority} unit="jobs" />
            <RampLegend low="Urgent" high="Low" steps={jobs.byPriority.length} />
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- ageing -- */}

      <section className="p-section">
        <div className="p-section-head">
          <h2>How long open jobs have been waiting</h2>
        </div>

        <div className="p-panel">
          <BarChart rows={ageing.buckets} unit="jobs" />
          <RampLegend
            low="Raised recently"
            high="Waiting longest"
            steps={ageing.buckets.length}
          />
          <p className="p-note">
            Completed jobs are not counted — ageing is about what is still
            waiting today.
          </p>
        </div>

        {ageing.waitingLongest.length ? (
          <div className="p-panel">
            <h3 className="p-small p-muted">The jobs waiting longest</h3>
            <div className="p-tablewrap">
              <table className="p-table">
                <caption className="sr-only">
                  Open jobs, oldest first, with how many days each has been waiting
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="p-sticky">
                      Job
                    </th>
                    <th scope="col">Site</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Priority</th>
                    <th scope="col" className="p-num">
                      Days
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ageing.waitingLongest.map((job: WaitingJob) => (
                    <tr key={job.id}>
                      <td className="p-sticky">
                        <Link href={`/portal/jobs/${job.id}`}>
                          <span className="p-mono">{job.reference}</span> {job.title}
                        </Link>
                      </td>
                      <td>{job.site_name}</td>
                      <td>{job.stage}</td>
                      <td>
                        <span className={priorityChipClass(job.priority)}>
                          {job.priority ?? "Unset"}
                        </span>
                      </td>
                      <td className="p-num">{job.age_days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>

      {/* --------------------------------------------------------- spend -- */}

      <section className="p-section">
        <div className="p-section-head">
          <h2>Cost of works by site</h2>
        </div>

        {spend ? (
          <div className="p-panel">
            {/*
              Both halves of the definition, on the page.

              This attributes cost to the month a job was RAISED, over six
              months. The organisation summary attributes to the month a job was
              COMPLETED, over twelve, and counts an approved quote where no cost
              has been written down. They are two different questions and will
              not match — the twelve-month figure can even be the smaller of the
              two. Each was reasonable on its own and neither mentioned the
              other, which left a reader with two totals and no way to reconcile
              them.
            */}
            <p className="p-note" style={{ marginTop: 0 }}>
              The last six months, by the month each job was <em>raised</em>,
              counting the cost of works recorded against it. Cells are rounded
              to the pound; the totals are exact. This will not match the
              organisation summary, which counts jobs <em>completed</em> over
              twelve months and falls back to the approved quote.
            </p>

            <div className="p-tablewrap">
              <table className="p-table">
                <caption className="sr-only">
                  Cost of works per site per month, for the last six months
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="p-sticky">
                      Site
                    </th>
                    {spend.months.map((month) => (
                      <th scope="col" className="p-num" key={month}>
                        {monthLabel(month)}
                      </th>
                    ))}
                    <th scope="col" className="p-num">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {spend.sites.map((site) => (
                    <tr key={site.siteName}>
                      <th scope="row" className="p-sticky">
                        {site.siteName}
                      </th>
                      {site.monthly.map((value, index) => (
                        <td
                          className={`p-num p-heat-${heat(value, spendMax)}`}
                          key={spend.months[index]}
                        >
                          {shortMoney(value)}
                        </td>
                      ))}
                      <td className="p-num">{formatMoney(site.totalPence)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="p-sticky">All sites</td>
                    {spend.monthlyTotals.map((value, index) => (
                      <td className="p-num" key={spend.months[index]}>
                        {shortMoney(value)}
                      </td>
                    ))}
                    <td className="p-num">{formatMoney(spend.totalPence)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="p-legend">
              <span>Less spent</span>
              <span className="p-legend-scale" aria-hidden="true">
                {[1, 2, 3, 4, 5].map((index) => (
                  <span key={index} className={`p-swatch p-heat-${index}`} />
                ))}
              </span>
              <span>More spent</span>
              <span className="p-muted">· every cell states its own figure</span>
            </p>
          </div>
        ) : (
          <div className="p-panel">
            <p className="p-note" style={{ marginTop: 0 }}>
              {money
                ? "No cost of works has been recorded in the last six months."
                : "Cost of works is not part of your access, so spend is not shown here."}
            </p>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------- compliance -- */}

      <section className="p-section">
        <div className="p-section-head">
          <h2>Compliance</h2>
        </div>

        <div className="p-grid2">
          <div className="p-panel">
            <h3 className="p-small p-muted">Certificates by status</h3>
            <ul className="p-files">
              {compliance.byStatus.map((row) => (
                <li key={row.label}>
                  <span>
                    <span className={complianceChip(row.label)}>{row.label}</span>
                  </span>
                  <span className="p-mono">{row.documents}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="p-panel">
            <h3 className="p-small p-muted">Expiring soon</h3>
            <BarChart
              rows={[
                { label: "Within 30 days", jobs: compliance.dueWithin.days30 },
                { label: "Within 60 days", jobs: compliance.dueWithin.days60 },
                { label: "Within 90 days", jobs: compliance.dueWithin.days90 },
              ]}
              unit="certificates"
            />
            <p className="p-note">
              Each window includes the one before it: “within 60 days” counts
              everything due in the next 60, the first 30 included. Already
              expired: <strong>{compliance.expired}</strong>.
            </p>
          </div>
        </div>

        {compliance.soonest.length ? (
          <div className="p-panel">
            <h3 className="p-small p-muted">Next to expire</h3>
            <div className="p-tablewrap">
              <table className="p-table">
                <thead>
                  <tr>
                    <th scope="col" className="p-sticky">
                      Certificate
                    </th>
                    <th scope="col">Site</th>
                    <th scope="col">Status</th>
                    <th scope="col">Expires</th>
                    <th scope="col" className="p-num">
                      Days left
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {compliance.soonest.map((doc: ComplianceDue) => (
                    <tr key={doc.id}>
                      <th scope="row" className="p-sticky">
                        {doc.kind}
                      </th>
                      <td>{doc.site_name}</td>
                      <td>
                        <span className={complianceChip(doc.status)}>{doc.status}</span>
                      </td>
                      <td>{doc.expiry_date}</td>
                      <td className={`p-num${doc.days_left < 0 ? " p-bad" : ""}`}>
                        {doc.days_left < 0 ? `${-doc.days_left} overdue` : doc.days_left}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>

      {/* --------------------------------------------------- contractors -- */}

      <section className="p-section">
        <div className="p-section-head">
          <h2>Contractors</h2>
        </div>

        <div className="p-panel">
          {contractors.rows.length ? (
            <div className="p-tablewrap">
              <table className="p-table">
                <caption className="sr-only">
                  Jobs and, where your role allows, spend per contractor
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="p-sticky">
                      Contractor
                    </th>
                    <th scope="col" className="p-num">
                      Jobs
                    </th>
                    <th scope="col" className="p-num">
                      Completed
                    </th>
                    {money ? (
                      <th scope="col" className="p-num">
                        Cost of works
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {contractors.rows.map((row: ContractorScore) => (
                    <tr key={row.id}>
                      <th scope="row" className="p-sticky">
                        {row.name}
                      </th>
                      <td className="p-num">{row.jobs}</td>
                      <td className="p-num">{row.completed}</td>
                      {/* `spendPence` is absent, not null, when the caller may
                          not see money — so this reads the key, not its value. */}
                      {money ? (
                        <td className="p-num">
                          {"spendPence" in row ? formatMoney(row.spendPence) : "—"}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-note" style={{ marginTop: 0 }}>
              No jobs have been assigned to a contractor yet.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
