"use client";

/**
 * The client-company pieces of People & access.
 *
 * A workspace belongs to a client company, and three things on the People
 * screen are about the company rather than the one workspace:
 *
 *   - `WorkspacePicker` — which of the company's workspaces an invitation
 *     grants. Only the workspaces where the caller may give the chosen role
 *     are listed; a workspace they cannot grant is not offered at all.
 *   - `WorkspaceAccessDialog` — give somebody a role in another workspace of
 *     the same company, or take one away. Nothing is inherited downwards: an
 *     Admin of one branch reaches another only once this is done.
 *   - `CompanyWorkspacesPanel` — the company's workspaces, and for a Platform
 *     Super Admin or the company's Owner, adding one.
 *
 * All three are renderers. `/api/admin/users` and `/api/admin/companies`
 * decide every one of these changes on their own, and refuse what the screen
 * would not have offered.
 */

import { useState } from "react";
import { Icon } from "../../../components";
import { adminWrite } from "./admin-shell";
import { useDialogBehaviour } from "../overlay/dialog-behaviour";

export type CompanyWorkspace = {
  id: string;
  name: string;
  isCurrent: boolean;
  isDefault?: boolean;
  /** The workspace roles the caller may invite somebody as, here. */
  inviteRoles: string[];
  /** The workspace roles the caller may give an existing person, here. */
  accessRoles: string[];
};

export type CompanyRef = {
  id: string;
  name: string;
  owned: boolean;
  /** MAINTSUPP's own demonstration company. */
  internal?: boolean;
  defaultOrganisationId?: string | null;
} | null;

type Flash = { ok: boolean; message: string };

const ROLE_NAMES: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  client: "Client",
};

/** Checkboxes for the company workspaces an invitation will grant. */
export function WorkspacePicker({
  workspaces,
  role,
  selected,
  onChange,
}: {
  workspaces: CompanyWorkspace[];
  role: string;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const grantable = workspaces.filter((workspace) => workspace.inviteRoles.includes(role));
  if (!grantable.length) {
    return (
      <p className="admin-company-note">
        There is no workspace here where you can invite somebody as {ROLE_NAMES[role] ?? role}.
      </p>
    );
  }
  return (
    <fieldset className="admin-workspace-picker">
      <legend>Workspaces</legend>
      {grantable.map((workspace) => (
        <label key={workspace.id} className="admin-check">
          <input
            type="checkbox"
            checked={selected.includes(workspace.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, workspace.id]
                  : selected.filter((id) => id !== workspace.id),
              )
            }
          />
          <span>
            {workspace.name}
            {workspace.isCurrent ? <em className="admin-you">this one</em> : null}
          </span>
        </label>
      ))}
      <small>
        They will reach exactly the workspaces ticked here, and no others of the company.
      </small>
    </fieldset>
  );
}

type AccessUser = {
  id: string;
  email: string;
  fullName: string | null;
  memberships: Array<{ organisationId: string; role: string; roleLabel: string; status: string }>;
};

/** Give or remove access to the company's other workspaces, one at a time. */
export function WorkspaceAccessDialog({
  user,
  company,
  workspaces,
  organisationId,
  onClose,
  onChanged,
}: {
  user: AccessUser;
  company: NonNullable<CompanyRef>;
  workspaces: CompanyWorkspace[];
  organisationId: string;
  onClose: () => void;
  onChanged: (result: Flash) => void | Promise<void>;
}) {
  /* What `aria-modal` promises — Escape, focus in and back, the Tab trap, the
     scroll lock — from the one shared implementation. See `dialog-behaviour.ts`. */
  const { surface, onKeyDown } = useDialogBehaviour(true, onClose);
  const [busy, setBusy] = useState<string | null>(null);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const held = new Map(
    user.memberships
      .filter((membership) => membership.status !== "removed")
      .map((membership) => [membership.organisationId, membership]),
  );

  async function change(workspace: CompanyWorkspace, access: "grant" | "remove", role?: string) {
    setBusy(workspace.id);
    const result = await adminWrite("/api/admin/users", "PATCH", {
      organisationId,
      userId: user.id,
      action: "workspace_access",
      workspaceId: workspace.id,
      access,
      role,
    });
    setBusy(null);
    await onChanged(
      result.ok
        ? {
            ok: true,
            message:
              access === "grant"
                ? `${user.email} can now open ${workspace.name}.`
                : `${user.email} no longer has access to ${workspace.name}.`,
          }
        : result,
    );
  }

  return (
    <div className="admin-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={surface}
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Workspace access for ${user.fullName ?? user.email}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{company.name}</span>
            <h2>Workspace access</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="admin-form">
          <p className="admin-company-note">
            {user.fullName ?? user.email} reaches only the workspaces listed with a role. Access to
            one workspace never grants another.
          </p>
          <ul className="admin-access-list">
            {workspaces.map((workspace) => {
              const membership = held.get(workspace.id);
              const choices = workspace.accessRoles;
              const chosen = roles[workspace.id] ?? choices[0] ?? "";
              return (
                <li key={workspace.id}>
                  <span className="admin-access-list__name">
                    <strong>{workspace.name}</strong>
                    <small>
                      {membership ? `Has access as ${membership.roleLabel}` : "No access"}
                    </small>
                  </span>
                  {membership ? (
                    choices.includes(membership.role) ? (
                      <button
                        type="button"
                        className="secondary-button admin-mini admin-mini--danger"
                        disabled={busy === workspace.id}
                        onClick={() => void change(workspace, "remove")}
                      >
                        Remove access
                      </button>
                    ) : null
                  ) : choices.length ? (
                    <span className="admin-access-list__grant">
                      <select
                        aria-label={`Role in ${workspace.name}`}
                        value={chosen}
                        onChange={(event) =>
                          setRoles((current) => ({ ...current, [workspace.id]: event.target.value }))
                        }
                      >
                        {choices.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_NAMES[role] ?? role}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="primary-button admin-mini"
                        disabled={busy === workspace.id || !chosen}
                        onClick={() => void change(workspace, "grant", chosen)}
                      >
                        Give access
                      </button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="admin-form__actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The company's workspaces, and adding one when the caller may. */
export function CompanyWorkspacesPanel({
  company,
  workspaces,
  canAdd,
  canRename,
  onFlash,
  onAdded,
}: {
  company: NonNullable<CompanyRef>;
  workspaces: CompanyWorkspace[];
  canAdd: boolean;
  /** A Platform Super Admin, or an Owner of this company. */
  canRename: boolean;
  onFlash: (flash: Flash) => void;
  onAdded: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [renaming, setRenaming] = useState(false);

  return (
    <section className="panel admin-panel">
      <div className="panel-heading">
        <div>
          <span>{company.name}</span>
          <h2>Company workspaces</h2>
        </div>
      </div>
      <p className="admin-company-note">
        {company.owned
          ? "As an Owner you reach every workspace of this company, including new ones. Everybody else reaches only the workspaces they are given."
          : "People reach only the workspaces they are given. The company's Owners reach all of them."}
      </p>
      <ul className="admin-company-workspaces">
        {workspaces.map((workspace) => (
          <li key={workspace.id} className={workspace.isCurrent ? "is-current" : ""}>
            <Icon name="building" size={15} />
            <span>{workspace.name}</span>
            {workspace.isDefault ? <em className="admin-chip">Default</em> : null}
            {workspace.isCurrent ? <em className="admin-chip admin-chip--current">Viewing</em> : null}
          </li>
        ))}
      </ul>
      {canRename ? (
        <form
          className="admin-company-add"
          onSubmit={async (event) => {
            event.preventDefault();
            const next = companyName.trim();
            if (renaming || !next || next === company.name) return;
            setRenaming(true);
            const result = await adminWrite("/api/admin/companies", "POST", {
              action: "rename_company",
              clientCompanyId: company.id,
              name: next,
            });
            setRenaming(false);
            onFlash(result.ok ? { ok: true, message: `The company is now called ${next}.` } : result);
            if (result.ok) {
              setCompanyName("");
              await onAdded();
            }
          }}
        >
          <label className="admin-field admin-field--grow">
            <span>Company name</span>
            <input
              value={companyName}
              maxLength={120}
              placeholder={company.name}
              onChange={(event) => setCompanyName(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="secondary-button"
            disabled={renaming || !companyName.trim()}
          >
            {renaming ? "Renaming…" : "Rename company"}
          </button>
        </form>
      ) : null}
      {canAdd ? (
        <form
          className="admin-company-add"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving || !name.trim()) return;
            setSaving(true);
            const result = await adminWrite("/api/admin/companies", "POST", {
              action: "create_workspace",
              clientCompanyId: company.id,
              name: name.trim(),
            });
            setSaving(false);
            onFlash(
              result.ok
                ? {
                    ok: true,
                    message: `${name.trim()} was added to ${company.name}. Nobody else can open it until you give them access.`,
                  }
                : result,
            );
            if (result.ok) {
              setName("");
              await onAdded();
            }
          }}
        >
          <label className="admin-field admin-field--grow">
            <span>New workspace</span>
            <input
              value={name}
              maxLength={120}
              placeholder="Branch or site name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button type="submit" className="secondary-button" disabled={saving || !name.trim()}>
            <Icon name="plus" size={16} />
            {saving ? "Adding…" : "Add workspace"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
