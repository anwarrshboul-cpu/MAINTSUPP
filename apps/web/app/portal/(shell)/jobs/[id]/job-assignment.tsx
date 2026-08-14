"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../../../lib/api";
import {
  ASSIGNMENT_LABELS,
  assignmentChipClass,
  formatDateTime,
  type AssignmentStatus,
  type Contractor,
} from "../../../../../lib/portal";

/**
 * Who the job was given to, and what they said back.
 *
 * ── ASSIGNING IS THE GRANT ────────────────────────────────────────────────
 * Pressing Assign is not filing a note about who is doing the work — it is the
 * moment the contractor can see the job at all. `scopeFor()` in the API scopes
 * a contractor to `jobs.contractor_id`, so writing that column IS the
 * authorisation, and re-assigning revokes the previous firm's access in the
 * same statement. The control says so out loud, because a coordinator changing
 * a dropdown ought to know they are changing who can read a client's record.
 *
 * ── A DECLINE IS LOUD ─────────────────────────────────────────────────────
 * Declining does not unassign (migration 0008 has the reasoning). The job stays
 * on this screen carrying the refusal and its reason in a chip that reads as a
 * problem, because the alternative — an empty contractor field — is
 * indistinguishable from a job nobody has looked at yet, and that is how work
 * goes quiet for a fortnight.
 *
 * Every write re-renders from the server rather than patching local state: what
 * an offer becomes is the API's answer, and it may refuse.
 */

export type AssignmentView = {
  status: AssignmentStatus | null;
  contractorName: string | null;
  assignedToName: string | null;
  assignedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  etaAt: string | null;
};

/** A profile who may be named as doing the work: our staff, or their engineer. */
export type Assignee = { id: string; name: string; contractorId: string | null };

type Pending = "assign" | "accept" | "decline" | "eta" | null;

export default function JobAssignment({
  jobId,
  assignment,
  canAssign,
  canAnswer,
  contractors,
  assignees,
}: {
  jobId: string;
  assignment: AssignmentView;
  /** Staff. The API refuses everybody else, so this only decides what is drawn. */
  canAssign: boolean;
  /** Staff, or a contractor. Whether THIS job is theirs is the API's answer. */
  canAnswer: boolean;
  contractors: Contractor[];
  assignees: Assignee[];
}) {
  const router = useRouter();
  const [contractorId, setContractorId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [etaAt, setEtaAt] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const status = assignment.status;
  const offered = status === "offered";
  const accepted = status === "accepted";
  const declined = status === "declined";

  /* Somebody at the chosen firm, or one of our own coordinators. Offering a
     client_user here is what the API refuses with 400 — see the assign route. */
  const people = assignees.filter(
    (person) => person.contractorId === null || person.contractorId === contractorId,
  );

  async function post(what: Exclude<Pending, null>, path: string, body?: unknown) {
    if (pending) return;
    setPending(what);
    setError(null);
    setNotice(null);
    const result = await api(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    router.refresh();
    return true;
  }

  async function assign(event: React.FormEvent) {
    event.preventDefault();
    if (!contractorId) return setError("Choose a contractor.");
    const done = await post("assign", `/jobs/${jobId}/assign`, {
      contractorId,
      assignedTo: assignedTo || undefined,
    });
    if (done) {
      setNotice("Offered. They can see the job now and will be asked to accept it.");
      setAssignedTo("");
    }
  }

  async function decline(event: React.FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      return setError("Say why — the coordinator's next move depends on it.");
    }
    const done = await post("decline", `/jobs/${jobId}/assignment/decline`, { reason });
    if (done) {
      setDeclining(false);
      setReason("");
      setNotice("Declined. A coordinator has been told and will reassign it.");
    }
  }

  async function saveEta(event: React.FormEvent) {
    event.preventDefault();
    if (!etaAt) return setError("Pick a date and a time.");
    /*
     * `datetime-local` hands back "2026-08-20T09:00" with no zone, which the
     * browser reads as the reader's own clock — which is right, because that is
     * the clock they are looking at while they type it. Converted to an
     * instant here so the API stores a moment rather than a wall time whose
     * meaning depends on which server parsed it.
     */
    const instant = new Date(etaAt);
    if (Number.isNaN(instant.getTime())) return setError("That is not a valid time.");
    const done = await post("eta", `/jobs/${jobId}/assignment/eta`, {
      etaAt: instant.toISOString(),
    });
    if (done) {
      setEtaAt("");
      setNotice("ETA saved. It is on the job for the client to see.");
    }
  }

  return (
    <section className="p-panel">
      <h2>Assignment</h2>

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="alert alert--good">{notice}</p> : null}
      </div>

      {status === null ? (
        <p className="p-note">
          Nobody has been offered this job yet.
        </p>
      ) : (
        <>
          <div className="chips">
            <span className={assignmentChipClass(status)}>
              {ASSIGNMENT_LABELS[status]}
            </span>
            {assignment.etaAt ? (
              <span className="chip chip--status">
                On site {formatDateTime(assignment.etaAt)}
              </span>
            ) : null}
          </div>

          <dl className="p-facts">
            <div>
              <dt>Contractor</dt>
              <dd>{assignment.contractorName ?? "—"}</dd>
            </div>
            {assignment.assignedToName ? (
              <div>
                <dt>Engineer</dt>
                <dd>{assignment.assignedToName}</dd>
              </div>
            ) : null}
            <div>
              <dt>Offered</dt>
              <dd>{formatDateTime(assignment.assignedAt) ?? "—"}</dd>
            </div>
            {accepted && assignment.acceptedAt ? (
              <div>
                <dt>Accepted</dt>
                <dd>{formatDateTime(assignment.acceptedAt)}</dd>
              </div>
            ) : null}
            {declined ? (
              <div>
                <dt>Declined</dt>
                <dd>{formatDateTime(assignment.declinedAt) ?? "—"}</dd>
              </div>
            ) : null}
          </dl>

          {declined && assignment.declineReason ? (
            <p className="alert alert--bad" role="status">
              <strong>{assignment.contractorName ?? "The contractor"} declined:</strong>{" "}
              {assignment.declineReason}
            </p>
          ) : null}
        </>
      )}

      {/* ── the contractor's answer ─────────────────────────────────────── */}
      {canAnswer && (offered || accepted) ? (
        <div className="p-assignact">
          {offered ? (
            <div className="p-btnrow">
              <button
                type="button"
                className="p-btn"
                disabled={pending !== null}
                onClick={async () => {
                  const done = await post("accept", `/jobs/${jobId}/assignment/accept`);
                  if (done) setNotice("Accepted. Give an ETA so the store knows when to expect you.");
                }}
              >
                {pending === "accept" ? "Accepting…" : "Accept this job"}
              </button>
              <button
                type="button"
                className="p-btn p-btn--ghost p-btn--danger"
                disabled={pending !== null}
                aria-expanded={declining}
                onClick={() => setDeclining((open) => !open)}
              >
                Decline
              </button>
            </div>
          ) : null}

          {accepted ? (
            <form onSubmit={saveEta} className="p-grid2">
              <label className="p-field">
                <span>{assignment.etaAt ? "Update the ETA" : "When will you attend?"}</span>
                <input
                  className="p-input"
                  type="datetime-local"
                  value={etaAt}
                  onChange={(event) => setEtaAt(event.target.value)}
                  disabled={pending !== null}
                />
              </label>
              <div className="p-field">
                <span aria-hidden="true">&nbsp;</span>
                <div className="p-btnrow">
                  <button className="p-btn" type="submit" disabled={pending !== null}>
                    {pending === "eta" ? "Saving…" : "Save ETA"}
                  </button>
                  <button
                    type="button"
                    className="p-btn p-btn--ghost p-btn--danger"
                    disabled={pending !== null}
                    aria-expanded={declining}
                    onClick={() => setDeclining((open) => !open)}
                  >
                    Hand it back
                  </button>
                </div>
              </div>
            </form>
          ) : null}

          {declining ? (
            <form onSubmit={decline} style={{ marginTop: 12 }}>
              <label className="p-field">
                <span>Why can you not take it?</span>
                <textarea
                  className="p-textarea"
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. No cherry picker available until Thursday."
                  disabled={pending !== null}
                />
              </label>
              <div className="p-btnrow" style={{ marginTop: 10 }}>
                <button className="p-btn p-btn--danger" type="submit" disabled={pending !== null}>
                  {pending === "decline" ? "Sending…" : "Confirm decline"}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      {/* ── staff assign or reassign ────────────────────────────────────── */}
      {canAssign ? (
        <form onSubmit={assign} style={{ marginTop: status === null ? 0 : 14 }}>
          <div className="p-grid2">
            <label className="p-field">
              <span>{status === null ? "Assign to" : "Reassign to"}</span>
              <select
                className="p-select"
                value={contractorId}
                onChange={(event) => {
                  setContractorId(event.target.value);
                  setAssignedTo(""); // the old person belongs to the old firm
                }}
                disabled={pending !== null || contractors.length === 0}
              >
                <option value="">Choose…</option>
                {contractors.map((contractor) => (
                  <option key={contractor.id} value={contractor.id}>
                    {contractor.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="p-field">
              <span>Engineer (optional)</span>
              <select
                className="p-select"
                value={assignedTo}
                onChange={(event) => setAssignedTo(event.target.value)}
                disabled={pending !== null || !contractorId}
              >
                <option value="">Not named</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="p-btnrow" style={{ marginTop: 12 }}>
            <button className="p-btn" type="submit" disabled={pending !== null}>
              {pending === "assign"
                ? "Assigning…"
                : status === null
                  ? "Assign contractor"
                  : "Reassign"}
            </button>
          </div>

          <p className="p-note">
            {contractors.length === 0
              ? "No contractors are on file yet — add one before assigning."
              : status === null
                ? "Assigning is what lets the contractor open this job. Until then it is invisible to them."
                : "Reassigning hands the job to the new contractor and takes it away from the current one."}
          </p>
        </form>
      ) : null}
    </section>
  );
}
