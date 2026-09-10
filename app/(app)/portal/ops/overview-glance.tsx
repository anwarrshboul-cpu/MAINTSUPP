"use client";

/**
 * SECTION A — Pulse, the eight meters, and where work is stuck.
 *
 * Replaces the five tiles that used to head this page — Open jobs, Needs
 * attention, Oldest open, Urgent open, Unassigned site. §2 of the dashboard
 * master prompt states the case against them: they "do not reconcile to
 * anything, hide the statuses that actually block work, and are not clickable".
 *
 * ── WHAT MAKES THE EIGHT DIFFERENT FROM THE FIVE ──────────────────────────
 *
 * They are a PARTITION. Every status this workspace has ever seen belongs to
 * exactly one meter — the assignment lives on `job_status_map.meter_key`, one
 * row per (organisation, status) behind a UNIQUE index, and anything
 * unassigned resolves to the permanent catch-all. So the eight always sum to
 * the cohort total, and the full-width bar above them is that arithmetic made
 * visible in one line rather than asserted in a caption.
 *
 * A hidden meter still contributes to the bar and to the total. Hiding removes
 * a TILE, never a job, which is why the Settings toggle carries that sentence
 * as its tooltip.
 */

import { useMemo } from "react";
import {
  CohortHeader,
  ChartFrame,
  MetricTile,
  SeverityBar,
  formatCount,
  useAbbreviatedNumbers,
} from "./overview-shared";
import { SegmentedBar, type ChartSegment } from "./overview-charts";
import { EmptyState, SkeletonRow } from "./ops-primitives";
import { excludedWording } from "../../../lib/overview-meters";
import type { MetersPayload, StuckPayload, CohortMeasure } from "./overview-contract";

type QueryState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

type FilterChip = { key: string; label: string; onRemove?: () => void };

/* ── Band 1 — Pulse (§2.2) ────────────────────────────────────────────────── */

/**
 * One thin row, four figures, each against the immediately preceding period of
 * equal length. **No chart** — §2.2 calls this "a headline, not an analysis",
 * and a sparkline here would invite the reader to interpret a shape before they
 * have read a number.
 *
 * It sits ABOVE At a glance in the page order and is deliberately not inside
 * that card: the four figures cut across all eight meters, so nesting them in
 * one card would imply they belonged to it.
 */
export function PulseRow({
  state,
  onDrill,
  onOpenRecords,
}: {
  state: QueryState<MetersPayload>;
  onDrill: (extra: Record<string, string>) => void;
  onOpenRecords: (query: string) => void;
}) {
  const abbreviate = useAbbreviatedNumbers();
  const data = state.data;

  if (state.error) {
    return (
      <section className="ops-card ovw-pulse" aria-label="Pulse">
        <p className="ops-error" role="alert">
          {state.error}{" "}
          <button type="button" className="ops-link" onClick={state.reload}>
            Retry
          </button>
        </p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="ops-card ovw-pulse" aria-label="Pulse">
        <SkeletonRow lines={1} height={92} />
      </section>
    );
  }

  const pulse = data.pulse;
  const figures = [
    {
      key: "open",
      label: "Open",
      value: pulse.open.value,
      previous: pulse.open.previous,
      onSelect: () => onDrill({ family: "in_progress" }),
      /* Days are days; counts are counts. Only the counts abbreviate. */
      accessible: null as string | null,
    },
    {
      key: "urgent",
      label: "P1 / Urgent open",
      value: pulse.urgentOpen.value,
      previous: pulse.urgentOpen.previous,
      onSelect: () => onDrill({ priority: "urgent" }),
      accessible: null,
    },
    {
      key: "oldest",
      label: "Oldest open",
      value: pulse.oldestOpenDays.value,
      previous: pulse.oldestOpenDays.previous,
      onSelect: pulse.oldestOpenDays.reference
        ? () => onDrill({ status: "" })
        : undefined,
      accessible:
        pulse.oldestOpenDays.value === null
          ? "no open job in this period"
          : `${pulse.oldestOpenDays.value} days${
              pulse.oldestOpenDays.reference ? `, ${pulse.oldestOpenDays.reference}` : ""
            }`,
    },
    {
      key: "incomplete",
      label: "Incomplete records",
      value: pulse.incompleteRecords.value,
      previous: pulse.incompleteRecords.previous,
      onSelect: () => onOpenRecords("no_site"),
      accessible: null,
    },
  ];

  return (
    <section className="ops-card ovw-pulse" aria-label="Pulse">
      <ul className="ovw-pulse__row">
        {figures.map((figure) => (
          <li key={figure.key} className="ovw-pulse__item">
            <MetricTile
              label={figure.label}
              value={
                figure.value === null
                  ? null
                  : figure.key === "oldest"
                    ? `${figure.value}d`
                    : formatCount(figure.value, abbreviate)
              }
              previous={figure.previous}
              onSelect={figure.onSelect}
              accessibleValue={
                figure.accessible ??
                (figure.value === null ? "not recorded" : String(figure.value))
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Band 2 and 3 — the meters, and the work they are holding ─────────────── */

/**
 * §2.3(b) — the ageing readout under each tile.
 *
 * "Oldest 89d · avg 34d" on an open meter; "Avg time to close 21d" on Completed,
 * because the oldest open job in a meter that holds no open jobs is not a
 * number and printing a dash there tells the reader nothing they wanted.
 *
 * `null` is never rendered as a zero. A meter with no open work says so.
 */
function ageingReadout(meter: MetersPayload["meters"][number]): string | null {
  if (meter.key === "completed") {
    return meter.averageCloseDays === null
      ? "No completion time recorded"
      : `Avg time to close ${meter.averageCloseDays}d`;
  }
  if (meter.open === 0) return "No open work";
  const parts: string[] = [];
  if (meter.oldestOpenDays !== null) parts.push(`Oldest ${meter.oldestOpenDays}d`);
  if (meter.averageOpenDays !== null) parts.push(`avg ${meter.averageOpenDays}d`);
  return parts.length ? parts.join(" · ") : null;
}

export function AtAGlanceCard({
  meters,
  stuck,
  measure,
  filterChips,
  onToggle,
  onDrill,
  onOpenRecords,
  onOpenJob,
}: {
  meters: QueryState<MetersPayload>;
  stuck: QueryState<StuckPayload>;
  measure: CohortMeasure;
  filterChips: FilterChip[];
  onToggle: (key: string, value: string) => void;
  onDrill: (extra: Record<string, string>) => void;
  onOpenRecords: (query: string) => void;
  onOpenJob: (id: string) => void;
}) {
  const abbreviate = useAbbreviatedNumbers();
  const data = meters.data;

  /*
   * The bar carries EVERY meter, visible or not (§2.3). The tiles carry only
   * the visible ones. That asymmetry is the whole point of the hide toggle:
   * a workspace that never uses "Waiting for parts" can stop drawing a tile for
   * it without the eight stopping to sum to the total.
   */
  const segments: ChartSegment[] = useMemo(
    () =>
      (data?.meters ?? []).map((meter) => ({
        key: meter.key,
        label: meter.label,
        value: meter.total,
        colour: meter.colour,
      })),
    [data],
  );

  const visible = (data?.meters ?? []).filter((meter) => meter.visible);
  const hidden = (data?.meters ?? []).filter((meter) => !meter.visible);

  const table = data
    ? {
        caption: "At a glance",
        head: ["Meter", "Jobs", "Share", "Open", "Oldest open (days)"],
        rows: data.meters.map((meter) => [
          meter.label,
          meter.total,
          `${meter.share}%`,
          meter.open,
          meter.oldestOpenDays === null ? "—" : meter.oldestOpenDays,
        ]),
      }
    : undefined;

  return (
    <section className="ops-card ovw-glance" aria-labelledby="ovw-glance-title">
      <CohortHeader
        id="ovw-glance-title"
        title="At a glance"
        total={data?.cohortTotal ?? 0}
        measure={measure}
        filterChips={filterChips}
        action={
          <button type="button" className="ops-link" onClick={() => onDrill({ group: "status" })}>
            View all statuses →
          </button>
        }
      />

      {/*
        §1.1's footnote. Never imputed, and it links to the records so the gap
        can be closed rather than merely counted.
      */}
      {data && data.excluded > 0 ? (
        <p className="ovw-glance__excluded" role="note">
          {excludedWording(measure, data.excluded)}{" "}
          <button
            type="button"
            className="ops-link"
            onClick={() => onOpenRecords("missing_measure_date")}
          >
            Show them →
          </button>
        </p>
      ) : null}

      {data && data.unmappedStatuses.length > 0 ? (
        <p className="ovw-glance__unmapped" role="status">
          {data.unmappedStatuses.length} status
          {data.unmappedStatuses.length === 1 ? " is" : "es are"} not in this workspace&rsquo;s
          status map and {data.unmappedStatuses.length === 1 ? "counts" : "count"} under Other:{" "}
          {data.unmappedStatuses.join(", ")}.
        </p>
      ) : null}

      <ChartFrame
        loading={meters.loading && !data}
        error={meters.error}
        onRetry={meters.reload}
        empty={Boolean(data) && data!.cohortTotal === 0}
        emptyLabel={
          measure === "completed"
            ? "No job was completed in this period"
            : "No job was requested in this period"
        }
        table={table}
        minHeight={64}
      >
        {data ? (
          <SegmentedBar
            segments={segments}
            total={data.cohortTotal}
            onSelect={(key) => onToggle("meter", key)}
            label="Jobs by meter"
          />
        ) : null}
      </ChartFrame>

      {data && data.cohortTotal > 0 ? (
        <ul className="ovw-tiles">
          {visible.map((meter) => (
            <li key={meter.key} className="ovw-tiles__item">
              <MetricTile
                label={meter.label}
                accent={meter.colour}
                value={formatCount(meter.total, abbreviate)}
                accessibleValue={`${meter.total}`}
                share={meter.share}
                previous={meter.previousTotal}
                delta={meter.delta}
                footnote={ageingReadout(meter)}
                severity={meter.key === "completed" ? null : meter.severity}
                /*
                 * §2.3: "The whole tile is a button → Jobs list filtered to that
                 * meter's statuses, carrying date range and page filters,
                 * showing one chip named after the meter, not five status
                 * names." The meter key travels as ONE parameter for exactly
                 * that reason; the status labels travel with it so a destination
                 * that does not know the vocabulary can still filter.
                 */
                onSelect={() =>
                  onDrill({ meter: meter.key, status: meter.statuses.join("|") })
                }
              />
            </li>
          ))}
        </ul>
      ) : null}

      {hidden.length > 0 ? (
        <p className="ovw-glance__hidden" role="note">
          {hidden.length} meter{hidden.length === 1 ? " is" : "s are"} hidden in Settings and
          {hidden.length === 1 ? " draws" : " draw"} no tile. {hidden.length === 1 ? "It is" : "They are"}{" "}
          still in the bar and in the total: {hidden.map((meter) => meter.label).join(", ")}.
        </p>
      ) : null}

      <StuckWork
        state={stuck}
        onOpenJob={onOpenJob}
        onDrill={onDrill}
        onOpenRecords={onOpenRecords}
      />
    </section>
  );
}

/* ── Band 3 — where work is stuck (§2.4) ──────────────────────────────────── */

/**
 * "The insight band, and the main reason to build this page."
 *
 * Six rows at most, the longest-held work across the four waiting meters,
 * sorted by days held. The sentence above the table is DERIVED — §2.4 says so
 * outright — because a hard-coded "45 jobs are waiting for approval" is exactly
 * the kind of figure that survives the data changing underneath it.
 */
function stuckSentence(data: StuckPayload): string | null {
  if (!data.byMeter.length) return null;
  const worst = [...data.byMeter].sort((a, b) => b.count - a.count)[0];
  if (!worst || worst.count === 0) return null;
  const jobs = worst.count === 1 ? "job is" : "jobs are";
  const label = worst.label.toLowerCase();
  if (worst.overThirtyDays > 0) {
    return `${worst.count} ${jobs} ${label}, ${worst.overThirtyDays} of them for more than 30 days.`;
  }
  return `${worst.count} ${jobs} ${label}, none for more than 30 days.`;
}

function StuckWork({
  state,
  onOpenJob,
  onDrill,
  onOpenRecords,
}: {
  state: QueryState<StuckPayload>;
  onOpenJob: (id: string) => void;
  onDrill: (extra: Record<string, string>) => void;
  onOpenRecords: (query: string) => void;
}) {
  const data = state.data;
  const sentence = data ? stuckSentence(data) : null;

  return (
    <div className="ovw-stuck">
      <div className="ops-card__head ovw-stuck__head">
        <p className="ops-section-title">Where work is stuck</p>
        {data && data.totalWaiting > 0 ? (
          <button
            type="button"
            className="ops-link"
            onClick={() => onDrill({ meter: "waiting", sort: "held" })}
          >
            View all stuck work →
          </button>
        ) : null}
      </div>

      {sentence ? <p className="ovw-stuck__lede">{sentence}</p> : null}

      {state.error ? (
        <p className="ops-error" role="alert">
          {state.error}{" "}
          <button type="button" className="ops-link" onClick={state.reload}>
            Retry
          </button>
        </p>
      ) : !data ? (
        <SkeletonRow lines={6} height={200} />
      ) : data.rows.length === 0 ? (
        <EmptyState>Nothing is being held for approval, parts, payment or a decision.</EmptyState>
      ) : (
        <>
          {/*
            One table on a wide screen, one card per job on a phone — §1.8's
            "same fields, primary value first". Both are rendered and CSS
            chooses, so the accessible tree carries the table's semantics at
            desktop widths and the cards' headings at phone widths, rather than
            a table forced through a horizontal scroller.
          */}
          <div className="ovw-stuck__table ops-table-wrap">
            <table>
              <caption className="visually-hidden">
                The six longest-held jobs, by days in their current status
              </caption>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Site</th>
                  <th scope="col">Meter</th>
                  <th scope="col">Held for</th>
                  <th scope="col">Last update</th>
                  <th scope="col">Owner</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <button type="button" className="ops-link" onClick={() => onOpenJob(row.id)}>
                        {row.reference ?? row.id}
                      </button>
                      <span className="ovw-stuck__title">{row.title}</span>
                    </th>
                    <td>{row.siteName}</td>
                    <td>{row.meterLabel}</td>
                    <td className="ovw-stuck__held">{row.heldDays}d</td>
                    <td>{row.lastUpdate ? row.lastUpdate.slice(0, 10) : "—"}</td>
                    <td>{row.owner ?? "Unassigned"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="ovw-stuck__cards ops-hide-desktop">
            {data.rows.map((row) => (
              <li key={row.id} className="ovw-stuck__card">
                <p className="ovw-stuck__card-held">
                  <strong>{row.heldDays}d</strong> held
                </p>
                <button type="button" className="ops-link" onClick={() => onOpenJob(row.id)}>
                  {row.reference ?? row.id} — {row.title}
                </button>
                <dl className="ovw-stuck__card-meta">
                  <div>
                    <dt>Site</dt>
                    <dd>{row.siteName}</dd>
                  </div>
                  <div>
                    <dt>Meter</dt>
                    <dd>{row.meterLabel}</dd>
                  </div>
                  <div>
                    <dt>Last update</dt>
                    <dd>{row.lastUpdate ? row.lastUpdate.slice(0, 10) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{row.owner ?? "Unassigned"}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>

          {/*
            WHERE "HELD FOR" CAME FROM, stated rather than assumed.
            §2.4 asks for the recovered/fallback split to be reported. On an
            estate with no status-change history every row falls back to
            `updated_at`, and a reader comparing "held for" against their own
            memory deserves to know that before they act on it.
          */}
          {data.fallback > 0 ? (
            <p className="ovw-stuck__provenance" role="note">
              {data.recovered > 0
                ? `${data.recovered} of these read their status-change date from the activity log; ${data.fallback} fall back to when the record was last edited.`
                : "No status-change history is recorded yet, so “held for” counts from when the record was last edited."}{" "}
              <button
                type="button"
                className="ops-link"
                onClick={() => onOpenRecords("stuck")}
              >
                Show every waiting job →
              </button>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
