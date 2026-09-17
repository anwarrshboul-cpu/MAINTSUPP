"use client";

/**
 * The owner's cross-client console.
 *
 * One screen answering "how is every client doing" without switching workspace
 * eight times. Each card is one tenant: how many people can sign in, how much
 * work is on its boards, how many sites it runs, what it is paying for, and when
 * anything last happened in it.
 *
 * Two properties this screen must not quietly break:
 *
 *   - It is gated on `clients.view_all`, and the gate is the API's. A client who
 *     types the URL gets the refusal panel below because `/api/admin/clients`
 *     answered 403 — the screen never had the data to hide.
 *
 *   - Nothing is invented. A workspace with no jobs shows 0 and a last activity
 *     of "Never", which is the truth about a tenant nobody has used yet. The
 *     second tenant in this database is exactly that, and it should look like
 *     it.
 *
 * "Open workspace" posts to `/api/context`, the same endpoint the sidebar's
 * client switcher uses — which refuses an organisation the actor is not a member
 * of. Switching tenant therefore goes through the tenancy check rather than
 * around it.
 *
 * CLIENT COMPANIES sit above the workspace cards: onboarding a customer is
 * create the company (with its first workspace) → invite its Owner → the Owner
 * accepts and lands in their company. `CompaniesPanel` is that flow, over
 * `/api/admin/companies` and `/api/auth/invitations`, and only a Platform
 * Super Admin is served it.
 */

import { useState } from "react";
import { chipInk } from "../chip-ink";
import { Icon } from "../../../components";
import {
  AdminFlash,
  AdminLoading,
  AdminNotice,
  adminWrite,
  relativeTime,
  useAdminResource,
} from "./admin-shell";
import { deliveryOf, IssuedLink, type Delivery } from "./admin-users";

type ClientRow = {
  id: string;
  name: string;
  slug: string;
  clientCompanyId?: string | null;
  companyName?: string | null;
  planTier: string;
  status: string;
  primaryColour: string;
  createdAt: string;
  users: number;
  usersByRole: Record<string, number>;
  jobs: number;
  openJobs: number;
  sites: number;
  units: number;
  lastActivityAt: string | null;
  isCurrent: boolean;
};

type ClientsPayload = {
  clients: ClientRow[];
  totals: { workspaces: number; users: number; jobs: number; openJobs: number; sites: number };
  actor: { email: string; role: string; roleLabel: string; currentOrganisationId: string };
};

export function AdminClientsView({
  onSwitched,
}: {
  /** Called after a successful workspace switch, so a host can reload. */
  onSwitched?: (organisationId: string) => void;
}) {
  const { data, loading, denied, error, reload } =
    useAdminResource<ClientsPayload>("/api/admin/clients");
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  async function open(client: ClientRow) {
    setSwitching(client.id);
    try {
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "select_organisation",
          organisationId: client.id,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setFlash({
          ok: false,
          message: payload?.error ?? `You may not open ${client.name}.`,
        });
        return;
      }
      setFlash({ ok: true, message: `Now working in ${client.name}.` });
      onSwitched?.(client.id);
      await reload();
    } catch {
      setFlash({ ok: false, message: "The workspace could not be reached." });
    } finally {
      setSwitching(null);
    }
  }

  return (
    <div className="section-stack admin-console">
      <section className="section-header">
        <div>
          <span className="eyebrow-chip">
            <Icon name="building" size={15} />
            Owner console
          </span>
          <h1>Client workspaces</h1>
          <p>
            Every client workspace on the platform, with real counts from its own
            rows. Only an account holding the <code>clients.view_all</code> permission
            can load this screen; everybody else is refused by the API.
          </p>
        </div>
      </section>

      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />

      {loading && !data ? <AdminLoading label="Counting every workspace…" /> : null}

      {denied ? (
        <AdminNotice tone="denied" icon="shield" title="This console is for the platform owner">
          {denied} The server refused this request — this is not a hidden button.
        </AdminNotice>
      ) : null}

      {error ? (
        <AdminNotice tone="error" icon="alert" title="The console could not be loaded">
          {error}
        </AdminNotice>
      ) : null}

      {data ? (
        <>
          <section className="site-stat-grid">
            <div>
              <span className="site-stat-icon">
                <Icon name="building" size={19} />
              </span>
              <small>Client workspaces</small>
              <strong>{data.totals.workspaces}</strong>
            </div>
            <div>
              <span className="site-stat-icon site-stat-icon--teal">
                <Icon name="users" size={19} />
              </span>
              <small>People with access</small>
              <strong>{data.totals.users}</strong>
            </div>
            <div>
              <span className="site-stat-icon site-stat-icon--orange">
                <Icon name="wrench" size={19} />
              </span>
              <small>Open jobs</small>
              <strong>{data.totals.openJobs}</strong>
            </div>
            <div>
              <span className="site-stat-icon site-stat-icon--green">
                <Icon name="store" size={19} />
              </span>
              <small>Sites under management</small>
              <strong>{data.totals.sites}</strong>
            </div>
          </section>

          <CompaniesPanel onChanged={reload} />

          {data.clients.length ? (
            <div className="admin-client-grid">
              {data.clients.map((client) => (
                <article
                  key={client.id}
                  className={`admin-client${client.isCurrent ? " admin-client--current" : ""}`}
                >
                  <header>
                    <span
                      className="admin-client__mark"
                      /*
                       * The ink is chosen against the ground, not fixed.
                       *
                       * This colour comes from the client record, so no
                       * stylesheet can know it — and `admin-console.css`
                       * hard-coded `color: #fff` for every one of them. The
                       * seeded teal put the initial at 2.59:1 and the blue at
                       * 3.99:1, in both themes. `chipInk` is what the board's
                       * status chips already use for exactly this problem.
                       */
                      style={{
                        background: client.primaryColour || "#12b4a8",
                        color: chipInk(client.primaryColour || "#12b4a8"),
                      }}
                      aria-hidden="true"
                    >
                      {client.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <h2>{client.name}</h2>
                      <small>
                        {client.companyName && client.companyName !== client.name
                          ? client.companyName
                          : client.slug}
                      </small>
                    </div>
                    <span className={`admin-plan admin-plan--${client.planTier}`}>
                      {client.planTier}
                    </span>
                  </header>

                  <dl className="admin-client__stats">
                    <div>
                      <dt>People</dt>
                      <dd>{client.users}</dd>
                    </div>
                    <div>
                      <dt>Jobs</dt>
                      <dd>{client.jobs}</dd>
                    </div>
                    <div>
                      <dt>Open</dt>
                      <dd>{client.openJobs}</dd>
                    </div>
                    <div>
                      <dt>Sites</dt>
                      <dd>{client.sites}</dd>
                    </div>
                    <div>
                      <dt>Assets</dt>
                      <dd>{client.units}</dd>
                    </div>
                  </dl>

                  <p className="admin-client__roles">
                    {Object.keys(client.usersByRole).length
                      ? Object.entries(client.usersByRole).map(([role, value]) => (
                          <span key={role} className="admin-chip">
                            {value} {role}
                          </span>
                        ))
                      : <span className="admin-chip admin-chip--empty">No active members</span>}
                  </p>

                  <footer>
                    <span className="admin-client__activity">
                      <Icon name="activity" size={15} />
                      Last activity {relativeTime(client.lastActivityAt).toLowerCase()}
                    </span>
                    <button
                      type="button"
                      className={client.isCurrent ? "secondary-button" : "primary-button"}
                      disabled={switching === client.id || client.isCurrent}
                      onClick={() => void open(client)}
                    >
                      {client.isCurrent
                        ? "Current workspace"
                        : switching === client.id
                          ? "Opening…"
                          : "Open workspace"}
                      {client.isCurrent ? null : <Icon name="arrow" size={16} />}
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            <AdminNotice tone="empty" icon="building" title="No client workspaces yet">
              A workspace appears here as soon as one is created.
            </AdminNotice>
          )}
        </>
      ) : null}
    </div>
  );
}

type CompanySummary = {
  id: string;
  name: string;
  defaultOrganisationId: string | null;
  workspaces: Array<{ id: string; name: string }>;
  owners: Array<{ userId: string; email: string; fullName: string | null; active: boolean }>;
  pendingOwnerInvitations: Array<{ id: string; email: string; expiresAt: string }>;
  canManageOwners: boolean;
};

type CompaniesPayload = {
  companies: CompanySummary[];
  actor: { platformAdmin: boolean; canCreateCompany: boolean };
};

/**
 * Client companies, and onboarding a new one.
 *
 * Create the company with its first workspace, invite its Owner (the link is
 * shown once, exactly as on the People screen — invitation emails are not
 * switched on), and the Owner lands in their company on accepting. Adding a
 * workspace and removing an Owner are here too. Every button is a request the
 * server decides; a refusal comes back in its own words.
 */
function CompaniesPanel({ onChanged }: { onChanged: () => void | Promise<void> }) {
  const { data, denied, error, reload } =
    useAdminResource<CompaniesPayload>("/api/admin/companies");
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{
    email: string;
    url: string;
    kind: "invitation";
    delivery: Delivery | null;
  } | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState<Record<string, string>>({});
  const [newWorkspace, setNewWorkspace] = useState<Record<string, string>>({});

  if (denied || !data?.actor.platformAdmin) return null;

  async function refresh() {
    await reload();
    await onChanged();
  }

  async function companyAction(key: string, body: Record<string, unknown>, success: string) {
    setBusy(key);
    const result = await adminWrite("/api/admin/companies", "POST", body);
    setBusy(null);
    setFlash(result.ok ? { ok: true, message: success } : result);
    if (result.ok) await refresh();
    return result.ok;
  }

  async function inviteOwner(company: CompanySummary) {
    const email = (ownerEmail[company.id] ?? "").trim();
    if (!email) return;
    setBusy(`owner-${company.id}`);
    const result = await adminWrite("/api/auth/invitations", "POST", {
      email,
      role: "owner",
      clientCompanyId: company.id,
    });
    setBusy(null);
    const url = result.payload?.inviteUrl;
    if (result.ok && typeof url === "string") {
      const delivery = deliveryOf(result.payload);
      setIssued({ email, url, kind: "invitation", delivery });
      setFlash({
        ok: true,
        message: `${email} has been invited as Owner of ${company.name}. ${delivery?.message ?? ""}`.trim(),
      });
      setOwnerEmail((current) => ({ ...current, [company.id]: "" }));
      await reload();
      return;
    }
    setFlash(result);
  }

  return (
    <section className="panel admin-panel">
      <div className="panel-heading">
        <div>
          <span>Platform</span>
          <h2>Client companies</h2>
        </div>
      </div>
      <p className="admin-company-note admin-company-lede">
        A client company holds one or more workspaces. Its Owners reach all of them,
        including new ones; everybody else reaches only the workspaces they are given.
      </p>

      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />
      {error ? (
        <AdminNotice tone="error" icon="alert" title="Client companies could not be loaded">
          {error}
        </AdminNotice>
      ) : null}
      {issued ? <IssuedLink issued={issued} onDismiss={() => setIssued(null)} /> : null}

      {data.actor.canCreateCompany ? (
        <form
          className="admin-company-add"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!companyName.trim()) return;
            const ok = await companyAction(
              "create-company",
              {
                action: "create_company",
                name: companyName.trim(),
                workspaceName: workspaceName.trim() || undefined,
              },
              `${companyName.trim()} was created with its first workspace. Invite its Owner next.`,
            );
            if (ok) {
              setCompanyName("");
              setWorkspaceName("");
            }
          }}
        >
          <label className="admin-field admin-field--grow">
            <span>New client company</span>
            <input
              value={companyName}
              maxLength={120}
              placeholder="Company name"
              onChange={(event) => setCompanyName(event.target.value)}
            />
          </label>
          <label className="admin-field admin-field--grow">
            <span>First workspace</span>
            <input
              value={workspaceName}
              maxLength={120}
              placeholder="Same as the company"
              onChange={(event) => setWorkspaceName(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={busy === "create-company" || !companyName.trim()}
          >
            <Icon name="plus" size={16} />
            {busy === "create-company" ? "Creating…" : "Create company"}
          </button>
        </form>
      ) : null}

      <div className="admin-company-grid">
        {data.companies.map((company) => (
          <article key={company.id} className="admin-company-card">
            <h3>{company.name}</h3>
            <dl>
              <dt>Workspaces</dt>
              <dd>
                {company.workspaces.map((workspace) => (
                  <span key={workspace.id} className="admin-chip">
                    {workspace.name}
                    {workspace.id === company.defaultOrganisationId ? " · default" : ""}
                  </span>
                ))}
              </dd>
              <dt>Owners</dt>
              <dd>
                {company.owners.length ? (
                  company.owners.map((owner) => (
                    <span key={owner.userId} className="admin-chip">
                      {owner.fullName || owner.email}
                      {company.canManageOwners ? (
                        <button
                          type="button"
                          className="admin-chip__remove"
                          aria-label={`Remove ${owner.email} as Owner of ${company.name}`}
                          disabled={busy === `remove-${owner.userId}`}
                          onClick={() => {
                            if (!window.confirm(`Remove ${owner.email} as Owner of ${company.name}? They lose access to every workspace they reach only as its Owner.`)) return;
                            void companyAction(
                              `remove-${owner.userId}`,
                              { action: "remove_owner", clientCompanyId: company.id, userId: owner.userId },
                              `${owner.email} is no longer an Owner of ${company.name}.`,
                            );
                          }}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      ) : null}
                    </span>
                  ))
                ) : (
                  <span className="admin-chip admin-chip--empty">No Owner yet</span>
                )}
              </dd>
              {company.pendingOwnerInvitations.length ? (
                <>
                  <dt>Invited</dt>
                  <dd>
                    {company.pendingOwnerInvitations.map((invitation) => (
                      <span key={invitation.id} className="admin-chip">
                        {invitation.email} · expires {relativeTime(invitation.expiresAt).toLowerCase()}
                      </span>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
            {company.canManageOwners ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void inviteOwner(company);
                }}
              >
                <label className="admin-field admin-field--grow">
                  <span>Invite an Owner</span>
                  <input
                    type="email"
                    required
                    value={ownerEmail[company.id] ?? ""}
                    placeholder="owner@company.com"
                    onChange={(event) =>
                      setOwnerEmail((current) => ({ ...current, [company.id]: event.target.value }))
                    }
                  />
                </label>
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={busy === `owner-${company.id}`}
                >
                  {busy === `owner-${company.id}` ? "Inviting…" : "Invite Owner"}
                </button>
              </form>
            ) : null}
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const name = (newWorkspace[company.id] ?? "").trim();
                if (!name) return;
                const ok = await companyAction(
                  `workspace-${company.id}`,
                  { action: "create_workspace", clientCompanyId: company.id, name },
                  `${name} was added to ${company.name}.`,
                );
                if (ok) setNewWorkspace((current) => ({ ...current, [company.id]: "" }));
              }}
            >
              <label className="admin-field admin-field--grow">
                <span>Add a workspace</span>
                <input
                  value={newWorkspace[company.id] ?? ""}
                  maxLength={120}
                  placeholder="Branch or site name"
                  onChange={(event) =>
                    setNewWorkspace((current) => ({ ...current, [company.id]: event.target.value }))
                  }
                />
              </label>
              <button
                type="submit"
                className="secondary-button"
                disabled={busy === `workspace-${company.id}`}
              >
                Add workspace
              </button>
            </form>
          </article>
        ))}
      </div>
    </section>
  );
}
