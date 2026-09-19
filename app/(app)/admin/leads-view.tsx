"use client";

/**
 * The enquiries the public website has taken — Master Specification §12.
 *
 * WHAT WAS ACTUALLY MISSING. Intake, storage and notification were finished and
 * good: the form posts, the route validates, a honeypot answers a bot with a fake
 * 201, the row is written, two emails go out and `notified_at` is stamped. But
 * `GET /api/leads` was a hard 501 and `status` had never been written, so an
 * enquiry was unreachable the moment its email had been read, and one that had been
 * answered looked exactly like one nobody had opened.
 *
 * ⚠️ WHY THIS SCREEN NAMES THE WORKSPACE EACH ENQUIRY IS FILED UNDER.
 *
 * Because it is not MAINTSUPP's. A public enquiry has no account, so the intake
 * route resolves to the PRIMARY active organisation — measured on Staging, that is a
 * client company's workspace, and all 8 stored leads sit in it. The rows are
 * MAINTSUPP's own sales pipeline filed under a customer.
 *
 * That is why the gate is `platformAdmin` and not a capability: a workspace
 * capability would have shown that customer every enquiry MAINTSUPP has received
 * from its own website. Showing the workspace name in the table is how the person
 * reading the screen can see the situation for themselves rather than take a
 * comment's word for it, and it is the prompt to fix the filing.
 *
 * BUILT ON THE ADMIN KIT. `views/admin-shell.tsx` owns the four states, the flash
 * and `adminWrite`; `views/admin-console.css` owns `.admin-field`, `.admin-notice`,
 * `.admin-toolbar`, `.admin-panel` and `.admin-table`. A second definition of any of
 * them is drift, and a test in `platform-admin-shell` is named for it.
 *
 * THE STATUS LIST COMES FROM THE SERVER, not from a copy here. `GET` sends
 * `LEAD_STATUSES` with each one's description and whether it closes an enquiry, so a
 * status added in `app/lib/lead-status.ts` appears with no edit to this file. That is
 * the mistake Phase 6 paid for, in its own words: a picker whose options are typed
 * into the panel stops agreeing with what the server will accept.
 */

import { useMemo, useState } from "react";

import { Icon } from "../../components";
import {
  AdminFlash,
  AdminLoading,
  AdminNotice,
  adminWrite,
  useAdminResource,
} from "../portal/views/admin-shell";
import "./leads.css";

type LeadStatus = { key: string; description: string; closed: boolean };

type Enquiry = {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string | null;
  siteRange: string;
  services: string[];
  regions: string[];
  challenge: string;
  status: string;
  closed: boolean;
  notifiedAt: string | null;
  notifyAttempts: number;
  createdAt: string;
  organisationId: string;
  workspaceName: string | null;
};

type Payload = {
  canEdit: boolean;
  enquiries: Enquiry[];
  statuses: LeadStatus[];
  counts: Record<string, number>;
  open: number;
  omissions: string[];
};

/** A date a person can read, from the text the column stores. */
function when(value: string): string {
  const parsed = Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(parsed)) return value.slice(0, 16);
  return new Date(parsed).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function LeadsInboxView() {
  const { data, loading, denied, error, reload } = useAdminResource<Payload>("/api/leads");
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [filter, setFilter] = useState<string>("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const statuses = useMemo(() => data?.statuses ?? [], [data]);

  const shown = useMemo(() => {
    const all = data?.enquiries ?? [];
    if (filter === "all") return all;
    if (filter === "open") return all.filter((entry) => !entry.closed);
    return all.filter((entry) => entry.status === filter);
  }, [data, filter]);

  /* Whether the enquiries are filed somewhere other than one workspace, and which.
     Read off the data rather than assumed, so the notice below states what is
     actually true of this installation. */
  const filedUnder = useMemo(() => {
    const names = new Set(
      (data?.enquiries ?? []).map((entry) => entry.workspaceName ?? entry.organisationId),
    );
    return [...names];
  }, [data]);

  const move = async (entry: Enquiry, next: string) => {
    setBusy(entry.id);
    const result = await adminWrite("/api/leads", "PATCH", {
      id: entry.id,
      status: next,
      reason: reason.trim() || undefined,
    });
    setBusy(null);
    setFlash({ ok: result.ok, message: result.message });
    if (result.ok) {
      setReason("");
      await reload();
    }
  };

  if (loading && !data) return <AdminLoading label="Loading the website's enquiries…" />;

  if (denied) {
    return (
      <AdminNotice tone="denied" icon="shield" title="This screen is for MAINTSUPP platform staff">
        {denied} These are enquiries to MAINTSUPP itself, not a workspace&rsquo;s records — the
        server refused this request, and the screen is not merely hidden.
      </AdminNotice>
    );
  }

  if (error || !data) {
    return (
      <AdminNotice tone="error" icon="alert" title="The enquiries could not be loaded">
        {error ?? "That could not be loaded."}
      </AdminNotice>
    );
  }

  return (
    <div className="admin-console leads-admin">
      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />

      <div className="admin-toolbar">
        <strong>
          {data.open} waiting on us
          <small className="leads-admin__total"> of {data.enquiries.length} in total</small>
        </strong>
        <span className="admin-toolbar__spacer" />
        <label className="admin-field">
          <span>Show</span>
          <select onChange={(event) => setFilter(event.target.value)} value={filter}>
            <option value="open">Still open</option>
            <option value="all">Everything</option>
            {statuses.map((status) => (
              <option key={status.key} value={status.key}>
                {status.key} ({data.counts[status.key] ?? 0})
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* The finding, stated on the screen rather than only in the code. It reads
          off the data, so it cannot claim something that has stopped being true. */}
      {filedUnder.length > 0 ? (
        <AdminNotice tone="info" icon="alert" title="These enquiries are filed under a client workspace">
          A public enquiry has no account behind it, so the intake route files it under the primary
          active workspace — currently <strong>{filedUnder.join(", ")}</strong>. They are
          MAINTSUPP&rsquo;s own enquiries, not that client&rsquo;s, which is why this screen answers to
          platform staff and why no workspace capability opens it. Re-filing the existing rows is a
          change to a customer&rsquo;s workspace and has not been made here.
        </AdminNotice>
      ) : null}

      {shown.length === 0 ? (
        <AdminNotice tone="empty" icon="inbox" title="Nothing here">
          {filter === "open"
            ? "Every enquiry has been dealt with."
            : "No enquiry matches that filter."}
        </AdminNotice>
      ) : (
        <table className="admin-table leads-admin__list">
          <thead>
            <tr>
              <th>Enquiry</th>
              <th>Estate</th>
              <th>Arrived</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr className={entry.closed ? "admin-row--off" : undefined} key={entry.id}>
                <td>
                  <strong>{entry.company}</strong>
                  <br />
                  <small>
                    {entry.name} ·{" "}
                    <a href={`mailto:${entry.email}`}>{entry.email}</a>
                    {entry.phone ? ` · ${entry.phone}` : ""}
                  </small>
                </td>
                <td>
                  <small>
                    {entry.siteRange}
                    {entry.regions.length ? <br /> : null}
                    {entry.regions.join(", ")}
                  </small>
                </td>
                <td>
                  <small>
                    {when(entry.createdAt)}
                    <br />
                    {/* Whether the alert email actually went out. It is stamped by the
                        intake route and has never been shown anywhere until now, so a
                        notification that silently failed was invisible. */}
                    {entry.notifiedAt ? "alert sent" : "alert NOT sent"}
                  </small>
                </td>
                <td>
                  <span
                    className={`leads-admin__state leads-admin__state--${entry.closed ? "closed" : "open"}`}
                  >
                    {entry.status}
                  </span>
                </td>
                <td>
                  <button
                    className="secondary-button admin-mini"
                    onClick={() => {
                      setExpanded(expanded === entry.id ? null : entry.id);
                      setReason("");
                    }}
                    type="button"
                  >
                    {expanded === entry.id ? "Close" : "Open"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {expanded
        ? (() => {
            const entry = shown.find((candidate) => candidate.id === expanded);
            if (!entry) return null;
            return (
              <div className="admin-panel leads-admin__detail">
                <h3>{entry.company}</h3>
                <dl className="leads-admin__facts">
                  <div>
                    <dt>Contact</dt>
                    <dd>
                      {entry.name} · <a href={`mailto:${entry.email}`}>{entry.email}</a>
                      {entry.phone ? ` · ${entry.phone}` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>Sites</dt>
                    <dd>{entry.siteRange}</dd>
                  </div>
                  {entry.regions.length ? (
                    <div>
                      <dt>Regions</dt>
                      <dd>{entry.regions.join(", ")}</dd>
                    </div>
                  ) : null}
                  {entry.services.length ? (
                    <div>
                      <dt>Services</dt>
                      <dd>{entry.services.join(", ")}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Filed under</dt>
                    <dd>{entry.workspaceName ?? entry.organisationId}</dd>
                  </div>
                  <div>
                    <dt>Alert email</dt>
                    <dd>
                      {entry.notifiedAt
                        ? `sent ${when(entry.notifiedAt)}`
                        : `never sent (${entry.notifyAttempts} attempt${entry.notifyAttempts === 1 ? "" : "s"})`}
                    </dd>
                  </div>
                </dl>

                {/* The submitter's own words, only ever rendered as text. The form
                    allows 900 characters of free prose and this is the only place it
                    has ever been readable. */}
                {entry.challenge ? (
                  <>
                    <h4>What they said</h4>
                    <p className="leads-admin__challenge">{entry.challenge}</p>
                  </>
                ) : (
                  <p className="leads-admin__challenge leads-admin__challenge--empty">
                    They did not write anything — the form stopped asking.
                  </p>
                )}

                <h4>Move it on</h4>
                <label className="admin-field admin-field--grow">
                  <span>Why (optional)</span>
                  <input
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Spoke to them, sending a quote on Monday"
                    value={reason}
                  />
                  <small>
                    Recorded in the audit trail against this enquiry. There is no notes field on a
                    lead, so this is where the reason lives.
                  </small>
                </label>
                <div className="leads-admin__moves">
                  {statuses.map((status) => (
                    <button
                      className={
                        status.key === entry.status
                          ? "primary-button admin-mini"
                          : "secondary-button admin-mini"
                      }
                      disabled={busy === entry.id}
                      key={status.key}
                      onClick={() => move(entry, status.key)}
                      title={status.description}
                      type="button"
                    >
                      {status.key}
                    </button>
                  ))}
                </div>
                <p className="leads-admin__hint">
                  {statuses.find((status) => status.key === entry.status)?.description ?? ""}
                </p>
              </div>
            );
          })()
        : null}

      <AdminNotice tone="info" icon="alert" title="What this inbox does not do yet">
        <ul className="leads-admin__omissions">
          {data.omissions.map((omission) => (
            <li key={omission}>{omission}</li>
          ))}
        </ul>
      </AdminNotice>

      <p className="leads-admin__foot">
        <Icon name="shield" size={14} /> These are enquiries to MAINTSUPP, and they carry other
        companies&rsquo; contact details. There is no export, deliberately.
      </p>
    </div>
  );
}
