"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../../../lib/api";
import { STAGE_ORDER, STAGE_STATUSES } from "../../../../../lib/job-stages";

/**
 * The two writes this page offers: move the status, and add a comment.
 *
 * Both re-render the server component afterwards rather than patching local
 * state. The status a job lands on is the database's decision — the stage is a
 * generated column, and the API may refuse the move outright — so the honest
 * thing to show is what the server says the job now is, not what this component
 * hoped it would be.
 */
export default function JobActions({
  jobId,
  status,
  canChangeStatus,
}: {
  jobId: string;
  status: string;
  canChangeStatus: boolean;
}) {
  const router = useRouter();
  const [nextStatus, setNextStatus] = useState(status);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<"status" | "comment" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function saveStatus(event: React.FormEvent) {
    event.preventDefault();
    if (pending || nextStatus === status) return;
    setPending("status");
    setError(null);
    setNotice(null);

    const result = await api(`/jobs/${jobId}/status`, {
      method: "POST",
      body: JSON.stringify({ status: nextStatus }),
    });
    setPending(null);

    if (!result.ok) {
      // The select goes back to what the job actually is: leaving it on the
      // refused value would show a status the job does not have.
      setNextStatus(status);
      return setError(result.error);
    }
    setNotice(`Status set to ${nextStatus}.`);
    router.refresh();
  }

  async function addComment(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!comment.trim()) return setError("Write something first.");
    setPending("comment");
    setError(null);
    setNotice(null);

    const result = await api(`/jobs/${jobId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: comment }),
    });
    setPending(null);

    if (!result.ok) return setError(result.error);
    setComment("");
    setNotice("Comment added.");
    router.refresh();
  }

  return (
    <section className="p-panel">
      <h2>Update this job</h2>

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="alert alert--good">{notice}</p> : null}
      </div>

      {canChangeStatus ? (
        <form onSubmit={saveStatus} className="p-grid2">
          <label className="p-field">
            <span>Status</span>
            <select
              className="p-select"
              value={nextStatus}
              onChange={(event) => setNextStatus(event.target.value)}
              disabled={pending !== null}
            >
              {/* Grouped by stage so the 23 labels are navigable on a phone,
                  and so it is obvious which move changes which column. */}
              {STAGE_ORDER.map((stage) => (
                <optgroup key={stage} label={stage}>
                  {STAGE_STATUSES[stage].map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <div className="p-field">
            <span aria-hidden="true">&nbsp;</span>
            <button
              className="p-btn"
              type="submit"
              disabled={pending !== null || nextStatus === status}
            >
              {pending === "status" ? "Saving…" : "Save status"}
            </button>
          </div>
        </form>
      ) : (
        <p className="p-note">
          Your role can read this job and comment on it. Status changes are made
          by the coordinators or the assigned contractor.
        </p>
      )}

      <form onSubmit={addComment}>
        <label className="p-field" style={{ marginTop: 14 }}>
          <span>Comment</span>
          <textarea
            className="p-textarea"
            rows={4}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What has changed, what is outstanding?"
            disabled={pending !== null}
          />
        </label>
        <div className="p-btnrow" style={{ marginTop: 10 }}>
          <button className="p-btn" type="submit" disabled={pending !== null}>
            {pending === "comment" ? "Sending…" : "Add comment"}
          </button>
        </div>
      </form>
    </section>
  );
}
