"use client";

/**
 * The capability matrix: what each role in this workspace may do.
 *
 * Three things the screen has to keep visible at once, because collapsing them
 * is how a permission editor becomes dangerous:
 *
 *   1. What is enforced now (the tick).
 *   2. Whether that is the shipped default or something this workspace changed
 *      (the "changed" marker and the per-cell Reset).
 *   3. Which cells cannot be changed, and why (a disabled box with the server's
 *      own reason attached).
 *
 * Reset writes `null`, which deletes the `role_capabilities` row rather than
 * storing the default's value. That keeps the table a diff, so a later change to
 * a shipped default still reaches every workspace that never disagreed with it.
 *
 * Changes are staged locally and sent as one batch. The server validates the
 * whole batch before writing any of it, so a refusal leaves the matrix exactly
 * as it was rather than half-applied.
 */

import { Fragment, useMemo, useState } from "react";
import { Icon } from "../../../components";
import {
  AdminFlash,
  AdminLoading,
  AdminNotice,
  adminWrite,
  useAdminResource,
} from "./admin-shell";

type CapabilityDefinition = {
  key: string;
  label: string;
  group: string;
  description: string;
  /** No route reads it yet — see `CAPABILITY_CATALOGUE`. */
  unenforced?: boolean;
};

type RolesPayload = {
  organisation: { id: string; name: string; slug: string; planTier: string };
  organisations: Array<{ id: string; name: string; slug: string }>;
  actor: { email: string; role: string; roleLabel: string };
  capabilities: CapabilityDefinition[];
  roles: Array<{ key: string; label: string; editable: boolean; lockedReason: string | null }>;
  defaults: Record<string, Record<string, boolean>>;
  overrides: Record<string, Record<string, boolean>>;
  effective: Record<string, Record<string, boolean>>;
  lockedCells: Array<{ role: string; capability: string; reason: string | null }>;
};

type Pending = Record<string, boolean | null>;

const cellKey = (role: string, capability: string) => `${role}|${capability}`;

export function AdminRolesView() {
  const [organisationId, setOrganisationId] = useState<string | null>(null);
  const url = organisationId
    ? `/api/admin/roles?organisationId=${encodeURIComponent(organisationId)}`
    : "/api/admin/roles";
  const { data, loading, denied, error, reload } = useAdminResource<RolesPayload>(url);

  const [pending, setPending] = useState<Pending>({});
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const lockedReasons = useMemo(() => {
    const map = new Map<string, string>();
    for (const cell of data?.lockedCells ?? []) {
      if (cell.reason) map.set(cellKey(cell.role, cell.capability), cell.reason);
    }
    return map;
  }, [data]);

  const grouped = useMemo(() => {
    const groups: Array<{ name: string; items: CapabilityDefinition[] }> = [];
    for (const capability of data?.capabilities ?? []) {
      const existing = groups.find((group) => group.name === capability.group);
      if (existing) existing.items.push(capability);
      else groups.push({ name: capability.group, items: [capability] });
    }
    return groups;
  }, [data]);

  if (loading && !data) return <Shell><AdminLoading label="Loading the permission matrix…" /></Shell>;

  if (denied) {
    return (
      <Shell>
        <AdminNotice tone="denied" icon="shield" title="You do not have access to this screen">
          {denied} The server refused this request — this is not a hidden button.
        </AdminNotice>
      </Shell>
    );
  }

  if (error || !data) {
    return (
      <Shell>
        <AdminNotice tone="error" icon="alert" title="The matrix could not be loaded">
          {error ?? "That could not be loaded."}
        </AdminNotice>
      </Shell>
    );
  }

  /** What the cell would enforce once the staged changes are saved. */
  const valueOf = (role: string, capability: string) => {
    const key = cellKey(role, capability);
    if (key in pending) {
      const staged = pending[key];
      return staged === null ? data.defaults[role][capability] : staged;
    }
    return data.effective[role][capability];
  };

  /** True when the cell says something other than the shipped default. */
  const isChanged = (role: string, capability: string) => {
    const key = cellKey(role, capability);
    if (key in pending) {
      return pending[key] !== null && pending[key] !== data.defaults[role][capability];
    }
    return capability in (data.overrides[role] ?? {});
  };

  const stagedCount = Object.keys(pending).length;

  const stage = (role: string, capability: string, allowed: boolean | null) => {
    setPending((current) => {
      const next = { ...current };
      const key = cellKey(role, capability);
      const storedOverride = data.overrides[role]?.[capability];
      const wouldMatchStored =
        allowed === null ? storedOverride === undefined : storedOverride === allowed;
      // Staging a value that already matches what is stored is not a change, so
      // it is dropped rather than sent — otherwise "Save (3)" would count cells
      // that had been toggled back and forth.
      if (wouldMatchStored) delete next[key];
      else next[key] = allowed;
      return next;
    });
  };

  async function save() {
    setSaving(true);
    const changes = Object.entries(pending).map(([key, allowed]) => {
      const [role, capability] = key.split("|");
      return { role, capability, allowed };
    });
    const result = await adminWrite("/api/admin/roles", "PUT", {
      organisationId: data?.organisation.id,
      changes,
    });
    setSaving(false);
    setFlash(result);
    if (result.ok) {
      setPending({});
      await reload();
    }
  }

  return (
    <Shell>
      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />

      <div className="admin-toolbar">
        {data.organisations.length > 1 ? (
          <label className="admin-field admin-field--inline">
            <span>Workspace</span>
            <select
              value={data.organisation.id}
              onChange={(event) => {
                setPending({});
                setOrganisationId(event.target.value);
              }}
            >
              {data.organisations.map((organisation) => (
                <option key={organisation.id} value={organisation.id}>
                  {organisation.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="admin-toolbar__spacer" />
        <button
          type="button"
          className="secondary-button"
          disabled={!stagedCount || saving}
          onClick={() => setPending({})}
        >
          Discard
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!stagedCount || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : stagedCount ? `Save ${stagedCount} change${stagedCount === 1 ? "" : "s"}` : "Save"}
        </button>
      </div>

      <AdminNotice tone="info" icon="shield" title="How this table is applied">
        A permission with no entry here falls back to the built-in default for that
        role, so an empty table is a working system rather than a locked-out one.
        Every tick is enforced on the server: removing one takes the ability away
        from the API, not just from the buttons.
      </AdminNotice>

      <section className="panel admin-panel">
        <div className="panel-heading">
          <div>
            <span>{data.organisation.name}</span>
            <h2>Capability matrix</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table admin-matrix">
            <thead>
              <tr>
                <th>Permission</th>
                {data.roles.map((role) => (
                  <th key={role.key} className="admin-matrix__role">
                    <span>{role.label}</span>
                    {role.lockedReason ? (
                      <small title={role.lockedReason}>
                        <Icon name="shield" size={13} /> locked
                      </small>
                    ) : (
                      <small>{role.key === data.actor.role ? "your role" : " "}</small>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map((group) => (
                <Fragment key={group.name}>
                  <tr className="admin-matrix__group">
                    <th colSpan={data.roles.length + 1} scope="colgroup">
                      {group.name}
                    </th>
                  </tr>
                  {group.items.map((capability) => (
                    <tr key={capability.key}>
                      <td>
                        <span className="admin-capability">
                          <strong>
                            {capability.label}
                            {/* A switch that decides nothing says so on the
                                row. Turning it off and believing an ability
                                had been withdrawn is worse than the gap. */}
                            {capability.unenforced ? (
                              <span className="admin-capability__pending">
                                Not enforced yet
                              </span>
                            ) : null}
                          </strong>
                          <small>{capability.description}</small>
                          <code>{capability.key}</code>
                        </span>
                      </td>
                      {data.roles.map((role) => {
                        const locked = lockedReasons.get(cellKey(role.key, capability.key));
                        const value = valueOf(role.key, capability.key);
                        const changed = isChanged(role.key, capability.key);
                        return (
                          <td key={role.key} className="admin-matrix__cell">
                            <label
                              className={`admin-toggle${changed ? " admin-toggle--changed" : ""}${
                                locked ? " admin-toggle--locked" : ""
                              }`}
                              title={locked ?? undefined}
                            >
                              <input
                                type="checkbox"
                                checked={value}
                                disabled={Boolean(locked)}
                                onChange={(event) =>
                                  stage(role.key, capability.key, event.target.checked)
                                }
                                aria-label={`${capability.label} for ${role.label}`}
                              />
                              <span aria-hidden="true">
                                {value ? <Icon name="check" size={14} /> : null}
                              </span>
                            </label>
                            {changed && !locked ? (
                              <button
                                type="button"
                                className="admin-reset"
                                onClick={() => stage(role.key, capability.key, null)}
                                title={`Reset to the built-in default (${
                                  data.defaults[role.key][capability.key] ? "allowed" : "denied"
                                })`}
                              >
                                reset
                              </button>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="section-stack admin-console">
      <section className="section-header">
        <div>
          <span className="eyebrow-chip">
            <Icon name="shield" size={15} />
            Roles &amp; permissions
          </span>
          <h1>Permissions</h1>
          <p>
            What each role in this workspace is allowed to do. Changes are stored per
            workspace and take effect on the next request — including for people who
            are already signed in.
          </p>
        </div>
      </section>
      {children}
    </div>
  );
}
