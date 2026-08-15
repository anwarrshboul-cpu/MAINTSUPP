"use client";

/**
 * The frame every screen behind the avatar menu sits in.
 *
 * The rail repeats the menu's own two columns — Account then Explore, in the
 * same order — so the menu and the pages agree about where things are. That is
 * monday's arrangement too: the menu is a shortcut into a settings area laid out
 * the same way, not a separate taxonomy.
 *
 * Deliberately not the portal shell. Rebuilding the dashboard sidebar here would
 * duplicate navigation another part of the app owns and would drift from it the
 * first time either changed; the top bar carries a link back instead.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BrandMark, Icon, type IconName } from "../../../components";
import { AccountMenu, type AccountSnapshot } from "../account-menu";
import { useAppliedTheme } from "../theme";
import { ACCOUNT_PANELS } from "./account-panels";
import { AccountError, AccountLoading } from "./account-ui";
import { AccountProfilePanel } from "./account-profile";
import {
  AccountArchivePanel,
  AccountBillingPanel,
  AccountTrashPanel,
  AccountWorkspacesPanel,
} from "./account-workspace";
import {
  AccountDevelopersPanel,
  AccountIntegrationsPanel,
} from "./account-platform";
import { useScrollOverflow } from "./scroll-affordance";
import {
  AccountBetaPanel,
  AccountHelpPanel,
  AccountInvitePanel,
  AccountMobilePanel,
  AccountShortcutsPanel,
  AccountThemePanel,
} from "./account-explore";
import "./account-views.css";


/**
 * Items that live in the avatar menu but are built elsewhere. Linked, never
 * reimplemented — and shown in the rail so the account area does not look like
 * it is missing them.
 */
const ELSEWHERE = [
  { href: "/dashboard/admin", label: "Administration", icon: "shield" as IconName },
  { href: "/dashboard/teams", label: "Teams", icon: "users" as IconName },
  { href: "/dashboard?manage=import", label: "Import data", icon: "upload" as IconName },
];

export function AccountShell({ panel }: { panel: string }) {
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /*
   * Below 900px the rail stops being a column and becomes a sideways strip of
   * twelve destinations, of which a phone shows three. See
   * scroll-affordance.ts — the state is measured, so the fade cannot claim
   * there is more to see once there is not.
   */
  const railRef = useScrollOverflow<HTMLElement>();

  /*
   * The account screens live outside the portal, which used to be the only
   * thing that set the theme attribute — hence the hard-coded "dark" that was
   * here. It was doing real damage: on /dashboard/account it was the ONLY
   * write, so an explicit Light choice was discarded and the whole area was a
   * permanently dark island whatever the user had picked.
   *
   * The intent behind it is kept, not deleted. The attribute is stamped on
   * `<html>` and `<body>` by the blocking script in app/(app)/layout.tsx before
   * anything paints, on every route in this group including these ones, and
   * `useAppliedTheme` keeps it in step afterwards — this area carries no theme
   * control of its own, so without it a device flip or a change made in another
   * tab would not reach these screens until a navigation. The account area
   * still never renders on an unthemed base; it just renders in the theme the
   * reader actually asked for.
   */
  useAppliedTheme();

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/account", {
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json()) as {
          account?: AccountSnapshot;
          error?: string;
        };
        if (!response.ok || !payload.account) {
          throw new Error(payload.error || "The account could not be loaded.");
        }
        setSnapshot(payload.account);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "The account could not be loaded.",
        );
      }
    })();
  }, []);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const active =
    ACCOUNT_PANELS.find((entry) => entry.key === panel) ?? ACCOUNT_PANELS[0];

  const body = () => {
    if (error) return <AccountError message={error} />;
    if (!snapshot) return <AccountLoading label="Loading your account" />;

    switch (active.key) {
      case "developers":
        return <AccountDevelopersPanel />;
      case "workspaces":
        return <AccountWorkspacesPanel snapshot={snapshot} onNotify={notify} />;
      case "trash":
        // Stage 23 — Trash restores and permanently deletes now, so it reports
        // outcomes through the same notifier every other acting panel uses.
        return <AccountTrashPanel snapshot={snapshot} onNotify={notify} />;
      case "archive":
        return <AccountArchivePanel snapshot={snapshot} onNotify={notify} />;
      case "integrations":
        return <AccountIntegrationsPanel />;
      case "mobile":
        return <AccountMobilePanel />;
      case "beta":
        return <AccountBetaPanel />;
      case "shortcuts":
        return <AccountShortcutsPanel />;
      case "invite":
        return <AccountInvitePanel snapshot={snapshot} onNotify={notify} />;
      case "help":
        return <AccountHelpPanel />;
      case "theme":
        return (
          <AccountThemePanel
            snapshot={snapshot}
            onSnapshotChange={setSnapshot}
            onNotify={notify}
          />
        );
      case "billing":
        return <AccountBillingPanel snapshot={snapshot} />;
      default:
        return (
          <AccountProfilePanel
            snapshot={snapshot}
            onSnapshotChange={setSnapshot}
            onNotify={notify}
          />
        );
    }
  };

  const groups: Array<"Account" | "Explore"> = ["Account", "Explore"];

  return (
    <div className="account-page">
      <header className="account-topbar">
        <Link className="account-topbar__brand" href="/dashboard" aria-label="MAINTSUPP dashboard">
          <BrandMark />
        </Link>
        <Link className="account-topbar__back" href="/dashboard">
          <Icon name="arrow" size={16} />
          <span>Back to workspace</span>
        </Link>
        <div className="account-topbar__spacer" />
        <AccountMenu
          userName={snapshot?.profile.fullName ?? "Account"}
          userEmail={snapshot?.profile.email ?? ""}
          snapshot={snapshot}
          onSnapshotChange={setSnapshot}
          onNotify={notify}
        />
      </header>

      <div className="account-body">
        <nav className="account-rail" aria-label="Account settings" ref={railRef}>
          {groups.map((group) => (
            <div key={group}>
              <h2>{group}</h2>
              {ACCOUNT_PANELS.filter((entry) => entry.group === group).map((entry) => (
                <a
                  key={entry.key || "profile"}
                  href={`/dashboard/account${entry.key ? `/${entry.key}` : ""}`}
                  className={entry.key === active.key ? "is-active" : ""}
                  aria-current={entry.key === active.key ? "page" : undefined}
                >
                  <Icon name={entry.icon} size={16} />
                  {entry.label}
                </a>
              ))}
            </div>
          ))}
          <div>
            <h2>Elsewhere</h2>
            {ELSEWHERE.map((entry) => (
              <a key={entry.href} href={entry.href}>
                <Icon name={entry.icon} size={16} />
                {entry.label}
              </a>
            ))}
          </div>
        </nav>

        <main className="account-main">{body()}</main>
      </div>

      {toast && (
        <div className="account-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

export default AccountShell;
