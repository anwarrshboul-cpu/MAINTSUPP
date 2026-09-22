"use client";

/**
 * Contractor applications from the public /contractors form — Master
 * Specification §12.
 *
 * Nothing read these rows before this screen: the form wrote a row and an email,
 * and the row was unreachable afterwards. It is the leads inbox's twin and is
 * built the same way — the admin kit (`views/admin-shell.tsx`) owns the four
 * states, the flash and `adminWrite`, the status list and the omissions come
 * from the server, and the inbox styling is `leads.css`'s, shared rather than
 * copied, because the two screens are one pattern.
 *
 * It names the workspace each application is filed under for the reason the
 * leads screen does: rows stored before the intake correction sit in a client's
 * workspace until they are re-homed deliberately, and this column is the only way
 * to see which is which.
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

type ApplicationStatus = { key: string; description: string; closed: boolean };

type Application = {
  id: string;
  company: string;
  contactName: string;
  email: string;
  phone: string;
  trades: string[];
  regions: string;
  insured: string;
  yearsTrading: string | null;
  certifications: string | null;
  notes: string | null;
  status: string;
  closed: boolean;
  notifiedAt: string | null;
  createdAt: string;
  organisationId: string;
  workspaceName: string | null;
};

type Payload = {
  canEdit: boolean;
  applications: Application[];
  statuses: ApplicationStatus[];
  counts: Record<string, number>;
  open: number;
  omissions: string[];
};

function when(value: string): string {
  const parsed = Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(parsed)) return value.slice(0, 16);
  return new Date(parsed).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function ApplicationsInboxView() {
  const { data, loading, denied, error, reload } = useAdminResource<Payload>("/api/contractor-applications/inbox");
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [filter, setFilter] = useState<string>("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const statuses = useMemo(() => data?.statuses ?? [], [data]);
  const shown = useMemo(() => {
    const all = data?.applications ?? [];
    if (filter === "all") return all;
    if (filter === "open") return all.filter((entry) => !entry.closed);
    return all.filter((entry) => entry.status === filter);
  }, [data, filter]);
  const filedUnder = useMemo(
    () => [...new Set((data?.applications ?? []).map((entry) => entry.workspaceName ?? entry.organisationId))],
    [data],
  );

  const move = async (entry: Application, next: string) => {
    setBusy(entry.id);
    const result = await adminWrite("/api/contractor-applications/inbox", "PATCH", {
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

  if (loading && !data) return <AdminLoading label="Loading the contractor applications…" />;

  if (denied) {
    return (
      <AdminNotice tone="denied" icon="shield" title="This screen is for MAINTSUPP platform staff">
        {denied} These are applications to join MAINTSUPP&rsquo;s network, not a workspace&rsquo;s
        records — the server refused this request, and the screen is not merely hidden.
      </AdminNotice>
    );
  }

  if (error || !data) {
    return (
      <AdminNotice tone="error" icon="alert" title="The applications could not be loaded">
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
          <small className="leads-admin__total"> of {data.applications.length} in total</small>
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

      {filedUnder.length > 0 ? (
        <AdminNotice tone="info" icon="alert" title="Where these applications are filed">
          These are applications to MAINTSUPP, which is why this screen answers to platform staff
          and why no workspace capability opens it. They are currently filed under{" "}
          <strong>{filedUnder.join(", ")}</strong>. A new application goes to the platform&rsquo;s own
          intake workspace; anything still showing a client&rsquo;s name arrived before that was
          corrected and has not been re-filed, because moving a row out of a customer&rsquo;s workspace
          is a deliberate change rather than something this screen does.
        </AdminNotice>
      ) : null}

      {shown.length === 0 ? (
        <AdminNotice tone="empty" icon="inbox" title="Nothing here">
          {filter === "open" ? "Every application has been dealt with." : "No application matches that filter."}
        </AdminNotice>
      ) : (
        <table className="admin-table leads-admin__list">
          <thead>
            <tr>
              <th>Applicant</th>
              <th>Trades</th>
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
                    {entry.contactName} · <a href={`mailto:${entry.email}`}>{entry.email}</a> · {entry.phone}
                  </small>
                </td>
                <td>
                  <small>
                    {entry.trades.join(", ")}
                    <br />
                    {entry.regions}
                  </small>
                </td>
                <td>
                  <small>
                    {when(entry.createdAt)}
                    <br />
                    {entry.notifiedAt ? "alert sent" : "alert NOT sent"}
                  </small>
                </td>
                <td>
                  <span className={`leads-admin__state leads-admin__state--${entry.closed ? "closed" : "open"}`}>
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
                      {entry.contactName} · <a href={`mailto:${entry.email}`}>{entry.email}</a> · {entry.phone}
                    </dd>
                  </div>
                  <div>
                    <dt>Trades</dt>
                    <dd>{entry.trades.join(", ")}</dd>
                  </div>
                  <div>
                    <dt>Regions</dt>
                    <dd>{entry.regions}</dd>
                  </div>
                  <div>
                    <dt>Public liability insurance</dt>
                    <dd>{entry.insured}</dd>
                  </div>
                  {entry.yearsTrading ? (
                    <div>
                      <dt>Years trading</dt>
                      <dd>{entry.yearsTrading}</dd>
                    </div>
                  ) : null}
                  {entry.certifications ? (
                    <div>
                      <dt>Certifications</dt>
                      <dd>{entry.certifications}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Filed under</dt>
                    <dd>{entry.workspaceName ?? entry.organisationId}</dd>
                  </div>
                </dl>

                {/* The applicant's own words, only ever rendered as text. */}
                {entry.notes ? (
                  <>
                    <h4>What they said</h4>
                    <p className="leads-admin__challenge">{entry.notes}</p>
                  </>
                ) : null}

                <h4>Move it on</h4>
                <label className="admin-field admin-field--grow">
                  <span>Why (optional)</span>
                  <input
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Insurance certificate checked, references requested"
                    value={reason}
                  />
                  <small>Recorded in the audit trail against this application.</small>
                </label>
                <div className="leads-admin__moves">
                  {statuses.map((status) => (
                    <button
                      className={status.key === entry.status ? "primary-button admin-mini" : "secondary-button admin-mini"}
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
        <Icon name="shield" size={14} /> These carry other companies&rsquo; contact details. There is no
        export, deliberately.
      </p>
    </div>
  );
}
