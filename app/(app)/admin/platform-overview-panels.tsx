"use client";
/* eslint-disable @next/next/no-img-element -- every picture here is a website media
   file or a workspace logo from this app's own routes, already web-sized; this Node
   build has no `next/image` optimiser to hand it to (as site-media-view.tsx says). */

/**
 * The platform console Overview's panels — visual pass, round 2 (2026-09-25).
 *
 * THE RULE EVERY PANEL KEEPS. The owner's reference console is dense and
 * live-looking; this one is dense and TRUE. Each panel below draws only what an
 * existing API already answered (read by `platform-overview.tsx`, one request at
 * a time) and links to the screen that edits it. Owner answers, 2026-09-25:
 *
 *   2A  reference-like density; card text never below 12px.
 *   4A  the integrations list mirrors Account → Integrations word for word,
 *       "Not configured" rows included — it is the product's own truthful list.
 *   5A  the one chart counts ENQUIRIES RECEIVED, and says so; there are no web
 *       analytics in this product and the chart does not pretend otherwise.
 *   6B  the brand snapshot shows colour chips and the icons a workspace has
 *       actually chosen — no sample chart shapes that could be read as data.
 *   7A  the homepage hero is a read-only snapshot of the real copy, marked as a
 *       snapshot; the public page is not loaded here.
 *
 * Theme, modules and icons stay owned by each workspace's Settings (answer 1A,
 * 2026-09-24): these panels summarise the current workspace and link there. No
 * control on this screen changes anything — there are no switches, only status.
 */

import Link from "next/link";
import { type ReactNode } from "react";

import { Icon, type IconName } from "../../components";
import { relativeTime } from "../portal/views/admin-shell";
import { formatDayMonth } from "../../lib/format-date";
import {
  choiceLabel,
  enquiriesByDay,
  pageStateCounts,
  parseStamp,
  summariseDays,
  websitePageRows,
  type PageState,
} from "../../lib/platform-overview-model";

/* ------------------------------------------------------------------ */
/* Read state, shared with the screen                                  */
/* ------------------------------------------------------------------ */

export type ReadState =
  | { status: "loading" }
  | { status: "ready"; data: unknown }
  | { status: "refused"; message: string }
  | { status: "failed"; message: string };

export function ready<T>(state: ReadState | undefined): T | null {
  return state?.status === "ready" ? (state.data as T) : null;
}

/* ------------------------------------------------------------------ */
/* Payload shapes — only the fields a panel reads                      */
/* ------------------------------------------------------------------ */

type Edited = { stored: boolean; updatedAt: string | null; updatedByEmail: string | null };

export type HeroCopy = {
  kicker?: string;
  titleLead?: string;
  titleAccent?: string;
  lede?: string;
  pills?: string[];
  bookLabel?: string;
  reportLabel?: string;
};

export type CopyPayload = Edited & {
  pages: Array<{ key: string; label: string; path: string }>;
  resolved?: { home?: { copy?: { hero?: HeroCopy }; heroImage?: string | null; sections?: string[] } };
};

export type PagesPayload = {
  pages: Array<{
    id: string;
    slug: string;
    title: string;
    state: PageState;
    updatedAt: string;
    updatedByEmail: string | null;
  }>;
  redirects?: unknown[];
};

export type NavigationPayload = Edited & {
  navigation: {
    primary: Array<{ id: string; label: string; href: string; hidden?: boolean }>;
    footer: Array<{ id: string; heading: string; links: Array<{ hidden?: boolean }> }>;
  };
};

export type MediaItem = {
  id: string;
  kind: "image" | "video" | "document";
  title: string;
  altText: string | null;
  updatedAt: string;
  updatedByEmail: string | null;
  current: { url: string; display: { url: string } | null; originalName: string } | null;
};

export type MediaPayload = {
  items: MediaItem[];
  storage: { state: string; message: string | null };
  accept?: string;
  rules?: { maxVideoBytes?: number; maxFileBytes?: number };
};

/** "50 MB" for a byte limit the media API states. */
function megabytes(bytes: number | undefined): string | null {
  return typeof bytes === "number" && bytes > 0 ? `${Math.round(bytes / 1048576)} MB` : null;
}

/** The accepted extensions from the upload `accept` string, upper-cased once each. */
function acceptedTypes(accept: string | undefined): string {
  const extensions = (accept ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("."))
    .map((entry) => entry.slice(1).toUpperCase());
  return [...new Set(extensions.map((entry) => (entry === "JPEG" ? "JPG" : entry)))].join(", ");
}

export type InboxPayload = { open: number; counts: Record<string, number> };

export type LeadsPayload = InboxPayload & {
  enquiries: Array<{
    id: string;
    name: string;
    company: string | null;
    siteRange: string | null;
    status: string;
    createdAt: string;
  }>;
};

export type ModulesPayload = { modules: Array<{ key: string; label: string; enabled: boolean }> };

export type ThemePayload = {
  tokens: Array<{
    key: string;
    label: string;
    kind: "colour" | "font" | "choice";
    value: string;
    isDefault: boolean;
    choices: Array<{ key: string; label: string }> | null;
  }>;
};

export type LogoPayload = { logo: { url: string; originalName: string } | null };

export type PortalNavPayload = {
  layout: {
    groups: Array<{
      label: string;
      items: Array<{ key: string; label: string; icon: string | null; hidden: boolean }>;
    }>;
  };
};

export type RolesPayload = {
  roles: Array<{ key: string; label: string }>;
  capabilities: Array<{ key: string; label: string }>;
  effective: Record<string, Record<string, boolean>>;
};

export type AuditPayload = {
  events: Array<{ id: string; summary: string; createdAt: string; organisationId: string | null }>;
  workspaces: Array<{ id: string; name: string }>;
};

export type BackupsPayload = {
  backups: { provider: string; visible: boolean };
  database: { name: string; configured: boolean };
  storage: { name: string; configured: boolean };
  migrations: { current: boolean; codeFingerprint: string; appliedAt: string | null };
};

export type PlatformPayload = {
  platform: {
    integrations: Array<{ key: string; name: string; category: string; configured: boolean; detail: string }>;
  };
};

/* ------------------------------------------------------------------ */
/* Frame pieces                                                        */
/* ------------------------------------------------------------------ */

export function Card({
  id,
  title,
  icon,
  action,
  className,
  landmark = true,
  meta,
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
  /** A short fact beside the title — "19 of 19 on", "0 files". */
  meta?: ReactNode;
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
          <Icon name={icon} size={16} />
        </span>
        <span className="platform-card__titles">
          <h2 id={`platform-card-${id}`}>{title}</h2>
          {meta ? <span className="platform-card__meta">{meta}</span> : null}
        </span>
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

/** A panel's own loading, refusal or failure, drawn where its content will go. */
export function CardState({
  read,
  onRetry,
  lines = 3,
}: {
  read: ReadState | undefined;
  onRetry: () => void;
  lines?: number;
}) {
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

/** A small status word in a pill — never a control. */
function StatusPill({ tone, children }: { tone: "good" | "warn" | "muted" | "info"; children: ReactNode }) {
  return <span className={`platform-status platform-status--${tone}`}>{children}</span>;
}

const STATE_LABEL: Record<PageState, string> = {
  live: "Live",
  draft: "Draft",
  scheduled: "Scheduled",
  ended: "Ended",
};

const STATE_TONE: Record<PageState, "good" | "warn" | "muted" | "info"> = {
  live: "good",
  draft: "muted",
  scheduled: "info",
  ended: "warn",
};

/** "just now" mid-sentence; the shared helper capitalises it as an opener. */
function when(stamp: string | null | undefined): string {
  const text = relativeTime(stamp);
  return text === "Just now" ? "just now" : text;
}

/* ------------------------------------------------------------------ */
/* Page management                                                     */
/* ------------------------------------------------------------------ */

export function PagesPanel({
  copy,
  pages,
  onRetry,
}: {
  copy: ReadState | undefined;
  pages: ReadState | undefined;
  onRetry: () => void;
}) {
  const copyData = ready<CopyPayload>(copy);
  const pagesData = ready<PagesPayload>(pages);
  const cms = pagesData?.pages ?? [];
  const counts = pageStateCounts(cms);
  const rows =
    copyData || pagesData
      ? websitePageRows(copyData?.pages ?? [], copyData?.stored ? copyData.updatedAt : null, cms)
      : [];
  const redirects = pagesData?.redirects?.length ?? 0;

  return (
    <Card
      id="pages"
      title="Page management"
      icon="document"
      action={{ href: "/admin/pages", label: "Manage pages" }}
      className="platform-card--pages"
      meta={
        pagesData
          ? `${(copyData?.pages.length ?? 0) + cms.length} pages · ${counts.live} CMS live · ${counts.draft} draft`
          : null
      }
    >
      {rows.length === 0 ? (
        <CardState read={pagesData ? copy : pages} onRetry={onRetry} lines={5} />
      ) : (
        <div className="platform-mini-table" role="region" aria-label="Website pages" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">Address</th>
                <th scope="col">Status</th>
                <th scope="col">Changed</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 7).map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    <a href={row.href}>{row.title}</a>
                    <small>{row.kind === "built-in" ? "Built-in · words in Website copy" : "Written in the CMS"}</small>
                  </th>
                  <td>
                    <code>{row.address}</code>
                  </td>
                  <td>
                    <StatusPill tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</StatusPill>
                  </td>
                  <td className="platform-mini-table__muted">
                    {row.changedAt ? when(row.changedAt) : "As shipped"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pagesData ? (
        <dl className="platform-mini-stats">
          <div>
            <dt>Built-in</dt>
            <dd>{copyData?.pages.length ?? "…"}</dd>
          </div>
          <div>
            <dt>CMS live</dt>
            <dd>{counts.live}</dd>
          </div>
          <div>
            <dt>Drafts</dt>
            <dd>{counts.draft}</dd>
          </div>
          <div>
            <dt>Scheduled</dt>
            <dd>{counts.scheduled}</dd>
          </div>
          <div>
            <dt>Redirects</dt>
            <dd>{redirects}</dd>
          </div>
        </dl>
      ) : null}
      <p className="platform-card__footnote">
        {rows.length > 7 ? `${rows.length - 7} more on Website pages. ` : ""}
        Built-in pages are always live; their words are edited under <a href="/admin/copy">Website copy</a>.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Homepage hero — a snapshot, not an editor (answer 7A)               */
/* ------------------------------------------------------------------ */

export function HeroPanel({
  copy,
  media,
  onRetry,
}: {
  copy: ReadState | undefined;
  media: ReadState | undefined;
  onRetry: () => void;
}) {
  const data = ready<CopyPayload>(copy);
  const hero = data?.resolved?.home?.copy?.hero;
  const imageId = data?.resolved?.home?.heroImage ?? null;
  const image = imageId ? ready<MediaPayload>(media)?.items.find((item) => item.id === imageId) : undefined;
  const imageUrl = image?.current ? image.current.display?.url ?? image.current.url : null;
  const sections = data?.resolved?.home?.sections?.length ?? null;

  return (
    <Card
      id="hero"
      title="Homepage hero"
      icon="home"
      action={{ href: "/admin/copy", label: "Edit copy" }}
      className="platform-card--hero"
      meta={data ? (data.stored ? `Edited ${when(data.updatedAt)}` : "As shipped") : null}
    >
      {!hero ? (
        <CardState read={copy} onRetry={onRetry} lines={5} />
      ) : (
        <>
          {/*
            Styled after the public hero so it is recognisable at a glance, and
            labelled as what it is: the words the live page prints, read from
            `/api/site-content`. Nothing here is clickable except the two links
            below it, and the calls to action are listed as words, not drawn as
            buttons that would do nothing.
          */}
          <figure className="platform-hero" aria-label="Snapshot of the live homepage hero">
            <div className="platform-hero__copy">
              {hero.kicker ? <span className="platform-hero__kicker">{hero.kicker}</span> : null}
              <p className="platform-hero__title">
                {hero.titleLead} <span>{hero.titleAccent}</span>
              </p>
              {hero.lede ? <p className="platform-hero__lede">{hero.lede}</p> : null}
              {hero.pills && hero.pills.length > 0 ? (
                <ul className="platform-hero__pills">
                  {hero.pills.map((pill) => (
                    <li key={pill}>{pill}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            {imageUrl ? (
              <img
                className="platform-hero__image"
                src={imageUrl}
                alt={image?.altText || image?.title || "Hero image"}
                loading="lazy"
              />
            ) : null}
            <figcaption className="platform-hero__caption">
              <span className="platform-hero__badge">Snapshot</span>
              Calls to action: {[hero.bookLabel, hero.reportLabel].filter(Boolean).join(" · ") || "none"}
              {sections !== null ? ` · ${sections} sections on the page` : ""}
              {imageId ? (imageUrl ? " · library image" : " · image not in the library") : " · no library image chosen"}
            </figcaption>
          </figure>
          <p className="platform-card__links">
            <a href="/admin/copy">Edit hero copy</a>
            <a href="/" target="_blank" rel="noopener noreferrer">
              View the live page <Icon name="arrow" size={12} />
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Brand & design — the current workspace's real tokens (6B)           */
/* ------------------------------------------------------------------ */

export function BrandPanel({
  workspace,
  theme,
  logo,
  portalNav,
  onRetry,
}: {
  workspace: string | null;
  theme: ReadState | undefined;
  logo: ReadState | undefined;
  portalNav: ReadState | undefined;
  onRetry: () => void;
}) {
  const tokens = ready<ThemePayload>(theme)?.tokens ?? null;
  const logoData = ready<LogoPayload>(logo);
  const nav = ready<PortalNavPayload>(portalNav);
  const colours = tokens?.filter((token) => token.kind === "colour") ?? [];
  const font = (key: string) => {
    const token = tokens?.find((entry) => entry.key === key);
    return token ? choiceLabel(token.value, token.choices) : "—";
  };
  const choice = (key: string) => {
    const token = tokens?.find((entry) => entry.key === key);
    return token ? choiceLabel(token.value, token.choices).replace(" (MAINTSUPP default)", "") : "—";
  };
  const changed = tokens?.filter((token) => !token.isDefault).length ?? 0;
  const items = nav?.layout.groups.flatMap((group) => group.items) ?? [];
  const customIcons = items.filter((item) => item.icon);
  const hidden = items.filter((item) => item.hidden).length;

  return (
    <Card
      id="brand"
      title="Brand & design"
      icon="spark"
      action={{ href: "/dashboard/settings", label: "Settings" }}
      className="platform-card--brand"
      meta={workspace ? `${workspace} · ${tokens ? (changed ? `${changed} changed` : "default theme") : "…"}` : null}
    >
      {!tokens ? (
        <CardState read={theme} onRetry={onRetry} lines={5} />
      ) : (
        <>
          <ul className="platform-swatches" aria-label="Brand colours">
            {colours.map((token) => (
              <li key={token.key}>
                {/* The colour is the workspace's data, so it is set inline. */}
                <span className="platform-swatch" style={{ background: token.value }} aria-hidden="true" />
                <span className="platform-swatch__copy">
                  <strong title={token.label}>
                    {token.key === "brand.primary" ? "Primary" : token.label.replace(/ colour$/i, "")}
                  </strong>
                  <code>{token.value.toUpperCase()}</code>
                </span>
              </li>
            ))}
          </ul>
          <dl className="platform-pairs">
            <div>
              <dt>Body</dt>
              <dd>{font("type.body")}</dd>
            </div>
            <div>
              <dt>Headings</dt>
              <dd>{font("type.display")}</dd>
            </div>
            <div>
              <dt>Corners</dt>
              <dd>{choice("shape.corners")}</dd>
            </div>
            <div>
              <dt>Panels</dt>
              <dd>{choice("surface.depth")}</dd>
            </div>
            <div>
              <dt>Logo</dt>
              <dd>
                {logoData?.logo ? (
                  <img className="platform-logo" src={logoData.logo.url} alt={`${workspace ?? "Workspace"} logo`} />
                ) : logoData ? (
                  "None uploaded"
                ) : (
                  "…"
                )}
              </dd>
            </div>
            <div>
              <dt>Sidebar</dt>
              <dd>
                {nav ? (
                  <>
                    {items.length} entries{hidden ? ` · ${hidden} hidden` : ""}
                    {customIcons.length ? (
                      <span className="platform-icon-row" aria-label={`${customIcons.length} custom icons`}>
                        {customIcons.slice(0, 6).map((item) => (
                          <span key={item.key} title={item.label}>
                            <Icon name={item.icon as IconName} size={14} />
                          </span>
                        ))}
                      </span>
                    ) : (
                      " · default icons"
                    )}
                  </>
                ) : (
                  "…"
                )}
              </dd>
            </div>
          </dl>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Navigation structure                                                */
/* ------------------------------------------------------------------ */

export function NavigationPanel({ navigation, onRetry }: { navigation: ReadState | undefined; onRetry: () => void }) {
  const data = ready<NavigationPayload>(navigation);
  const primary = data?.navigation.primary ?? [];
  const shown = primary.filter((link) => !link.hidden);
  let footerLinks = 0;
  for (const group of data?.navigation.footer ?? []) footerLinks += group.links.filter((link) => !link.hidden).length;

  return (
    <Card
      id="navigation"
      title="Navigation"
      icon="menu"
      action={{ href: "/admin/navigation", label: "Edit" }}
      className="platform-card--quarter"
      meta={data ? (data.stored ? `Edited ${when(data.updatedAt)}` : "Built-in menus") : null}
    >
      {!data ? (
        <CardState read={navigation} onRetry={onRetry} lines={6} />
      ) : (
        <>
          {/* The header menu as the site prints it — the shown links, in order. */}
          <div className="platform-menu-preview" aria-label="Header menu as shown on the site">
            <span className="platform-menu-preview__brand">MAINTSUPP</span>
            {shown.slice(0, 6).map((link) => (
              <span key={link.id}>{link.label}</span>
            ))}
          </div>
          <ul className="platform-list">
            {primary.map((link) => (
              <li key={link.id}>
                <span className="platform-list__main platform-list__main--inline">
                  <strong>{link.label}</strong>
                  <code>{link.href}</code>
                </span>
                <StatusPill tone={link.hidden ? "muted" : "good"}>{link.hidden ? "Hidden" : "Shown"}</StatusPill>
              </li>
            ))}
          </ul>
          <p className="platform-card__footnote">
            Footer: {data.navigation.footer.length} groups · {footerLinks} links shown
          </p>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Media library                                                       */
/* ------------------------------------------------------------------ */

const KIND_ICON: Record<MediaItem["kind"], IconName> = { image: "image", video: "camera", document: "document" };

export function MediaPanel({ media, onRetry }: { media: ReadState | undefined; onRetry: () => void }) {
  const data = ready<MediaPayload>(media);
  const items = data?.items ?? [];
  const byKind = { image: 0, video: 0, document: 0 };
  for (const item of items) byKind[item.kind] += 1;
  const video = megabytes(data?.rules?.maxVideoBytes);
  const other = megabytes(data?.rules?.maxFileBytes);
  const limits = [video ? `video ${video}` : null, other ? `others ${other}` : null].filter(Boolean).join(" · ");

  return (
    <Card
      id="media"
      title="Media library"
      icon="image"
      action={{ href: "/admin/media", label: "Open" }}
      className="platform-card--quarter"
      meta={data ? `${items.length} file${items.length === 1 ? "" : "s"}` : null}
    >
      {!data ? (
        <CardState read={media} onRetry={onRetry} lines={4} />
      ) : items.length === 0 ? (
        <div className="platform-empty">
          <Icon name="upload" size={20} />
          <p>
            No files in the library yet. Images, video and PDFs uploaded under{" "}
            <a href="/admin/media">Website media</a> appear here.
          </p>
          {data.storage.state !== "ready" ? <StatusPill tone="warn">{data.storage.message ?? "Storage not ready"}</StatusPill> : null}
        </div>
      ) : null}
      {data && items.length > 0 ? (
        <>
          <ul className="platform-thumbs">
            {items.slice(0, 6).map((item) => {
              const src = item.kind === "image" && item.current ? item.current.display?.url ?? item.current.url : null;
              return (
                <li key={item.id}>
                  <a href="/admin/media" title={item.title}>
                    {src ? (
                      <img src={src} alt={item.altText || item.title} loading="lazy" />
                    ) : (
                      <span className="platform-thumbs__glyph" aria-hidden="true">
                        <Icon name={KIND_ICON[item.kind]} size={20} />
                      </span>
                    )}
                    <span className="platform-thumbs__name">{item.title}</span>
                  </a>
                </li>
              );
            })}
          </ul>
          <p className="platform-card__footnote">
            {byKind.image} images · {byKind.video} videos · {byKind.document} documents
          </p>
        </>
      ) : null}
      {data ? (
        /* The library's own rules, as the media API states them. */
        <dl className="platform-pairs platform-pairs--single">
          <div>
            <dt>Accepts</dt>
            <dd>{acceptedTypes(data.accept) || "—"}</dd>
          </div>
          <div>
            <dt>Largest file</dt>
            <dd>{limits || "—"}</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>{data.storage.state === "ready" ? "Ready" : data.storage.message ?? "Not ready"}</dd>
          </div>
        </dl>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Portal modules — status, never switches                             */
/* ------------------------------------------------------------------ */

export function ModulesPanel({
  workspace,
  modules,
  onRetry,
}: {
  workspace: string | null;
  modules: ReadState | undefined;
  onRetry: () => void;
}) {
  const list = ready<ModulesPayload>(modules)?.modules ?? null;
  const on = list?.filter((module) => module.enabled).length ?? 0;
  return (
    <Card
      id="modules"
      title="Portal modules"
      icon="grid"
      action={{ href: "/dashboard/settings", label: "Settings" }}
      className="platform-card--quarter"
      meta={list ? `${on} of ${list.length} on${workspace ? ` · ${workspace}` : ""}` : null}
    >
      {!list ? (
        <CardState read={modules} onRetry={onRetry} lines={6} />
      ) : (
        <ul className="platform-modules">
          {list.map((module) => (
            <li key={module.key} className={module.enabled ? "is-on" : "is-off"}>
              <span className="platform-modules__dot" aria-hidden="true" />
              <span className="platform-modules__label">{module.label}</span>
              <span className="platform-modules__state">{module.enabled ? "On" : "Off"}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Roles & access — from the workspaces read, no extra request         */
/* ------------------------------------------------------------------ */

export function AccessPanel({
  workspace,
  usersByRole,
  people,
  roles,
  onRetry,
}: {
  workspace: string | null;
  usersByRole: Record<string, number> | null;
  people: number | null;
  roles: ReadState | undefined;
  onRetry: () => void;
}) {
  const data = ready<RolesPayload>(roles);
  const total = data?.capabilities.length ?? 0;
  return (
    <Card
      id="access"
      title="Roles & access"
      icon="shield"
      action={{ href: "/admin/roles", label: "Roles" }}
      className="platform-card--quarter"
      meta={workspace && people !== null ? `${people} people · ${workspace}` : null}
    >
      {!data ? (
        <CardState read={roles} onRetry={onRetry} lines={5} />
      ) : (
        /*
         * The reference's "Roles & access" table, from the permission matrix the
         * Roles screen edits (`/api/admin/roles`, for the current workspace) and
         * the member counts the workspaces read already carries. Super Admin is
         * platform authority, not a membership, so it has no member count here.
         */
        <div className="platform-mini-table platform-mini-table--flush" role="region" aria-label="Roles" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col" className="is-numeric">People</th>
                <th scope="col" className="is-numeric">
                  Permissions<span className="visually-hidden">, of {total}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.roles.map((role) => {
                const granted = Object.values(data.effective[role.key] ?? {}).filter(Boolean).length;
                const members = usersByRole?.[role.label];
                return (
                  <tr key={role.key}>
                    <th scope="row">{role.label}</th>
                    <td className="is-numeric">{members !== undefined ? members.toLocaleString() : "—"}</td>
                    <td className="is-numeric">
                      {granted}
                      <span className="platform-mini-table__muted">/{total}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <nav className="platform-card__links" aria-label="Access screens">
        <a href="/admin/users">Users &amp; access</a>
        <a href="/admin/roles">Roles &amp; permissions</a>
        <a href="/admin/audit">Audit log</a>
      </nav>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Inbox, with enquiries received per day (answer 5A)                  */
/* ------------------------------------------------------------------ */

export function InboxPanel({
  leads,
  applications,
  now,
  onRetry,
}: {
  leads: ReadState | undefined;
  applications: ReadState | undefined;
  /** When the screen read the clock, so every render agrees about "today". */
  now: number;
  onRetry: () => void;
}) {
  const leadsData = ready<LeadsPayload>(leads);
  const appsData = ready<InboxPayload>(applications);
  const series = leadsData ? enquiriesByDay(leadsData.enquiries.map((lead) => lead.createdAt), now) : [];
  const { total, busiest } = summariseDays(series);
  const tallest = busiest?.count ?? 0;
  /* A `YYYY-MM-DD` day; the shared formatter reads a date-only value in UTC. */
  const dayLabel = (day: string) => formatDayMonth(day);
  const summary = leadsData
    ? `${total} enquir${total === 1 ? "y" : "ies"} received in the last 30 days${
        busiest ? `; busiest day ${dayLabel(busiest.day)}, with ${busiest.count}` : ""
      }.`
    : "";

  return (
    <Card
      id="inbox"
      title="Inbox"
      icon="inbox"
      action={{ href: "/admin/leads", label: "Enquiries" }}
      className="platform-card--inbox"
    >
      <div className="platform-inbox-stats">
        <a href="/admin/leads" className="platform-inbox-stat">
          <small>Open enquiries</small>
          <strong>{leadsData ? leadsData.open.toLocaleString() : "…"}</strong>
          <em>{leadsData ? `${(leadsData.counts.New ?? 0).toLocaleString()} not opened` : ""}</em>
        </a>
        <a href="/admin/applications" className="platform-inbox-stat">
          <small>Contractor applications</small>
          <strong>{appsData ? appsData.open.toLocaleString() : "…"}</strong>
          <em>{appsData ? `${(appsData.counts.New ?? 0).toLocaleString()} not opened` : ""}</em>
        </a>
      </div>

      {!leadsData ? (
        <CardState read={leads} onRetry={onRetry} lines={3} />
      ) : (
        <figure className="platform-chart">
          <figcaption>
            <strong>Enquiries received, last 30 days</strong>
            <span>From the public enquiry form — not website traffic.</span>
          </figcaption>
          <div className="platform-chart__bars" role="img" aria-label={summary}>
            {series.map((entry) => (
              <span
                key={entry.day}
                className={entry.count ? "has-value" : ""}
                style={{ height: `${tallest ? Math.max(entry.count ? 8 : 2, Math.round((entry.count / tallest) * 100)) : 2}%` }}
                title={`${dayLabel(entry.day)}: ${entry.count} enquir${entry.count === 1 ? "y" : "ies"}`}
              />
            ))}
          </div>
          <div className="platform-chart__axis" aria-hidden="true">
            <span>{series.length ? dayLabel(series[0].day) : ""}</span>
            <span>Today</span>
          </div>
          <p className="platform-chart__summary">{summary}</p>
        </figure>
      )}

      {leadsData && leadsData.enquiries.length > 0 ? (
        <div className="platform-latest">
          <h3>Latest enquiries</h3>
          <ul>
            {leadsData.enquiries.slice(0, 3).map((lead) => (
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
  );
}

/* ------------------------------------------------------------------ */
/* Recent activity                                                     */
/* ------------------------------------------------------------------ */

export function ActivityPanel({ activity, onRetry }: { activity: ReadState | undefined; onRetry: () => void }) {
  const data = ready<AuditPayload>(activity);
  const events = data?.events ?? [];
  const workspaces = data?.workspaces ?? [];
  return (
    <Card
      id="activity"
      title="Recent activity"
      icon="activity"
      action={{ href: "/admin/audit", label: "Audit log" }}
      className="platform-card--third"
    >
      {!data ? (
        <CardState read={activity} onRetry={onRetry} lines={6} />
      ) : events.length === 0 ? (
        <p className="platform-card__note">Nothing has been recorded yet.</p>
      ) : (
        <ol className="platform-activity">
          {events.slice(0, 7).map((event) => {
            const workspace = workspaces.find((entry) => entry.id === event.organisationId);
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
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Website changes — the reference's "Publishing & versions", honestly */
/* ------------------------------------------------------------------ */

type Change = { key: string; what: string; detail: string; at: string; by: string | null; tone: "good" | "muted" | "info" | "warn"; state: string };

export function ChangesPanel({
  copy,
  navigation,
  pages,
  media,
}: {
  copy: ReadState | undefined;
  navigation: ReadState | undefined;
  pages: ReadState | undefined;
  media: ReadState | undefined;
}) {
  const copyData = ready<CopyPayload>(copy);
  const navData = ready<NavigationPayload>(navigation);
  const pagesData = ready<PagesPayload>(pages);
  const mediaData = ready<MediaPayload>(media);
  /* Every source has answered, one way or another; a failed one shows its own
     error in its own panel, so this one never waits on it for ever. */
  const settled = [copy, navigation, pages, media].every((read) => read && read.status !== "loading");
  const incomplete = settled && !(copyData && navData && pagesData && mediaData);

  const changes: Change[] = [];
  if (copyData?.stored && copyData.updatedAt) {
    changes.push({ key: "copy", what: "Website copy", detail: "Built-in pages' words", at: copyData.updatedAt, by: copyData.updatedByEmail, tone: "good", state: "Saved" });
  }
  if (navData?.stored && navData.updatedAt) {
    changes.push({ key: "nav", what: "Website navigation", detail: "Header and footer menus", at: navData.updatedAt, by: navData.updatedByEmail, tone: "good", state: "Saved" });
  }
  for (const page of pagesData?.pages ?? []) {
    changes.push({ key: `page:${page.id}`, what: page.title, detail: `/p/${page.slug}`, at: page.updatedAt, by: page.updatedByEmail, tone: STATE_TONE[page.state], state: STATE_LABEL[page.state] });
  }
  for (const item of mediaData?.items ?? []) {
    changes.push({ key: `media:${item.id}`, what: item.title, detail: `Media · ${item.kind}`, at: item.updatedAt, by: item.updatedByEmail, tone: "info", state: "Uploaded" });
  }
  changes.sort((a, b) => (parseStamp(b.at) ?? 0) - (parseStamp(a.at) ?? 0));

  return (
    <Card
      id="changes"
      title="Website changes"
      icon="updates"
      action={{ href: "/admin/pages", label: "History" }}
      className="platform-card--third"
      meta="Last saved edits, newest first"
    >
      {!settled && changes.length === 0 ? (
        <CardState read={{ status: "loading" }} onRetry={() => undefined} lines={5} />
      ) : changes.length === 0 ? (
        <p className="platform-card__note">
          {incomplete
            ? "Some of the website could not be read just now; the panels above say which."
            : "Nothing on the website has been edited here yet: the copy and menus are the ones the site shipped with, and the CMS holds no pages or files. Every save will be listed here, and each page keeps its full history."}
        </p>
      ) : (
        <ol className="platform-timeline">
          {changes.slice(0, 6).map((change) => (
            <li key={change.key}>
              <span className="platform-timeline__main">
                <strong>{change.what}</strong>
                <small>
                  {change.detail} · {when(change.at)}
                  {change.by ? ` · ${change.by}` : ""}
                </small>
              </span>
              <StatusPill tone={change.tone}>{change.state}</StatusPill>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Integrations — Account → Integrations, word for word (answer 4A)    */
/* ------------------------------------------------------------------ */

export function IntegrationsPanel({ platform, onRetry }: { platform: ReadState | undefined; onRetry: () => void }) {
  const list = ready<PlatformPayload>(platform)?.platform.integrations ?? null;
  const configured = list?.filter((entry) => entry.configured).length ?? 0;
  return (
    <Card
      id="integrations"
      title="Integrations"
      icon="link"
      action={{ href: "/dashboard/account/integrations", label: "Details" }}
      className="platform-card--integrations"
      meta={list ? `${configured} of ${list.length} configured` : null}
    >
      {!list ? (
        <CardState read={platform} onRetry={onRetry} lines={6} />
      ) : (
        <ul className="platform-integrations">
          {list.map((entry) => (
            <li key={entry.key}>
              <span className="platform-integrations__main">
                <strong>{entry.name}</strong>
                <small title={entry.detail}>
                  {entry.category} · {entry.detail}
                </small>
              </span>
              <span className={`platform-status platform-status--${entry.configured ? "good" : "muted"}`}>
                <Icon name={entry.configured ? "check" : "close"} size={12} />
                {entry.configured ? "Configured" : "Not configured"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

export function SystemPanel({ backups, onRetry }: { backups: ReadState | undefined; onRetry: () => void }) {
  const system = ready<BackupsPayload>(backups);
  return (
    <Card
      id="system"
      title="System"
      icon="shield"
      action={{ href: "/admin/backups", label: "Backups" }}
      className="platform-card--system"
    >
      {!system ? (
        <CardState read={backups} onRetry={onRetry} lines={4} />
      ) : (
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
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* How the platform connects                                           */
/* ------------------------------------------------------------------ */

/**
 * The four places a person moves between, each a real address. The owner's
 * reference ends its console with the same band; here it is the one element that
 * says what the console is FOR: it edits the first, governs the second and
 * third, and configures the fourth.
 */
export function PlatformMap() {
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
