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
 */

import { useState } from "react";
import { chipInk } from "../chip-ink";
import { Icon } from "../../../components";
import {
  AdminFlash,
  AdminLoading,
  AdminNotice,
  relativeTime,
  useAdminResource,
} from "./admin-shell";

type ClientRow = {
  id: string;
  name: string;
  slug: string;
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
                      <small>{client.slug}</small>
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
