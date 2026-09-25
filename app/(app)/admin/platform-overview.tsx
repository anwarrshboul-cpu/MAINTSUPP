"use client";

/**
 * The platform console's Overview — every client workspace, what each holds, and
 * the state of the website the console edits.
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
 *
 * THE PANELS AROUND IT (visual pass, round 1 2026-09-24 and round 2 2026-09-25)
 *
 * The owner's reference console puts the website, the inboxes, the brand, the
 * portal's modules, access, publishing, integrations and the system on its
 * landing screen, densely. Round 2 (owner answers 2A–7A) brings this screen as
 * close to that as the product's REAL data allows: every panel lives in
 * `platform-overview-panels.tsx` and draws only what an API a console or
 * workspace screen already reads has answered — `/api/site-content`,
 * `/api/site-pages`, `/api/cms-media`, `/api/theme`, `/api/branding/logo`,
 * `/api/navigation`, `/api/site-navigation`, `/api/portal-modules`, `/api/admin/roles`, `/api/leads`,
 * `/api/contractor-applications/inbox`, `/api/audit`, `/api/account/platform`
 * and `/api/admin/backups` — each still enforcing its own gate. Roles & access
 * reads the `usersByRole` the workspaces payload already carries. Where the
 * reference shows something this product does not have (page views, visitors, a
 * platform health light, "Publish all", a live hero editor), there is no panel.
 *
 * ONE READ AT A TIME. Those fourteen reads are made in sequence after the
 * workspaces table has answered, not in parallel. On the serverless deployment
 * every concurrent request can wake its own instance with its own pool, and the
 * 2026-09-22 incident was exactly that fan-out (handoff: "instance fan-out"). A
 * landing screen that fired fourteen at once would be the same shape again, for a
 * page one person opens. In sequence they reuse one warm instance, and each panel
 * fills as its own answer lands — in the order the panels are read, top first.
 */

import { useEffect, useState } from "react";

import { Icon } from "../../components";
import {
  AdminLoading,
  AdminNotice,
  relativeTime,
  useAdminResource,
} from "../portal/views/admin-shell";
import {
  AccessPanel,
  ActivityPanel,
  BrandPanel,
  Card,
  ChangesPanel,
  HeroPanel,
  InboxPanel,
  IntegrationsPanel,
  MediaPanel,
  ModulesPanel,
  NavigationPanel,
  PagesPanel,
  PlatformMap,
  SystemPanel,
  ready,
  type CopyPayload,
  type LeadsPayload,
  type MediaPayload,
  type PagesPayload,
  type ReadState,
} from "./platform-overview-panels";
import "./platform-overview.css";

type ClientRow = {
  id: string;
  name: string;
  slug: string;
  planTier: string;
  status: string;
  users: number;
  usersByRole?: Record<string, number>;
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

/**
 * The headline figures the server totals (owner answer 3A). Each caption says
 * what the server counted, in its own terms. The strip's last three — website
 * pages, media files, open enquiries — come from the panel reads below.
 */
const TOTALS: ReadonlyArray<{
  key: "workspaces" | "users" | "sites" | "openJobs";
  label: string;
  icon: "building" | "users" | "store" | "alert";
  note: string;
}> = [
  { key: "workspaces", label: "Workspaces", icon: "building", note: "Active on this installation" },
  { key: "users", label: "People", icon: "users", note: "Active members, per workspace" },
  { key: "sites", label: "Sites", icon: "store", note: "Across every workspace" },
  { key: "openJobs", label: "Open jobs", icon: "alert", note: "Not completed" },
];

/* ------------------------------------------------------------------ */
/* The secondary reads                                                 */
/* ------------------------------------------------------------------ */

/** In the order the panels are read, top to bottom, so the screen fills downwards. */
const READS = [
  ["copy", "/api/site-content"],
  ["pages", "/api/site-pages"],
  ["media", "/api/cms-media"],
  ["theme", "/api/theme"],
  ["logo", "/api/branding/logo"],
  ["portalNav", "/api/navigation"],
  ["navigation", "/api/site-navigation"],
  ["modules", "/api/portal-modules"],
  ["roles", "/api/admin/roles"],
  ["leads", "/api/leads"],
  ["applications", "/api/contractor-applications/inbox"],
  ["activity", "/api/audit?pageSize=7"],
  ["backups", "/api/admin/backups"],
  ["platform", "/api/account/platform"],
] as const;

type ReadKey = (typeof READS)[number][0];
type Reads = Partial<Record<ReadKey, ReadState>>;

async function readOnce(url: string, signal: AbortSignal): Promise<ReadState> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal });
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (response.status === 401 || response.status === 403) {
      return { status: "refused", message: payload?.error ?? "Not available to this account." };
    }
    if (!response.ok || !payload) {
      return { status: "failed", message: payload?.error ?? "That could not be read." };
    }
    return { status: "ready", data: payload };
  } catch {
    return { status: "failed", message: "That could not be read." };
  }
}

/**
 * Runs `READS` one after another once `start` is true. `retry(key)` re-reads one
 * panel without re-running the rest.
 */
function useQueuedReads(start: boolean) {
  const [reads, setReads] = useState<Reads>({});

  useEffect(() => {
    if (!start) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      for (const [key, url] of READS) {
        const state = await readOnce(url, controller.signal);
        if (cancelled) return;
        setReads((current) => ({ ...current, [key]: state }));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [start]);

  const retry = (key: ReadKey) => {
    const url = READS.find(([candidate]) => candidate === key)?.[1];
    if (!url) return;
    setReads((current) => ({ ...current, [key]: { status: "loading" } }));
    void readOnce(url, new AbortController().signal).then((state) =>
      setReads((current) => ({ ...current, [key]: state })),
    );
  };

  return { reads, retry };
}

/** One tile of the headline strip. `value` null draws its placeholder. */
function Stat({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: "building" | "users" | "store" | "alert" | "document" | "image" | "inbox";
  label: string;
  value: string | null;
  note: string;
  tone?: "attention";
}) {
  return (
    <div className={`platform-total${tone ? ` platform-total--${tone}` : ""}`}>
      <span className="platform-total__icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <span className="platform-total__copy">
        <small>{label}</small>
        {value === null ? (
          <span className="platform-skeleton platform-skeleton--figure" aria-hidden="true" />
        ) : (
          <strong>{value}</strong>
        )}
        <em>{note}</em>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The screen                                                          */
/* ------------------------------------------------------------------ */

export function PlatformOverview() {
  const { data, loading, denied, error, reload } =
    useAdminResource<ClientsPayload>("/api/admin/clients");
  const { reads, retry } = useQueuedReads(Boolean(data));
  /* One clock for the whole screen, read once, so the enquiries chart and every
     "n days ago" agree about today. */
  const [now] = useState(() => Date.now());

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
  const current = clients.find((client) => client.isCurrent) ?? null;
  const jobsTotal = data.totals?.jobs ?? 0;

  const copy = ready<CopyPayload>(reads.copy);
  const pages = ready<PagesPayload>(reads.pages);
  const media = ready<MediaPayload>(reads.media);
  const leads = ready<LeadsPayload>(reads.leads);
  const builtIn = copy?.pages.length ?? 0;
  const cmsPages = pages?.pages.length ?? 0;

  return (
    <div className="platform-overview">
      <section className="platform-totals" aria-label="Across the platform">
        {TOTALS.map((total) => (
          <Stat
            key={total.key}
            icon={total.icon}
            label={total.label}
            value={(data.totals?.[total.key] ?? 0).toLocaleString()}
            note={total.key === "openJobs" ? `Of ${jobsTotal.toLocaleString()} live jobs` : total.note}
            tone={total.key === "openJobs" ? "attention" : undefined}
          />
        ))}
        <Stat
          icon="document"
          label="Web pages"
          value={copy && pages ? (builtIn + cmsPages).toLocaleString() : null}
          note={copy && pages ? `${builtIn} built-in · ${cmsPages} CMS` : "Built-in and CMS"}
        />
        <Stat
          icon="image"
          label="Media"
          value={media ? media.items.length.toLocaleString() : null}
          note="Files in the website library"
        />
        <Stat
          icon="inbox"
          label="Enquiries"
          value={leads ? leads.open.toLocaleString() : null}
          note={leads ? `Open · ${(leads.counts.New ?? 0).toLocaleString()} not opened` : "From the public form"}
          tone={leads && (leads.counts.New ?? 0) > 0 ? "attention" : undefined}
        />
      </section>

      <div className="platform-grid">
        <PagesPanel copy={reads.copy} pages={reads.pages} onRetry={() => retry("pages")} />
        <HeroPanel copy={reads.copy} media={reads.media} onRetry={() => retry("copy")} />
        <BrandPanel
          workspace={current?.name ?? null}
          theme={reads.theme}
          logo={reads.logo}
          portalNav={reads.portalNav}
          onRetry={() => retry("theme")}
        />

        <NavigationPanel navigation={reads.navigation} onRetry={() => retry("navigation")} />
        <MediaPanel media={reads.media} onRetry={() => retry("media")} />
        <ModulesPanel workspace={current?.name ?? null} modules={reads.modules} onRetry={() => retry("modules")} />
        <AccessPanel
          workspace={current?.name ?? null}
          usersByRole={current?.usersByRole ?? null}
          people={current ? current.users : null}
          roles={reads.roles}
          onRetry={() => retry("roles")}
        />

        <Card
          id="clients"
          title="Client workspaces"
          icon="building"
          action={{ href: "/admin/clients", label: "Manage clients" }}
          className="platform-card--clients"
          landmark={false}
          meta={`${clients.length} workspace${clients.length === 1 ? "" : "s"}`}
        >
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
                        <span className="platform-table__name">
                          {client.name}
                          {/* Which workspace this console's per-workspace screens are
                              currently pointed at. Worth saying: Users and Roles answer
                              for ONE workspace, and without this the reader has to guess
                              which. */}
                          {client.isCurrent ? (
                            <span className="platform-table__current">current</span>
                          ) : null}
                        </span>
                        <small>{client.slug}</small>
                      </th>
                      <td>
                        <span className="platform-pill">{client.planTier}</span>
                      </td>
                      <td className="is-numeric">{client.users.toLocaleString()}</td>
                      <td className="is-numeric">{client.sites.toLocaleString()}</td>
                      <td className="is-numeric">{client.units.toLocaleString()}</td>
                      <td className="is-numeric">{client.jobs.toLocaleString()}</td>
                      <td className="is-numeric">
                        <span className={client.openJobs > 0 ? "platform-open" : "platform-open is-zero"}>
                          {client.openJobs.toLocaleString()}
                        </span>
                      </td>
                      {/* `relativeTime` from the shared kit, so "3 days ago" is
                          phrased the same here as on every other admin screen. */}
                      <td className="platform-table__muted">{relativeTime(client.lastActivityAt) || "never"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <SystemPanel backups={reads.backups} onRetry={() => retry("backups")} />

        <InboxPanel
          leads={reads.leads}
          applications={reads.applications}
          now={now}
          onRetry={() => retry("leads")}
        />
        <ActivityPanel activity={reads.activity} onRetry={() => retry("activity")} />
        <ChangesPanel copy={reads.copy} navigation={reads.navigation} pages={reads.pages} media={reads.media} />

        <IntegrationsPanel platform={reads.platform} onRetry={() => retry("platform")} />

        <PlatformMap />
      </div>
    </div>
  );
}

export default PlatformOverview;
