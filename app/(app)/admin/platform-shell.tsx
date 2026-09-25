"use client";

/**
 * The frame every Platform Super Admin screen sits in — Master Specification §5.
 *
 * DELIBERATELY A SIBLING OF `views/account-shell.tsx`, NOT A FORK OF `PortalApp`.
 *
 * That was the decision this phase turned on, so it is worth writing down. The
 * portal shell is a 10,000-line client component whose sidebar, topbar and content
 * switch are welded to one another and to twenty screens' worth of state: the
 * workspace switcher alone depends on six derived values and two async actions,
 * and five separate test files slice that file BY STRING INDEX between named
 * declarations, so moving any of them produces an empty slice rather than a loud
 * failure.
 *
 * `AccountShell` had this exact problem two phases ago and answered it in 230
 * lines, saying so in its own header: rebuilding the dashboard sidebar "would
 * duplicate navigation another part of the app owns and would drift from it the
 * first time either changed; the top bar carries a link back instead." This file
 * follows that answer rather than re-litigating it. Nothing under
 * `app/(app)/portal/portal-app.tsx` is touched by this phase.
 *
 * WHAT IS REUSED, WHICH IS ALMOST EVERYTHING THAT MATTERS
 *
 * The screens. `AdminClientsView`, `AdminUsersView`, `AdminRolesView` and
 * `AuditLog` are mounted here unchanged — they take no props, fetch their own
 * data, and refuse on their own through `useAdminResource`'s four-state model
 * (loading / loaded / denied / broken). `AdminUsersView` and `AdminRolesView`
 * already render a grouped workspace picker from `data.organisations`, so in a
 * platform shell they are a per-workspace platform console on the first day.
 *
 * The chrome. `BrandMark`, `Icon`, `AccountMenu` and `useAppliedTheme` are the
 * same four `AccountShell` reuses. The design tokens, both themes and the
 * per-workspace brand `:root` block arrive from `app/(app)/layout.tsx`, which
 * stamps them for everything under `(app)` — so this console is themed without a
 * line of work.
 *
 * WHY `useAppliedTheme()` IS NOT OPTIONAL HERE
 *
 * `AccountShell` learned this the hard way: it hard-coded `"dark"`, and because it
 * was the only write on its own routes an explicit Light choice was discarded and
 * the whole area became a permanently dark island. The blocking script in the
 * layout stamps the attribute before paint on every route in this group, and this
 * hook keeps it in step afterwards — this console carries no theme control of its
 * own, so without it a device flip or a change made in another tab would not reach
 * these screens until a navigation.
 *
 * WHY THE RAIL IS PLAIN ANCHORS AND NOT `SidebarNav`
 *
 * `SidebarNav` takes its catalogue as a prop and looks free. It is not: its
 * arrangement comes from `/api/navigation`, which merges against `BUILT_IN_ORDER`
 * and DROPS any key that list does not contain. Registering platform keys there
 * would demand a `sectionRoutes` entry in the portal's own route map for a screen
 * the portal does not have, and would trip four source-slice pins on the way.
 * Full-page anchors also mean every navigation re-enters `requirePlatformAdmin` on
 * the server, which is the property a console that reads every client's data
 * should want.
 *
 * THE 2026-09-24 VISUAL PASS (owner answers 1A, 2A, 3B)
 *
 * The frame now follows the owner's reference console: the brand sits above a
 * dark rail (the portal sidebar's own `--rail-*` tokens, so the two surfaces are
 * one product), the rail is drawn in groups (`PLATFORM_GROUPS`), and the top bar
 * carries the controls that have something real behind them — a search that
 * opens `/admin/search`, a link to the public website, the way back, the account
 * menu. The reference's "Platform Online", "Save Changes" and "Publish All" are
 * deliberately absent: there is no health endpoint and no platform-wide save or
 * publish, and a control with nothing behind it is the thing this console refuses.
 *
 * Below 1024px the rail is a disclosure: one button opens it under the top bar,
 * rather than the sideways strip it used to be, which hid ten of its thirteen
 * links off the edge of a phone.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { BrandMark, Icon } from "../../components";
import { AccountMenu, type AccountSnapshot } from "../portal/account-menu";
import { useAppliedTheme } from "../portal/theme";
import { AdminClientsView } from "../portal/views/admin-clients";
import { AdminRolesView } from "../portal/views/admin-roles";
import { AdminUsersView } from "../portal/views/admin-users";
import { AuditLog } from "../portal/views/audit-log";
import {
  PLATFORM_ELSEWHERE,
  PLATFORM_GROUPS,
  PLATFORM_SECTIONS,
  PLATFORM_WORKSPACE_LINKS,
  platformGroupOf,
  platformSection,
  platformSectionPath,
} from "../../lib/platform-sections";
import { ApplicationsInboxView } from "./applications-view";
import { BackupsView } from "./backups-view";
import { ConsoleSearchView } from "./console-search-view";
import { LeadsInboxView } from "./leads-view";
import { PlatformOverview } from "./platform-overview";
import { SiteCopyView } from "./site-copy-view";
import { SiteMediaView } from "./site-media-view";
import { SiteNavigationView } from "./site-navigation-view";
import { SitePagesView } from "./site-pages-view";
import "./platform-shell.css";

export function PlatformShell({
  section,
  userName,
  userEmail,
}: {
  /** A key from `PLATFORM_SECTIONS`. The empty string is the Dashboard. */
  section: string;
  /**
   * From the server's session, so the topbar has a name before any fetch lands.
   * `AccountShell` reads these out of `/api/account` and shows "Account" until it
   * arrives; the route here already holds the session, so there is no reason to
   * make the reader watch a placeholder.
   */
  userName: string;
  userEmail: string;
}) {
  useAppliedTheme();

  /*
   * The rail below 1024px: closed until asked for. Not a modal — it opens in the
   * page flow under the top bar, so focus is never trapped and the page behind it
   * stays reachable; Escape closes it and hands focus back to the button that
   * opened it. Every rail link is a full-page navigation, so a choice closes it
   * by loading the next screen.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  /*
   * Ctrl K / ⌘ K focuses the console's search, the shortcut the portal's own
   * search answers to — so one habit works on both surfaces. The field is a
   * plain GET form to `/admin/search`, which reads `?q=` and runs it.
   */
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      searchField.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* `AccountMenu` owns its own read of `/api/account` when handed null, so the
     console does not add a second fetch of it. Held here only so the menu can
     hand back an updated snapshot after somebody edits their own profile. */
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  };

  const active = platformSection(section) ?? PLATFORM_SECTIONS[0];
  const activeGroup = platformGroupOf(active.key);

  const body = () => {
    switch (active.key) {
      case "clients":
        /* `onSwitched` reloads, because switching workspace changes what every
           other screen in this console would answer — and the organisation cookie
           it sets is read on the server. A client-side state update would leave
           the rail's other screens describing the workspace that was current when
           the page loaded. */
        return <AdminClientsView onSwitched={() => window.location.reload()} />;
      case "search":
        return <ConsoleSearchView />;
      case "users":
        return <AdminUsersView />;
      case "roles":
        return <AdminRolesView />;
      case "audit":
        return <AuditLog />;
      case "pages":
        return <SitePagesView />;
      case "navigation":
        return <SiteNavigationView />;
      case "copy":
        return <SiteCopyView />;
      case "media":
        return <SiteMediaView />;
      case "leads":
        return <LeadsInboxView />;
      case "applications":
        return <ApplicationsInboxView />;
      case "backups":
        return <BackupsView />;
      default:
        return <PlatformOverview />;
    }
  };

  return (
    <div className="platform-page">
      <header className="platform-topbar">
        <div className="platform-topbar__identity">
          <button
            ref={menuButton}
            type="button"
            className="platform-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="platform-rail"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name={menuOpen ? "close" : "menu"} size={20} />
            <span className="visually-hidden">{menuOpen ? "Close the menu" : "Open the menu"}</span>
          </button>
          <Link
            className="platform-topbar__brand"
            href="/admin"
            aria-label="MAINTSUPP platform console"
          >
            <BrandMark />
          </Link>
          {/*
            Said on the screen, not inferred from the URL. A console that looks like
            the client portal but answers across every client is worth labelling, and
            this is the label — it is the one piece of chrome here that the portal
            shell does not have.
          */}
          <span className="platform-topbar__badge">Platform</span>
        </div>

        {/*
          A real search, not a picture of one: a GET form to the console's own
          Search screen, which reads `?q=` and runs it across every workspace. It
          works before hydration too, because it is only a form.
        */}
        <form className="platform-search" role="search" action="/admin/search" method="get">
          <Icon name="search" size={16} />
          <label className="visually-hidden" htmlFor="platform-search-q">
            Search every workspace
          </label>
          <input
            ref={searchField}
            id="platform-search-q"
            type="search"
            name="q"
            autoComplete="off"
            placeholder="Search jobs, stores, people, pages, enquiries…"
          />
          <kbd aria-hidden="true">Ctrl K</kbd>
        </form>

        <div className="platform-topbar__actions">
          <a className="platform-topbar__link" href="/" target="_blank" rel="noopener noreferrer">
            <Icon name="link" size={16} />
            <span>Visit website</span>
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          <Link className="platform-topbar__back" href="/dashboard">
            <Icon name="arrow" size={16} />
            <span>Back to workspace</span>
          </Link>
          <AccountMenu
            userName={userName}
            userEmail={userEmail}
            snapshot={snapshot}
            onSnapshotChange={setSnapshot}
            onNotify={notify}
          />
        </div>
      </header>

      <div className="platform-body">
        <nav
          id="platform-rail"
          className={`platform-rail${menuOpen ? " is-open" : ""}`}
          aria-label="Platform administration"
        >
          {/*
            Who this console answers to, said once at the top of the rail. The
            name is the session's own; "Platform staff" is what `requirePlatformAdmin`
            has just established on the server to render this at all.
          */}
          <div className="platform-rail__identity">
            <span className="platform-rail__identity-mark" aria-hidden="true">
              <Icon name="shield" size={18} />
            </span>
            <span>
              <strong>MAINTSUPP platform</strong>
              <small>Platform staff · {userName}</small>
            </span>
          </div>

          {PLATFORM_GROUPS.map((group) => (
            <div className="platform-rail__group" key={group.key}>
              <h2>{group.label}</h2>
              {group.sections.map((key) => {
                const entry = platformSection(key);
                if (!entry) return null;
                const current = entry.key === active.key;
                return (
                  <a
                    key={entry.key || "overview"}
                    href={platformSectionPath(entry.key)}
                    title={entry.blurb}
                    className={current ? "is-active" : ""}
                    aria-current={current ? "page" : undefined}
                  >
                    <Icon name={entry.icon} size={17} />
                    <span>{entry.label}</span>
                  </a>
                );
              })}
              {PLATFORM_WORKSPACE_LINKS.filter((link) => link.group === group.key).map((link) => (
                /* Leaves the console for the workspace's own Settings — marked,
                   so nobody takes it for a platform-wide control (answer 1A). */
                <a key={link.href} href={link.href} title={link.blurb} className="platform-rail__out">
                  <Icon name={link.icon} size={17} />
                  <span>{link.label}</span>
                  <Icon name="arrow" size={14} />
                </a>
              ))}
            </div>
          ))}

          <div className="platform-rail__group platform-rail__group--elsewhere">
            <h2>Elsewhere</h2>
            {PLATFORM_ELSEWHERE.map((entry) => (
              /* Titled, because on a desktop the rail shows these three as icons
                 in one row; the label stays in the markup for a screen reader. */
              <a key={entry.href} href={entry.href} title={entry.label}>
                <Icon name={entry.icon} size={17} />
                <span>{entry.label}</span>
              </a>
            ))}
          </div>
        </nav>

        <main className="platform-main">
          <div className="platform-heading">
            {activeGroup ? <span className="platform-heading__eyebrow">{activeGroup.label}</span> : null}
            <h1>{active.label}</h1>
            <p>{active.blurb}</p>
          </div>
          {body()}
        </main>
      </div>

      {toast && (
        <div className="platform-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

export default PlatformShell;
