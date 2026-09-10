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
      /*
       * `open`, not `in_progress`. The status model is completed / in_progress
       * / attention, so a job needing attention is open too and `openJobSql`
       * counts it — drilling on `in_progress` alone would hand the reader a
       * list SHORTER than the figure they tapped, which is the same class of
       * error as one that is wider, and harder to notice.
       */
      onSelect: () => onDrill({ family: "open" }),
      /* Days are days; counts are counts. Only the counts abbreviate. */
      accessible: null as string | null,
      footnote: null as string | null,
    },
    {
      key: "urgent",
      label: "P1 / Urgent open",
      value: pulse.urgentOpen.value,
      previous: pulse.urgentOpen.previous,
      /*
       * TWO conditions, because the figure has two: the aggregate counts
       * `openJobSql and urgentSql`. The priority alone opened a board holding
       * every urgent job in the period INCLUDING the closed ones, which on this
       * estate is most of them. A drill-through wider than the figure it came
       * from is worse than none at all — the reader has no way to see that the
       * two are different populations, so they read the longer list as the
       * number they tapped and conclude the tile is under-counting.
       */
      onSelect: () => onDrill({ priority: "urgent", family: "open" }),
      accessible: null,
      footnote: null,
    },
    {
      key: "oldest",
      label: "Oldest open",
      value: pulse.oldestOpenDays.value,
      previous: pulse.oldestOpenDays.previous,
      /*
       * THIS USED TO NAVIGATE TO AN ENTIRELY UNFILTERED BOARD.
       *
       * It sent `status: ""`, and `drill()` DELETES an empty value rather than
       * setting it, so the parameter never arrived and the tile landed on every
       * job in the estate under no chip at all — from a figure about the age of
       * ONE job. The honest destination is the population the figure was
       * measured over, which is the open work in this cohort.
       *
       * The job itself is not reachable from here. `pulse.oldestOpenDays`
       * carries `reference`, which the aggregate fills from the job's human
       * reference and falls back to its id, so it cannot be handed to
       * `onOpenJob` — and `PulseRow` is not given `onOpenJob` in any case. See
       * the report: an `oldestOpenId` beside the reference would let this tile
       * open the job it is actually about.
       */
      onSelect: pulse.oldestOpenDays.reference
        ? () => onDrill({ family: "open" })
        : undefined,
      accessible:
        pulse.oldestOpenDays.value === null
          ? "no open job in this period"
          : `${pulse.oldestOpenDays.value} days${
              pulse.oldestOpenDays.reference ? `, ${pulse.oldestOpenDays.reference}` : ""
            }`,
      footnote: null,
    },
    {
      key: "incomplete",
      label: "Incomplete records",
      value: pulse.incompleteRecords.value,
      previous: pulse.incompleteRecords.previous,
      onSelect: () => onOpenRecords("incomplete_records"),
      accessible: null,
      /*
       * THE FIGURE AND THE LIST NOW COUNT THE SAME THING.
       *
       * `incompleteRecordSql` is a five-way OR — no site, a blank or
       * unrecognised priority, no engineer, no tier (null or zero), and a
       * closed job with no cost. This tile used to open `no_site`, which is one
       * of the five, so a reader tapped a figure and was handed a visibly
       * shorter list with no explanation. They do not conclude that the list is
       * narrower; they conclude the page cannot count, and then they stop
       * trusting the other three tiles too.
       *
       * `incomplete_records` calls that same predicate rather than restating
       * it, so the two cannot drift. Measured: the tile reads 80 and the list
       * it opens holds 80. The footnote stays because the figure still needs
       * to say WHAT it counts — five different gaps under one word is not
       * self-evident — but it no longer has to apologise for the list.
       */
      footnote:
        "Counts a missing site, priority, engineer or tier, or a closed job with no cost.",
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
              footnote={figure.footnote}
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
  measure: requestedMeasure,
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
   * THE VERB COMES OFF THE WIRE, NOT OFF THE CONTROL.
   *
   * `/api/dashboard/meters` resolves the cohort axis from the QUERY STRING and
   * from nothing else: `parseFilters` has no way to reach a stored user
   * preference. The page's resolved `measure` layers that preference over the
   * URL, which makes it an INTENT rather than a measurement — and a reader
   * whose saved axis is `completed`, arriving at a bare `/dashboard`, was shown
   * "N jobs completed in this period" over a cohort the server had cut on
   * `requested_at`. That is not a cosmetic mismatch; it is a wrong statement of
   * fact about the data, asserted in the largest sentence on the card.
   *
   * `MetersPayload.measure` is the axis the server actually counted on, so
   * every sentence describing this cohort is drawn from it. The prop arrives
   * as `requestedMeasure` and the local `measure` is what was APPLIED — the
   * rename is the whole distinction, and it puts the intent one identifier away
   * from any sentence that would state it as a fact. The prop is still read,
   * for the single render before a payload exists, and no cohort sentence is
   * drawn in that render anyway: see the header below.
   */
  const measure = data?.measure ?? requestedMeasure;

  /*
   * THE CATCH-ALL'S DISPLAY NAME, WHICH IS DATA.
   *
   * The unmapped-status notice below said "count under Other" in so many
   * words, but §2.1 makes `other` a permanent ROLE rather than a permanent
   * name: an operator may relabel that meter in Settings, and a workspace that
   * had done so read a sentence pointing at a tile no longer on its own page.
   * `isCatchAll` is the field that knows which meter holds the role, and §2.1
   * guarantees exactly one does; the fallback covers only the render before the
   * payload lands, where the notice is not drawn anyway.
   */
  const catchAllLabel =
    (data?.meters ?? []).find((meter) => meter.isCatchAll)?.label ?? "Other";

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
      {/*
        NO COHORT SENTENCE UNTIL THERE IS A COHORT.

        Before the payload lands there is no server measure and no total, and
        `CohortHeader` has no way to draw a title without also drawing
        `cohortWording`. Printing "0 jobs requested in this period" while the
        request is still in flight states two things that are not known — the
        figure and the verb — and the second of them is the whole defect this
        card was rewritten to fix. So the wait draws the title alone, which is
        what `JobBreakdownCard` and `SitesAttentionCard` already do and for the
        same stated reason: a failure, and a wait, must never look like a zero.

        The better shape is a `CohortHeader` that accepts a null measure and
        omits the line itself, so the three cards that already suppress it stop
        doing so by hand. Until it takes one, the suppression is the caller's.
      */}
      {data ? (
        <CohortHeader
          id="ovw-glance-title"
          title="At a glance"
          total={data.cohortTotal}
          measure={measure}
          filterChips={filterChips}
          action={
            /*
             * `group` was read by NOTHING — not by `readDrillFilter`, not even
             * by `DRILL_KEYS`, so a board "Clear" would not have stripped it —
             * and this link never meant a filter in the first place. "All
             * statuses" IS this cohort; the drill carries the page's period and
             * filters, and the board groups by status on its own. Sending an
             * inert parameter only implied a narrowing that was never going to
             * happen.
             */
            <button type="button" className="ops-link" onClick={() => onDrill({})}>
              View all statuses →
            </button>
          }
        />
      ) : (
        <h2 className="ovw-cohort__title" id="ovw-glance-title">
          At a glance
        </h2>
      )}

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
          status map and {data.unmappedStatuses.length === 1 ? "counts" : "count"} under{" "}
          {catchAllLabel}: {data.unmappedStatuses.join(", ")}.
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
        /*
         * The meter rows travel down because they are the only place the STATUS
         * LABELS live — `/api/dashboard/stuck` reports the four waiting meters
         * by key and count, and the board filters on labels. Both payloads are
         * already on this card, so the link below can be built from real data
         * rather than from a hard-coded list that would go stale the first time
         * a workspace mapped a new status.
         */
        meters={data?.meters ?? []}
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
  meters,
  onOpenJob,
  onDrill,
  onOpenRecords,
}: {
  state: QueryState<StuckPayload>;
  /** Every meter the workspace has, for the status labels the link must send. */
  meters: MetersPayload["meters"];
  onOpenJob: (id: string) => void;
  onDrill: (extra: Record<string, string>) => void;
  onOpenRecords: (query: string) => void;
}) {
  const data = state.data;
  const sentence = data ? stuckSentence(data) : null;

  /*
   * WHAT "VIEW ALL STUCK WORK" ACTUALLY SELECTS ON.
   *
   * This link sent `meter=waiting&sort=held`, and neither parameter did
   * anything. In `board-drill-filter.ts` `meter` only NAMES the chip — the
   * pipe-joined `status` list is what selects rows — and `sort` is read by
   * nothing at all. So the board showed EVERY job in the period, closed ones
   * included, under a chip reading "Meter waiting": a promise of a filtered
   * list delivered as an unfiltered one, which is the worst shape a
   * drill-through can take because the chip is the reader's evidence that it
   * worked.
   *
   * The meter tiles above already do this correctly, and this is the same
   * construction widened across the four waiting meters. `byMeter` names which
   * meters the stuck endpoint is reporting on — it is `WAITING_METERS`, and
   * reading it rather than restating it is what stops the two drifting — and
   * each meter row carries the status labels that meter owns. Nothing here is
   * hard-coded: a status mapped to "Waiting for parts" tomorrow is in this list
   * tomorrow, with no code change, which is §9.9's requirement.
   */
  const waitingStatuses = useMemo(() => {
    if (!data) return "";
    const reported = new Set(data.byMeter.map((entry) => entry.key));
    const labels = new Set<string>();
    for (const meter of meters) {
      if (!reported.has(meter.key)) continue;
      for (const status of meter.statuses) {
        if (status.trim()) labels.add(status);
      }
    }
    return [...labels].join("|");
  }, [data, meters]);

  return (
    <div className="ovw-stuck">
      <div className="ops-card__head ovw-stuck__head">
        <p className="ops-section-title">Where work is stuck</p>
        {/*
          The link appears only when it can be made to filter. With no status
          labels to send — a workspace whose meters have not been read yet, or
          one whose waiting meters own no statuses — the honest thing is to draw
          no control rather than one that lands on the whole board. The
          sentence above and the six rows below still say what is stuck.
        */}
        {data && data.totalWaiting > 0 && waitingStatuses ? (
          <button
            type="button"
            className="ops-link"
            onClick={() => onDrill({ meter: "waiting", status: waitingStatuses })}
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
