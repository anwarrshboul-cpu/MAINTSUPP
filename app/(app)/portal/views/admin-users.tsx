"use client";

/**
 * People in this workspace.
 *
 * The screen is a thin renderer over `/api/admin/users`. Every control it draws
 * corresponds to a capability the server independently checks, and the payload
 * carries the actor's effective capabilities so the two agree — but the hiding
 * is cosmetic. Unticking "Edit people" and reloading removes the buttons;
 * unticking it and calling PATCH anyway returns 403. The screen is the polite
 * version of the rule, not the rule.
 *
 * Guard-rails surface as the server's own sentence. When a deactivation is
 * refused because the person is the last Super Admin, the strip at the top says
 * exactly that, because a generic "that didn't work" would leave the operator
 * with no idea what to do next.
 */

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import {
  AdminFlash,
  AdminLoading,
  AdminNotice,
  Avatar,
  adminWrite,
  relativeTime,
  useAdminResource,
  type AdminActor,
} from "./admin-shell";

type MembershipSummary = {
  organisationId: string;
  organisationName: string;
  role: string;
  roleLabel: string;
  status: string;
  isCurrent: boolean;
};

type AdminUser = {
  id: string;
  email: string;
  fullName: string | null;
  jobTitle: string | null;
  phone: string | null;
  timezone: string | null;
  avatarColour: string | null;
  status: string;
  active: boolean;
  deactivatedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  role: string;
  roleLabel: string;
  membershipStatus: string;
  memberships: MembershipSummary[];
  isSelf: boolean;
};

type Invitation = {
  id: string;
  email: string;
  role: string;
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
  /** Past its expiry, so the link in that inbox no longer opens anything. */
  expired?: boolean;
};

type UsersPayload = {
  organisation: { id: string; name: string; slug: string; planTier: string };
  organisations: Array<{ id: string; name: string; slug: string }>;
  actor: AdminActor;
  roles: Array<{ key: string; label: string; assignable: boolean }>;
  users: AdminUser[];
  invitations: Invitation[];
};

type Flash = { ok: boolean; message: string } | null;

export function AdminUsersView() {
  const [organisationId, setOrganisationId] = useState<string | null>(null);
  const url = organisationId
    ? `/api/admin/users?organisationId=${encodeURIComponent(organisationId)}`
    : "/api/admin/users";
  const { data, loading, denied, error, reload } = useAdminResource<UsersPayload>(url);

  const [flash, setFlash] = useState<Flash>(null);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /*
   * The link, held until the admin has actually copied it.
   *
   * There is no mail server in this product, so the invitation link IS the
   * delivery mechanism, and it exists exactly once — the row stores only its
   * hash, by design, so nothing can hand it back afterwards. Losing it means
   * the invitation cannot be accepted by anybody. So it stays on screen until
   * dismissed rather than vanishing with the dialog.
   */
  const [issued, setIssued] = useState<{
    email: string;
    url: string;
    kind: "invitation" | "reset";
  } | null>(null);
  const [search, setSearch] = useState("");

  const can = (capability: string) => Boolean(data?.actor.capabilities?.[capability]);

  const visible = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return data.users;
    return data.users.filter((user) =>
      [user.fullName, user.email, user.jobTitle, user.roleLabel]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle)),
    );
  }, [data, search]);

  const counts = useMemo(() => {
    const users = data?.users ?? [];
    return {
      active: users.filter((user) => user.active).length,
      deactivated: users.filter((user) => !user.active).length,
      admins: users.filter((user) => user.role === "admin" || user.role === "super_admin")
        .length,
      // Expired invitations are listed, but they are not waiting for anybody.
      pending: (data?.invitations ?? []).filter((invitation) => !invitation.expired).length,
    };
  }, [data]);

  /**
   * Mint a fresh link for somebody already invited.
   *
   * `createInvitation` revokes any outstanding invitation for that address
   * before writing the new one, so this cannot leave two live links to the same
   * workspace — the old one stops working the moment the new one is issued.
   * That is what makes this safe to offer as "send again" when a link was lost
   * or has expired.
   */
  async function reissue(invitation: Invitation) {
    setBusy(invitation.id);
    const result = await adminWrite("/api/admin/users", "POST", {
      organisationId: data?.organisation.id,
      email: invitation.email,
      role: invitation.role,
    });
    setBusy(null);
    const url = result.payload?.inviteUrl;
    if (result.ok && typeof url === "string") {
      setIssued({ email: invitation.email, url, kind: "invitation" });
      setFlash({ ok: true, message: `A new link for ${invitation.email}. The previous one no longer works.` });
      await reload();
      return;
    }
    setFlash(result);
  }

  /**
   * Hand somebody a way back into their own account.
   *
   * Forgetting a password used to be permanent: there is no mail server, so no
   * "forgot password" link, and `POST /api/auth/password` refuses to take a
   * `userId` on purpose. The link is issued here and passed on by hand, which
   * is the same delivery story as an invitation and is why it reuses the same
   * panel rather than inventing a second way to show a credential.
   */
  async function resetPassword(user: AdminUser) {
    const name = user.fullName || user.email;
    if (
      !window.confirm(
        `Issue a password reset link for ${name}?\n\nAny link issued earlier stops working, and when they use this one every device signed in as them is signed out.`,
      )
    ) {
      return;
    }
    setBusy(user.id);
    const result = await adminWrite("/api/admin/users/password-reset", "POST", {
      organisationId: data?.organisation.id,
      userId: user.id,
    });
    setBusy(null);
    const url = result.payload?.resetUrl;
    if (result.ok && typeof url === "string") {
      setIssued({ email: user.email, url, kind: "reset" });
      setFlash({ ok: true, message: `A reset link for ${user.email}. Give it to them directly.` });
      return;
    }
    setFlash(result);
  }

  async function revoke(invitation: Invitation) {
    setBusy(invitation.id);
    const result = await adminWrite(
      `/api/admin/users?organisationId=${encodeURIComponent(
        data?.organisation.id ?? "",
      )}&invitationId=${encodeURIComponent(invitation.id)}`,
      "DELETE",
    );
    setBusy(null);
    setFlash(
      result.ok
        ? { ok: true, message: `The invitation to ${invitation.email} has been withdrawn.` }
        : result,
    );
    if (issued?.email === invitation.email) setIssued(null);
    if (result.ok) await reload();
  }

  async function run(body: Record<string, unknown>, key: string) {
    setBusy(key);
    const result = await adminWrite("/api/admin/users", "PATCH", {
      organisationId: data?.organisation.id,
      ...body,
    });
    setBusy(null);
    setFlash(result);
    if (result.ok) await reload();
    return result.ok;
  }

  return (
    <div className="section-stack admin-console">
      <section className="section-header">
        <div>
          <span className="eyebrow-chip">
            <Icon name="users" size={15} />
            People &amp; access
          </span>
          <h1>Users</h1>
          <p>
            Everyone with a membership of this workspace, the role that membership
            grants and the other workspaces they belong to. Deactivating somebody
            suspends their access without deleting them or their history.
          </p>
        </div>
        {can("users.invite") ? (
          <button className="primary-button" type="button" onClick={() => setInviting(true)}>
            <Icon name="plus" size={17} />
            Invite person
          </button>
        ) : null}
      </section>

      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />

      {loading && !data ? <AdminLoading label="Loading the people directory…" /> : null}

      {denied ? (
        <AdminNotice tone="denied" icon="shield" title="You do not have access to this screen">
          {denied} The server refused this request — this is not a hidden button.
        </AdminNotice>
      ) : null}

      {error ? (
        <AdminNotice tone="error" icon="alert" title="The directory could not be loaded">
          {error}
        </AdminNotice>
      ) : null}

      {data ? (
        <>
          <div className="admin-toolbar">
            {/* The workspace picker only appears when there is something to pick
                between. A client resolves to exactly one organisation, so for
                them a select with a single option would imply a choice they do
                not have. */}
            {data.organisations.length > 1 ? (
              <label className="admin-field admin-field--inline">
                <span>Workspace</span>
                <select
                  value={data.organisation.id}
                  onChange={(event) => setOrganisationId(event.target.value)}
                >
                  {data.organisations.map((organisation) => (
                    <option key={organisation.id} value={organisation.id}>
                      {organisation.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="admin-field admin-field--inline admin-field--grow">
              <span>Search</span>
              <input
                type="search"
                value={search}
                placeholder="Name, email or job title"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>

          <section className="site-stat-grid">
            <div>
              <span className="site-stat-icon">
                <Icon name="users" size={19} />
              </span>
              <small>Active people</small>
              <strong>{counts.active}</strong>
            </div>
            <div>
              <span className="site-stat-icon site-stat-icon--teal">
                <Icon name="shield" size={19} />
              </span>
              <small>Admins &amp; super admins</small>
              <strong>{counts.admins}</strong>
            </div>
            <div>
              <span className="site-stat-icon site-stat-icon--orange">
                <Icon name="inbox" size={19} />
              </span>
              <small>Pending invitations</small>
              <strong>{counts.pending}</strong>
            </div>
            <div>
              <span className="site-stat-icon site-stat-icon--green">
                <Icon name="user" size={19} />
              </span>
              <small>Deactivated</small>
              <strong>{counts.deactivated}</strong>
            </div>
          </section>

          <section className="panel admin-panel">
            <div className="panel-heading">
              <div>
                <span>{data.organisation.name}</span>
                <h2>Members</h2>
              </div>
            </div>
            {visible.length ? (
              <div className="table-scroll">
                <table className="data-table admin-table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Role here</th>
                      <th>Workspaces</th>
                      <th>Status</th>
                      <th>Last sign-in</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((user) => (
                      <tr key={user.id} className={user.active ? "" : "admin-row--off"}>
                        <td>
                          <span className="admin-person">
                            <Avatar
                              name={user.fullName}
                              email={user.email}
                              colour={user.avatarColour}
                              muted={!user.active}
                            />
                            <span>
                              <strong>
                                {user.fullName ?? user.email.split("@")[0]}
                                {user.isSelf ? <em className="admin-you">you</em> : null}
                              </strong>
                              <small>{user.email}</small>
                              {user.jobTitle ? <small>{user.jobTitle}</small> : null}
                            </span>
                          </span>
                        </td>
                        <td>
                          {can("users.edit") && !user.isSelf ? (
                            <select
                              className="admin-role-select"
                              value={user.role}
                              disabled={busy === user.id}
                              onChange={(event) =>
                                void run(
                                  { userId: user.id, action: "role", role: event.target.value },
                                  user.id,
                                )
                              }
                            >
                              {data.roles.map((role) => (
                                <option
                                  key={role.key}
                                  value={role.key}
                                  /* An admin cannot grant Super Admin; the API
                                     refuses it too, so this only saves a round
                                     trip. */
                                  disabled={!role.assignable}
                                >
                                  {role.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className={`admin-role-chip admin-role-chip--${user.role}`}>
                              {user.roleLabel}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="admin-workspaces">
                            {user.memberships.map((membership) => (
                              <span
                                key={membership.organisationId}
                                className={`admin-chip${membership.isCurrent ? " admin-chip--current" : ""}`}
                                title={`${membership.roleLabel} · ${membership.status}`}
                              >
                                {membership.organisationName}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`admin-status admin-status--${user.active ? "on" : "off"}`}
                          >
                            {user.active ? "Active" : "Deactivated"}
                          </span>
                          {!user.active && user.deactivatedAt ? (
                            <small className="admin-subtle">
                              {relativeTime(user.deactivatedAt)}
                            </small>
                          ) : null}
                        </td>
                        <td>{relativeTime(user.lastLoginAt)}</td>
                        <td>
                          <span className="admin-actions">
                            {can("users.edit") ? (
                              <button
                                type="button"
                                className="secondary-button admin-mini"
                                onClick={() => setEditing(user)}
                              >
                                Edit
                              </button>
                            ) : null}
                            {can("users.edit") && !user.isSelf && user.active ? (
                              <button
                                type="button"
                                className="secondary-button admin-mini"
                                disabled={busy === user.id}
                                onClick={() => void resetPassword(user)}
                                title="Issue a single-use link so they can set a new password"
                              >
                                Reset password
                              </button>
                            ) : null}
                            {can("users.deactivate") ? (
                              <button
                                type="button"
                                className="secondary-button admin-mini"
                                disabled={busy === user.id}
                                onClick={() =>
                                  void run(
                                    {
                                      userId: user.id,
                                      action: user.active ? "deactivate" : "reactivate",
                                    },
                                    user.id,
                                  )
                                }
                              >
                                {user.active ? "Deactivate" : "Reactivate"}
                              </button>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <AdminNotice
                tone="empty"
                icon="users"
                title={search ? "Nobody matches that search" : "This workspace has no members yet"}
              >
                {search
                  ? "Clear the search to see everybody."
                  : "Invite somebody to give them access. Nothing here is sample data."}
              </AdminNotice>
            )}
          </section>

          {issued ? <IssuedLink issued={issued} onDismiss={() => setIssued(null)} /> : null}

          <section className="panel admin-panel">
            <div className="panel-heading">
              <div>
                <span>Awaiting acceptance</span>
                <h2>Pending invitations</h2>
              </div>
            </div>
            {data.invitations.length ? (
              <div className="table-scroll">
                <table className="data-table admin-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role on acceptance</th>
                      <th>Invited by</th>
                      <th>Sent</th>
                      <th>Expires</th>
                      {can("users.invite") ? <th aria-label="Actions" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data.invitations.map((invitation) => (
                      <tr key={invitation.id}>
                        <td>{invitation.email}</td>
                        <td>
                          <span className={`admin-role-chip admin-role-chip--${invitation.role}`}>
                            {invitation.role}
                          </span>
                        </td>
                        <td>{invitation.invitedBy ?? "—"}</td>
                        <td>{relativeTime(invitation.createdAt)}</td>
                        <td>
                          {invitation.expired ? (
                            <span className="admin-status-chip admin-status-chip--expired">
                              Expired {relativeTime(invitation.expiresAt)}
                            </span>
                          ) : (
                            relativeTime(invitation.expiresAt)
                          )}
                        </td>
                        {can("users.invite") ? (
                          <td>
                            <span className="admin-actions">
                            <button
                              type="button"
                              className="secondary-button admin-mini"
                              disabled={busy === invitation.id}
                              onClick={() => reissue(invitation)}
                            >
                              {invitation.expired ? "Send a new link" : "Get the link again"}
                            </button>
                            <button
                              type="button"
                              className="secondary-button admin-mini admin-mini--danger"
                              disabled={busy === invitation.id}
                              onClick={() => revoke(invitation)}
                            >
                              Withdraw
                            </button>
                            </span>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <AdminNotice tone="empty" icon="inbox" title="No invitations are outstanding">
                Invitations appear here between being sent and being accepted.
              </AdminNotice>
            )}
          </section>
        </>
      ) : null}

      {editing ? (
        <ProfileDialog
          user={editing}
          organisationId={data?.organisation.id ?? ""}
          onClose={() => setEditing(null)}
          onSaved={async (result) => {
            setFlash(result);
            setEditing(null);
            if (result.ok) await reload();
          }}
        />
      ) : null}

      {inviting && data ? (
        <InviteDialog
          roles={data.roles}
          organisationId={data.organisation.id}
          onClose={() => setInviting(false)}
          onSent={async (result, link) => {
            setFlash(result);
            if (result.ok) {
              if (link) setIssued({ ...link, kind: "invitation" });
              setInviting(false);
              await reload();
            }
          }}
        />
      ) : null}
    </div>
  );
}

function AdminDialog({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="admin-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{subtitle}</span>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={17} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function ProfileDialog({
  user,
  organisationId,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  organisationId: string;
  onClose: () => void;
  onSaved: (result: { ok: boolean; message: string }) => void | Promise<void>;
}) {
  const [fullName, setFullName] = useState(user.fullName ?? "");
  const [jobTitle, setJobTitle] = useState(user.jobTitle ?? "");
  const [phone, setPhone] = useState(user.phone ?? "");
  const [timezone, setTimezone] = useState(user.timezone ?? "Europe/London");
  const [saving, setSaving] = useState(false);

  return (
    <AdminDialog title={user.fullName ?? user.email} subtitle="Edit profile" onClose={onClose}>
      <form
        className="admin-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          const result = await adminWrite("/api/admin/users", "PATCH", {
            organisationId,
            userId: user.id,
            action: "profile",
            fullName,
            jobTitle,
            phone,
            timezone,
          });
          setSaving(false);
          await onSaved(result);
        }}
      >
        <label className="admin-field">
          <span>Full name</span>
          <input value={fullName} onChange={(event) => setFullName(event.target.value)} />
        </label>
        <label className="admin-field">
          <span>Email</span>
          {/* Read-only on purpose: the email is the key every membership lookup
              joins on, so changing it here would silently move somebody's
              access. It belongs to account recovery, not to an admin form. */}
          <input value={user.email} readOnly aria-describedby="admin-email-note" />
          <small id="admin-email-note">
            The email is this person&rsquo;s identity and cannot be changed here.
          </small>
        </label>
        <label className="admin-field">
          <span>Job title</span>
          <input value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} />
        </label>
        <label className="admin-field">
          <span>Phone</span>
          <input value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>
        <label className="admin-field">
          <span>Timezone</span>
          <input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
        </label>
        <div className="admin-form__actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>
    </AdminDialog>
  );
}

/**
 * The invitation link, and the only chance to copy it.
 *
 * Stated plainly rather than dressed up as a sent email, because no email is
 * sent — this product has no mail server, and a screen that says "invitation
 * sent" while nothing leaves the building is the kind of lie that has somebody
 * waiting a week for a message that was never going to arrive.
 *
 * Not dismissed on a timer or by clicking elsewhere: losing this link means the
 * invitation cannot be accepted by anyone, and it cannot be fetched again.
 */
function IssuedLink({
  issued,
  onDismiss,
}: {
  issued: { email: string; url: string; kind: "invitation" | "reset" };
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const reset = issued.kind === "reset";

  return (
    <section className="panel admin-panel admin-invite-link">
      <div className="panel-heading">
        <div>
          <span>Send this to {issued.email}</span>
          <h2>{reset ? "Their password reset link" : "Their invitation link"}</h2>
        </div>
        <button type="button" className="secondary-button admin-mini" onClick={onDismiss}>
          Done
        </button>
      </div>
      <p className="admin-invite-link__note">
        {reset
          ? "Shown once, and it expires in 24 hours. Give it to them directly — it opens their account, so treat it like a password. Using it signs out every device they are signed in on."
          : "Shown once. Only a hash of it is stored, so it cannot be looked up again — if it is lost, use “Send a new link” to issue a replacement, which retires this one."}
      </p>
      <div className="admin-invite-link__row">
        <input
          className="admin-invite-link__field"
          readOnly
          value={issued.url}
          aria-label="Invitation link"
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="primary-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(issued.url);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2_000);
            } catch {
              // Clipboard access can be refused — over plain http, or by
              // policy. The field is selectable, so say so rather than
              // reporting a copy that did not happen.
              setCopied(false);
              window.alert("Copying was blocked. Select the link and copy it manually.");
            }
          }}
        >
          <Icon name={copied ? "check" : "document"} size={16} />
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
    </section>
  );
}

function InviteDialog({
  roles,
  organisationId,
  onClose,
  onSent,
}: {
  roles: Array<{ key: string; label: string; assignable: boolean }>;
  organisationId: string;
  onClose: () => void;
  onSent: (
    result: { ok: boolean; message: string },
    link: { email: string; url: string } | null,
  ) => void | Promise<void>;
}) {
  const assignable = roles.filter((role) => role.assignable);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(assignable[0]?.key ?? "client");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  return (
    <AdminDialog title="Invite somebody" subtitle="People &amp; access" onClose={onClose}>
      <form
        className="admin-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setSending(true);
          const result = await adminWrite("/api/admin/users", "POST", {
            organisationId,
            email,
            role,
            message,
          });
          setSending(false);
          const url = result.payload?.inviteUrl;
          await onSent(
            result.ok
              ? { ok: true, message: `${email} has been invited. Send them the link below.` }
              : result,
            result.ok && typeof url === "string" ? { email, url } : null,
          );
        }}
      >
        <label className="admin-field">
          <span>Email address</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@company.com"
          />
        </label>
        <label className="admin-field">
          <span>Role on acceptance</span>
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            {assignable.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
          <small>
            You can only invite at or below your own role. The role is written onto the
            invitation, so accepting it cannot grant anything more.
          </small>
        </label>
        <label className="admin-field">
          <span>Message (optional)</span>
          <textarea
            rows={3}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        <div className="admin-form__actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={sending}>
            {sending ? "Creating…" : "Create invitation"}
          </button>
        </div>
      </form>
    </AdminDialog>
  );
}
