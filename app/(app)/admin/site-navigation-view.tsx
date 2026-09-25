"use client";

/**
 * The website's navigation, edited — decision J (§77 item 11).
 *
 * The header menu (the desktop bar and the phone drawer draw the same list)
 * and the footer's four link lists. Platform staff add, rename, reorder, hide
 * and re-point links here; the site's frame — the logo, the header's own three
 * buttons, the contact details — is listed as fixed rather than offered as a
 * control that does not exist.
 *
 * EVERY RULE IS THE SERVER'S. `GET /api/site-navigation` carries the limits,
 * the locked links with their reasons, and the destinations a link may take;
 * this screen draws them and stages a whole navigation locally, then sends it
 * once. A refusal arrives as the server's own sentence (`validateNavigation`).
 * The two checks made here as well — the header's link count and its label
 * budget — are drawn from the server's own numbers, so they cannot disagree
 * with it; they only say so before the Save rather than after.
 *
 * WHOLE-DOCUMENT SAVE, CONDITIONAL. The save names the revision it was opened
 * at, so a second editor's save in between is refused (409) rather than
 * silently overwritten.
 */

import { useMemo, useState } from "react";

import { Icon } from "../../components";
import { formatShortDateTime } from "../../lib/format-date";
import { headerFit } from "../../lib/site-navigation";
import { useUnsavedChanges } from "../../lib/use-unsaved-changes";
import { AdminFlash, AdminLoading, AdminNotice, adminWrite, useAdminResource } from "../portal/views/admin-shell";
import { VersionHistory } from "../portal/views/version-history";
import "./site-pages.css";
import "./site-navigation.css";

/* The server's shapes, mirrored: what crosses the wire. */
type Link = { id: string; label: string; href: string; hidden: boolean };
type Group = { id: string; heading: string; links: Link[] };
type Navigation = { primary: Link[]; footer: Group[] };
type Destination = { href: string; label: string; state?: "draft" | "scheduled" | "live" | "ended" };

type Payload = {
  canEdit: boolean;
  stored: boolean;
  revision: number | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
  navigation: Navigation;
  defaults: Navigation;
  rules: {
    primaryMaxVisible: number;
    primaryMaxLinks: number;
    primaryLabelMax: number;
    footerLabelMax: number;
    headingMax: number;
    groupMaxLinks: number;
  };
  locked: Array<{ id: string; group: string; href: string; reason: string }>;
  fixed: string[];
  destinations: { anchors: Destination[]; routes: Destination[]; pages: Destination[] };
  cacheSeconds: number;
};

const OTHER = "__other__";

const newId = () => `link-${Math.random().toString(36).slice(2, 10)}`;

const STATE_WORD: Record<NonNullable<Destination["state"]>, string> = {
  draft: "a draft",
  scheduled: "scheduled, not yet live",
  live: "live",
  ended: "past its publishing window",
};

export function SiteNavigationView() {
  const { data, loading, denied, error, reload } = useAdminResource<Payload>("/api/site-navigation");
  const [draft, setDraft] = useState<Navigation | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  /* The editor works on a local copy; with none yet, it shows what the server has. */
  const working = draft ?? data?.navigation ?? null;
  const dirty = draft !== null && data !== null && JSON.stringify(draft) !== JSON.stringify(data?.navigation);
  const confirmLeave = useUnsavedChanges(dirty);

  const lockOf = useMemo(() => new Map((data?.locked ?? []).map((entry) => [entry.id, entry])), [data]);
  const pages = useMemo(() => new Map((data?.destinations.pages ?? []).map((entry) => [entry.href, entry])), [data]);

  const change = (update: (current: Navigation) => Navigation) =>
    setDraft((current) => {
      const base = current ?? data?.navigation;
      return base ? update(structuredClone(base)) : current;
    });

  /** Edit one link wherever it lives: `list` is "primary" or a footer group id. */
  const editLink = (list: string, id: string, patch: Partial<Link>) =>
    change((current) => {
      const links = list === "primary" ? current.primary : current.footer.find((group) => group.id === list)?.links ?? [];
      const target = links.find((entry) => entry.id === id);
      if (target) Object.assign(target, patch);
      return current;
    });

  const listOf = (current: Navigation, list: string) =>
    list === "primary" ? current.primary : (current.footer.find((group) => group.id === list)?.links ?? []);

  const moveLink = (list: string, id: string, by: number) =>
    change((current) => {
      const links = listOf(current, list);
      const index = links.findIndex((entry) => entry.id === id);
      const target = index + by;
      if (index < 0 || target < 0 || target >= links.length) return current;
      const [moved] = links.splice(index, 1);
      links.splice(target, 0, moved);
      return current;
    });

  const removeLink = (list: string, id: string) =>
    change((current) => {
      const links = listOf(current, list);
      const index = links.findIndex((entry) => entry.id === id);
      if (index >= 0) links.splice(index, 1);
      return current;
    });

  const addLink = (list: string) =>
    change((current) => {
      /* A new link starts hidden in the header, so adding one can never push the
         bar past its budget before it has even been named. */
      listOf(current, list).push({ id: newId(), label: "New link", href: "#services", hidden: list === "primary" });
      return current;
    });

  const renameGroup = (id: string, heading: string) =>
    change((current) => {
      const group = current.footer.find((entry) => entry.id === id);
      if (group) group.heading = heading;
      return current;
    });

  const save = async () => {
    if (!draft || !data) return;
    setSaving(true);
    const result = await adminWrite("/api/site-navigation", "PUT", { navigation: draft, expectedRevision: data.revision });
    setSaving(false);
    setFlash({
      ok: result.ok,
      message: result.ok
        ? `Saved. The site shows it now for you, and for every visitor within ${data.cacheSeconds} seconds.`
        : result.message,
    });
    if (result.ok) {
      setDraft(null);
      await reload();
    }
  };

  const reset = async () => {
    if (!data) return;
    if (!window.confirm("Go back to the built-in navigation? The current one stays in the version history and can be restored.")) return;
    setSaving(true);
    const result = await adminWrite("/api/site-navigation", "PUT", { reset: true, expectedRevision: data.revision });
    setSaving(false);
    setFlash({ ok: result.ok, message: result.ok ? "Back to the built-in navigation." : result.message });
    if (result.ok) {
      setDraft(null);
      await reload();
    }
  };

  if (loading && !data) return <AdminLoading label="Loading the website's navigation…" />;
  if (denied) {
    return (
      <AdminNotice tone="denied" icon="shield" title="This screen is for MAINTSUPP platform staff">
        {denied} The server refused this request — the screen is not hidden behind a button.
      </AdminNotice>
    );
  }
  if (error || !data || !working) {
    return (
      <AdminNotice tone="error" icon="alert" title="The website navigation could not be loaded">
        {error ?? "That could not be loaded."}
      </AdminNotice>
    );
  }

  const shown = working.primary.filter((entry) => !entry.hidden);
  /* The same pixel check the server makes (`headerFit`, a pure module), so the
     meter and the Save button can never disagree with the refusal. */
  const fit = headerFit(shown.map((entry) => entry.label.trim()));
  const overCount = shown.length > data.rules.primaryMaxVisible;
  const overBudget = !fit.fits;

  const destinationNote = (href: string): string | null => {
    const match = /^\/p\/([a-z0-9-]+)$/.exec(href);
    if (!match) return null;
    const page = pages.get(href);
    if (!page) return `There is no website page at ${href}, so visitors do not see this link.`;
    if (page.state !== "live") return `${href} is ${STATE_WORD[page.state ?? "draft"]}; visitors see this link only while the page is live.`;
    return null;
  };

  const row = (list: string, link: Link, index: number, count: number) => {
    const lock = lockOf.get(link.id) ?? null;
    const labelMax = list === "primary" ? data.rules.primaryLabelMax : data.rules.footerLabelMax;
    const known = [...data.destinations.anchors, ...data.destinations.routes, ...data.destinations.pages].some(
      (entry) => entry.href === link.href,
    );
    const note = destinationNote(link.href);
    return (
      <li key={link.id} className={`site-nav__row${link.hidden ? " site-nav__row--hidden" : ""}`}>
        <label className="admin-field site-nav__label">
          <span>Label</span>
          <input
            maxLength={labelMax}
            value={link.label}
            onChange={(event) => editLink(list, link.id, { label: event.target.value })}
          />
        </label>
        <label className="admin-field site-nav__dest">
          <span>Goes to</span>
          {lock ? (
            <input readOnly value={link.href} aria-describedby={`lock-${link.id}`} />
          ) : (
            <select
              value={known ? link.href : OTHER}
              onChange={(event) =>
                editLink(list, link.id, { href: event.target.value === OTHER ? "https://" : event.target.value })
              }
            >
              <optgroup label="Home page sections">
                {data.destinations.anchors.map((entry) => (
                  <option key={entry.href} value={entry.href}>
                    {entry.label} ({entry.href})
                  </option>
                ))}
              </optgroup>
              <optgroup label="Site pages">
                {data.destinations.routes.map((entry) => (
                  <option key={entry.href} value={entry.href}>
                    {entry.label} ({entry.href})
                  </option>
                ))}
              </optgroup>
              {data.destinations.pages.length > 0 && (
                <optgroup label="Website pages">
                  {data.destinations.pages.map((entry) => (
                    <option key={entry.href} value={entry.href}>
                      {entry.label} ({entry.href}){entry.state && entry.state !== "live" ? ` — ${entry.state}` : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={OTHER}>Another site (https://…)</option>
            </select>
          )}
        </label>
        {!lock && !known && (
          <label className="admin-field site-nav__other">
            <span>Address</span>
            <input
              inputMode="url"
              placeholder="https://example.com/page"
              value={link.href}
              onChange={(event) => editLink(list, link.id, { href: event.target.value })}
            />
            <small>Another site opens in a new tab. Only https:// addresses are accepted.</small>
          </label>
        )}
        <div className="site-nav__actions">
          {lock ? (
            <span className="site-nav__lock" id={`lock-${link.id}`}>
              <Icon name="shield" size={14} /> Locked — {lock.reason}
            </span>
          ) : (
            <label className="site-nav__toggle">
              <input
                type="checkbox"
                checked={!link.hidden}
                onChange={(event) => editLink(list, link.id, { hidden: !event.target.checked })}
              />
              Shown on the site
            </label>
          )}
          <button
            type="button"
            className="secondary-button admin-mini"
            aria-label={`Move ${link.label} up`}
            disabled={index === 0}
            onClick={() => moveLink(list, link.id, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="secondary-button admin-mini"
            aria-label={`Move ${link.label} down`}
            disabled={index === count - 1}
            onClick={() => moveLink(list, link.id, 1)}
          >
            ↓
          </button>
          {!lock && (
            <button
              type="button"
              className="secondary-button admin-mini admin-mini--danger"
              aria-label={`Remove ${link.label}`}
              onClick={() => removeLink(list, link.id)}
            >
              Remove
            </button>
          )}
        </div>
        {note && <p className="site-nav__note">{note}</p>}
      </li>
    );
  };

  return (
    <div className="admin-console cms-admin site-nav">
      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />

      <div className="admin-toolbar">
        <strong>Website navigation</strong>
        <span className="admin-subtle">
          {data.stored
            ? `Saved ${data.updatedAt ? formatShortDateTime(data.updatedAt) : ""}${data.updatedByEmail ? ` by ${data.updatedByEmail}` : ""}`
            : "The built-in navigation — nothing has been saved here yet."}
        </span>
        <span className="admin-toolbar__spacer" />
        {dirty && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              if (confirmLeave()) setDraft(null);
            }}
          >
            Discard changes
          </button>
        )}
        {data.stored && !dirty && (
          <button className="secondary-button" type="button" disabled={saving} onClick={() => void reset()}>
            Reset to built-in
          </button>
        )}
        <button
          className="primary-button"
          type="button"
          disabled={!dirty || saving || overCount || overBudget}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save navigation"}
        </button>
      </div>

      <p className="site-nav__intro">
        A save shows on the site straight away for you, and for every visitor within {data.cacheSeconds} seconds. A link
        to a website page appears only while that page is live, and a hidden link stays here without reaching the
        page.
      </p>

      {/* JUMP TO A PANEL (visual pass, round 2): links to the panels' own headings;
          it moves the page and changes nothing. */}
      <nav className="platform-jump" aria-label="Jump to a menu">
        <span className="platform-jump__label">Jump to</span>
        <a href="#site-nav-header">Header menu</a>
        {working.footer.map((group) => (
          <a key={group.id} href={`#site-nav-${group.id}`}>
            Footer — {group.heading || group.id}
          </a>
        ))}
        <a href="#site-nav-fixed">Fixed links</a>
      </nav>

      <section className="admin-panel site-nav__panel" aria-labelledby="site-nav-header">
        <h2 id="site-nav-header" className="site-nav__heading">
          Header menu
        </h2>
        <p className="site-nav__meter" role="status">
          {shown.length} of {data.rules.primaryMaxVisible} links shown · {Math.round((fit.usedPx / fit.roomPx) * 100)}% of the
          bar&apos;s width on the tightest laptop screen. The desktop bar and the phone menu show the same list; the six
          links that ship already fill the bar, so a longer label needs another one shortened or hidden.
          {overCount && ` The header shows at most ${data.rules.primaryMaxVisible} — hide one or move it to the footer.`}
          {overBudget && ` The labels are ${Math.ceil(fit.usedPx - fit.roomPx)}px too wide for the bar — shorten one or hide a link.`}
        </p>
        <ol className="site-nav__list">
          {working.primary.map((link, index) => row("primary", link, index, working.primary.length))}
        </ol>
        <button
          type="button"
          className="secondary-button"
          disabled={working.primary.length >= data.rules.primaryMaxLinks}
          onClick={() => addLink("primary")}
        >
          <Icon name="plus" size={16} /> Add a header link
        </button>
      </section>

      {working.footer.map((group) => (
        <section key={group.id} className="admin-panel site-nav__panel" aria-labelledby={`site-nav-${group.id}`}>
          <h2 id={`site-nav-${group.id}`} className="site-nav__heading">
            Footer — {group.heading || group.id}
            {group.id === "legal" && <small> (drawn under Contact)</small>}
          </h2>
          <label className="admin-field site-nav__group-heading">
            <span>Heading</span>
            <input
              maxLength={data.rules.headingMax}
              value={group.heading}
              onChange={(event) => renameGroup(group.id, event.target.value)}
            />
          </label>
          <ol className="site-nav__list">
            {group.links.map((link, index) => row(group.id, link, index, group.links.length))}
          </ol>
          <button
            type="button"
            className="secondary-button"
            disabled={group.links.length >= data.rules.groupMaxLinks}
            onClick={() => addLink(group.id)}
          >
            <Icon name="plus" size={16} /> Add a link to {group.heading || group.id}
          </button>
        </section>
      ))}

      <section className="admin-panel site-nav__panel" aria-labelledby="site-nav-fixed">
        <h2 id="site-nav-fixed" className="site-nav__heading">
          Always on the site
        </h2>
        <ul className="site-nav__fixed">
          {data.fixed.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      {/* §38 — every saved navigation, and a way back to any of them. A restore
          goes through the same save and the same locks, and is recorded as a new
          version. */}
      <VersionHistory
        subject="site_navigation"
        subjectKey="public"
        title="Navigation history"
        onRestored={() => {
          setDraft(null);
          setFlash({ ok: true, message: "Restored. The restore is saved as a new version." });
          void reload();
        }}
      />
    </div>
  );
}
