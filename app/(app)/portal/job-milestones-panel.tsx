"use client";

/**
 * THE JOB'S RESPONSE MILESTONES, in the drawer — decision N.
 *
 * Acknowledged, assigned and attended: when each first happened, who (or which
 * rule or door) caused it, and the two explicit actions — "Acknowledge" and
 * "Record attendance". Assigned has no button on purpose: it is recorded by the
 * write that actually gives the job a person or an engineer, and a button that
 * claimed one without making one would invent a time.
 *
 * Every time is the server's and is written once. A job raised before the
 * recording began says so instead of showing anything — the owner's rule is
 * that nothing historical is reconstructed.
 *
 * Shown on both widths (unlike the desktop-only detail grid above it), because
 * the person recording attendance is as likely to be on a phone as not.
 */

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components";
import { formatShortDateTime } from "../../lib/format-date";
import "./job-milestones-panel.css";

type Milestone = "acknowledged" | "assigned" | "attended";

type MilestoneEntry = { at: string; label: string; actorEmail: string | null; source: string | null } | null;

type MilestonesAnswer = {
  id: string;
  milestones: Record<Milestone, MilestoneEntry>;
  workOrder: boolean;
  eligible: boolean;
  since: string | null;
  reason: string | null;
  canRecord: boolean;
  error?: string;
};

const ROWS: Array<{ key: Milestone; label: string; hint: string }> = [
  { key: "acknowledged", label: "Acknowledged", hint: "The first time a person answered or handled this job." },
  { key: "assigned", label: "Assigned", hint: "The first time a responsible person or an engineer was assigned." },
  { key: "attended", label: "Attended", hint: "Recorded when the engineer is on site — only ever by “Record attendance”." },
];

const SOURCE: Record<string, string> = {
  "job.milestone": "recorded on the job",
  "job.edit": "edited on the job",
  "board.move": "moved on the board",
  "board.bulk": "bulk edit",
  "board.cell": "edited on the board",
  "update.posted": "an update was posted",
  automation: "an automation",
};

function sourceLabel(source: string | null) {
  if (!source) return null;
  if (source.startsWith("created:")) return `raised from ${source.slice("created:".length)}`;
  return SOURCE[source] ?? source;
}

/* The product's one formatter, in the product's one zone — as the history below. */
const when = (value: string) => formatShortDateTime(value, { timeZone: "Europe/London" });

/** The day recording began here, named rather than implied. */
function sinceLabel(value: string) {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? value
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
}

export function JobMilestonesPanel({
  requestId,
  hidden,
  refreshKey,
  onRecorded,
  onNotify,
}: {
  requestId: string;
  /** The drawer's own tab rule: shown on Columns, kept mounted elsewhere. */
  hidden: boolean;
  /** Changes whenever the job itself changes, so an assignment made in the drawer shows up. */
  refreshKey: string;
  /** After a milestone is recorded — the drawer re-reads its history. */
  onRecorded: () => void;
  onNotify: (message: string) => void;
}) {
  const [answer, setAnswer] = useState<MilestonesAnswer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<Milestone | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/maintenance/milestones?id=${encodeURIComponent(requestId)}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as MilestonesAnswer | null;
      if (!response.ok || !body) {
        setFailure(body?.error ?? "The job's milestones could not be loaded.");
        return;
      }
      setAnswer(body);
      setFailure(null);
    } catch {
      setFailure("The job's milestones could not be loaded.");
    }
  }, [requestId]);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits the fetch
     before it touches state, as the brand-colours panel does; re-reading when
     the job changes is the synchronisation an effect is for. */
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const record = async (milestone: "acknowledged" | "attended") => {
    const question =
      milestone === "attended"
        ? "Record that the engineer has attended this job now? It is recorded once, with the current time, and cannot be changed."
        : "Record that this job is acknowledged now? It is recorded once, with the current time.";
    if (!window.confirm(question)) return;
    setBusy(milestone);
    try {
      const response = await fetch("/api/maintenance/milestones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: requestId, milestone }),
      });
      const body = (await response.json().catch(() => null)) as MilestonesAnswer | null;
      if (body?.milestones) setAnswer(body);
      if (!response.ok) {
        onNotify(body?.error ?? "The milestone could not be recorded.");
        return;
      }
      onNotify(milestone === "attended" ? `Attendance recorded for ${requestId}.` : `${requestId} acknowledged.`);
      onRecorded();
    } catch {
      onNotify("The milestone could not be recorded.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`drawer-section job-milestones${hidden ? " is-tab-hidden" : ""}`} aria-label="Response milestones">
      <div className="drawer-section__title">
        <span className="drawer-label">Response milestones</span>
      </div>
      {failure && !answer ? <p className="job-milestones__note">{failure}</p> : null}
      {answer ? (
        <>
          {/* WHAT EXISTS IS ALWAYS SHOWN. A job outside the recording may still
              carry a stamp — recorded before its row was, or by a gate that has
              since changed — and the stage-and-status history below lists those
              same events. Hiding them here would make one drawer disagree with
              itself. The reason only explains why nothing NEW is recorded. */}
          <ul className="job-milestones__list">
            {ROWS.map((row) => {
              const entry = answer.milestones[row.key];
              const by = entry ? (entry.actorEmail ?? sourceLabel(entry.source)) : null;
              const door = entry?.actorEmail ? sourceLabel(entry.source) : null;
              return (
                <li key={row.key} className={`job-milestones__row${entry ? " is-recorded" : ""}`}>
                  <span className="job-milestones__mark" aria-hidden="true">
                    <Icon name={entry ? "check" : "clock"} size={14} />
                  </span>
                  <span className="job-milestones__body">
                    <strong>{row.label}</strong>
                    <small>
                      {entry ? (
                        <>
                          {when(entry.at)}
                          {by ? ` · ${by}` : ""}
                          {door ? ` (${door})` : ""}
                        </>
                      ) : answer.eligible ? (
                        <>Not yet · {row.hint}</>
                      ) : (
                        <>Not recorded · {row.hint}</>
                      )}
                    </small>
                  </span>
                </li>
              );
            })}
          </ul>
          {answer.reason ? <p className="job-milestones__note">{answer.reason}</p> : null}
          {answer.since ? (
            <p className="job-milestones__note">
              Recorded for jobs raised in this portal from {sinceLabel(answer.since)}.
            </p>
          ) : null}
          {answer.canRecord && (!answer.milestones.acknowledged || !answer.milestones.attended) ? (
            <div className="job-milestones__actions">
              {!answer.milestones.acknowledged ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy !== null}
                  onClick={() => void record("acknowledged")}
                >
                  <Icon name="check" size={16} />
                  {busy === "acknowledged" ? "Recording…" : "Acknowledge"}
                </button>
              ) : null}
              {!answer.milestones.attended ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy !== null}
                  onClick={() => void record("attended")}
                >
                  <Icon name="map" size={16} />
                  {busy === "attended" ? "Recording…" : "Record attendance"}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
