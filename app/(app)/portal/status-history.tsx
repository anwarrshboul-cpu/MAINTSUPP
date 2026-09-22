"use client";

/**
 * A JOB'S STAGE AND STATUS HISTORY, in the drawer's Activity Log — §23.
 *
 * Reads what `GET /api/maintenance?id=` returns as `statusHistory`: one line per
 * transition of one field, newest first, each saying who (or which rule, import
 * or form) moved it. The record begins on `since`, and the component says so —
 * the owner's rule is that nothing earlier is reconstructed by inference, so an
 * empty or short list must never read as "this job never moved".
 */

import { formatShortDateTime } from "../../lib/format-date";

export type StatusHistoryEntry = {
  id: string;
  field: string;
  from: string | null;
  to: string | null;
  actorEmail: string | null;
  source: string;
  createdAt: string;
};

const SOURCE_LABELS: Record<string, string> = {
  "job.edit": "edited on the job",
  "board.move": "moved on the board",
  "board.archive": "archived on the board",
  "board.bulk": "bulk edit",
  "board.create": "created on the board",
  "board.duplicate": "duplicated",
  "board.group_deleted": "its group was deleted",
  automation: "an automation",
  "options.reassign": "a status option was retired",
  import: "a re-import",
  "job.milestone": "recorded on the job",
  "board.cell": "edited on the board",
  "update.posted": "an update was posted",
};

/*
 * DECISION N — a job's acknowledged, assigned and attended moments are written
 * into this same history (`field = "milestone"`), once each, by the door that
 * caused them. Drawn here as their own lines so the one history says both what
 * the job's state was and when it was first answered, assigned and attended.
 */
const MILESTONE_LABELS: Record<string, string> = {
  acknowledged: "Acknowledged",
  assigned: "Assigned",
  attended: "Attended",
};

function sourceLabel(source: string) {
  if (source.startsWith("created:")) return `created from ${source.slice("created:".length)}`;
  return SOURCE_LABELS[source] ?? source;
}

/* The product's one formatter, in the product's one zone — the same call the
   drawer's activity history makes, so the two panels agree about a moment. */
function when(value: string) {
  return formatShortDateTime(value, { timeZone: "Europe/London" });
}

export function StatusHistory({ entries, since }: { entries: StatusHistoryEntry[]; since: string | null }) {
  const sinceLabel = since
    ? new Date(`${since}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;
  return (
    <div className="status-history">
      <div className="drawer-section__title">
        <span className="drawer-label">Stage and status history</span>
        <span>{entries.length} change{entries.length === 1 ? "" : "s"}</span>
      </div>
      {entries.length === 0 ? (
        <div className="drawer-history-state">No stage, status or milestone has been recorded for this job yet.</div>
      ) : (
        <div className="activity-timeline">
          {entries.map((entry, index) => (
            <div key={entry.id}>
              <span className={`activity-dot${index === 0 ? " activity-dot--teal" : ""}`} />
              <p>
                {entry.field === "milestone" ? (
                  <>
                    <strong>{MILESTONE_LABELS[entry.to ?? ""] ?? entry.to}</strong> recorded
                  </>
                ) : (
                  <>
                    <strong>{entry.field === "stage" ? "Stage" : "Status"}</strong>{" "}
                    {entry.from ? (
                      <>
                        {entry.from} → <strong>{entry.to ?? "—"}</strong>
                      </>
                    ) : (
                      <>
                        set to <strong>{entry.to ?? "—"}</strong>
                      </>
                    )}
                  </>
                )}{" "}
                <span className="status-history__who">
                  · {entry.actorEmail ?? sourceLabel(entry.source)}
                  {entry.actorEmail ? ` (${sourceLabel(entry.source)})` : ""}
                </span>
              </p>
              <small>{when(entry.createdAt)}</small>
            </div>
          ))}
        </div>
      )}
      {sinceLabel && (
        <p className="drawer-history-state">
          Recorded from {sinceLabel}. Changes before then appear in the activity history below as they were logged at the time.
        </p>
      )}
    </div>
  );
}
