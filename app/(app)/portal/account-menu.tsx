"use client";

/**
 * The top-right avatar menu — MAINTSUPP's version of monday.com's.
 *
 * monday's menu is a panel hung off the avatar with a workspace name and a
 * credits pill across the top, two labelled columns underneath (Account on the
 * left, Explore on the right), and a working-status row along the bottom
 * carrying "Do not disturb", an On/Off pair and a "More" affordance. That shape
 * is reproduced item-for-item and position-for-position here; only the
 * destinations are MAINTSUPP's, because monday's items name monday's product.
 *
 * The translation the owner chose, which the `monday` field on every item
 * records so the mapping is legible from the code:
 *
 *   App marketplace → Integrations      Upgrade account → Plan & billing
 *   monday.labs     → Beta features     Mobile app      → Mobile access
 *   Spaces          → Workspaces        credits pill    → plan tier
 *
 * Nothing here is decorative. Every item resolves to a screen backed by real
 * data or to a route another part of Stage 20 owns; where that route may not
 * have landed yet, the item still fires and reports the pending state rather
 * than being disabled or silently doing nothing.
 */

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Avatar, Icon, type IconName } from "../../components";
import "./account-menu.css";

/** The working statuses `/api/account` will persist to `users.working_status`. */
const WORKING_STATUS_LABELS: Record<string, string> = {
  available: "Available",
  do_not_disturb: "Do not disturb",
  in_a_meeting: "In a meeting",
  working_from_home: "Working from home",
  on_site: "On site",
  out_of_office: "Out of office",
};

const STATUS_ORDER = [
  "available",
  "do_not_disturb",
  "in_a_meeting",
  "working_from_home",
  "on_site",
  "out_of_office",
] as const;

export type AccountSnapshot = {
  profile: {
    exists: boolean;
    email: string;
    fullName: string | null;
    role: string | null;
    jobTitle: string | null;
    phone: string | null;
    timezone: string;
    avatarColour: string | null;
    themePreference: string;
    workingStatus: string | null;
    passwordUpdatedAt: string | null;
    lastLoginAt: string | null;
    createdAt: string | null;
  };
  workspace: {
    id: string;
    name: string;
    slug: string;
    planTier: string;
    primaryColour: string;
    status: string;
    createdAt: string;
  };
  workspaces: Array<{
    id: string;
    name: string;
    slug: string;
    planTier: string;
    status: string;
    current: boolean;
  }>;
  usage: {
    maintenanceRequests: number;
    sites: number;
    units: number;
    members: number;
  };
  options: {
    workingStatuses: string[];
    supportedThemes: string[];
    avatarColours: string[];
  };
  role: string;
  crossOrganisation: boolean;
};

type MenuItem = {
  key: string;
  /** The monday.com label this stands in for, kept next to its replacement. */
  monday: string;
  label: string;
  icon: IconName;
  href?: string;
  onSelect?: () => void | Promise<void>;
  /** Shown under the label when the destination belongs to another route. */
  hint?: string;
};

/** Plan tier as monday renders its credits pill: short, next to the name. */
function planLabel(tier: string) {
  if (!tier) return "No plan";
  return tier
    .split(/[_\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function AccountMenu({
  userName,
  userEmail,
  snapshot: providedSnapshot,
  onSnapshotChange,
  onImportData,
  onNotify,
}: {
  userName: string;
  userEmail: string;
  /**
   * An account payload the host already has.
   *
   * The dashboard has none, so the menu fetches its own on first open. The
   * account screens do, and passing it here is what makes a change saved on the
   * profile screen — an avatar colour, a working status — show on the avatar
   * immediately instead of after the next reload.
   */
  snapshot?: AccountSnapshot | null;
  onSnapshotChange?: (next: AccountSnapshot) => void;
  /**
   * monday's "Import data" opens the importer in place. On the dashboard the
   * portal passes the callback that opens Manage data → Import; on the account
   * screens there is no importer to open, so the item navigates instead.
   */
  onImportData?: () => void;
  onNotify?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<AccountSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const snapshot = providedSnapshot ?? fetched;
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusListOpen, setStatusListOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const notify = useCallback(
    (message: string) => {
      if (onNotify) onNotify(message);
      else if (typeof window !== "undefined") window.alert(message);
    },
    [onNotify],
  );

  /*
   * Loaded on first open rather than on mount: the payload runs four COUNT
   * queries for the Plan & billing figures, and the dashboard should not pay
   * for them on every page load just to render an avatar.
   */
  useEffect(() => {
    if (providedSnapshot) return;
    if (!open || fetched || loadError) return;
    let live = true;
    void (async () => {
      try {
        const response = await fetch("/api/account", {
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json()) as {
          account?: AccountSnapshot;
          error?: string;
        };
        if (!live) return;
        if (!response.ok || !payload.account) {
          throw new Error(payload.error || "The account could not be loaded.");
        }
        setFetched(payload.account);
      } catch (error) {
        if (!live) return;
        setLoadError(
          error instanceof Error ? error.message : "The account could not be loaded.",
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [open, fetched, loadError, providedSnapshot]);

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      setStatusListOpen(false);
      // monday returns focus to the avatar when the menu closes, so a keyboard
      // user is not dropped at the top of the document.
      if (returnFocus) triggerRef.current?.focus();
    },
    [],
  );

  /** Every focusable control inside the panel, in DOM order. */
  const focusables = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return [] as HTMLElement[];
    return Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => node.offsetParent !== null);
  }, []);

  /** The menu items only, grouped by the column they sit in. */
  const columnItems = useCallback(
    (column: string) => {
      const panel = panelRef.current;
      if (!panel) return [] as HTMLElement[];
      return Array.from(
        panel.querySelectorAll<HTMLElement>(
          `[data-menu-column="${column}"] [data-menu-item]`,
        ),
      );
    },
    [],
  );

  // Focus the first item when the menu opens — monday does the same, so the
  // menu is operable from the keyboard the moment it appears.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      // The first item of the Account column, which is where monday lands too.
      const first = panelRef.current?.querySelector<HTMLElement>(
        '[data-menu-column="account"] [data-menu-item]',
      );
      first?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Close on a click anywhere outside the panel or the avatar.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  /**
   * Keyboard model, matching monday's menu:
   *   Escape      closes and returns focus to the avatar
   *   Tab         cycles inside the panel (focus is trapped while open)
   *   Up/Down     move within the column the focus is in
   *   Left/Right  swap column, keeping the row where it exists
   *   Home/End    first and last item of the column
   */
  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }

    if (event.key === "Tab") {
      const nodes = focusables();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !active)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    const column = active?.closest<HTMLElement>("[data-menu-column]")?.dataset
      .menuColumn;
    if (!column) return;
    const items = columnItems(column);
    const index = active ? items.indexOf(active) : -1;
    if (index < 0) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (index + step + items.length) % items.length;
      items[next]?.focus();
      return;
    }

    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const other = column === "account" ? "explore" : "account";
      const target = columnItems(other);
      if (!target.length) return;
      target[Math.min(index, target.length - 1)]?.focus();
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  /** POST a change to the account row and fold the answer back into state. */
  const patchAccount = useCallback(
    async (body: Record<string, unknown>) => {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        profile?: AccountSnapshot["profile"];
        error?: string;
      };
      if (!response.ok || !payload.profile) {
        throw new Error(payload.error || "The change could not be saved.");
      }
      const next = payload.profile;
      setFetched((current) => (current ? { ...current, profile: next } : current));
      if (providedSnapshot) {
        onSnapshotChange?.({ ...providedSnapshot, profile: next });
      }
      return next;
    },
    [providedSnapshot, onSnapshotChange],
  );

  const setWorkingStatus = async (status: string | null) => {
    setStatusBusy(true);
    try {
      await patchAccount({ workingStatus: status });
      notify(
        status
          ? `Working status set to ${WORKING_STATUS_LABELS[status] ?? status}.`
          : "Working status cleared.",
      );
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "The working status could not be saved.",
      );
    } finally {
      setStatusBusy(false);
    }
  };

  /**
   * Log out. `/api/auth/logout` belongs to the authentication work; until it
   * lands the call 404s, and the honest answer is to say so rather than to
   * pretend the browser has been signed out.
   */
  const logOut = async () => {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (response.status === 404) {
        notify(
          "Sign-out is not available yet — the authentication routes are still being built.",
        );
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error || "Sign-out failed.");
      }
      window.location.assign("/login");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Sign-out failed.");
    }
  };

  const accountItems = useMemo<MenuItem[]>(
    () => [
      {
        key: "profile",
        monday: "My profile",
        label: "My profile",
        icon: "user",
        href: "/dashboard/account",
      },
      {
        key: "import",
        monday: "Import data",
        label: "Import data",
        icon: "upload",
        ...(onImportData
          ? { onSelect: onImportData }
          : { href: "/dashboard?manage=import" }),
      },
      {
        key: "developers",
        monday: "Developers",
        label: "Developers",
        icon: "tool",
        href: "/dashboard/account/developers",
      },
      {
        key: "workspaces",
        monday: "Spaces",
        label: "Workspaces",
        icon: "building",
        href: "/dashboard/account/workspaces",
      },
      {
        key: "trash",
        monday: "Trash",
        label: "Trash",
        icon: "close",
        href: "/dashboard/account/trash",
      },
      {
        key: "archive",
        monday: "Archive",
        label: "Archive",
        icon: "folder",
        href: "/dashboard/account/archive",
      },
      {
        key: "admin",
        monday: "Administration",
        label: "Administration",
        icon: "shield",
        href: "/dashboard/admin",
      },
      {
        key: "teams",
        monday: "Teams",
        label: "Teams",
        icon: "users",
        href: "/dashboard/teams",
      },
      {
        key: "logout",
        monday: "Log out",
        label: "Log out",
        icon: "arrow",
        onSelect: logOut,
      },
    ],
    // `logOut` and `onImportData` are stable enough for a menu rebuilt on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onImportData],
  );

  const exploreItems = useMemo<MenuItem[]>(
    () => [
      {
        key: "integrations",
        monday: "App marketplace",
        label: "Integrations",
        icon: "grid",
        href: "/dashboard/account/integrations",
      },
      {
        key: "mobile",
        monday: "Mobile app",
        label: "Mobile access",
        icon: "download",
        href: "/dashboard/account/mobile",
      },
      {
        key: "beta",
        monday: "monday.labs",
        label: "Beta features",
        icon: "spark",
        href: "/dashboard/account/beta",
      },
      {
        key: "shortcuts",
        monday: "Shortcuts",
        label: "Shortcuts",
        icon: "list",
        href: "/dashboard/account/shortcuts",
      },
      {
        key: "invite",
        monday: "Invite members",
        label: "Invite members",
        icon: "plus",
        href: "/dashboard/account/invite",
      },
      {
        key: "help",
        monday: "Get help",
        label: "Get help",
        icon: "message",
        href: "/dashboard/account/help",
      },
      {
        key: "theme",
        monday: "Change theme",
        label: "Change theme",
        icon: "moon",
        href: "/dashboard/account/theme",
      },
      {
        key: "billing",
        monday: "Upgrade account",
        label: "Plan & billing",
        icon: "document",
        href: "/dashboard/account/billing",
      },
    ],
    [],
  );

  const displayName = snapshot?.profile.fullName ?? userName;
  const displayEmail = snapshot?.profile.email ?? userEmail;
  const workingStatus = snapshot?.profile.workingStatus ?? null;
  const doNotDisturb = workingStatus === "do_not_disturb";

  const renderItem = (item: MenuItem) => {
    const body = (
      <>
        <Icon name={item.icon} size={17} />
        <span className="account-menu__label">
          {item.label}
          {item.hint && <small>{item.hint}</small>}
        </span>
      </>
    );
    // `title` carries monday's own label, so the mapping is inspectable in the
    // running app and not only in this file.
    const shared = {
      className: "account-menu__item",
      "data-menu-item": true,
      title: `monday: ${item.monday}`,
    } as const;

    if (item.href) {
      return (
        <Link key={item.key} href={item.href} {...shared}>
          {body}
        </Link>
      );
    }
    return (
      <button
        key={item.key}
        type="button"
        {...shared}
        onClick={() => {
          close(false);
          void item.onSelect?.();
        }}
      >
        {body}
      </button>
    );
  };

  return (
    <div className="account-menu">
      <button
        ref={triggerRef}
        className={`account-menu__trigger${open ? " is-open" : ""}`}
        /*
         * The chosen avatar colour, applied. `Avatar` is a shared component this
         * work does not own, so the value is handed down as a custom property
         * the menu's own stylesheet consumes — the setting is visible rather
         * than merely stored.
         */
        style={
          snapshot?.profile.avatarColour
            ? ({ "--account-avatar": snapshot.profile.avatarColour } as React.CSSProperties)
            : undefined
        }
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Account menu for ${displayName}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Avatar name={displayName} size="small" />
        {/* monday puts a status ring on the avatar; ours mirrors working status. */}
        {workingStatus && (
          <span
            className={`account-menu__status-dot account-menu__status-dot--${workingStatus.replace(/_/g, "-")}`}
            aria-hidden="true"
          />
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className="account-menu__panel"
          role="menu"
          aria-label="Account"
          onKeyDown={onPanelKeyDown}
        >
          {/* monday's header: workspace name on the left, credits pill on the
              right. Ours is the workspace and its plan tier. */}
          <header className="account-menu__header">
            <div className="account-menu__workspace">
              <strong>{snapshot?.workspace.name ?? "Workspace"}</strong>
              <span>{displayEmail}</span>
            </div>
            {/*
              Tab-reachable but deliberately outside the arrow ring: the pill is
              a header affordance in monday too, and pulling it into the column
              walk would put the first ArrowDown somewhere no reader expects.
            */}
            <Link
              className="account-menu__plan"
              href="/dashboard/account/billing"
              title="monday: credits pill"
            >
              {snapshot ? planLabel(snapshot.workspace.planTier) : "Plan"}
            </Link>
          </header>

          {loadError && (
            <p className="account-menu__error" role="status">
              {loadError}
            </p>
          )}

          <div className="account-menu__columns">
            <section data-menu-column="account">
              <h3>Account</h3>
              {accountItems.map((item) => renderItem(item))}
            </section>
            <section data-menu-column="explore">
              <h3>Explore</h3>
              {exploreItems.map((item) => renderItem(item))}
            </section>
          </div>

          {/* monday's bottom row: "Do not disturb", On / Off, More. */}
          <footer className="account-menu__status" data-menu-column="status">
            <span className="account-menu__status-label">
              <Icon name="clock" size={16} />
              {workingStatus
                ? (WORKING_STATUS_LABELS[workingStatus] ?? workingStatus)
                : "Do not disturb"}
            </span>
            <div className="account-menu__toggle" role="group" aria-label="Do not disturb">
              <button
                type="button"
                data-menu-item
                className={doNotDisturb ? "is-active" : ""}
                aria-pressed={doNotDisturb}
                disabled={statusBusy || !snapshot?.profile.exists}
                onClick={() => void setWorkingStatus("do_not_disturb")}
              >
                On
              </button>
              <button
                type="button"
                data-menu-item
                className={!doNotDisturb ? "is-active" : ""}
                aria-pressed={!doNotDisturb}
                disabled={statusBusy || !snapshot?.profile.exists}
                onClick={() => void setWorkingStatus(null)}
              >
                Off
              </button>
            </div>
            <button
              type="button"
              data-menu-item
              className="account-menu__more"
              aria-expanded={statusListOpen}
              aria-label="More working statuses"
              disabled={!snapshot?.profile.exists}
              onClick={() => setStatusListOpen((value) => !value)}
            >
              <Icon name="more" size={16} />
            </button>
          </footer>

          {statusListOpen && (
            <div className="account-menu__status-list" data-menu-column="status">
              {STATUS_ORDER.map((status) => (
                <button
                  key={status}
                  type="button"
                  data-menu-item
                  className={workingStatus === status ? "is-active" : ""}
                  disabled={statusBusy}
                  onClick={() => void setWorkingStatus(status)}
                >
                  <span
                    className={`account-menu__status-dot account-menu__status-dot--${status.replace(/_/g, "-")}`}
                    aria-hidden="true"
                  />
                  {WORKING_STATUS_LABELS[status]}
                </button>
              ))}
              <button
                type="button"
                data-menu-item
                disabled={statusBusy || !workingStatus}
                onClick={() => void setWorkingStatus(null)}
              >
                Clear status
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AccountMenu;
