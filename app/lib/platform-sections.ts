/**
 * The Platform Super Admin console's screens — Master Specification §5.
 *
 * WHY THIS IS A PLAIN MODULE AND NOT PART OF THE SHELL
 *
 * The same reason `views/account-panels.ts` is: the routes under `app/(app)/admin`
 * are server components, and importing a value out of a `"use client"` file gives
 * back a client reference rather than the array — so a route could not read the
 * keys from there. The shell's rail and every route's slug check read this.
 *
 * WHY THIS IS A NEW LIST RATHER THAN AN EXTENSION OF THE PORTAL'S
 *
 * `BUILT_IN_ORDER` in `app/api/navigation/layout.ts` is the PORTAL's catalogue,
 * and four separate test files hold it level with `navPrimary`, `navSecondary`,
 * `sectionMeta` and `sectionRoutes` in `portal-app.tsx` — by slicing those files
 * between named declarations. Registering a platform key there would demand a
 * `sectionRoutes` entry in the portal's own route map for a screen the portal does
 * not have, and `/api/navigation`'s resolver would then try to arrange it in a
 * sidebar it never appears in.
 *
 * So this console owns its own list and its own rail. That is the choice
 * `views/account-shell.tsx` already made, in its own words: rebuilding the
 * dashboard sidebar "would duplicate navigation another part of the app owns and
 * would drift from it the first time either changed".
 *
 * WHY FIVE SCREENS AND NOT TEN
 *
 * The console is the shell plus the screens that EXIST. Five platform reads exist
 * today and every one is mounted here:
 *
 *   Dashboard   `GET /api/admin/clients` totals — platform-wide already
 *   Clients     `AdminClientsView`
 *   Users       `AdminUsersView`, which already renders a workspace picker
 *   Roles       `AdminRolesView`
 *   Audit       `GET /api/audit`, which is already platform-wide for a Super
 *               Admin and is the only route that also returns workspace-less
 *               events
 *
 * Branding, Integrations, Billing and platform Settings are NOT listed. Each
 * needs a server side that does not exist — in Billing's case a payment
 * integration this product has never had — and a rail entry leading to an empty
 * screen is the "configuration that does not affect components" this codebase
 * refuses everywhere else. They arrive with their APIs or not at all.
 *
 * Reconcile is not listed either, and that is a different reason: `/admin/reconcile`
 * already exists and already means something else. It is a redirect into the
 * workspace screen, the screen refuses outside non-production, and the tool is a
 * workspace harness rather than a platform view. Moving it here would take a URL
 * that has a documented meaning and quietly change it.
 */

import type { IconName } from "../components";
import type { Capability } from "./permissions";

export type PlatformSection = {
  /** URL segment under `/admin`. The empty string is the console's own root. */
  key: string;
  label: string;
  icon: IconName;
  /** One line under the heading, and the rail's title attribute. */
  blurb: string;
  /**
   * The capability the screen's own API enforces, or null where reaching the
   * console at all is the only rule.
   *
   * It is NOT the gate on the route — `requirePlatformAdmin` is, because a
   * Platform Super Admin holds every capability by construction (`can()` returns
   * true for `super_admin` before it reads anything). This is recorded so the
   * console and the API cannot drift, and so a reader can see which API answers.
   */
  capability: Capability | null;
};

/**
 * In the order the console presents them: the overview, then the platform's
 * tenants, then its people, then what they may do, then what they did.
 */
export const PLATFORM_SECTIONS: readonly PlatformSection[] = [
  {
    key: "",
    label: "Dashboard",
    icon: "home",
    blurb: "Every client workspace on this installation, and what each holds.",
    capability: "clients.view_all",
  },
  {
    key: "clients",
    label: "Clients",
    icon: "building",
    blurb: "The client workspaces, their plans, and a way into each.",
    capability: "clients.view_all",
  },
  {
    key: "users",
    label: "Users & access",
    icon: "users",
    blurb: "Who is in which workspace, and at what role.",
    capability: "users.view",
  },
  {
    key: "roles",
    label: "Roles & permissions",
    icon: "shield",
    blurb: "What each role may do, per workspace.",
    capability: "roles.edit",
  },
  {
    key: "audit",
    label: "Audit log",
    icon: "list",
    blurb: "What happened, who did it, and where — across every workspace.",
    capability: "audit.read",
  },
] as const;

export const PLATFORM_SECTION_KEYS: readonly string[] = PLATFORM_SECTIONS.map((s) => s.key);

/** The section a slug names, or null. The empty slug is the Dashboard. */
export function platformSection(key: string): PlatformSection | null {
  return PLATFORM_SECTIONS.find((section) => section.key === key) ?? null;
}

/** Where a section lives. `/admin` for the Dashboard, `/admin/<key>` otherwise. */
export function platformSectionPath(key: string): string {
  return key ? `/admin/${key}` : "/admin";
}

/**
 * Screens the console links to rather than reimplements.
 *
 * `views/account-shell.tsx` does the same with its `ELSEWHERE` list, for the
 * reason it gives: a shell that quietly grew its own copy of another area's
 * screen would drift from it the first time either changed. These are the two
 * platform-adjacent tools that already have a home.
 */
export const PLATFORM_ELSEWHERE: ReadonlyArray<{
  href: string;
  label: string;
  icon: IconName;
}> = [
  { href: "/dashboard", label: "Back to the workspace", icon: "arrow" },
  { href: "/dashboard/account", label: "Your own account", icon: "user" },
];
