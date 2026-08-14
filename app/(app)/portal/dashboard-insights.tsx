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
  resolvePeriod,
} from "./period-model";

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

function money(pence: number) {
  return `£${Math.round(pence).toLocaleString("en-GB")}`;
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

/* ── Shared shell ────────────────────────────────────────────────────────── */

export function InsightPanel({
  title,
  hint,
  action,
  children,
  empty,
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
      {empty ? (
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
    const closed = requests.filter((request) => request.completedAt);
    let onTime = 0;
    let measured = 0;
    let totalCloseDays = 0;
    const byPriority = new Map<string, { met: number; total: number }>();

    for (const request of closed) {
      totalCloseDays += daysBetween(request.requestedAt, request.completedAt) ?? 0;
      if (!request.dueAt) continue;

      const due = new Date(request.dueAt).getTime();
      const done = new Date(request.completedAt as string).getTime();
      if (Number.isNaN(due) || Number.isNaN(done)) continue;

      measured += 1;
      const met = done <= due;
      if (met) onTime += 1;

      const bucket = byPriority.get(request.priority) ?? { met: 0, total: 0 };
      bucket.total += 1;
      if (met) bucket.met += 1;
      byPriority.set(request.priority, bucket);
    }

    return {
      closed: closed.length,
      measured,
      onTimePercent: measured ? Math.round((onTime / measured) * 100) : 0,
      averageCloseDays: closed.length ? totalCloseDays / closed.length : 0,
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
            <dd>{stats.averageCloseDays.toFixed(1)} days</dd>
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
    const open = requests.filter((request) => !request.completedAt);
    const aged = open.map((request) => ({
      request,
      days: Math.max(
        0,
        Math.round((now - new Date(request.requestedAt).getTime()) / 86_400_000),
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
 */
export function ContractorScorecard({ requests }: { requests: MaintenanceRequest[] }) {
  const rows = useMemo(() => {
    const byContractor = new Map<
      string,
      { jobs: number; closed: number; days: number; spend: number }
    >();
    for (const request of requests) {
      const name = (request.contractor ?? "").trim();
      if (!name) continue;
      const entry =
        byContractor.get(name) ?? { jobs: 0, closed: 0, days: 0, spend: 0 };
      entry.jobs += 1;
      entry.spend += request.cost ?? 0;
      const days = daysBetween(request.requestedAt, request.completedAt);
      if (days !== null) {
        entry.closed += 1;
        entry.days += days;
      }
      byContractor.set(name, entry);
    }
    return [...byContractor.entries()]
      .map(([name, entry]) => ({
        name,
        jobs: entry.jobs,
        closed: entry.closed,
        averageDays: entry.closed ? entry.days / entry.closed : null,
        spend: entry.spend,
      }))
      .sort((left, right) => right.jobs - left.jobs)
      .slice(0, 8);
  }, [requests]);

  if (!rows.length) {
    return (
      <InsightPanel
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
      <div className="insight-table-wrap">
        <table className="insight-table">
          <thead>
            <tr>
              <th scope="col">Contractor</th>
              <th scope="col">Jobs</th>
              <th scope="col">Avg. close</th>
              <th scope="col">Spend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td>
                  <div className="insight-table__bar">
                    <i
                      style={{
                        width: `${Math.max((row.jobs / maximum) * 100, 3)}%`,
                        background: BRAND.teal,
                      }}
                    />
                  </div>
                  <span>{row.name}</span>
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
}: {
  requests: MaintenanceRequest[];
  now: number;
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
      // The same rule the spend tiles use, so the two cannot disagree.
      if (classifySpend(request) === "reactive") slots[at].reactive += 1;
      else slots[at].planned += 1;
    });
    return slots;
  }, [clock, period, requests]);

  const hasData = months.some((slot) => slot.reactive + slot.planned > 0);

  if (!hasData) {
    return (
      <InsightPanel
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
              title={`${slot.label}: ${plural(slot.reactive, "reactive job")}, ${plural(slot.planned, "planned job")}`}
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
        Planned
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
}: {
  requests: MaintenanceRequest[];
  stores: StoreRecord[];
  now: number;
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
      <div className="insight-table-wrap">
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
export function CostByCategory({ requests }: { requests: MaintenanceRequest[] }) {
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
}: {
  requests: MaintenanceRequest[];
  compliance: WorkspaceComplianceRecord[];
  stores: StoreRecord[];
}) {
  const rows = useMemo(() => {
    const nameById = new Map(stores.map((store) => [store.id, store.name]));
    const bySite = new Map<string, { open: number; urgent: number; gaps: number }>();

    const ensure = (site: string) =>
      bySite.get(site) ?? { open: 0, urgent: 0, gaps: 0 };

    for (const request of requests) {
      if (request.completedAt) continue;
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

  if (!rows.length) {
    return (
      <InsightPanel
        title="Sites needing attention"
        hint="Open work and compliance gaps together"
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
      <div className="insight-table-wrap">
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
}: {
  requests: MaintenanceRequest[];
  sites: Array<{ id: string; name: string; annualBudgetPence: number | null }>;
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

  if (!rows.length) {
    return (
      <InsightPanel
        title="Spend against budget"
        hint="How each site is tracking against its annual maintenance budget"
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
