"use client";

/**
 * Dashboard insight panels — the deeper charts added to Overview, Compliance and
 * Reports.
 *
 * COLOUR
 *
 * These use the MAINTSUPP palette unchanged, because it is the palette of the
 * whole site. Where the data is *ordered* — age buckets, a spend matrix — they
 * use a single-hue teal ramp rather than assorted brand colours, which is both
 * the correct encoding for ordered data and what lets the ramp pass validation
 * on the dark surface (monotone lightness, ≥0.06 step gaps, light end at 3.45:1).
 *
 * The brand hues are only ever used for *identity*, never more than three at a
 * time, and always with a legend and direct labels rather than colour alone.
 * `#6f8793` is deliberately never used to identify a series — its chroma is
 * 0.033, so it reads as grey; it is the de-emphasis colour and nothing else.
 *
 * Status colours (compliant / expiring / expired / missing) always ship with
 * their label, so no meaning rests on colour.
 *
 * DATA
 *
 * Every panel is computed from the rows the workspace already holds and is
 * scoped by organisation upstream, so two accounts see two different pictures
 * from the same code. Nothing here is hard-coded or sampled.
 */

import { useMemo } from "react";
import { Icon } from "../../components";
import { chipStyle } from "./chip-ink";
import type { MaintenanceRequest, StoreRecord } from "../../lib/types";
import type { WorkspaceComplianceRecord } from "../../lib/workspace-data";
import {
  bucketFor,
  parseStamp,
  periodColumns,
  periodVolumeSeries,
  resolvePeriod,
} from "./period-model";
import { isClosedRequest, isOpenRequest } from "./dashboard-meters";
import { TrendChart } from "./dashboard-analytics";
import {
  CONTRACTOR_SPEND_BASIS,
  attributeContractorWork,
  contractorJobCost,
  contractorSpendBasisNote,
  type ContractorRosterEntry,
} from "../../lib/contractor-attribution";

/**
 * The period a panel covers when its caller does not name one.
 *
 * "6m" resolves to the first of the month five months back through the end of
 * today, which is the six calendar months `SpendMatrix` and `ReactiveVsPlanned`
 * used to build for themselves. Keeping it as the default means a caller that
 * has not been updated draws exactly what it drew before, while a caller that
 * passes its period gets panels that follow it.
 */
const DEFAULT_PANEL_PERIOD = "6m";

/* ── Palette ─────────────────────────────────────────────────────────────── */

/** Single-hue ordinal ramp. Validated light→dark on the dark surface. */
export const TEAL_RAMP = ["#8fe3dc", "#4fcfc4", "#12b4a8", "#0a7d74"] as const;

/** Brand identity hues. Never more than three in one chart. */
const BRAND = {
  teal: "#12b4a8",
  amber: "#f0a91f",
  red: "#e2445c",
  blue: "#3899e8",
  slate: "#5c82af",
} as const;

/*
 * The same hues as TEXT.
 *
 * A hue that reads well as a 9px bar on any ground does not necessarily read
 * as a word on one: `BRAND.teal` set on the SLA percentage measured 2.59:1 on
 * a white panel. Fills stay exactly as they are — they are graphics, judged
 * against 3:1 — and only the text forms go through the tint tokens, which
 * carry a value for each theme.
 */
const TONE_TEXT = {
  teal: "var(--accent-fg)",
  amber: "var(--amber-600)",
  red: "var(--red-600)",
} as const;

/** De-emphasis only — too low in chroma to identify anything. */
const MUTED = "#6f8793";

export type SpendClass = "planned" | "projects" | "reactive";

/**
 * How a job's spend is classified.
 *
 * Exported and shared, because the Reports page shows the same split twice —
 * once as the four tiles at the top, once as the six-month trend below. Two
 * copies of this rule would drift, and a page that contradicts itself is worse
 * than one that only tells you half the story.
 */
export function classifySpend(request: MaintenanceRequest): SpendClass {
  if ((request.category ?? "").toLowerCase().includes("compliance") || request.tier >= 4) {
    return "planned";
  }
  if ((request.cost ?? 0) >= 1000) return "projects";
  return "reactive";
}

/**
 * Pounds in, pounds out. `maintenance_requests.cost` is a `real` holding
 * POUNDS — never pence — and the parameter used to be *named* `pence`, which
 * is exactly the misreading that once had a screen divide by 100 and print
 * £425 for £42,540. The name now states the contract the tests assert.
 */
function money(pounds: number) {
  return `£${Math.round(pounds).toLocaleString("en-GB")}`;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function daysBetween(from: string | null | undefined, to: string | null | undefined) {
  if (!from || !to) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/**
 * The caption for a job's priority in a split.
 *
 * The same judgement `tradeLabel` in views/overview-series.ts makes for the
 * trade bars, for the same reason: the legacy importer stringified monday's
 * blank status cells, so 22 rows carry the sixteen characters "[object
 * Object]" where a priority would be — see the note on UNUSABLE_TRADE_VALUES
 * there for the full provenance. A by-priority row captioned with the wreckage
 * of a value would be the identical defect wearing a different chart.
 */
function priorityLabel(value: unknown): string {
  if (typeof value !== "string") return "Priority not recorded";
  const text = value.trim();
  if (!text || ["[object object]", "undefined", "null"].includes(text.toLowerCase())) {
    return "Priority not recorded";
  }
  return text;
}

/* ── Shared shell ────────────────────────────────────────────────────────── */

export function InsightPanel({
  title,
  hint,
  action,
  children,
  empty,
  loading,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Shown instead of the chart when there is nothing to plot. A new account has
   * no data at all, and an empty axis with no explanation reads as a broken
   * panel rather than an empty one.
   */
  empty?: { message: string; hint?: string };
  /**
   * Shown instead of either while the panel's source has not answered yet.
   *
   * Loading and empty are different states: a panel fed by the workspace fetch
   * used to render its empty claim — "No sites yet", "No budgets set yet" — for
   * the seconds before that fetch landed, and permanently if it failed. A
   * definitive statement about data nobody has read yet is the one thing an
   * empty state must never make. Takes precedence over `empty`.
   */
  loading?: boolean;
}) {
  return (
    <section className="panel insight-panel">
      <header className="insight-panel__head">
        <div>
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
        </div>
        {action}
      </header>
      {loading ? (
        <div className="insight-empty" aria-busy="true">
          <Icon name="chart" size={22} />
          <strong>Loading…</strong>
        </div>
      ) : empty ? (
        <div className="insight-empty">
          <Icon name="chart" size={22} />
          <strong>{empty.message}</strong>
          {empty.hint && <span>{empty.hint}</span>}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

/* ── SLA and response performance ────────────────────────────────────────── */

/**
 * Did we hit our own targets?
 *
 * Measured against each job's own `dueAt`, which the workflow stamps from the
 * SLA for its priority when the job is raised. That is the target that actually
 * applied at the time — recomputing it from today's settings would silently
 * re-judge historic work every time someone edits a target.
 *
 * A job with no completion date is not counted as a miss. It is not yet judged,
 * and treating open work as failed would make the figure drop every time a
 * request comes in.
 */
export function SlaPerformance({ requests }: { requests: MaintenanceRequest[] }) {
  const stats = useMemo(() => {
    /*
     * Closed by the canonical partition, so "Jobs closed" here is the same
     * number as the Completed tile above this panel. It used to be "has a
     * completion date", and the monday import files finished work with a
     * "Job Completed" status and NO completion date — the tile would say 28
     * closed while this card said 1, on the same page.
     *
     * A closed job without dates is still not judged: `measured` needs both a
     * target and a completion stamp, and the close-time average is taken over
     * the rows that carry one (`?? 0` used to pour zero-day closes into the
     * mean for every undated row, which would have flattered it).
     */
    const closed = requests.filter(isClosedRequest);
    let onTime = 0;
    let measured = 0;
    let totalCloseDays = 0;
    let timedCloses = 0;
    const byPriority = new Map<string, { met: number; total: number }>();

    for (const request of closed) {
      const closeDays = daysBetween(request.requestedAt, request.completedAt);
      if (closeDays !== null) {
        totalCloseDays += closeDays;
        timedCloses += 1;
      }
      if (!request.dueAt || !request.completedAt) continue;

      const due = new Date(request.dueAt).getTime();
      const done = new Date(request.completedAt).getTime();
      if (Number.isNaN(due) || Number.isNaN(done)) continue;

      measured += 1;
      const met = done <= due;
      if (met) onTime += 1;

      // The import wrote "[object Object]" into `priority` on 22 rows — the
      // same wreckage `tradeLabel` catches for the trade bars. A split row
      // must not be captioned with the stringification of an absent value.
      const priority = priorityLabel(request.priority);
      const bucket = byPriority.get(priority) ?? { met: 0, total: 0 };
      bucket.total += 1;
      if (met) bucket.met += 1;
      byPriority.set(priority, bucket);
    }

    return {
      closed: closed.length,
      measured,
      onTimePercent: measured ? Math.round((onTime / measured) * 100) : 0,
      averageCloseDays: timedCloses ? totalCloseDays / timedCloses : 0,
      timedCloses,
      byPriority: [...byPriority.entries()]
        .map(([priority, bucket]) => ({
          priority,
          percent: Math.round((bucket.met / bucket.total) * 100),
          total: bucket.total,
        }))
        .sort((left, right) => right.total - left.total),
    };
  }, [requests]);

  if (!stats.measured) {
    return (
      <InsightPanel
        title="SLA performance"
        hint="On-time closure against each job's target date"
        empty={{
          message: "No closed job carries a target date yet",
          hint: "Jobs raised through the request form get a target from their priority. This fills in as they close.",
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const toneFor = (percent: number) =>
    percent >= 90 ? "teal" : percent >= 70 ? "amber" : "red";
  const toneKey = toneFor(stats.onTimePercent);
  const tone = BRAND[toneKey];

  return (
    <InsightPanel
      title="SLA performance"
      hint={`${plural(stats.measured, "closed job")} measured against their target date`}
    >
      <div className="insight-sla">
        {/* A single ratio against a limit — a meter, not a chart. */}
        <div className="insight-meter">
          <div
            className="insight-meter__track"
            role="img"
            aria-label={`${stats.onTimePercent}% of measured jobs met their target`}
          >
            <i style={{ width: `${stats.onTimePercent}%`, background: tone }} />
          </div>
          <strong style={{ color: TONE_TEXT[toneKey] }}>
            {stats.onTimePercent}%
          </strong>
          <span>met target</span>
        </div>

        <dl className="insight-facts">
          <div>
            <dt>Average time to close</dt>
            {/* A dash, not "0.0 days", when no close carries both dates. */}
            <dd>{stats.timedCloses ? `${stats.averageCloseDays.toFixed(1)} days` : "—"}</dd>
          </div>
          <div>
            <dt>Jobs closed</dt>
            <dd>{stats.closed}</dd>
          </div>
        </dl>

        {stats.byPriority.length > 0 && (
          <div className="insight-sla__split">
            <h4>By priority</h4>
            {stats.byPriority.map((row) => (
              <div key={row.priority} className="insight-sla__row">
                <span>{row.priority}</span>
                <div
                  className="insight-meter__track"
                  title={`${row.percent}% of ${plural(row.total, "job")} met target`}
                >
                  <i
                    style={{ width: `${row.percent}%`, background: toneFor(row.percent) }}
                  />
                </div>
                <strong>{row.percent}%</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </InsightPanel>
  );
}

/* ── Open job ageing ─────────────────────────────────────────────────────── */

const AGE_BUCKETS = [
  { label: "0–7 days", min: 0, max: 7 },
  { label: "8–30 days", min: 8, max: 30 },
  { label: "31–90 days", min: 31, max: 90 },
  { label: "90+ days", min: 91, max: Infinity },
] as const;

/**
 * Open work by age.
 *
 * Ordered buckets, so a single-hue ramp rather than four unrelated colours — the
 * reader should see the order in the colour. The oldest jobs are listed under
 * the chart, because the number in the 90+ bucket is not actionable on its own.
 */
export function OpenJobAgeing({
  requests,
  now,
  onOpen,
}: {
  requests: MaintenanceRequest[];
  /** One clock for every panel, passed in — reading it during render is impure. */
  now: number;
  onOpen?: (request: MaintenanceRequest) => void;
}) {
  const { buckets, oldest, total } = useMemo(() => {
    // Open by the canonical partition, not `!completedAt`. The monday import
    // files finished work in "… Recently completed" groups whose rows carry
    // status "Job Completed" but no completion date and stage "Incoming" — a
    // `!completedAt` test counts every one of them as open work still waiting,
    // and the oldest of them tops the "waiting longest" list. `isOpenRequest`
    // is the same signal the "Open jobs" tile and the board meters use, so this
    // panel can no longer disagree with the number above it.
    const open = requests.filter(isOpenRequest);
    const aged = open.map((request) => ({
      request,
      /*
       * FLOOR, not round: "how many days has this waited" counts whole days
       * completed, and it must agree with the "Days" column in the attention
       * table (`requestAgeDays` in portal-app.tsx, which floors). Rounding had
       * the same job reading 61 days here and 60 days there on one screen —
       * half a day old is 0 days waiting, not 1.
       */
      days: Math.max(
        0,
        Math.floor((now - new Date(request.requestedAt).getTime()) / 86_400_000),
      ),
    }));
    return {
      total: open.length,
      buckets: AGE_BUCKETS.map((bucket) => ({
        label: bucket.label,
        value: aged.filter((entry) => entry.days >= bucket.min && entry.days <= bucket.max)
          .length,
      })),
      oldest: [...aged].sort((left, right) => right.days - left.days).slice(0, 5),
    };
  }, [now, requests]);

  if (!total) {
    // Two different situations, and telling them apart matters: "everything is
    // closed" is good news, "there are no jobs" is a new workspace. One message
    // for both would congratulate an empty account on its throughput.
    const noJobsAtAll = requests.length === 0;
    return (
      <InsightPanel
        title="Open job ageing"
        hint="How long open work has been waiting"
        empty={{
          message: noJobsAtAll ? "No jobs yet" : "Nothing is open",
          hint: noJobsAtAll
            ? "Raise a request or import a board, and open work will appear here bucketed by age."
            : "Every job has been closed. New requests will appear here as they age.",
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const maximum = Math.max(...buckets.map((bucket) => bucket.value), 1);

  return (
    <InsightPanel
      title="Open job ageing"
      hint={`${plural(total, "open job")} by how long they have been waiting`}
    >
      <div className="insight-ageing">
        {buckets.map((bucket, index) => (
          <div
            key={bucket.label}
            className="insight-ageing__row"
            title={`${plural(bucket.value, "job")} in ${bucket.label}`}
          >
            <span>{bucket.label}</span>
            <div className="insight-bar">
              <i
                style={{
                  width: `${bucket.value ? Math.max((bucket.value / maximum) * 100, 3) : 0}%`,
                  background: TEAL_RAMP[index],
                }}
              />
            </div>
            <strong>{bucket.value}</strong>
          </div>
        ))}
      </div>

      {oldest.length > 0 && (
        <div className="insight-list">
          <h4>Waiting longest</h4>
          {oldest.map((entry) => (
            <button
              key={entry.request.id}
              type="button"
              onClick={() => onOpen?.(entry.request)}
              disabled={!onOpen}
            >
              <span>
                <strong>{entry.request.title || entry.request.description}</strong>
                <small>
                  {entry.request.location || "No location"} · {entry.request.status}
                </small>
              </span>
              <em>{plural(entry.days, "day")}</em>
            </button>
          ))}
        </div>
      )}
    </InsightPanel>
  );
}

/* ── Contractor scorecard ────────────────────────────────────────────────── */

/**
 * Who is actually performing.
 *
 * Contractor names are nominal — swapping their order changes nothing — so every
 * bar takes the same hue. Colouring each contractor differently would spend the
 * identity channel re-encoding what the bar length already shows.
 *
 * W06-12 — THIS PANEL COUNTED BY NAME TEXT, and a name is not an identity.
 *
 * It read `(request.contractor ?? "").trim()` and never looked at
 * `contractorId` at all: the same line commit `9c53bd9` removed from the
 * Contractors register, still here because nothing shared the rule between the
 * two screens and no test covered this panel. Measured on the running product:
 * the register showed a renamed contractor holding £250 while this table
 * printed that £250 under a name no register row carries. Attribution now goes
 * through `attributeContractorWork`, which is that one rule — see
 * app/lib/contractor-attribution.ts for the three ways the name-only version
 * was wrong and why an ambiguous name is attributed to nobody.
 */
export function ContractorScorecard({
  requests,
  contractors = [],
  loading = false,
}: {
  requests: MaintenanceRequest[];
  /**
   * The contractor register, which is what makes an id mean something.
   *
   * Optional and defaulting to empty, because a name-only estate is a real
   * state of this product — a workspace that has imported jobs but registered
   * nobody — and the panel still has something true to say about it: every job
   * then falls to the unregistered-name branch, exactly as it did before, and
   * the table looks the same. What changes is that as soon as a register EXISTS
   * it is believed ahead of the text.
   */
  contractors?: ContractorRosterEntry[];
  /**
   * Whether the rows have arrived yet. `InsightPanel` has rendered a
   * "Loading…" state since it was written; the panels simply were not told,
   * so on a slow first load each one announced "Nothing in this period"
   * against a named window — a finding about the portfolio, made before the
   * portfolio had been read. `SpendAgainstBudget` already took this prop;
   * these are the rest of the panels Reports draws.
   */
  loading?: boolean;
}) {
  const { rows, unplaced } = useMemo(() => {
    const attribution = attributeContractorWork(requests, contractors);
    /*
     * Registered contractors and unlinked names in one ranking, and a
     * registered contractor with no work in the window is left out of the
     * TABLE rather than shown as a zero row. That is this panel's question —
     * it ranks by volume and shows the top eight — and differs on purpose from
     * the Contractors register, which lists everybody because "we use them and
     * they did nothing this quarter" is what that page is for.
     */
    const ranked = [...attribution.byRoster, ...attribution.unregistered]
      .filter((row) => row.jobs.length > 0)
      .map((row) => {
        let closed = 0;
        let days = 0;
        for (const request of row.jobs) {
          const elapsed = daysBetween(request.requestedAt, request.completedAt);
          if (elapsed !== null) {
            closed += 1;
            days += elapsed;
          }
        }
        return {
          key: row.id ?? `name:${row.name}`,
          name: row.name,
          registered: row.registered,
          jobs: row.jobs.length,
          averageDays: closed ? days / closed : null,
          spend: contractorJobCost(row.jobs),
        };
      })
      .sort((left, right) => right.jobs - left.jobs);
    /*
     * What this table cannot place, carried out rather than dropped.
     *
     * Jobs with no contractor at all, jobs whose name two register rows share,
     * and jobs whose `contractor_id` points at nobody in this roster. The old
     * code silently discarded all three; a spend column somebody reads as a
     * total has to be able to say what is missing from it, and the ambiguous
     * case in particular is the operator's cue to rename one of the pair.
     */
    const claimed = attribution.unattributed.filter(
      (request) => Boolean(request.contractorId) || Boolean((request.contractor ?? "").trim()),
    );
    return {
      rows: ranked.slice(0, 8),
      unplaced: { jobs: claimed.length, spend: contractorJobCost(claimed) },
    };
  }, [contractors, requests]);

  if (!rows.length) {
    return (
      <InsightPanel
        loading={loading}
        title="Contractor scorecard"
        hint="Volume, speed and spend per contractor"
        empty={{
          message: "No contractor has been named on a job yet",
          hint: "Fill in the Contractor column on the board and this ranks them by volume, average close time and spend.",
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const maximum = Math.max(...rows.map((row) => row.jobs), 1);

  return (
    <InsightPanel
      title="Contractor scorecard"
      hint={`${plural(rows.length, "contractor")} by job volume`}
    >
      {/* A region that scrolls has to be reachable by keyboard: at 390px this
          wrapper is the only way to see the columns past the fold, and without
          a tab stop a keyboard user cannot scroll it at all. Named so the stop
          is not an anonymous one. */}
      <div
        className="insight-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Contractor scorecard"
      >
        <table className="insight-table">
          <thead>
            <tr>
              <th scope="col">Contractor</th>
              <th scope="col">Jobs</th>
              <th scope="col">Avg. close</th>
              {/* "Actual spend", because the register now also holds AGREED
                  terms — a day rate, a call-out charge, an hourly rate. This
                  column is neither: it is recorded job cost and nothing is
                  ever substituted for a cost nobody entered. */}
              <th scope="col">Actual spend</th>
            </tr>
          </thead>
          <tbody>
            {/* Keyed by the register id where there is one, so two contractors
                who genuinely share a name stay two rows. The old key was the
                NAME, which is the same mistake as counting by it. */}
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <div className="insight-table__bar">
                    <i
                      style={{
                        width: `${Math.max((row.jobs / maximum) * 100, 3)}%`,
                        background: BRAND.teal,
                      }}
                    />
                  </div>
                  <span>
                    {row.name}
                    {/* Said out loud, because a name-only row is a different
                        claim: nothing links these jobs to a register record,
                        so a rename of that firm will not carry them. */}
                    {!row.registered && (
                      <small title="Named on the job, but not linked to a contractor record">
                        {" "}
                        · not in register
                      </small>
                    )}
                  </span>
                </td>
                <td>{row.jobs}</td>
                <td>
                  {row.averageDays === null ? "—" : `${row.averageDays.toFixed(1)} d`}
                </td>
                <td>{row.spend ? money(row.spend) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="insight-note">
        {contractorSpendBasisNote(CONTRACTOR_SPEND_BASIS.requested)}
      </p>
      {unplaced.jobs > 0 && (
        /*
         * What the table left out, and never folded into somebody else's row.
         *
         * These are jobs that name a contractor the register cannot resolve to
         * exactly one record — an ambiguous name, or an id pointing at a record
         * that is gone. Attributing them to a guess is what this whole change
         * exists to stop; hiding them would make the spend column read as a
         * total it is not.
         */
        <p className="insight-note">
          {plural(unplaced.jobs, "job")} could not be matched to one contractor
          record{unplaced.spend ? ` (${money(unplaced.spend)})` : ""} and is
          counted against nobody.
        </p>
      )}
    </InsightPanel>
  );
}

/* ── Contractor cost, for the Dashboard ──────────────────────────────────── */

/**
 * WHAT THIS PORTFOLIO IS SPENDING WITH ITS CONTRACTORS, on the Overview.
 *
 * W06-12 asks for contractor cost on Reports AND the Dashboard. The scorecard
 * above has only ever been on Reports — `portal-app.tsx` renders it once, in
 * the `surface="reports"` widget list — so the Dashboard half of that wording
 * had nothing behind it at all. This is that half: the same attribution rule,
 * the same date basis as every other Overview figure, ranked by MONEY rather
 * than by volume, because "who is costing us the most" is the question a
 * dashboard is asked and the scorecard answers a different one.
 *
 * Deliberately NOT a second copy of the scorecard. It shows the total, how much
 * of it is linked to a register record, and the largest few — and it shares
 * `attributeContractorWork` with the scorecard and with the Contractors
 * register, so the three cannot drift the way the scorecard drifted from the
 * register for a whole release.
 */
export function ContractorCostPanel({
  requests,
  contractors = [],
  loading = false,
}: {
  requests: MaintenanceRequest[];
  contractors?: ContractorRosterEntry[];
  loading?: boolean;
}) {
  const summary = useMemo(() => {
    const attribution = attributeContractorWork(requests, contractors);
    const ranked = [...attribution.byRoster, ...attribution.unregistered]
      .map((row) => ({
        key: row.id ?? `name:${row.name}`,
        name: row.name,
        registered: row.registered,
        jobs: row.jobs.length,
        spend: contractorJobCost(row.jobs),
      }))
      .filter((row) => row.spend > 0)
      .sort((left, right) => right.spend - left.spend);
    /*
     * Three totals that add up, and are shown as three so nobody has to assume
     * they do. `attributed` is what this panel can put a name to; `unplaced` is
     * costed work whose contractor the register cannot resolve; `total` is
     * every costed job in the window including the ones nobody was named on.
     * A reader who wants the estate's whole spend has it, and a reader who
     * wants contractor spend is not silently handed the other number.
     */
    const attributed = ranked.reduce((sum, row) => sum + row.spend, 0);
    const unplaced = contractorJobCost(
      attribution.unattributed.filter(
        (request) => Boolean(request.contractorId) || Boolean((request.contractor ?? "").trim()),
      ),
    );
    return {
      rows: ranked.slice(0, 5),
      named: ranked.length,
      attributed,
      unplaced,
      total: contractorJobCost(requests),
      linked: attribution.byRoster.reduce((sum, row) => sum + contractorJobCost(row.jobs), 0),
    };
  }, [contractors, requests]);

  if (!summary.rows.length) {
    return (
      <InsightPanel
        loading={loading}
        title="Contractor spend"
        hint="Recorded job cost by contractor"
        empty={{
          message: "No costed job in this period names a contractor",
          hint: "Assign a contractor on the board and record the cost of works, and this ranks them by spend.",
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const maximum = Math.max(...summary.rows.map((row) => row.spend), 1);

  return (
    <InsightPanel
      title="Contractor spend"
      hint={`${money(summary.attributed)} attributed across ${plural(summary.named, "contractor")}`}
    >
      <dl className="insight-facts">
        <div>
          <dt>Attributed to a contractor</dt>
          <dd>{money(summary.attributed)}</dd>
        </div>
        <div>
          {/* The share the register actually stands behind. Name-only work is
              real spend, but it is not linked to anything a rename, a rate or
              a document can travel with. */}
          <dt>Of which linked to a record</dt>
          <dd>{money(summary.linked)}</dd>
        </div>
        <div>
          <dt>All job cost in period</dt>
          <dd>{money(summary.total)}</dd>
        </div>
      </dl>

      <div className="insight-ageing">
        {summary.rows.map((row) => (
          <div
            key={row.key}
            className="insight-ageing__row"
            title={`${money(row.spend)} across ${plural(row.jobs, "job")}`}
          >
            <span>{row.name}</span>
            <div className="insight-bar">
              <i
                style={{
                  width: `${Math.max((row.spend / maximum) * 100, 3)}%`,
                  background: BRAND.teal,
                }}
              />
            </div>
            <strong>{money(row.spend)}</strong>
          </div>
        ))}
      </div>

      <p className="insight-note">
        {contractorSpendBasisNote(CONTRACTOR_SPEND_BASIS.requested)}
      </p>
      {summary.unplaced > 0 && (
        <p className="insight-note">
          {money(summary.unplaced)} names a contractor the register cannot
          resolve to one record, and is counted against nobody.
        </p>
      )}
    </InsightPanel>
  );
}

/* ── Compliance expiry timeline ──────────────────────────────────────────── */

/**
 * What expires when, twelve months forward.
 *
 * Colour here is status, not identity, so every bar carries its count as a
 * label and the month carries its own name — nothing rests on the colour alone.
 */
export function ComplianceExpiryTimeline({
  compliance,
  now: clock,
}: {
  compliance: WorkspaceComplianceRecord[];
  now: number;
}) {
  const months = useMemo(() => {
    const now = new Date(clock);
    const slots: Array<{ key: string; label: string; count: number; overdue: boolean }> = [];
    for (let offset = 0; offset < 12; offset += 1) {
      const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      slots.push({
        key: `${date.getFullYear()}-${date.getMonth()}`,
        label: date.toLocaleDateString("en-GB", { month: "short" }),
        count: 0,
        overdue: false,
      });
    }
    const index = new Map(slots.map((slot) => [slot.key, slot]));

    let expired = 0;
    for (const record of compliance) {
      if (!record.expiry) continue;
      const date = new Date(record.expiry);
      if (Number.isNaN(date.getTime())) continue;
      if (date.getTime() < now.getTime()) {
        expired += 1;
        continue;
      }
      const slot = index.get(`${date.getFullYear()}-${date.getMonth()}`);
      if (slot) slot.count += 1;
    }
    return { slots, expired };
  }, [clock, compliance]);

  const total = months.slots.reduce((sum, slot) => sum + slot.count, 0);

  if (!total && !months.expired) {
    return (
      <InsightPanel
        title="Expiry timeline"
        hint="Certificates falling due over the next twelve months"
        empty={{
          message: "No expiry dates recorded",
          hint: "Add expiry dates to the certificate register and renewals can be planned rather than chased.",
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const maximum = Math.max(...months.slots.map((slot) => slot.count), 1);

  return (
    <InsightPanel
      title="Expiry timeline"
      hint={`${plural(total, "certificate")} due in the next twelve months`}
      action={
        months.expired > 0 ? (
          <span className="insight-flag">
            <Icon name="alert" size={14} />
            {plural(months.expired, "already expired", "already expired")}
          </span>
        ) : undefined
      }
    >
      <div className="insight-columns" role="img" aria-label="Certificates expiring by month">
        {months.slots.map((slot, index) => (
          <div
            key={slot.key}
            className="insight-columns__slot"
            title={`${plural(slot.count, "certificate")} due in ${slot.label}`}
          >
            <span className="insight-columns__value">{slot.count || ""}</span>
            <div className="insight-columns__track">
              <i
                style={{
                  height: `${slot.count ? Math.max((slot.count / maximum) * 100, 4) : 0}%`,
                  // The next three months are the ones that need action now.
                  background: index < 3 ? BRAND.amber : BRAND.teal,
                }}
              />
            </div>
            <span className="insight-columns__label">{slot.label}</span>
          </div>
        ))}
      </div>
      <p className="insight-note">
        <i style={{ background: BRAND.amber }} aria-hidden="true" />
        Next three months
        <i style={{ background: BRAND.teal }} aria-hidden="true" />
        Later in the year
      </p>
    </InsightPanel>
  );
}

/* ── Reactive versus planned ─────────────────────────────────────────────── */

/**
 * The share of spend going on unplanned work, month by month.
 *
 * Two series, so a legend plus a value label on each stack — colour never
 * carries the distinction on its own. A rising reactive share is the clearest
 * single signal that maintenance is slipping out of control.
 */
export function ReactiveVsPlanned({
  requests,
  now: clock,
  period = DEFAULT_PANEL_PERIOD,
  loading = false,
}: {
  requests: MaintenanceRequest[];
  now: number;
  /**
   * Whether the rows have arrived yet. `InsightPanel` has rendered a
   * "Loading…" state since it was written; the panels simply were not told,
   * so on a slow first load each one announced "Nothing in this period"
   * against a named window — a finding about the portfolio, made before the
   * portfolio had been read. `SpendAgainstBudget` already took this prop;
   * these are the rest of the panels Reports draws.
   */
  loading?: boolean;
  /**
   * The period the screen is reporting on.
   *
   * This panel used to build six calendar months from `now` and ignore the
   * period control entirely, so on "March 2026" it drew March through August
   * with five columns that could not contain a row by construction, and the
   * reactive share it printed was measured over months the reader had just
   * excluded. The columns now come from the window itself.
   */
  period?: string;
}) {
  const window = resolvePeriod(period, clock);
  const months = useMemo(() => {
    const stamps = requests.map((request) => parseStamp(request.requestedAt));
    const columns = periodColumns(period, clock, stamps, 6);
    const slots = columns.map((column) => ({
      key: column.key,
      label: column.label,
      reactive: 0,
      planned: 0,
    }));

    requests.forEach((request, index) => {
      const at = bucketFor(columns, stamps[index]);
      if (at < 0) return;
      // The same rule the spend tiles use, so the two cannot disagree. Note
      // the non-reactive stack HOLDS TWO CLASSES: "planned" (compliance work,
      // tier 4+) and "projects" (£1,000-plus jobs). The legend and the hover
      // text say so — a £1,142 emergency repair is in the teal stack because
      // it is large, not because anyone scheduled it, and a bar labelled
      // simply "planned" would claim otherwise.
      if (classifySpend(request) === "reactive") slots[at].reactive += 1;
      else slots[at].planned += 1;
    });
    return slots;
  }, [clock, period, requests]);

  const hasData = months.some((slot) => slot.reactive + slot.planned > 0);

  if (!hasData) {
    return (
      <InsightPanel
        loading={loading}
        title="Reactive vs planned"
        hint="The share of work that was not scheduled"
        /*
         * Two situations, two sentences. A period the control cannot read is
         * not an empty period; one message for both would tell one of the two
         * readers something untrue.
         */
        empty={{
          message: window.recognised
            ? `Nothing in this period — ${window.label}`
            : "No period selected",
          hint: window.recognised
            ? "Once work is logged in this window, this shows whether the reactive share is rising."
            : window.reason,
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const maximum = Math.max(...months.map((slot) => slot.reactive + slot.planned), 1);
  const totals = months.reduce(
    (sum, slot) => ({
      reactive: sum.reactive + slot.reactive,
      planned: sum.planned + slot.planned,
    }),
    { reactive: 0, planned: 0 },
  );
  const reactiveShare = Math.round(
    (totals.reactive / Math.max(totals.reactive + totals.planned, 1)) * 100,
  );

  return (
    <InsightPanel
      title="Reactive vs planned"
      hint={`${reactiveShare}% of the work in ${window.label} was reactive`}
    >
      <div className="insight-columns insight-columns--stacked">
        {months.map((slot) => {
          const total = slot.reactive + slot.planned;
          return (
            <div
              key={slot.key}
              className="insight-columns__slot"
              title={`${slot.label}: ${plural(slot.reactive, "reactive job")}, ${plural(slot.planned, "planned or project job")}`}
            >
              <span className="insight-columns__value">{total || ""}</span>
              <div className="insight-columns__track">
                <i
                  style={{
                    height: `${total ? (slot.planned / maximum) * 100 : 0}%`,
                    background: BRAND.teal,
                  }}
                />
                <i
                  style={{
                    height: `${total ? (slot.reactive / maximum) * 100 : 0}%`,
                    background: BRAND.amber,
                  }}
                />
              </div>
              <span className="insight-columns__label">{slot.label}</span>
            </div>
          );
        })}
      </div>
      <p className="insight-note">
        <i style={{ background: BRAND.amber }} aria-hidden="true" />
        Reactive
        <i style={{ background: BRAND.teal }} aria-hidden="true" />
        Planned / project
      </p>
    </InsightPanel>
  );
}

/* ── Spend by site and month ─────────────────────────────────────────────── */

/**
 * A site-by-month matrix.
 *
 * Magnitude on a grid, so a single-hue heatmap: more spend is darker. Every cell
 * carries its value as text as well as its shade, so the reader never has to
 * judge a colour to read a number.
 */
export function SpendMatrix({
  requests,
  stores,
  now: clock,
  period = DEFAULT_PANEL_PERIOD,
  direction = "desc",
  loading = false,
}: {
  requests: MaintenanceRequest[];
  stores: StoreRecord[];
  now: number;
  /**
   * Whether the rows have arrived yet. `InsightPanel` has rendered a
   * "Loading…" state since it was written; the panels simply were not told,
   * so on a slow first load each one announced "Nothing in this period"
   * against a named window — a finding about the portfolio, made before the
   * portfolio had been read. `SpendAgainstBudget` already took this prop;
   * these are the rest of the panels Reports draws.
   */
  loading?: boolean;
  /** The reporting period. See the note on `ReactiveVsPlanned`. */
  period?: string;
  /**
   * Row order. Highest total first by default, matching "Top sites by spend"
   * directly above it — the two answer the same question and reversing one
   * while the other stays put would read as a contradiction.
   */
  direction?: "desc" | "asc";
}) {
  const window = resolvePeriod(period, clock);
  const { rows, months } = useMemo(() => {
    const stamps = requests.map((request) => parseStamp(request.requestedAt));
    const slots = periodColumns(period, clock, stamps, 6);

    const nameById = new Map(stores.map((store) => [store.id, store.name]));
    const bySite = new Map<string, Map<string, number>>();

    requests.forEach((request, index) => {
      if (!request.cost) return;
      const at = bucketFor(slots, stamps[index]);
      if (at < 0) return;
      const site = nameById.get(request.siteId) ?? request.location ?? "Unassigned";
      const row = bySite.get(site) ?? new Map<string, number>();
      row.set(slots[at].key, (row.get(slots[at].key) ?? 0) + request.cost);
      bySite.set(site, row);
    });

    const ranked = [...bySite.entries()]
      .map(([site, cells]) => ({
        site,
        cells,
        total: [...cells.values()].reduce((sum, value) => sum + value, 0),
      }))
      .sort((left, right) => right.total - left.total);

    return {
      months: slots,
      // Sliced before reversing, so "Lowest first" shows the ten sites this
      // panel can speak for in the other order — not the ten cheapest sites in
      // the portfolio, which is a different claim.
      rows: direction === "asc" ? ranked.slice(0, 10).reverse() : ranked.slice(0, 10),
    };
  }, [clock, direction, period, requests, stores]);

  if (!rows.length) {
    return (
      <InsightPanel
        loading={loading}
        title="Spend by site"
        hint="Where the money goes, period by period"
        /* See the note on `ReactiveVsPlanned` — two situations, two sentences. */
        empty={{
          message: window.recognised
            ? `Nothing in this period — ${window.label}`
            : "No period selected",
          hint: window.recognised
            ? "Fill in Cost of Works on the board and this shows which sites are consistently expensive."
            : window.reason,
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const peak = Math.max(
    ...rows.flatMap((row) => [...row.cells.values()]),
    1,
  );

  /** Four steps of one hue — the ramp validated for ordered magnitude. */
  const shade = (value: number) => {
    if (!value) return "transparent";
    const ratio = value / peak;
    if (ratio > 0.66) return TEAL_RAMP[3];
    if (ratio > 0.33) return TEAL_RAMP[2];
    if (ratio > 0.1) return TEAL_RAMP[1];
    return TEAL_RAMP[0];
  };

  return (
    <InsightPanel
      title="Spend by site"
      hint={`${window.label}. Darker means more spent.`}
    >
      {/* A region that scrolls has to be reachable by keyboard: at 390px this
          wrapper is the only way to see the columns past the fold, and without
          a tab stop a keyboard user cannot scroll it at all. Named so the stop
          is not an anonymous one. */}
      <div
        className="insight-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Spend by site"
      >
        <table className="insight-matrix">
          <thead>
            <tr>
              <th scope="col">Site</th>
              {months.map((month) => (
                <th key={month.key} scope="col">
                  {month.label}
                </th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.site}>
                <th scope="row">{row.site}</th>
                {months.map((month) => {
                  const value = row.cells.get(month.key) ?? 0;
                  return (
                    <td
                      key={month.key}
                      title={`${row.site}, ${month.label}: ${value ? money(value) : "nothing spent"}`}
                    >
                      <span
                        className="insight-matrix__cell"
                        /*
                         * The ramp is data, so the cell keeps its shade and
                         * the label is measured against it. The old rule was
                         * "white above a third of peak", which left the two
                         * palest steps inheriting `--muted`: 4.45:1 in light
                         * and 1.55:1 in dark on the same ramp step.
                         */
                        style={
                          value
                            ? chipStyle(shade(value))
                            : { background: shade(value) }
                        }
                      >
                        {value ? money(value) : "—"}
                      </span>
                    </td>
                  );
                })}
                <td>
                  <strong>{money(row.total)}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </InsightPanel>
  );
}

/* ── Cost by job category ────────────────────────────────────────────────── */

/** Which kinds of fault cost the most. Nominal categories, so one hue. */
/**
 * JOB VOLUME TREND — the chart that replaced the second Spend trend.
 *
 * THE DEFECT THIS FIXES. /dashboard/reports drew "Spend trend" twice: once as
 * the `analytics-report-trend` panel and again as the first arrangeable widget
 * beneath it. Same rows, same period, same axis, same title — the owner
 * screenshotted the pair. Two identical charts do not merely waste a screen;
 * they make a reader look for the difference between them and invent one.
 *
 * WHY VOLUME, of the four candidates offered. "Reactive vs planned" is already
 * a widget on this page, so it would have moved the duplication rather than
 * removed it. SLA has its own panel on the Overview and is not a spend
 * question. Job volume is the one analysis that is provably absent from the
 * product AND makes the chart above it more informative: spend and volume side
 * by side answer "is spend up because we raised more work, or because the work
 * got more expensive?", which is the question a spend report is opened to ask
 * and which neither line answers alone.
 *
 * It shares `periodVolumeSeries` with the spend chart's bucketing — same edges,
 * same window rule — because the comparison is only valid if the two lines are
 * cut identically.
 *
 * NOTE WHAT IT COUNTS: jobs RAISED in each bucket, by `requestedAt`. Not jobs
 * closed, and not the open count over time — no status history is recorded
 * anywhere in this product, so a "how has our backlog moved" line cannot be
 * drawn honestly and is not attempted. The hint says so on the panel.
 */
export function JobVolumeTrend({
  requests,
  period,
  now,
  loading = false,
}: {
  requests: MaintenanceRequest[];
  period: string;
  now: number;
  loading?: boolean;
}) {
  const series = useMemo(
    () => periodVolumeSeries(requests, period, now),
    [now, period, requests],
  );
  const window = resolvePeriod(period, now);
  const total = series.reduce((sum, point) => sum + point.value, 0);

  /*
   * Unlike spend, a zero here is unambiguous — no job was raised — so an empty
   * period says exactly that rather than hedging about missing cost data.
   */
  if (total === 0) {
    return (
      <InsightPanel
        loading={loading}
        title="Job volume"
        hint={window.label}
        empty={{
          message: "No jobs were raised in this period",
          hint: "This counts jobs by the date they were raised.",
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  return (
    <InsightPanel
      title="Job volume"
      /* `plural` already prints the count, so interpolating `total` beside it
         rendered "73 73 jobs raised" on the live page. */
      hint={`${plural(total, "job")} raised · ${window.label}`}
    >
      <TrendChart
        items={series}
        valueFormatter={(value) => `${Math.round(value)}`}
      />
    </InsightPanel>
  );
}

export function CostByCategory({
  requests,
  loading = false,
}: {
  requests: MaintenanceRequest[];
  /**
   * Whether the rows have arrived yet. `InsightPanel` has rendered a
   * "Loading…" state since it was written; the panels simply were not told,
   * so on a slow first load each one announced "Nothing in this period"
   * against a named window — a finding about the portfolio, made before the
   * portfolio had been read. `SpendAgainstBudget` already took this prop;
   * these are the rest of the panels Reports draws.
   */
  loading?: boolean;
}) {
  const rows = useMemo(() => {
    const byCategory = new Map<string, { total: number; jobs: number }>();
    for (const request of requests) {
      const label = (request.category ?? "").trim() || "Unlabelled";
      const entry = byCategory.get(label) ?? { total: 0, jobs: 0 };
      entry.total += request.cost ?? 0;
      entry.jobs += 1;
      byCategory.set(label, entry);
    }
    return [...byCategory.entries()]
      .map(([label, entry]) => ({
        label,
        total: entry.total,
        jobs: entry.jobs,
        average: entry.jobs ? entry.total / entry.jobs : 0,
      }))
      .filter((row) => row.total > 0)
      .sort((left, right) => right.total - left.total)
      .slice(0, 8);
  }, [requests]);

  if (!rows.length) {
    return (
      <InsightPanel
        loading={loading}
        title="Cost by job type"
        hint="Which kinds of fault cost the most"
        empty={{
          message: "No costed jobs yet",
          hint: "Set the Label and Cost of Works columns and recurring expensive categories will stand out here.",
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const maximum = Math.max(...rows.map((row) => row.total), 1);

  return (
    <InsightPanel title="Cost by job type" hint="Total spend, with the average per job">
      <div className="insight-ageing">
        {rows.map((row) => (
          <div
            key={row.label}
            className="insight-ageing__row"
            title={`${row.label}: ${money(row.total)} across ${plural(row.jobs, "job")} — ${money(row.average)} average`}
          >
            <span>{row.label}</span>
            <div className="insight-bar">
              <i
                style={{
                  width: `${Math.max((row.total / maximum) * 100, 3)}%`,
                  background: BRAND.teal,
                }}
              />
            </div>
            <strong>{money(row.total)}</strong>
          </div>
        ))}
      </div>
    </InsightPanel>
  );
}

/* ── Site risk ───────────────────────────────────────────────────────────── */

/**
 * Which sites need attention, combining open work with compliance gaps.
 *
 * One row per site with two small meters rather than a composite "risk score" —
 * a single invented number would hide which of the two is actually the problem.
 */
export function SiteAttention({
  requests,
  compliance,
  stores,
  loading = false,
}: {
  requests: MaintenanceRequest[];
  compliance: WorkspaceComplianceRecord[];
  stores: StoreRecord[];
  /** True while the workspace fetch has not answered — see `InsightPanel`. */
  loading?: boolean;
}) {
  const rows = useMemo(() => {
    const nameById = new Map(stores.map((store) => [store.id, store.name]));
    const bySite = new Map<string, { open: number; urgent: number; gaps: number }>();

    const ensure = (site: string) =>
      bySite.get(site) ?? { open: 0, urgent: 0, gaps: 0 };

    for (const request of requests) {
      // Closed by the canonical partition, not `completedAt`: a monday-imported
      // "Job Completed" row carries no completion date, so skipping on
      // `completedAt` alone would count finished jobs as a site's open work and
      // disagree with the "Open jobs" tile. Same signal as the board meters.
      if (isClosedRequest(request)) continue;
      const site = nameById.get(request.siteId) ?? request.location ?? "Unassigned";
      const entry = ensure(site);
      entry.open += 1;
      if (request.priority === "Urgent") entry.urgent += 1;
      bySite.set(site, entry);
    }

    for (const record of compliance) {
      if (record.state === "Compliant" || record.state === "Not required") continue;
      const entry = ensure(record.siteName);
      entry.gaps += 1;
      bySite.set(record.siteName, entry);
    }

    return [...bySite.entries()]
      .map(([site, entry]) => ({ site, ...entry }))
      .filter((row) => row.open + row.gaps > 0)
      .sort(
        (left, right) =>
          right.urgent * 3 + right.gaps * 2 + right.open -
          (left.urgent * 3 + left.gaps * 2 + left.open),
      )
      .slice(0, 8);
  }, [compliance, requests, stores]);

  if (loading || !rows.length) {
    return (
      <InsightPanel
        title="Sites needing attention"
        hint="Open work and compliance gaps together"
        loading={loading}
        empty={{
          message: stores.length ? "Nothing outstanding" : "No sites yet",
          hint: stores.length
            ? "No site currently has open jobs or missing certificates."
            : "Add your sites, and this ranks them by urgent work and compliance gaps.",
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const peakOpen = Math.max(...rows.map((row) => row.open), 1);
  const peakGaps = Math.max(...rows.map((row) => row.gaps), 1);

  return (
    <InsightPanel
      title="Sites needing attention"
      hint="Ranked by urgent work and compliance gaps"
    >
      {/* A region that scrolls has to be reachable by keyboard: at 390px this
          wrapper is the only way to see the columns past the fold, and without
          a tab stop a keyboard user cannot scroll it at all. Named so the stop
          is not an anonymous one. */}
      <div
        className="insight-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Sites needing attention"
      >
        <table className="insight-table insight-table--split">
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col">Open jobs</th>
              <th scope="col">Compliance gaps</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.site}>
                <th scope="row">{row.site}</th>
                <td title={`${plural(row.open, "open job")}, ${row.urgent} urgent`}>
                  <div className="insight-bar insight-bar--slim">
                    <i
                      style={{
                        width: `${Math.max((row.open / peakOpen) * 100, row.open ? 4 : 0)}%`,
                        background: row.urgent ? BRAND.red : BRAND.blue,
                      }}
                    />
                  </div>
                  <span>
                    {row.open}
                    {row.urgent > 0 && <em> · {row.urgent} urgent</em>}
                  </span>
                </td>
                <td title={`${plural(row.gaps, "certificate")} missing or expired`}>
                  <div className="insight-bar insight-bar--slim">
                    <i
                      style={{
                        width: `${Math.max((row.gaps / peakGaps) * 100, row.gaps ? 4 : 0)}%`,
                        background: row.gaps ? BRAND.amber : MUTED,
                      }}
                    />
                  </div>
                  <span>{row.gaps}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </InsightPanel>
  );
}

/* ── Spend against budget ────────────────────────────────────────────────── */

/**
 * What each site has spent against what it was given.
 *
 * The one Stage 18 panel that was never built, because there was nowhere to put
 * a budget. `sites.annual_budget_pence` is that place — per site, because that
 * is the level a budget is actually set at, and a portfolio figure is then just
 * the sum. Going the other way, splitting one portfolio number across ten
 * stores, would be invention.
 *
 * UNITS. `annualBudgetPence` is pence, as all money in `sites` is;
 * `request.cost` is POUNDS, which is why `classifySpend` compares it against
 * 1000 for "projects" and why the helper named `money()` takes pounds. The
 * conversion happens once, here, rather than being repeated at each use.
 *
 * A site with no budget set is NOT treated as a budget of zero — that would
 * report every unbudgeted site as infinitely over. It is counted separately and
 * named, so the panel says how much of the portfolio it can actually speak for.
 * That distinction is the whole reason this panel can be trusted: "£40,000 of
 * £120,000, covering 5 of 10 sites" is an answer; "£40,000 of £120,000" when
 * half the portfolio has no budget is a lie by omission.
 */
export function SpendAgainstBudget({
  requests,
  sites,
  period,
  now,
  loading = false,
}: {
  requests: MaintenanceRequest[];
  sites: Array<{ id: string; name: string; annualBudgetPence: number | null }>;
  /** True while the workspace fetch has not answered — see `InsightPanel`. */
  loading?: boolean;
  /**
   * Named so the panel can say what it is comparing.
   *
   * The denominator here is an ANNUAL budget and the numerator is whatever the
   * period selector has scoped `requests` to. That was harmless while the only
   * choices were 30, 90 or 365 days; with "Today" and "Last quarter" on the
   * menu it stops being harmless — one day's spend drawn against a year's
   * budget is a bar that means nothing unless the reader is told which window
   * fed it. The panel therefore prints the window rather than silently
   * implying a full year.
   *
   * Passed with the caller's clock rather than reading `Date.now()` here: a
   * component that calls it during render is not idempotent, and the two
   * dashboards already hold one shared, ticking `now`.
   */
  period?: string;
  now?: number;
}) {
  const rows = useMemo(() => {
    const spendBySite = new Map<string, number>();
    for (const request of requests) {
      if (!request.siteId || request.cost == null) continue;
      spendBySite.set(request.siteId, (spendBySite.get(request.siteId) ?? 0) + request.cost);
    }

    return sites
      .filter((site) => site.annualBudgetPence != null)
      .map((site) => {
        const budget = (site.annualBudgetPence ?? 0) / 100;
        const spent = spendBySite.get(site.id) ?? 0;
        return {
          id: site.id,
          name: site.name,
          budget,
          spent,
          // Guarded: a budget of exactly zero is legitimate ("spend nothing
          // here"), and dividing by it would render Infinity into the bar.
          percent: budget > 0 ? Math.round((spent / budget) * 100) : null,
        };
      })
      .sort((left, right) => (right.percent ?? 0) - (left.percent ?? 0));
  }, [requests, sites]);

  const unbudgeted = sites.filter((site) => site.annualBudgetPence == null).length;

  if (loading || !rows.length) {
    return (
      <InsightPanel
        title="Spend against budget"
        hint="How each site is tracking against its annual maintenance budget"
        loading={loading}
        empty={{
          message: "No budgets set yet",
          hint:
            "Set an annual maintenance budget on a site — Sites, open a site, Lease — and this fills itself in from the Cost of Works column.",
        }}
      >
        <span />
      </InsightPanel>
    );
  }

  const totalBudget = rows.reduce((sum, row) => sum + row.budget, 0);
  const totalSpent = rows.reduce((sum, row) => sum + row.spent, 0);
  const totalPercent = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : null;
  // The spend is the period's; the budget is the year's. Say so.
  const budgetWindow = period && now !== undefined ? resolvePeriod(period, now) : null;
  const windowNote =
    budgetWindow && budgetWindow.recognised
      ? `. Spend is ${budgetWindow.label}; budgets are annual.`
      : "";

  return (
    <InsightPanel
      title="Spend against budget"
      hint={`${
        unbudgeted
          ? `${money(totalSpent)} of ${money(totalBudget)} — covering ${rows.length} of ${rows.length + unbudgeted} sites`
          : `${money(totalSpent)} of ${money(totalBudget)} across the portfolio`
      }${windowNote}`}
    >
      <div className="budget-list">
        {/*
          The portfolio total first, then each site. monday's battery widget
          reads as one bar with the number on it, so the bar carries the
          percentage rather than putting it in a legend the eye has to travel to.
        */}
        <div className="budget-row budget-row--total">
          <div className="budget-row__head">
            <strong>All sites with a budget</strong>
            <span>
              {money(totalSpent)} / {money(totalBudget)}
            </span>
          </div>
          <BudgetBar percent={totalPercent} />
        </div>

        {rows.map((row) => (
          <div className="budget-row" key={row.id}>
            <div className="budget-row__head">
              <strong>{row.name}</strong>
              <span>
                {money(row.spent)} / {money(row.budget)}
              </span>
            </div>
            <BudgetBar percent={row.percent} />
          </div>
        ))}
      </div>

      {unbudgeted > 0 && (
        <p className="budget-note">
          {plural(unbudgeted, "site has", "sites have")} no budget set, so
          {unbudgeted === 1 ? " it is" : " they are"} not counted above. Set one
          on the site record to include {unbudgeted === 1 ? "it" : "them"}.
        </p>
      )}
    </InsightPanel>
  );
}

/**
 * monday's battery: one bar, the number on it, colour by how close to the line.
 *
 * Over budget is drawn as a full bar with the real percentage beside it rather
 * than a bar that overflows its track — 340% of budget is a number to read, not
 * a shape to compare, and letting the fill escape the track breaks the row.
 */
function BudgetBar({ percent }: { percent: number | null }) {
  if (percent === null) {
    return (
      <div className="budget-bar budget-bar--none">
        <span>No budget to measure against</span>
      </div>
    );
  }
  const state = percent > 100 ? "over" : percent >= 85 ? "close" : "within";
  return (
    <div
      className={`budget-bar budget-bar--${state}`}
      role="img"
      aria-label={`${percent}% of budget spent`}
    >
      <i style={{ width: `${Math.min(percent, 100)}%` }} />
      <span>{percent}%</span>
    </div>
  );
}
