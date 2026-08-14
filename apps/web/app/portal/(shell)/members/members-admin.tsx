"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../../lib/api";
import {
  ALL_ROLES,
  canActOnMember,
  canGrantRole,
  formatDate,
  OWNER_EMAIL,
  ROLE_LABELS,
  type Actor,
  type Invitation,
  type Member,
  type Role,
  type Scopes,
} from "../../../../lib/portal";

/**
 * The Members page.
 *
 * Every control here is drawn from the same rank rules the API enforces in
 * `access.ts`, so an admin is not offered a button whose only outcome is
 * "You cannot modify an account at or above your own level." The API is still
 * the authority — this only keeps the page honest about what it can do.
 */
export default function MembersAdmin({
  actor,
  members,
  invitations,
  scopes,
}: {
  actor: Actor;
  members: Member[];
  invitations: Invitation[];
  scopes: Scopes;
}) {
  const pending = members.filter((member) => member.status === "pending_approval");
  const rest = members.filter((member) => member.status !== "pending_approval");
  const grantable = ALL_ROLES.filter((role) => canGrantRole(actor, role));

  return (
    <>
      <section className="p-section">
        <div className="p-section-head">
          <h2>Waiting for approval</h2>
          <span className="p-muted p-small">{pending.length}</span>
        </div>

        {pending.length === 0 ? (
          <div className="card card--empty">
            <p className="muted">Nobody is waiting.</p>
          </div>
        ) : (
          <ul className="p-list">
            {pending.map((member) => (
              <li key={member.id}>
                <ApproveRow member={member} scopes={scopes} grantable={grantable} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="p-section">
        <h2>Invite someone</h2>
        <InviteForm scopes={scopes} grantable={grantable} />
      </section>

      {invitations.length ? (
        <section className="p-section">
          <div className="p-section-head">
            <h2>Outstanding invitations</h2>
            <span className="p-muted p-small">{invitations.length}</span>
          </div>
          <ul className="p-list">
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <InvitationRow invitation={invitation} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="p-section">
        <div className="p-section-head">
          <h2>Everyone</h2>
          <span className="p-muted p-small">{rest.length}</span>
        </div>
        <ul className="p-list">
          {rest.map((member) => (
            <li key={member.id}>
              <MemberRow member={member} actor={actor} grantable={grantable} />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ rows -- */

function ApproveRow({
  member,
  scopes,
  grantable,
}: {
  member: Member;
  scopes: Scopes;
  grantable: readonly Role[];
}) {
  const router = useRouter();
  const [role, setRole] = useState<Role>(grantable.includes("client_user") ? "client_user" : grantable[0]);
  const [organisationId, setOrganisationId] = useState("");
  const [contractorId, setContractorId] = useState("");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The API's CHECK constraint refuses an active client role with no
  // organisation, and a contractor with no contractor. Asking for the right
  // field up front turns a 400 into a form that cannot be wrong.
  const needsOrganisation = role === "client_admin" || role === "client_user";
  const needsContractor = role === "contractor";
  const offersSites = role === "client_user";
  const orgSites = scopes.sites.filter((site) => site.organisation_id === organisationId);

  async function approve(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const result = await api(`/members/${member.id}/approve`, {
      method: "POST",
      body: JSON.stringify({
        role,
        organisationId: needsOrganisation ? organisationId : null,
        contractorId: needsContractor ? contractorId : null,
        siteIds: offersSites ? siteIds : [],
      }),
    });
    setPending(false);

    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <form className="p-row" onSubmit={approve}>
      <div className="p-row-head">
        <h3>{member.full_name ?? member.email}</h3>
        <span className="p-row-when">{formatDate(member.created_at) ?? "—"}</span>
      </div>
      <p className="p-muted p-small" style={{ margin: 0 }}>
        {member.email}
        {member.email_verified ? "" : " · email not confirmed"}
      </p>

      <div aria-live="polite">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="p-grid2">
        <label className="p-field">
          <span>Role</span>
          <select
            className="p-select"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            disabled={pending}
          >
            {grantable.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        {needsOrganisation ? (
          <label className="p-field">
            <span>Organisation</span>
            <select
              className="p-select"
              value={organisationId}
              onChange={(event) => {
                setOrganisationId(event.target.value);
                setSiteIds([]);
              }}
              disabled={pending}
            >
              <option value="">Choose…</option>
              {scopes.organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>
                  {organisation.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {needsContractor ? (
          <label className="p-field">
            <span>Contractor</span>
            <select
              className="p-select"
              value={contractorId}
              onChange={(event) => setContractorId(event.target.value)}
              disabled={pending}
            >
              <option value="">Choose…</option>
              {scopes.contractors.map((contractor) => (
                <option key={contractor.id} value={contractor.id}>
                  {contractor.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {offersSites ? (
        <div className="p-field" style={{ marginTop: 10 }}>
          <span>
            Sites {organisationId ? "" : "— choose an organisation first"}
          </span>
          {/* A client_user with no sites sees nothing at all: `scopeFor` denies
              them outright. Saying so is kinder than an empty board. */}
          <div className="p-checks">
            {orgSites.map((site) => (
              <label className="p-check" key={site.id}>
                <input
                  type="checkbox"
                  checked={siteIds.includes(site.id)}
                  onChange={(event) =>
                    setSiteIds((prev) =>
                      event.target.checked
                        ? [...prev, site.id]
                        : prev.filter((id) => id !== site.id),
                    )
                  }
                  disabled={pending}
                />
                <span>{site.name}</span>
              </label>
            ))}
          </div>
          {organisationId && siteIds.length === 0 ? (
            <p className="p-note">
              With no sites selected this account will see no jobs.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="p-btnrow" style={{ marginTop: 12 }}>
        <button className="p-btn" type="submit" disabled={pending}>
          {pending ? "Approving…" : "Approve"}
        </button>
      </div>
    </form>
  );
}

function MemberRow({
  member,
  actor,
  grantable,
}: {
  member: Member;
  actor: Actor;
  grantable: readonly Role[];
}) {
  const router = useRouter();
  const [role, setRole] = useState<Role>(member.role);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mayAct = canActOnMember(actor, member);
  const isOwner = member.email.trim().toLowerCase() === OWNER_EMAIL;
  const suspended = member.status === "suspended";

  async function post(path: string, body: unknown, label: string) {
    if (pending) return;
    setPending(label);
    setError(null);
    const result = await api(path, { method: "POST", body: JSON.stringify(body) });
    setPending(null);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <article className="p-row">
      <div className="p-row-head">
        <h3>{member.full_name ?? member.email}</h3>
        <span className={`p-badge${isOwner ? " p-badge--owner" : ""}`}>
          {ROLE_LABELS[member.role]}
        </span>
        {suspended ? <span className="chip chip--urgent">Suspended</span> : null}
        <span className="p-row-when">
          {member.last_seen_at ? `seen ${formatDate(member.last_seen_at)}` : "never signed in"}
        </span>
      </div>

      <p className="p-muted p-small" style={{ margin: 0 }}>
        {member.email}
        {member.organisation_name ? ` · ${member.organisation_name}` : ""}
        {member.contractor_name ? ` · ${member.contractor_name}` : ""}
        {member.site_names.length ? ` · ${member.site_names.join(", ")}` : ""}
      </p>

      <div aria-live="polite">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {isOwner ? (
        <p className="p-note">
          The owner account cannot be modified — not by anyone, including itself.
          That is what stops a sequence of requests locking everybody out.
        </p>
      ) : !mayAct ? (
        <p className="p-note">You cannot modify an account at or above your own level.</p>
      ) : (
        <div className="p-grid2">
          <label className="p-field">
            <span>Role</span>
            <select
              className="p-select"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              disabled={pending !== null}
            >
              {/* The member's current role stays listed even when this actor
                  could not grant it, or the select would silently show someone
                  else's role as the wrong value. */}
              {(grantable.includes(member.role)
                ? grantable
                : [member.role, ...grantable]
              ).map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>

          <div className="p-field">
            <span aria-hidden="true">&nbsp;</span>
            <div className="p-btnrow">
              <button
                type="button"
                className="p-btn"
                disabled={pending !== null || role === member.role}
                onClick={() => post(`/members/${member.id}/role`, { role }, "role")}
              >
                {pending === "role" ? "Saving…" : "Save role"}
              </button>

              {suspended ? (
                <button
                  type="button"
                  className="p-btn p-btn--ghost"
                  disabled={pending !== null}
                  onClick={() => post(`/members/${member.id}/reactivate`, {}, "reactivate")}
                >
                  {pending === "reactivate" ? "…" : "Reactivate"}
                </button>
              ) : (
                <button
                  type="button"
                  className="p-btn p-btn--danger"
                  disabled={pending !== null}
                  onClick={() => post(`/members/${member.id}/deactivate`, {}, "deactivate")}
                >
                  {pending === "deactivate" ? "…" : "Deactivate"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await api(`/members/invitations/${invitation.id}/revoke`, {
      method: "POST",
    });
    setPending(false);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <article className="p-row">
      <div className="p-row-head">
        <h3>{invitation.email}</h3>
        <span className="p-badge">{ROLE_LABELS[invitation.role]}</span>
        <span className="p-row-when">expires {formatDate(invitation.expires_at) ?? "—"}</span>
      </div>
      {error ? (
        <p className="alert alert--bad" role="alert">
          {error}
        </p>
      ) : null}
      <div className="p-btnrow" style={{ marginTop: 10 }}>
        <button type="button" className="p-btn p-btn--ghost" onClick={revoke} disabled={pending}>
          {pending ? "Revoking…" : "Revoke"}
        </button>
      </div>
    </article>
  );
}

function InviteForm({
  scopes,
  grantable,
}: {
  scopes: Scopes;
  grantable: readonly Role[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(grantable[0]);
  const [organisationId, setOrganisationId] = useState("");
  const [contractorId, setContractorId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const needsOrganisation = role === "client_admin" || role === "client_user";
  const needsContractor = role === "contractor";

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);

    const result = await api(`/members/invite`, {
      method: "POST",
      body: JSON.stringify({
        email,
        role,
        organisationId: needsOrganisation ? organisationId : null,
        contractorId: needsContractor ? contractorId : null,
      }),
    });
    setPending(false);

    if (!result.ok) return setError(result.error);
    setNotice(`Invitation sent to ${email}.`);
    setEmail("");
    router.refresh();
  }

  return (
    <form className="p-row" onSubmit={invite}>
      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="alert alert--good">{notice}</p> : null}
      </div>

      <div className="p-grid2">
        <label className="p-field">
          <span>Email</span>
          <input
            className="p-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoCapitalize="none"
            spellCheck={false}
            placeholder="them@company.com"
            required
            disabled={pending}
          />
        </label>

        <label className="p-field">
          <span>Role</span>
          <select
            className="p-select"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            disabled={pending}
          >
            {grantable.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>

        {needsOrganisation ? (
          <label className="p-field">
            <span>Organisation</span>
            <select
              className="p-select"
              value={organisationId}
              onChange={(event) => setOrganisationId(event.target.value)}
              disabled={pending}
            >
              <option value="">Choose…</option>
              {scopes.organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>
                  {organisation.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {needsContractor ? (
          <label className="p-field">
            <span>Contractor</span>
            <select
              className="p-select"
              value={contractorId}
              onChange={(event) => setContractorId(event.target.value)}
              disabled={pending}
            >
              <option value="">Choose…</option>
              {scopes.contractors.map((contractor) => (
                <option key={contractor.id} value={contractor.id}>
                  {contractor.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="p-btnrow" style={{ marginTop: 12 }}>
        <button className="p-btn" type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send invitation"}
        </button>
      </div>
      <p className="p-note">
        No account is created until they accept: the invitation records the role
        and scope, and they choose their own password.
      </p>
    </form>
  );
}
