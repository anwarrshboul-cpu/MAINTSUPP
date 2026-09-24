"use client";

/**
 * The platform console's Overview — every client workspace, what each holds, and
 * the state of the website the console edits.
 *
 * READS APIS THAT ALREADY EXIST, AND DELIBERATELY ADDS NONE.
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
 * THE CARDS AROUND IT (2026-09-24 visual pass, owner answers 1A and 2A)
 *
 * The owner's reference console puts the website, the inboxes, the portal's
 * theme and modules, recent publishing and the system on its landing screen.
 * Every card here is one of those, drawn only from an API a console screen
 * already reads — `/api/site-pages`, `/api/site-navigation`, `/api/site-content`,
 * `/api/cms-media`, `/api/leads`, `/api/contractor-applications/inbox`,
 * `/api/portal-modules`, `/api/theme`, `/api/branding/logo`, `/api/audit` and
 * `/api/admin/backups` — each still enforcing its own gate. Nothing here is a
 * figure the server did not send. Where the reference shows something this
 * product does not have (page views, visitors, a platform health light, a
 * "Publish all"), there is no card for it.
 *
 * ONE READ AT A TIME. Those eleven reads are made in sequence after the
 * workspaces table has answered, not in parallel. On the serverless deployment
 * every concurrent request can wake its own instance with its own pool, and the
 * 2026-09-22 incident was exactly that fan-out (handoff: "instance fan-out"). A
 * landing screen that fired eleven at once would be the same shape again, for a
 * page one person opens. In sequence they reuse one warm instance, and each card
 * fills as its own answer lands.
 */

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { Icon, type IconName } from "../../components";
import {
  AdminLoading,
  AdminNotice,
  relativeTime,
  useAdminResource,
} from "../portal/views/admin-shell";
import "./platform-overview.css";

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

/** The headline figures, in the order a platform operator reads them. Each
    caption says what the server counted, in its own terms. */
const TOTALS: ReadonlyArray<{
  key: keyof ClientsPayload["totals"];
  label: string;
  icon: "building" | "users" | "wrench" | "alert" | "store";
  note: string;
}> = [
  { key: "workspaces", label: "Workspaces", icon: "building", note: "Active on this installation" },
  { key: "users", label: "People", icon: "users", note: "Active members, per workspace" },
  { key: "sites", label: "Sites", icon: "store", note: "Across every workspace" },
  { key: "jobs", label: "Jobs", icon: "wrench", note: "Live — binned ones excluded" },
  { key: "openJobs", label: "Open jobs", icon: "alert", note: "Not completed" },
];

/* ------------------------------------------------------------------ */
/* The secondary reads                                                 */
/* ------------------------------------------------------------------ */

type ReadState =
  | { status: "loading" }
  | { status: "ready"; data: unknown }
  | { status: "refused"; message: string }
  | { status: "failed"; message: string };

/** In the order the cards are read top to bottom, so the screen fills downwards. */
const READS = [
  ["pages", "/api/site-pages"],
  ["navigation", "/api/site-navigation"],
  ["copy", "/api/site-content"],
  ["media", "/api/cms-media"],
  ["leads", "/api/leads"],
  ["applications", "/api/contractor-applications/inbox"],
  ["modules", "/api/portal-modules"],
  ["theme", "/api/theme"],
  ["logo", "/api/branding/logo"],
  ["activity", "/api/audit?pageSize=6"],
  ["backups", "/api/admin/backups"],
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
 * card without re-running the rest.
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

function ready<T>(state: ReadState | undefined): T | null {
  return state?.status === "ready" ? (state.data as T) : null;
}

/* ------------------------------------------------------------------ */
/* Payload shapes — only the fields a card reads                       */
/* ------------------------------------------------------------------ */

type PagesPayload = { pages: Array<{ state: "draft" | "scheduled" | "live" | "ended" }> };
type EditedPayload = { stored: boolean; updatedAt: string | null; updatedByEmail: string | null };
type NavigationPayload = EditedPayload & {
  navigation: {
    primary: Array<{ hidden?: boolean }>;
    footer: Array<{ links: Array<{ hidden?: boolean }> }>;
  };
};
type CopyPayload = EditedPayload & { pages: Array<{ key: string }> };
type MediaPayload = { items: unknown[]; storage: { state: string; message: string | null } };
type InboxPayload = { open: number; counts: Record<string, number> };
type LeadsPayload = InboxPayload & {
  enquiries: Array<{
    id: string;
    name: string;
    company: string | null;
    siteRange: string | null;
    status: string;
    createdAt: string;
  }>;
};
type ModulesPayload = { modules: Array<{ enabled: boolean }> };
type ThemePayload = { tokens: Array<{ isDefault: boolean }> };
type LogoPayload = { logo: unknown | null };
type AuditPayload = {
  events: Array<{ id: string; summary: string; createdAt: string; organisationId: string | null }>;
  workspaces: Array<{ id: string; name: string }>;
};
type BackupsPayload = {
  backups: { provider: string; visible: boolean };
  database: { name: string; configured: boolean };
  storage: { name: string; configured: boolean };
  migrations: { current: boolean; codeFingerprint: string; appliedAt: string | null };
};

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function edited(payload: EditedPayload, untouched: string) {
  if (!payload.stored) return untouched;
  const who = payload.updatedByEmail ? ` by ${payload.updatedByEmail}` : "";
  /* "Just now" is a sentence opener in the shared helper; mid-sentence it is not.
     Past a month the helper returns a date, which must keep its capital. */
  const when = relativeTime(payload.updatedAt);
  return `edited ${when === "Just now" ? "just now" : when}${who}`;
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Card({
  id,
  title,
  icon,
  action,
  className,
  landmark = true,
  children,
}: {
  id: string;
  title: string;
  icon: IconName;
  action?: { href: string; label: string };
  className?: string;
  /**
   * A labelled `<section>` is a region landmark. The workspaces card holds the
   * table's own scrollable region, already named "Client workspaces", so it is a
   * plain `<div>` — two landmarks with one name is what axe calls
   * `landmark-unique`.
   */
  landmark?: boolean;
  children: ReactNode;
}) {
  const Frame = landmark ? "section" : "div";
  return (
    <Frame
      className={`platform-card${className ? ` ${className}` : ""}`}
      aria-labelledby={landmark ? `platform-card-${id}` : undefined}
    >
      <header className="platform-card__head">
        <span className="platform-card__icon" aria-hidden="true">
          <Icon name={icon} size={17} />
        </span>
        <h2 id={`platform-card-${id}`}>{title}</h2>
        {action ? (
          <a className="platform-card__action" href={action.href}>
            {action.label}
          </a>
        ) : null}
      </header>
      {children}
    </Frame>
  );
}

type RowFacts = { note: string; value: string; tone?: "warn" | "good" };

/**
 * One line of a card: a screen, what it holds, and a way into it. Loading draws
 * a placeholder of the same height; a refusal and a failure say which they are.
 */
function StatRow({
  href,
  icon,
  label,
  read,
  describe,
  onRetry,
}: {
  href: string;
  icon: IconName;
  label: string;
  read: ReadState | undefined;
  describe: (data: never) => RowFacts;
  onRetry: () => void;
}) {
  if (read?.status === "failed") {
    return (
      <li className="platform-row platform-row--failed">
        <span className="platform-row__icon" aria-hidden="true">
          <Icon name={icon} size={16} />
        </span>
        <span className="platform-row__copy">
          <a href={href}>{label}</a>
          <small>{read.message}</small>
        </span>
        <button type="button" className="platform-retry" onClick={onRetry}>
          Try again
        </button>
      </li>
    );
  }
  const facts: RowFacts | null =
    read?.status === "ready"
      ? describe(read.data as never)
      : read?.status === "refused"
        ? { note: "Not available to this account.", value: "—" }
        : null;
  return (
    <li>
      <a className="platform-row" href={href} aria-busy={facts ? undefined : true}>
        <span className="platform-row__icon" aria-hidden="true">
          <Icon name={icon} size={16} />
        </span>
        <span className="platform-row__copy">
          <strong>{label}</strong>
          {facts ? <small>{facts.note}</small> : <span className="platform-skeleton platform-skeleton--line" />}
        </span>
        {facts ? (
          <span className={`platform-row__value${facts.tone ? ` is-${facts.tone}` : ""}`}>{facts.value}</span>
        ) : (
          <span className="platform-skeleton platform-skeleton--value" />
        )}
        <span className="platform-row__go" aria-hidden="true">
          <Icon name="arrow" size={14} />
        </span>
      </a>
    </li>
  );
}

/** A card's own loading, refusal or failure, for the cards that are not rows. */
function CardState({ read, onRetry, lines = 3 }: { read: ReadState | undefined; onRetry: () => void; lines?: number }) {
  if (read?.status === "refused") return <p className="platform-card__note">{read.message}</p>;
  if (read?.status === "failed") {
    return (
      <p className="platform-card__note" role="alert">
        {read.message}{" "}
        <button type="button" className="platform-retry" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  return (
    <div className="platform-skeleton-stack" aria-busy="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="platform-skeleton platform-skeleton--block" />
      ))}
    </div>
  );
}

/**
 * How the product connects — the four places a person moves between, each a
 * real address. The owner's reference ends its console with the same band; here
 * it is the one element that says what the console is FOR: it edits the first,
 * governs the second and third, and configures the fourth.
 */
function PlatformMap() {
  return (
    <section className="platform-map" aria-labelledby="platform-map-title">
      <h2 id="platform-map-title">How the platform connects</h2>
      <ol>
        <li>
          <a href="/" target="_blank" rel="noopener noreferrer">
            <span className="platform-map__icon" aria-hidden="true">
              <Icon name="link" size={18} />
            </span>
            <span>
              <strong>Public website</strong>
              <small>
                <code>/</code> — pages, enquiries and contractor applications
              </small>
            </span>
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </li>
        <li>
          <span className="platform-map__node">
            <span className="platform-map__icon" aria-hidden="true">
              <Icon name="shield" size={18} />
            </span>
            <span>
              <strong>Sign in</strong>
              <small>
                <code>/login</code> — one door for staff and clients
              </small>
            </span>
          </span>
        </li>
        <li aria-current="page">
          <span className="platform-map__node is-here">
            <span className="platform-map__icon" aria-hidden="true">
              <Icon name="settings" size={18} />
            </span>
            <span>
              <strong>Platform console</strong>
              <small>
                <code>/admin</code> — you are here
              </small>
            </span>
          </span>
        </li>
        <li>
          <Link href="/dashboard">
            <span className="platform-map__icon" aria-hidden="true">
              <Icon name="grid" size={18} />
            </span>
            <span>
              <strong>Client portal</strong>
              <small>
                <code>/dashboard</code> — each client&apos;s own workspace
              </small>
            </span>
          </Link>
        </li>
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The screen                                                          */
/* ------------------------------------------------------------------ */

export function PlatformOverview() {
  const { data, loading, denied, error, reload } =
    useAdminResource<ClientsPayload>("/api/admin/clients");
  const { reads, retry } = useQueuedReads(Boolean(data));

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
  const openTotal = data.totals?.openJobs ?? 0;

  const activity = ready<AuditPayload>(reads.activity);
  /* Guarded, so a payload missing a list draws an empty card rather than
     taking the whole screen down with it. */
  const events = activity?.events ?? [];
  const eventWorkspaces = activity?.workspaces ?? [];
  const latestLeads = (ready<LeadsPayload>(reads.leads)?.enquiries ?? []).slice(0, 3);
  const system = ready<BackupsPayload>(reads.backups);

  return (
    <div className="platform-overview">
      <section className="platform-totals" aria-label="Across the platform">
        {TOTALS.map((total) => (
          <div className={`platform-total platform-total--${total.key}`} key={total.key}>
            <span className="platform-total__icon" aria-hidden="true">
              <Icon name={total.icon} size={20} />
            </span>
            <span className="platform-total__copy">
              <small>{total.label}</small>
              <strong>{(data.totals?.[total.key] ?? 0).toLocaleString()}</strong>
              <em>
                {total.key === "openJobs" && jobsTotal > 0
                  ? `${total.note} · ${Math.round((openTotal / jobsTotal) * 100)}% of jobs`
                  : total.note}
              </em>
            </span>
          </div>
        ))}
      </section>

      <div className="platform-grid">
        <Card
          id="website"
          title="Website"
          icon="document"
          action={{ href: "/admin/pages", label: "Manage pages" }}
          className="platform-card--website"
        >
          <ul className="platform-rows">
            <StatRow
              href="/admin/pages"
              icon="document"
              label="Website pages"
              read={reads.pages}
              onRetry={() => retry("pages")}
              describe={(payload: PagesPayload) => {
                const pages = payload.pages ?? [];
                if (pages.length === 0) {
                  return { note: "None written in the CMS yet", value: "0" };
                }
                const live = pages.filter((page) => page.state === "live").length;
                const drafts = pages.filter((page) => page.state === "draft").length;
                const scheduled = pages.filter((page) => page.state === "scheduled").length;
                const parts = [`${live} live`, `${drafts} draft`];
                if (scheduled) parts.push(`${scheduled} scheduled`);
                return { note: parts.join(" · "), value: pages.length.toLocaleString() };
              }}
            />
            <StatRow
              href="/admin/navigation"
              icon="menu"
              label="Website navigation"
              read={reads.navigation}
              onRetry={() => retry("navigation")}
              describe={(payload: NavigationPayload) => {
                const header = (payload.navigation?.primary ?? []).filter((link) => !link.hidden).length;
                let footer = 0;
                for (const group of payload.navigation?.footer ?? []) {
                  footer += (group.links ?? []).filter((link) => !link.hidden).length;
                }
                return {
                  note: `${header} in the header, ${footer} in the footer · ${edited(payload, "built-in, not edited yet")}`,
                  value: plural(header + footer, "link"),
                };
              }}
            />
            <StatRow
              href="/admin/copy"
              icon="edit"
              label="Website copy"
              read={reads.copy}
              onRetry={() => retry("copy")}
              describe={(payload: CopyPayload) => ({
                note: `Built-in pages · ${edited(payload, "as shipped, not edited yet")}`,
                value: plural((payload.pages ?? []).length, "page"),
              })}
            />
            <StatRow
              href="/admin/media"
              icon="image"
              label="Website media"
              read={reads.media}
              onRetry={() => retry("media")}
              describe={(payload: MediaPayload) =>
                payload.storage?.state === "ready"
                  ? { note: "Storage ready", value: plural((payload.items ?? []).length, "file") }
                  : {
                      note: payload.storage?.message ?? "Storage is not ready",
                      value: "Check",
                      tone: "warn",
                    }
              }
            />
          </ul>
        </Card>

        <Card
          id="inbox"
          title="Inbox"
          icon="inbox"
          action={{ href: "/admin/leads", label: "Open enquiries" }}
          className="platform-card--inbox"
        >
          <ul className="platform-rows">
            <StatRow
              href="/admin/leads"
              icon="inbox"
              label="Website enquiries"
              read={reads.leads}
              onRetry={() => retry("leads")}
              describe={(payload: LeadsPayload) => {
                const fresh = payload.counts?.New ?? 0;
                return {
                  note: fresh ? `${fresh.toLocaleString()} not opened yet` : "Nothing waiting to be opened",
                  value: `${(payload.open ?? 0).toLocaleString()} open`,
                  tone: fresh ? "warn" : "good",
                };
              }}
            />
            <StatRow
              href="/admin/applications"
              icon="wrench"
              label="Contractor applications"
              read={reads.applications}
              onRetry={() => retry("applications")}
              describe={(payload: InboxPayload) => {
                const fresh = payload.counts?.New ?? 0;
                return {
                  note: fresh ? `${fresh.toLocaleString()} not opened yet` : "Nothing waiting to be opened",
                  value: `${(payload.open ?? 0).toLocaleString()} open`,
                  tone: fresh ? "warn" : "good",
                };
              }}
            />
          </ul>
          {/*
            The three newest enquiries, from the same read the row above counted —
            who and how large an estate, never their contact details, which stay
            behind the inbox's own screen.
          */}
          {latestLeads.length > 0 ? (
            <div className="platform-latest">
              <h3>Latest enquiries</h3>
              <ul>
                {latestLeads.map((lead) => (
                  <li key={lead.id}>
                    <span className="platform-latest__who">
                      <strong>{lead.company || lead.name}</strong>
                      <small>
                        {lead.siteRange ? `${lead.siteRange} sites · ` : ""}
                        {relativeTime(lead.createdAt)}
                      </small>
                    </span>
                    <span className="platform-pill">{lead.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card
          id="clients"
          title="Client workspaces"
          icon="building"
          action={{ href: "/admin/clients", label: "Manage clients" }}
          className="platform-card--wide"
          landmark={false}
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

        {/*
          Answer 1A: the theme and the portal's modules are real, and they belong to
          ONE workspace. This card says which, shows what that workspace has set, and
          links to its own Settings — it never edits anything itself.
        */}
        <Card
          id="portal"
          title="Portal & theme"
          icon="settings"
          className="platform-card--portal"
        >
          <p className="platform-card__lede">
            {current ? (
              <>
                For <strong>{current.name}</strong>, the workspace this console is pointed at. Brand, modules and
                icons are set per workspace.
              </>
            ) : (
              <>Brand, modules and icons are set per workspace, on each workspace&apos;s Settings page.</>
            )}
          </p>
          <ul className="platform-rows">
            <StatRow
              href="/dashboard/settings"
              icon="grid"
              label="Portal modules"
              read={reads.modules}
              onRetry={() => retry("modules")}
              describe={(payload: ModulesPayload) => {
                const modules = payload.modules ?? [];
                const on = modules.filter((module) => module.enabled).length;
                return { note: `${on} of ${modules.length} switched on`, value: `${on}/${modules.length}` };
              }}
            />
            <StatRow
              href="/dashboard/settings"
              icon="spark"
              label="Brand & theme"
              read={reads.theme}
              onRetry={() => retry("theme")}
              describe={(payload: ThemePayload) => {
                const tokens = payload.tokens ?? [];
                const changed = tokens.filter((token) => !token.isDefault).length;
                return changed
                  ? { note: `${changed} of ${tokens.length} settings changed`, value: "Custom" }
                  : { note: "Default colours, type and corners", value: "Default" };
              }}
            />
            <StatRow
              href="/dashboard/settings"
              icon="image"
              label="Workspace logo"
              read={reads.logo}
              onRetry={() => retry("logo")}
              describe={(payload: LogoPayload) =>
                payload.logo
                  ? { note: "On the portal and its reports", value: "Set", tone: "good" }
                  : { note: "None uploaded yet", value: "None" }
              }
            />
          </ul>
          <div className="platform-card__actions">
            <Link className="platform-button" href="/dashboard/settings">
              Open settings
            </Link>
            <a className="platform-button platform-button--quiet" href="/admin/clients">
              Switch workspace
            </a>
          </div>
        </Card>

        <Card
          id="activity"
          title="Recent activity"
          icon="activity"
          action={{ href: "/admin/audit", label: "Audit log" }}
          className="platform-card--activity"
        >
          {activity ? (
            events.length === 0 ? (
              <p className="platform-card__note">Nothing has been recorded yet.</p>
            ) : (
              <ol className="platform-activity">
                {events.slice(0, 6).map((event) => {
                  const workspace = eventWorkspaces.find((entry) => entry.id === event.organisationId);
                  return (
                    <li key={event.id}>
                      <span className="platform-activity__dot" aria-hidden="true" />
                      <span className="platform-activity__copy">
                        <strong>{event.summary}</strong>
                        <small>
                          {workspace ? workspace.name : "Platform"} · {relativeTime(event.createdAt)}
                        </small>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )
          ) : (
            <CardState read={reads.activity} onRetry={() => retry("activity")} lines={5} />
          )}
        </Card>

        <Card
          id="system"
          title="System"
          icon="shield"
          action={{ href: "/admin/backups", label: "Backups" }}
          className="platform-card--system"
        >
          {system ? (
            <dl className="platform-facts">
              <div>
                <dt>Database schema</dt>
                <dd className={system.migrations?.current ? "is-good" : "is-warn"}>
                  {system.migrations?.current ? "Up to date" : "Behind this build"}
                  <small>
                    Fingerprint <code>{system.migrations?.codeFingerprint}</code>
                  </small>
                </dd>
              </div>
              <div>
                <dt>Database</dt>
                <dd className={system.database?.configured ? "is-good" : "is-warn"}>
                  {system.database?.configured ? "Connected" : "Not configured"}
                  <small>{system.database?.name}</small>
                </dd>
              </div>
              <div>
                <dt>File storage</dt>
                <dd className={system.storage?.configured ? "is-good" : "is-warn"}>
                  {system.storage?.configured ? "Configured" : "Not configured"}
                  <small>{system.storage?.name}</small>
                </dd>
              </div>
              <div>
                <dt>Backups</dt>
                <dd>
                  {system.backups?.provider ?? "—"}
                  <small>
                    {system.backups?.visible
                      ? "Status reported by the provider"
                      : "Taken by the provider; the portal cannot read their status"}
                  </small>
                </dd>
              </div>
            </dl>
          ) : (
            <CardState read={reads.backups} onRetry={() => retry("backups")} lines={4} />
          )}
        </Card>
      </div>

      <PlatformMap />
    </div>
  );
}

export default PlatformOverview;
