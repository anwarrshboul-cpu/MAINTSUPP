import type { Metadata } from "next";
import Link from "next/link";
import "../../ms-tokens.css";
import "../../ms-analytics.css";
import { getViewerState, serverFetch } from "../../../../lib/session";
import {
  formatMoney,
  type AnalyticsOverview,
  type MonthlySummary,
  type WaitingJob,
} from "../../../../lib/portal";
import { Icon } from "../../../../components/icon";
import {
  AnalyticsMetricCard,
  DonutChart,
  DonutLegend,
  HorizontalBars,
  TrendChart,
  type DonutSegment,
} from "../../../../components/analytics-charts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Dashboard Overview" };

/**
 * Dashboard Overview — the legacy portal's landing screen, on Phase 2 data.
 *
 * WHAT THIS IS. The legacy app's Overview is a client-rendered screen over an
 * in-memory workspace snapshot: it holds every request, store, unit and
 * compliance record in the browser and recomputes each panel from them on
 * every filter change. This is the same screen drawn from aggregates the API
 * computes, on the server, with no component JavaScript shipped for the charts
 * at all. `/portal/analytics` already renders the same figures as tables; this
 * is the picture, and both read from `/analytics/overview` so they cannot
 * disagree about a number.
 *
 * ============================================================================
 * TWO OF THE LEGACY'S SIX KPI TILES ARE NOT HERE, AND THAT IS DELIBERATE.
 * ============================================================================
 *
 * "Active units" counted rows in a unit register. Phase 2 has no concept of a
 * unit — not an empty table, no table, no column, nothing on a job that names
 * one. The legacy tile itself carries a comment about this class of mistake:
 * it used to fall back to the number of SITES when the register was empty,
 * which "put a plausible number under the words 'Active units' that was really
 * a count of something else". Rendering a 0 here would be the same defect in
 * its other form — a reader takes "Active units: 0" as a fact about their
 * estate, when the truth is that nobody has ever been asked for one.
 *
 * "Overdue" counted open jobs whose target date had passed. Phase 2 jobs have
 * no due date column at all, so there is no date to be past. `next_update`
 * exists but means something else — when somebody promised to say more — and
 * counting against it would invent an SLA the business has not agreed to.
 *
 * So the row is four tiles, not six, and `.ms-metric-grid` is the legacy's
 * four-up base grid rather than its `--six` variant. Nothing is stretched to
 * fill a gap and no filler metric was invented to square the layout.
 *
 * ONE PANEL CHANGED ITS SUBJECT. The legacy's third bottom panel is "Jobs by
 * trade", read off `request.engineer`. Phase 2 does carry `engineer_required`
 * on a job, but no endpoint aggregates by it, and this pass may not add one —
 * grouping a single page of `GET /jobs` would draw a chart of 25 rows labelled
 * as if it were 798. Priority is a real ordered breakdown the API already
 * returns for every scoped job, so the panel draws that and says so in its own
 * header rather than being left empty or mislabelled.
 */

/* --------------------------------------------------------------- helpers -- */

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
 * Money for a chart axis: rounded to the pound, thousands abbreviated.
 *
 * The exact figure is never only here — the KPI tile above the chart prints
 * `formatMoney`, which does not round. A y-axis reading £13,644.18 at 54px
 * wide is unreadable, and a reader who needs the pence is reading the job.
 */
function shortMoney(pence: number): string {
  if (pence <= 0) return "£0";
  const pounds = pence / 100;
  if (pounds >= 1000) return `£${(pounds / 1000).toFixed(1)}k`;
  return `£${Math.round(pounds)}`;
}

function priorityChip(priority: string | null): string {
  switch (priority) {
    case "Urgent":
      return "ms-chip ms-chip--urgent";
    case "Medium":
      return "ms-chip ms-chip--medium";
    default:
      return "ms-chip ms-chip--low";
  }
}

/**
 * The compliance score, computed from the status counts already on this page.
 *
 * It is NOT a second round trip to `/compliance`. Both figures come from the
 * same cross join — every active requirement, at every visible site, with the
 * document if one exists, statused by `compliance_status_for` against today —
 * so the arithmetic here lands on the identical numbers, and doing it in one
 * place means the two panels on this screen cannot disagree with each other
 * about a denominator.
 *
 * `inDate` counts Valid AND Expiring: a certificate expiring next month has
 * not lapsed. "Not required" leaves the denominator entirely, which is why it
 * is subtracted rather than counted as a failure.
 *
 * `percent` is null, not 0, when nothing is required. "0%" says the sites are
 * failing their requirements; "no requirements recorded" says nobody has told
 * us what the requirements are, and a new client has the second problem.
 */
function complianceScore(rows: { label: string; documents: number }[]) {
  const count = (label: string) =>
    rows.find((row) => row.label === label)?.documents ?? 0;
  const valid = count("Valid");
  const expiring = count("Expiring");
  const expired = count("Expired");
  const missing = count("Missing");
  const inDate = valid + expiring;
  const required = inDate + expired + missing;
  return {
    valid,
    expiring,
    expired,
    missing,
    inDate,
    required,
    percent: required ? Math.round((inDate / required) * 100) : null,
  };
}

/* ------------------------------------------------------------------ page -- */

export default async function OverviewPage() {
  const state = await getViewerState();
  // The shell has already turned away anyone who is not active; this only
  // narrows the type so the page never renders actor-less.
  if (state.kind !== "ok") return null;

  /*
   * Two calls, in parallel, and only the first is required.
   *
   * `/analytics/overview` carries every figure this screen draws. The monthly
   * summary is asked for ONLY to give the KPI tiles a real twelve-month shape
   * to plot: the overview endpoint returns counts as of now with no time
   * dimension, and a sparkline is a claim about history. It refuses a
   * contractor outright (it is money-bearing), which is why its failure is
   * survivable — the tiles simply lose their lines and keep their figures.
   */
  const [result, monthly] = await Promise.all([
    serverFetch<AnalyticsOverview>("/analytics/overview"),
    serverFetch<MonthlySummary>("/jobs/summary/monthly"),
  ]);

  if (!result.ok) {
    return (
      <div className="card card--empty">
        <h1>Dashboard Overview</h1>
        <p className="muted">{result.error}</p>
      </div>
    );
  }

  const { jobs, ageing, compliance, spend, generatedAt } = result.data;
  const months = monthly.ok ? monthly.data.months : [];
  const score = complianceScore(compliance.byStatus);

  /*
   * The donut counts OPEN work, which is why Done is dropped rather than drawn
   * as a sixth slice. Done is 85% of this board, and a ring where one segment
   * swallows the circle tells a reader nothing about the six stages they can
   * actually act on. The centre figure is the open total, so the slices and
   * the number in the hole are the same population.
   */
  const statusSegments: DonutSegment[] = [
    { label: "New", value: 0, color: "var(--ms-brand-bright)" },
    { label: "Scheduling", value: 0, color: "var(--ms-blue-600)" },
    { label: "In Progress", value: 0, color: "var(--ms-orange-600)" },
    { label: "Quotes", value: 0, color: "var(--ms-purple-600)" },
    { label: "On Hold", value: 0, color: "var(--ms-red-600)" },
    { label: "Payment", value: 0, color: "var(--ms-green-700)" },
  ].map((segment) => ({
    ...segment,
    value: jobs.byStage.find((stage) => stage.label === segment.label)?.jobs ?? 0,
  }));

  const complianceSegments: DonutSegment[] = [
    { label: "Valid", value: score.valid, color: "var(--ms-brand-bright)" },
    { label: "Expiring", value: score.expiring, color: "var(--ms-orange-600)" },
    { label: "Expired", value: score.expired, color: "var(--ms-red-600)" },
    { label: "Missing", value: score.missing, color: "var(--ms-blue-600)" },
  ];

  const spendSeries = spend
    ? spend.months.map((month, index) => ({
        label: monthLabel(month),
        value: spend.monthlyTotals[index] ?? 0,
      }))
    : [];
  const hasSpend = spendSeries.some((point) => point.value > 0);

  return (
    <div className="ms-dash">
      <div className="ms-dash-stack">
        <section className="ms-heading">
          <div>
            <span>Live operations</span>
            <h1>Dashboard Overview</h1>
          </div>
          {/*
            No portfolio or period picker. The legacy heading carries both, and
            `/analytics/*` in Phase 2 accepts no parameters at all — its windows
            are hard-coded to six months. A control whose only possible effect
            is to do nothing teaches people the product is broken.
          */}
          <p className="ms-stamp">
            Counted {new Date(generatedAt).toLocaleString("en-GB", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </section>

        {/* ------------------------------------------------------- tiles -- */}

        <section className="ms-metric-grid">
          <AnalyticsMetricCard
            label="Open jobs"
            value={String(jobs.open)}
            detail={`${jobs.total} on the board in total`}
            icon="inbox"
            tone="blue"
            trend={months.map((month) => month.raised)}
            trendLabel="Jobs raised each month over the last twelve months"
            href="/portal/dashboard"
          />
          <AnalyticsMetricCard
            label="Completed"
            value={String(jobs.completed)}
            detail="Jobs at the Done stage"
            icon="check"
            tone="green"
            trend={months.map((month) => month.completed)}
            trendLabel="Jobs completed each month over the last twelve months"
            href="/portal/dashboard"
          />
          <AnalyticsMetricCard
            label="Compliance"
            value={score.percent === null ? "—" : `${score.percent}%`}
            /* Both integers, beside the percentage, always. A score can halve
               because the requirement list grew rather than because anything
               lapsed, and the fraction is the only way to tell the two apart. */
            detail={
              score.required
                ? `${score.inDate} of ${score.required} in date`
                : "No requirements recorded"
            }
            icon="shield"
            tone="teal"
            /* No sparkline: see `AnalyticsMetricCard`. The score is recomputed
               from today's date on every read and nothing records what it was. */
            href="/portal/compliance"
          />
          {spend ? (
            <AnalyticsMetricCard
              label="Cost of works, 6 months"
              value={formatMoney(spend.totalPence) ?? "—"}
              /* Counts SITES, not table rows: the spend table ends with an
                 "Other sites (n)" rollup, so its length read 13 while the money
                 spanned 26 stores. The API sends the real figure. */
              detail={`Across ${spend.siteCount} sites`}
              icon="chart"
              tone="orange"
              trend={spend.monthlyTotals}
              trendLabel="Cost of works recorded each month over the last six months"
              href="/portal/analytics"
            />
          ) : null}
        </section>

        {/* ------------------------------------------------------ bottom -- */}

        <section className="ms-bottom-grid">
          <article className="ms-panel ms-spend-panel">
            <header>
              <h2>Spend trend</h2>
              <span>Last 6 months</span>
            </header>
            {/*
              Cost is optional on a job and most of a live board is still open,
              so a portfolio can genuinely have no spend recorded. Plotting that
              as a line pinned to the axis looks like a charting failure, and
              worse, it invites the reader to conclude the work was free.
            */}
            {!spend ? (
              <p className="ms-empty">
                Cost of works is not part of your access, so spend is not shown here.
              </p>
            ) : hasSpend ? (
              <>
                <TrendChart items={spendSeries} valueFormatter={shortMoney} />
                <p className="ms-note">
                  By the month each job was <em>raised</em>, counting the cost of
                  works recorded against it. This will not match the monthly
                  summary, which counts jobs <em>completed</em> over twelve
                  months and falls back to the approved quote.
                </p>
              </>
            ) : (
              <p className="ms-empty">
                No costs recorded against jobs in the last six months. Spend
                appears here once jobs carry a cost.
              </p>
            )}
          </article>

          <article className="ms-panel ms-score-panel">
            <header>
              <h2>Compliance score</h2>
            </header>
            <DonutChart
              segments={complianceSegments}
              value={score.percent === null ? "—" : `${score.percent}%`}
              label="In date"
              size="medium"
            />
            {/*
              0% and "0 of 0" are different claims: one says the sites are
              failing their requirements, the other says nobody has told us what
              the requirements are. A new client has the second problem.
            */}
            <span>
              {score.required
                ? `${score.inDate} of ${score.required} requirements in date — a certificate expiring soon still counts as in date`
                : "No compliance requirements recorded for these sites yet"}
            </span>
            <Link href="/portal/compliance">
              View compliance <Icon name="chevron" size={15} />
            </Link>
          </article>

          <article className="ms-panel ms-mix-panel">
            <header>
              <h2>Jobs by priority</h2>
            </header>
            {/*
              An empty bar chart is indistinguishable from a broken one, so no
              jobs at all says so in words instead of drawing an axis with
              nothing on it.
            */}
            {jobs.total ? (
              <>
                <HorizontalBars
                  items={jobs.byPriority.map((slice) => ({
                    label: slice.label,
                    value: slice.jobs,
                    color:
                      slice.label === "Urgent"
                        ? "var(--ms-red-600)"
                        : slice.label === "Medium"
                          ? "var(--ms-orange-600)"
                          : slice.label === "Low"
                            ? "var(--ms-green-700)"
                            : "var(--ms-muted)",
                  }))}
                />
                <p className="ms-note">
                  Every job you can see, triaged or not — “Unset” is work nobody
                  has given a priority, which is exactly the thing worth seeing.
                  The legacy screen showed jobs by trade here; no Phase 2
                  endpoint groups by trade yet.
                </p>
              </>
            ) : (
              <p className="ms-empty">No jobs on the board yet.</p>
            )}
          </article>
        </section>

        {/* ---------------------------------------------------- attention -- */}

        <section className="ms-overview-grid">
          <article className="ms-panel">
            <header>
              <h2>Jobs requiring attention</h2>
              <Link href="/portal/dashboard">
                View all <Icon name="chevron" size={15} />
              </Link>
            </header>
            <div className="ms-tablewrap">
              <table className="ms-table">
                <caption className="sr-only">
                  Open jobs, the ones that have waited longest first, with how
                  many days each has been waiting
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Priority</th>
                    <th scope="col">Site</th>
                    <th scope="col">Issue</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="ms-num">Days</th>
                  </tr>
                </thead>
                <tbody>
                  {ageing.waitingLongest.map((job: WaitingJob) => (
                    <tr key={job.id}>
                      <td>
                        <span className={priorityChip(job.priority)}>
                          {job.priority ?? "Unset"}
                        </span>
                      </td>
                      <td>{job.site_name}</td>
                      <td>
                        {/*
                          A real link, not a row with a click handler. The
                          legacy table gave its `<tr>` role="button" and a
                          keydown listener; a link is what that always was, and
                          it opens in a new tab when somebody asks it to.
                        */}
                        <Link href={`/portal/jobs/${job.id}`}>
                          <span className="ms-ref">{job.reference}</span> {job.title}
                        </Link>
                      </td>
                      <td>
                        <span className="ms-status">{job.stage}</span>
                      </td>
                      <td className="ms-num">{job.age_days}</td>
                    </tr>
                  ))}
                  {!ageing.waitingLongest.length && (
                    <tr>
                      <td colSpan={5} className="ms-empty">
                        Nothing is open. Every job is closed.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="ms-note">
              The open jobs that have waited longest, oldest first. Completed
              jobs are not counted — this is about what is still waiting today.
            </p>
          </article>

          <article className="ms-panel">
            <header>
              <h2>Jobs by status</h2>
            </header>
            <div className="ms-donut-layout">
              <DonutChart
                segments={statusSegments}
                value={String(jobs.open)}
                label="Open jobs"
              />
              <DonutLegend segments={statusSegments} />
            </div>
            <p className="ms-note">
              Open work only, so the six stages and the figure in the middle
              count the same jobs. The {jobs.completed} at Done are on the
              Completed tile above.
            </p>
          </article>
        </section>
      </div>
    </div>
  );
}
