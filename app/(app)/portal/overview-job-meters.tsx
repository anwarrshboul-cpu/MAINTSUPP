"use client";

/**
 * THE FIVE JOB METERS ON THE DASHBOARD OVERVIEW.
 *
 * The owner asked that five Main Table columns — Tier Level, Engineer Required,
 * Priority, Label and Status — be readable from the Overview without opening
 * the board.
 *
 * WHAT THIS COMPONENT IS NOT ALLOWED TO DO.
 *
 * It does no arithmetic. Every number and every proportion arrives already
 * computed from `buildJobMeters` in views/overview-series.ts, which is where
 * the rule that matters lives: every job lands in exactly one segment, a value
 * the option set has never heard of keeps its own segment rather than being
 * dropped, and the share denominator is the whole window. A renderer that did
 * its own bucketing could satisfy those tests and still lie on screen, so it
 * does not get the chance.
 *
 * WHY THE BAR AND THE LEGEND SHARE ONE ELEMENT LIST.
 *
 * They are the same `segments` array rendered twice. The bar cannot come to
 * disagree with the legend beneath it — a failure that is invisible in a
 * screenshot and obvious to the person who counts.
 *
 * WHY THE COLOURS ARE INLINE STYLES.
 *
 * They are DATA, not design: an administrator picked them in the option editor
 * and the board paints these five columns with them. A stylesheet cannot know
 * them, and hardcoding a palette here would put the same jobs in different
 * colours one click apart. The muted fallbacks for "not recorded" and for an
 * unconfigured value are the only two colours this file chooses, and both are
 * deliberately not confident hues.
 *
 * ACCESSIBILITY. The bar is decorative and hidden from assistive technology —
 * it carries no information the legend does not state in words. Each legend
 * entry is a real button, so the whole meter is reachable and operable from the
 * keyboard, and the count is text rather than a width.
 */

import type { JobMeter, JobMeterSegment } from "./views/overview-series";
import "./overview-job-meters.css";

export default function OverviewJobMeters({
  meters,
  loading,
  onSelect,
}: {
  meters: JobMeter[];
  /** True until /api/maintenance has answered. Loading and empty differ. */
  loading: boolean;
  onSelect: (meter: JobMeter, segment: JobMeterSegment) => void;
}) {
  return (
    <article className="analytics-panel job-meters">
      <header>
        <h2>Job breakdown</h2>
        <span>Tier, engineer, priority, label and status across this period</span>
      </header>

      {/*
        Loading and empty are different claims and must not share a rendering.
        "No jobs" over a period that simply has not loaded is the same defect
        `workspaceReady` was added to fix on the tiles above.
      */}
      {loading ? (
        <p className="analytics-empty">Loading jobs…</p>
      ) : meters.every((meter) => meter.total === 0) ? (
        <p className="analytics-empty">
          No jobs in this period. Each meter groups the jobs on the board by one
          of its columns.
        </p>
      ) : (
        <ul className="job-meters__list">
          {meters.map((meter) => (
            <li className="job-meter" key={meter.key}>
              <div className="job-meter__head">
                <h3>{meter.title}</h3>
                {/*
                  Named, not implied. A meter over eleven jobs where four have
                  no value is a different picture from one over seven, and the
                  bar alone cannot say which it is.
                */}
                <span className="job-meter__count">
                  {meter.recorded === meter.total
                    ? `${meter.total} ${meter.total === 1 ? "job" : "jobs"}`
                    : `${meter.recorded} of ${meter.total} recorded`}
                </span>
              </div>

              <div className="job-meter__track" aria-hidden="true">
                {meter.segments.map((segment) => (
                  <span
                    key={segment.value || "__unrecorded"}
                    className="job-meter__fill"
                    style={{
                      width: `${segment.share * 100}%`,
                      background: segment.color,
                    }}
                  />
                ))}
              </div>

              <ul className="job-meter__legend">
                {meter.segments.map((segment) => (
                  <li key={segment.value || "__unrecorded"}>
                    <button
                      type="button"
                      className={
                        segment.unknown
                          ? "job-meter__chip job-meter__chip--unknown"
                          : "job-meter__chip"
                      }
                      onClick={() => onSelect(meter, segment)}
                      /*
                        The label alone reads as a fragment out of context —
                        "Tier 2, 8" tells a screen reader nothing about which
                        column it belongs to or what the number counts.
                      */
                      aria-label={`${meter.title}: ${segment.label}, ${segment.count} of ${meter.total} jobs. Open the job list.`}
                      title={
                        segment.unknown
                          ? `${segment.label} — this value is not in the configured option set`
                          : undefined
                      }
                    >
                      <span
                        className="job-meter__swatch"
                        style={{ background: segment.color }}
                        aria-hidden="true"
                      />
                      <span className="job-meter__label">{segment.label}</span>
                      <strong>{segment.count}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
