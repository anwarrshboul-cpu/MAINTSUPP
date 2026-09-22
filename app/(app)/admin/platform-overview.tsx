"use client";

/**
 * The platform console's Dashboard — every client workspace, and what each holds.
 *
 * READS AN API THAT ALREADY EXISTS, AND DELIBERATELY ADDS NONE.
 *
 * `GET /api/admin/clients` is already the platform-wide list: it gates on
 * `clients.view_all`, restricts its rows to `context.organisationIds` (which for a
 * Platform Super Admin IS every active organisation), and aggregates eight grouped
 * counts per workspace plus the five totals across them. Writing a
 * `/api/admin/platform-summary` beside it would be a second place for the same
 * numbers to be derived, and the first time one of them changed they would
 * disagree.
 *
 * Two gates, neither substituting for the other — that route's own header says so:
 * the capability decides whether to answer at all, and the row filter decides what
 * the answer contains. This screen inherits both.
 *
 * WHY THE TOTALS ARE NOT RE-DERIVED HERE
 *
 * The payload carries `totals`, computed server-side from the same rows. Summing
 * `clients` in the browser would produce the same figures today and a different
 * one the day the route starts paginating — and a dashboard whose headline
 * disagrees with its own table is worse than one with no headline.
 *
 * WHY IT SHOWS A REFUSAL RATHER THAN AN EMPTY STATE
 *
 * `useAdminResource` distinguishes four states — loading, loaded, DENIED, broken —
 * and the third is the one that matters on a console reached by URL.
 * `requirePlatformAdmin` already refused anyone who should not be here, so a 403
 * arriving at this screen means the capability and the platform-admin flag
 * disagree, which is a real condition worth naming rather than painting as
 * "no clients yet".
 */

import { Icon } from "../../components";
import {
  AdminLoading,
  AdminNotice,
  relativeTime,
  useAdminResource,
} from "../portal/views/admin-shell";

type ClientRow = {
  id: string;
  name: string;
  slug: string;
  planTier: string;
  status: string;
  users: number;
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
};

/** The headline figures, in the order a platform operator reads them. */
const TOTALS: ReadonlyArray<{
  key: keyof ClientsPayload["totals"];
  label: string;
  icon: "building" | "users" | "wrench" | "alert" | "store";
}> = [
  { key: "workspaces", label: "Workspaces", icon: "building" },
  { key: "users", label: "People", icon: "users" },
  { key: "sites", label: "Sites", icon: "store" },
  { key: "jobs", label: "Jobs", icon: "wrench" },
  { key: "openJobs", label: "Open jobs", icon: "alert" },
];

export function PlatformOverview() {
  const { data, loading, denied, error, reload } =
    useAdminResource<ClientsPayload>("/api/admin/clients");

  if (loading && !data) return <AdminLoading label="Loading the platform…" />;

  if (denied) {
    return (
      <AdminNotice tone="denied" icon="shield" title="You do not have access to this screen">
        {denied} The server refused this request — this is not a hidden button.
      </AdminNotice>
    );
  }

  if (error || !data) {
    return (
      <AdminNotice tone="error" icon="alert" title="The platform figures could not be loaded">
        {error ?? "That could not be loaded."}{" "}
        <button type="button" className="platform-retry" onClick={() => void reload()}>
          Try again
        </button>
      </AdminNotice>
    );
  }

  const clients = data.clients ?? [];

  return (
    <div className="platform-overview">
      <div className="platform-totals">
        {TOTALS.map((total) => (
          <div className="platform-total" key={total.key}>
            <span className="platform-total__icon" aria-hidden="true">
              <Icon name={total.icon} size={17} />
            </span>
            <strong>{(data.totals?.[total.key] ?? 0).toLocaleString()}</strong>
            <small>{total.label}</small>
          </div>
        ))}
      </div>

      {clients.length === 0 ? (
        /* Genuinely empty, which a fresh installation is. Distinguished from a
           refusal above, because the two look identical in a table and mean
           opposite things. */
        <AdminNotice tone="empty" icon="building" title="No client workspaces yet">
          One is created the first time a client is onboarded.
        </AdminNotice>
      ) : (
        /* A region that scrolls sideways on a phone must be reachable without a
           pointer: focusable, and named so a screen reader says what it is. */
        <div className="platform-table-wrap" tabIndex={0} role="region" aria-label="Client workspaces">
          <table className="platform-table">
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Plan</th>
                <th scope="col" className="is-numeric">People</th>
                <th scope="col" className="is-numeric">Sites</th>
                <th scope="col" className="is-numeric">Units</th>
                <th scope="col" className="is-numeric">Jobs</th>
                <th scope="col" className="is-numeric">Open</th>
                <th scope="col">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id} className={client.isCurrent ? "is-current" : ""}>
                  <th scope="row">
                    <span className="platform-table__name">{client.name}</span>
                    {/* Which workspace this console's per-workspace screens are
                        currently pointed at. Worth saying: Users and Roles answer
                        for ONE workspace, and without this the reader has to guess
                        which. */}
                    {client.isCurrent ? (
                      <span className="platform-table__current">current</span>
                    ) : null}
                    <small>{client.slug}</small>
                  </th>
                  <td>{client.planTier}</td>
                  <td className="is-numeric">{client.users.toLocaleString()}</td>
                  <td className="is-numeric">{client.sites.toLocaleString()}</td>
                  <td className="is-numeric">{client.units.toLocaleString()}</td>
                  <td className="is-numeric">{client.jobs.toLocaleString()}</td>
                  <td className="is-numeric">{client.openJobs.toLocaleString()}</td>
                  {/* `relativeTime` from the shared kit, so "3 days ago" is
                      phrased the same here as on every other admin screen. */}
                  <td>{relativeTime(client.lastActivityAt) || "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default PlatformOverview;
