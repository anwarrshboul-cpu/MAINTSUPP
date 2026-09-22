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
 *
 * SCOPE-AWARE. The roster is one workspace's members plus its client company's
 * Owners. Invitations grant a company (Owner, from a Super Admin) or chosen
 * workspaces of one company (everybody else), and the access dialog adds or
 * removes a workspace at a time — each offered only where the server says the
 * caller may (`companyWorkspaces[].inviteRoles` / `accessRoles`).
 */

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import { useDialogBehaviour } from "../overlay/dialog-behaviour";
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
import {
  CompanyWorkspacesPanel,
  WorkspaceAccessDialog,
  WorkspacePicker,
  type CompanyRef,
  type CompanyWorkspace,
} from "./admin-company";

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
  /** The server's answer to "does the caller outrank-or-equal this person". */
  manageable?: boolean;
  /** An Owner of this workspace's client company: every workspace of it. */
  companyOwner?: boolean;
  /** The company's only active Owner, who cannot be removed or switched off. */
  soleOwner?: boolean;
  platformAdmin?: boolean;
};

type Invitation = {
  id: string;
  email: string;
  role: string;
  roleLabel?: string;
  /** The inviter's name or email — never their internal id. */
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
  /** Past its expiry, so the link in that inbox no longer opens anything. */
  expired?: boolean;
  /** An Owner invitation: the whole company rather than listed workspaces. */
  companyWide?: boolean;
  workspaces?: Array<{ id: string; name: string }>;
  /** Whether the caller may resend or withdraw it — the power to issue it. */
  manageable?: boolean;
};

type UsersPayload = {
  organisation: { id: string; name: string; slug: string; planTier: string };
  organisations: Array<{ id: string; name: string; slug: string; companyName?: string | null }>;
  company?: CompanyRef;
  companyWorkspaces?: CompanyWorkspace[];
  actor: AdminActor & { platformAdmin?: boolean; ownsCompany?: boolean };
  roles: Array<{ key: string; label: string; assignable: boolean }>;
  users: AdminUser[];
  invitations: Invitation[];
};

type Flash = { ok: boolean; message: string } | null;

/** What `/api/auth/invitations` says happened to the email. */
export type Delivery = {
  status: "sent" | "sink" | "failed" | "skipped" | "suppressed" | "disabled";
  message: string;
};

export function deliveryOf(payload: Record<string, unknown> | null | undefined): Delivery | null {
  const delivery = payload?.delivery as Delivery | undefined;
  return delivery && typeof delivery.message === "string" ? delivery : null;
}

export function AdminUsersView() {
  const [organisationId, setOrganisationId] = useState<string | null>(null);
  const url = organisationId
    ? `/api/admin/users?organisationId=${encodeURIComponent(organisationId)}`
    : "/api/admin/users";
  const { data, loading, denied, error, reload } = useAdminResource<UsersPayload>(url);

  const [flash, setFlash] = useState<Flash>(null);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [inviting, setInviting] = useState(false);
  const [granting, setGranting] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /*
   * The link, held until the admin has dismissed it.
   *
   * Invitation emails from admin@maintsupp.com exist in the code but are
   * switched off until real delivery is set up (`INVITATION_EMAIL_MODE`) — and
   * even when they are on, the link exists
   * exactly once either way: the row stores only its hash, so nothing can hand
   * it back afterwards. So the link is still shown, with the server's own
   * sentence about whether an email actually left, and it stays on screen until
   * dismissed rather than vanishing with the dialog.
   */
  const [issued, setIssued] = useState<{
    email: string;
    url: string;
    kind: "invitation" | "reset";
    delivery?: Delivery | null;
  } | null>(null);
  const [search, setSearch] = useState("");

  const can = (capability: string) => Boolean(data?.actor.capabilities?.[capability]);
  const assignable = useMemo(
    () => (data?.roles ?? []).filter((role) => role.assignable),
    [data],
  );
  /* A membership's role is changed only between the three workspace roles. */
  const workspaceRoles = assignable.filter(
    (role) => role.key !== "owner" && role.key !== "super_admin",
  );
  const companyWorkspaces = data?.companyWorkspaces ?? [];
  const canGrantAccess = companyWorkspaces.some(
    (workspace) => !workspace.isCurrent && workspace.accessRoles.length > 0,
  );
  const organisationGroups = useMemo(() => {
    const groups = new Map<string, UsersPayload["organisations"]>();
    for (const organisation of data?.organisations ?? []) {
      const key = organisation.companyName ?? "";
      groups.set(key, [...(groups.get(key) ?? []), organisation]);
    }
    const entries = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
    // Grouped only when a company has several workspaces; otherwise flat.
    return entries.some(([, list]) => list.length > 1) ? entries : [];
  }, [data]);

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
      admins: users.filter((user) => ["admin", "owner", "super_admin"].includes(user.role))
        .length,
      // Expired invitations are listed, but they are not waiting for anybody.
      pending: (data?.invitations ?? []).filter((invitation) => !invitation.expired).length,
    };
  }, [data]);

  /**
   * Resend an invitation — explicitly, by naming it.
   *
   * Only the invitation's id is sent: the address, the role and the message
   * are read back from the stored row, so a resend repeats the invitation and
   * cannot change it. `createInvitation` revokes the outstanding link before
   * writing the new one, so this cannot leave two live links to the same
   * workspace — the old one stops working the moment the new one is issued.
   */
  async function reissue(invitation: Invitation) {
    setBusy(invitation.id);
    const result = await adminWrite("/api/admin/users", "POST", {
      organisationId: data?.organisation.id,
      invitationId: invitation.id,
    });
    setBusy(null);
    const url = result.payload?.inviteUrl;
    if (result.ok && typeof url === "string") {
      const delivery = deliveryOf(result.payload);
      setIssued({ email: invitation.email, url, kind: "invitation", delivery });
      setFlash({
        ok: true,
        message: `A new invitation for ${invitation.email}; the previous link no longer works. ${delivery?.message ?? ""}`.trim(),
      });
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
            Everyone who can open this workspace — its members, and the Owners of its
            client company — with the role each holds here and the other workspaces of
            yours they belong to. Deactivating somebody suspends their access without
            deleting them or their history.
          </p>
        </div>
        {can("users.invite") && assignable.length > 0 && !data?.company?.internal ? (
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
                  {organisationGroups.length > 1
                    ? organisationGroups.map(([company, organisations]) => (
                        <optgroup key={company || "none"} label={company || "Other workspaces"}>
                          {organisations.map((organisation) => (
                            <option key={organisation.id} value={organisation.id}>
                              {organisation.name}
                            </option>
                          ))}
                        </optgroup>
                      ))
                    : data.organisations.map((organisation) => (
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
              <small>Owners &amp; admins</small>
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
                <span>
                  {data.company && data.company.name !== data.organisation.name
                    ? `${data.company.name} · ${data.organisation.name}`
                    : data.organisation.name}
                </span>
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
                      <th>Actions</th>
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
                          {/*
                            A picker only where a change could be accepted: the
                            caller may edit people, this is not them, the person
                            does not outrank them, and their current role is one
                            the caller could grant. The options are ONLY the
                            assignable roles — a role the caller cannot grant is
                            not offered at all rather than shown disabled. The
                            API refuses every one of these cases on its own.
                          */}
                          {can("users.edit") &&
                          !user.isSelf &&
                          user.manageable !== false &&
                          !user.companyOwner &&
                          workspaceRoles.some((role) => role.key === user.role) ? (
                            <select
                              className="admin-role-select"
                              aria-label={`Role for ${user.fullName ?? user.email}`}
                              value={user.role}
                              disabled={busy === user.id}
                              onChange={(event) =>
                                void run(
                                  { userId: user.id, action: "role", role: event.target.value },
                                  user.id,
                                )
                              }
                            >
                              {workspaceRoles.map((role) => (
                                <option key={role.key} value={role.key}>
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
                            {user.companyOwner ? (
                              <span className="admin-chip admin-chip--current">
                                Every {data.company?.name ?? "company"} workspace
                              </span>
                            ) : null}
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
                            {canGrantAccess &&
                            data.company &&
                            !data.company.internal &&
                            user.manageable !== false &&
                            !user.isSelf &&
                            !user.companyOwner &&
                            !user.platformAdmin ? (
                              <button
                                type="button"
                                className="secondary-button admin-mini"
                                onClick={() => setGranting(user)}
                              >
                                Workspaces
                              </button>
                            ) : null}
                            {can("users.edit") && user.manageable !== false ? (
                              <button
                                type="button"
                                className="secondary-button admin-mini"
                                onClick={() => setEditing(user)}
                              >
                                Edit
                              </button>
                            ) : null}
                            {can("users.edit") &&
                            user.manageable !== false &&
                            !user.isSelf &&
                            user.active ? (
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
                            {can("users.deactivate") && user.manageable !== false ? (
                              <button
                                type="button"
                                className="secondary-button admin-mini"
                                /* The only Owner of a company stays switched on
                                   until another Owner is appointed; the server
                                   refuses it either way. */
                                title={
                                  user.soleOwner && user.active
                                    ? `The only Owner of ${data.company?.name ?? "this company"} cannot be deactivated. Appoint another Owner first.`
                                    : undefined
                                }
                                disabled={busy === user.id || Boolean(user.soleOwner && user.active)}
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

          {data.company?.internal ? (
            <AdminNotice tone="empty" icon="shield" title="MAINTSUPP internal workspace">
              This workspace belongs to MAINTSUPP&rsquo;s own demonstration company. Only Platform
              Super Admins work in it, so nobody is invited or given access here.
            </AdminNotice>
          ) : null}

          {data.company && (data.actor.platformAdmin || data.company.owned) ? (
            <CompanyWorkspacesPanel
              company={data.company}
              workspaces={companyWorkspaces}
              canAdd
              canRename
              onFlash={setFlash}
              onAdded={reload}
            />
          ) : null}

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
                      <th>Grants</th>
                      <th>Invited by</th>
                      <th>Sent</th>
                      <th>Expires</th>
                      {can("users.invite") ? <th>Actions</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {data.invitations.map((invitation) => (
                      <tr key={invitation.id}>
                        <td>{invitation.email}</td>
                        <td>
                          <span className={`admin-role-chip admin-role-chip--${invitation.role}`}>
                            {invitation.roleLabel ?? invitation.role}
                          </span>
                        </td>
                        <td>
                          <span className="admin-workspaces">
                            {invitation.companyWide ? (
                              <span className="admin-chip">
                                Every {data.company?.name ?? "company"} workspace
                              </span>
                            ) : (
                              (invitation.workspaces ?? []).map((workspace) => (
                                <span key={workspace.id} className="admin-chip">
                                  {workspace.name}
                                </span>
                              ))
                            )}
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
                            {/* Only for an invitation the caller could have
                                issued — in every workspace it grants: the API
                                refuses resending or withdrawing any other. */}
                            {invitation.manageable ?? assignable.some((role) => role.key === invitation.role) ? (
                            <span className="admin-actions">
                            <button
                              type="button"
                              className="secondary-button admin-mini"
                              disabled={busy === invitation.id}
                              onClick={() => reissue(invitation)}
                            >
                              {invitation.expired ? "Send a new invitation" : "Resend invitation"}
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
                            ) : null}
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

      {granting && data?.company ? (
        <WorkspaceAccessDialog
          user={granting}
          company={data.company}
          workspaces={companyWorkspaces}
          organisationId={data.organisation.id}
          onClose={() => setGranting(null)}
          onChanged={async (result) => {
            setFlash(result);
            if (result.ok) {
              await reload();
              setGranting(null);
            }
          }}
        />
      ) : null}

      {inviting && data ? (
        <InviteDialog
          roles={data.roles}
          company={data.company ?? null}
          workspaces={companyWorkspaces}
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
  /* What `aria-modal` promises — Escape, focus in and back, the Tab trap, the
     scroll lock — from the one shared implementation. See `dialog-behaviour.ts`. */
  const { surface, onKeyDown } = useDialogBehaviour(true, onClose);
  return (
    <div className="admin-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={surface}
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
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
 * Invitations are emailed now — but only where the deployment has email
 * configured and switched on, and only if the provider accepted the message.
 * So this panel repeats the SERVER's sentence about what happened rather than
 * assuming: a screen that says "invitation sent" while nothing left the
 * building is the kind of lie that has somebody waiting a week for a message
 * that was never going to arrive.
 *
 * Not dismissed on a timer or by clicking elsewhere: losing this link means the
 * invitation cannot be accepted by anyone, and it cannot be fetched again.
 */
export function IssuedLink({
  issued,
  onDismiss,
}: {
  issued: { email: string; url: string; kind: "invitation" | "reset"; delivery?: Delivery | null };
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const reset = issued.kind === "reset";
  const emailed = issued.delivery?.status === "sent";

  return (
    <section className="panel admin-panel admin-invite-link">
      <div className="panel-heading">
        <div>
          <span>{emailed ? `Emailed to ${issued.email}` : `Send this to ${issued.email}`}</span>
          <h2>{reset ? "Their password reset link" : "Their invitation link"}</h2>
        </div>
        <button type="button" className="secondary-button admin-mini" onClick={onDismiss}>
          Done
        </button>
      </div>
      <p className="admin-invite-link__note">
        {reset
          ? "Shown once, and it expires in 24 hours. Give it to them directly — it opens their account, so treat it like a password. Using it signs out every device they are signed in on."
          : `${issued.delivery?.message ?? "No email was sent — share this link with them directly."} Shown once. Only a hash of it is stored, so it cannot be looked up again — if it is lost, use “Resend invitation”, which retires this one.`}
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
  company,
  workspaces,
  organisationId,
  onClose,
  onSent,
}: {
  roles: Array<{ key: string; label: string; assignable: boolean }>;
  company: CompanyRef;
  workspaces: CompanyWorkspace[];
  organisationId: string;
  onClose: () => void;
  onSent: (
    result: { ok: boolean; message: string },
    link: { email: string; url: string; delivery: Delivery | null } | null,
  ) => void | Promise<void>;
}) {
  /*
   * THE RELATIONSHIP comes first: Owner of the company, or a role in chosen
   * workspaces of it. Only relationships the caller may grant are listed — an
   * Owner only for a Super Admin — and for a workspace role, only the
   * workspaces where they may grant it. The invitee chooses none of this.
   */
  const assignable = roles.filter(
    (role) =>
      role.assignable &&
      role.key !== "super_admin" &&
      (role.key === "owner"
        ? Boolean(company)
        : !workspaces.length || workspaces.some((workspace) => workspace.inviteRoles.includes(role.key))),
  );
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(
    assignable.find((item) => item.key === "client")?.key ?? assignable[0]?.key ?? "client",
  );
  const [selected, setSelected] = useState<string[]>([organisationId]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const owner = role === "owner";
  const grantable = workspaces.filter((workspace) => workspace.inviteRoles.includes(role));
  const chosen = workspaces.length
    ? selected.filter((id) => grantable.some((workspace) => workspace.id === id))
    : [organisationId];

  return (
    <AdminDialog title="Invite somebody" subtitle="People &amp; access" onClose={onClose}>
      <form
        className="admin-form"
        onSubmit={async (event) => {
          event.preventDefault();
          // One request per invitation: a second press while the first is in
          // flight is ignored here, and the server refuses a duplicate anyway.
          if (sending) return;
          if (!owner && !chosen.length) return;
          setSending(true);
          const result = await adminWrite("/api/admin/users", "POST", {
            organisationId,
            email,
            role,
            organisationIds: owner ? [] : chosen,
            clientCompanyId: company?.id,
            message,
          });
          setSending(false);
          const url = result.payload?.inviteUrl;
          const delivery = deliveryOf(result.payload);
          await onSent(
            result.ok
              ? {
                  ok: true,
                  message: `${email} has been invited. ${delivery?.message ?? "Send them the link below."}`,
                }
              : result,
            result.ok && typeof url === "string" ? { email, url, delivery } : null,
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
          <span>Relationship</span>
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            {assignable.map((item) => (
              <option key={item.key} value={item.key}>
                {item.key === "owner" ? `Owner of ${company?.name ?? "the company"}` : item.label}
              </option>
            ))}
          </select>
          <small>
            Only what you are allowed to grant is listed. It is written onto the
            invitation, so accepting it cannot grant anything more. You will get a link
            to share; invitation emails are not switched on yet.
          </small>
        </label>
        {owner ? (
          <p className="admin-company-note">
            An Owner of {company?.name ?? "this company"} reaches every one of its
            workspaces, including ones added later, and can invite Admins, Managers and
            Clients to them.
          </p>
        ) : workspaces.length ? (
          <WorkspacePicker
            workspaces={workspaces}
            role={role}
            selected={chosen}
            onChange={setSelected}
          />
        ) : null}
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
          <button
            type="submit"
            className="primary-button"
            disabled={sending || (!owner && !chosen.length)}
          >
            {sending ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </form>
    </AdminDialog>
  );
}
