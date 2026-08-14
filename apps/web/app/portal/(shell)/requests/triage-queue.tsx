"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "../../../../lib/api";
import {
  formatDateTime,
  type IntakeRequest,
  type Organisation,
  type Site,
} from "../../../../lib/portal";

type Settled = { kind: "converted"; jobId: string; reference: string } | { kind: "rejected" };

/**
 * Triage, one request at a time.
 *
 * A settled request stays on screen with its outcome rather than vanishing:
 * conversion returns the new job's reference, and the coordinator's next action
 * is nearly always to open it. Removing the row would take the link away at the
 * moment it became useful.
 */
export default function TriageQueue({
  requests,
  organisations,
  sites,
}: {
  requests: IntakeRequest[];
  organisations: Organisation[];
  sites: Site[];
}) {
  const [settled, setSettled] = useState<Record<string, Settled>>({});

  return (
    <ul className="p-list">
      {requests.map((request) => (
        <li key={request.id}>
          <TriageRow
            request={request}
            organisations={organisations}
            sites={sites}
            settled={settled[request.id]}
            onSettled={(outcome) =>
              setSettled((prev) => ({ ...prev, [request.id]: outcome }))
            }
          />
        </li>
      ))}
    </ul>
  );
}

function TriageRow({
  request,
  organisations,
  sites,
  settled,
  onSettled,
}: {
  request: IntakeRequest;
  organisations: Organisation[];
  sites: Site[];
  settled: Settled | undefined;
  onSettled: (outcome: Settled) => void;
}) {
  const [organisationId, setOrganisationId] = useState(
    organisations.length === 1 ? organisations[0].id : "",
  );
  const [siteId, setSiteId] = useState("");
  const [priority, setPriority] = useState(urgencyToPriority(request.urgency));
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [pending, setPending] = useState<"convert" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sites belong to organisations. Offering one from a different client would
  // file the job against a store its owner cannot see.
  const availableSites = organisationId
    ? sites.filter((site) => site.organisation_id === organisationId)
    : [];

  async function convert() {
    if (pending) return;
    if (!organisationId) return setError("Choose an organisation.");
    setPending("convert");
    setError(null);

    const result = await api<{ job: { id: string; reference: string } }>(
      `/jobs/intake/${request.id}/convert`,
      {
        method: "POST",
        body: JSON.stringify({ organisationId, siteId: siteId || undefined, priority }),
      },
    );
    setPending(null);

    if (!result.ok) return setError(result.error);
    onSettled({
      kind: "converted",
      jobId: result.data.job.id,
      reference: result.data.job.reference,
    });
  }

  async function reject(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!reason.trim()) return setError("Give a reason — it is recorded against the request.");
    setPending("reject");
    setError(null);

    const result = await api(`/jobs/intake/${request.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    setPending(null);

    if (!result.ok) return setError(result.error);
    onSettled({ kind: "rejected" });
  }

  return (
    <article className="p-row">
      <div className="p-row-head">
        <h3>
          {request.fault_category} — {request.site_name}
        </h3>
        <span className="p-row-when">{formatDateTime(request.created_at) ?? "—"}</span>
      </div>

      <div className="chips">
        <span className="chip chip--status">{request.urgency}</span>
        <span className="chip chip--status">
          {request.photos.length} photo{request.photos.length === 1 ? "" : "s"}
        </span>
      </div>

      <p className="body" style={{ marginTop: 10 }}>
        {request.description}
      </p>

      <dl className="p-facts">
        <div>
          <dt>Reported by</dt>
          <dd>{request.contact_name}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>
            <a href={`tel:${request.phone.replace(/\s+/g, "")}`}>{request.phone}</a>
          </dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{request.email}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>
            {request.address}
            {request.postcode ? `, ${request.postcode}` : ""}
          </dd>
        </div>
        {request.access_window ? (
          <div>
            <dt>Access</dt>
            <dd>{request.access_window}</dd>
          </div>
        ) : null}
      </dl>

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {settled?.kind === "converted" ? (
        <p className="alert alert--good">
          Converted to <strong>{settled.reference}</strong>.{" "}
          <Link href={`/portal/jobs/${settled.jobId}`}>Open the job</Link>
        </p>
      ) : settled?.kind === "rejected" ? (
        <p className="alert alert--good">Rejected. The reason is on the record.</p>
      ) : (
        <>
          <div className="p-grid2">
            <label className="p-field">
              <span>Organisation</span>
              <select
                className="p-select"
                value={organisationId}
                onChange={(event) => {
                  setOrganisationId(event.target.value);
                  setSiteId(""); // the old site belongs to the old organisation
                }}
                disabled={pending !== null}
              >
                <option value="">Choose…</option>
                {organisations.map((organisation) => (
                  <option key={organisation.id} value={organisation.id}>
                    {organisation.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="p-field">
              <span>Site (optional)</span>
              <select
                className="p-select"
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
                disabled={pending !== null || availableSites.length === 0}
              >
                <option value="">Not set</option>
                {availableSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="p-field">
              <span>Priority</span>
              <select
                className="p-select"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                disabled={pending !== null}
              >
                <option value="Urgent">Urgent</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            </label>
          </div>

          <div className="p-btnrow" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="p-btn"
              onClick={convert}
              disabled={pending !== null}
            >
              {pending === "convert" ? "Converting…" : "Convert to job"}
            </button>
            <button
              type="button"
              className="p-btn p-btn--ghost"
              onClick={() => setRejecting((open) => !open)}
              disabled={pending !== null}
              aria-expanded={rejecting}
            >
              Reject
            </button>
          </div>

          {rejecting ? (
            <form onSubmit={reject} style={{ marginTop: 12 }}>
              <label className="p-field">
                <span>Reason</span>
                <textarea
                  className="p-textarea"
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. Duplicate of MS-00042, or no usable photographs."
                  disabled={pending !== null}
                />
              </label>
              <div className="p-btnrow" style={{ marginTop: 10 }}>
                <button className="p-btn p-btn--danger" type="submit" disabled={pending !== null}>
                  {pending === "reject" ? "Rejecting…" : "Confirm rejection"}
                </button>
              </div>
            </form>
          ) : null}
        </>
      )}
    </article>
  );
}

/**
 * The public form offers P1–P4; the board has three priorities. P1 and P2 are
 * both Urgent, per the brief. Only a default — the coordinator can override it,
 * because the person filling in the form is not the person who decides.
 */
function urgencyToPriority(urgency: string): string {
  if (urgency === "P1" || urgency === "P2") return "Urgent";
  if (urgency === "P4") return "Low";
  return "Medium";
}
