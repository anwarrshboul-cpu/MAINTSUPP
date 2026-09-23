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
 */

import Link from "next/link";
import { useState } from "react";

import { BrandMark, Icon } from "../../components";
import { AccountMenu, type AccountSnapshot } from "../portal/account-menu";
import { useAppliedTheme } from "../portal/theme";
import { AdminClientsView } from "../portal/views/admin-clients";
import { AdminRolesView } from "../portal/views/admin-roles";
import { AdminUsersView } from "../portal/views/admin-users";
import { AuditLog } from "../portal/views/audit-log";
import { useScrollOverflow } from "../portal/views/scroll-affordance";
import {
  PLATFORM_ELSEWHERE,
  PLATFORM_SECTIONS,
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
  /*
   * Below the rail's breakpoint it stops being a column and becomes a sideways
   * strip. `useScrollOverflow` measures the state rather than assuming it, so the
   * fade cannot claim there is more to see once there is not — the same reason
   * `AccountShell` uses it.
   */
  const railRef = useScrollOverflow<HTMLElement>();
  useAppliedTheme();

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
        <Link className="platform-topbar__back" href="/dashboard">
          <Icon name="arrow" size={16} />
          <span>Back to workspace</span>
        </Link>
        <div className="platform-topbar__spacer" />
        <AccountMenu
          userName={userName}
          userEmail={userEmail}
          snapshot={snapshot}
          onSnapshotChange={setSnapshot}
          onNotify={notify}
        />
      </header>

      <div className="platform-body">
        <nav className="platform-rail" aria-label="Platform administration" ref={railRef}>
          <div>
            <h2>Platform</h2>
            {PLATFORM_SECTIONS.map((entry) => (
              <a
                key={entry.key || "dashboard"}
                href={platformSectionPath(entry.key)}
                title={entry.blurb}
                className={entry.key === active.key ? "is-active" : ""}
                aria-current={entry.key === active.key ? "page" : undefined}
              >
                <Icon name={entry.icon} size={16} />
                {entry.label}
              </a>
            ))}
          </div>
          <div>
            <h2>Elsewhere</h2>
            {PLATFORM_ELSEWHERE.map((entry) => (
              <a key={entry.href} href={entry.href}>
                <Icon name={entry.icon} size={16} />
                {entry.label}
              </a>
            ))}
          </div>
        </nav>

        <main className="platform-main">
          <div className="platform-heading">
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
