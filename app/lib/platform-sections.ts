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
 * WHY SEVEN SCREENS AND NOT TEN
 *
 * The console is the shell plus the screens that EXIST. Seven platform surfaces
 * exist today and every one is mounted here:
 *
 *   Dashboard   `GET /api/admin/clients` totals — platform-wide already
 *   Clients     `AdminClientsView`
 *   Users       `AdminUsersView`, which already renders a workspace picker
 *   Roles       `AdminRolesView`
 *   Audit       `GET /api/audit`, which is already platform-wide for a Super
 *               Admin and is the only route that also returns workspace-less
 *               events
 *   Pages       `/api/site-pages` — a real read, write and delete, and a real
 *               public page at `/p/<slug>`
 *   Enquiries   `/api/leads`, whose GET was a hard 501 until it was listed
 *
 * The last two both prove the rule below rather than weakening it: each was listed
 * on the day it had a server side, and not before.
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
  /*
   * Website pages, added when its API arrived — which is the rule above being
   * kept rather than bent. `app/api/site-pages/route.ts` is a real read, a real
   * write and a real delete, gated on the same `scope.platformAdmin` this console
   * is, and `/p/<slug>` is a real public page.
   *
   * `capability: null` is the honest answer, and this was the first entry to need
   * it. The five above name the capability their own API enforces so the console
   * and the API cannot drift. This API enforces no capability at all: every
   * capability in this product is per-workspace, and MAINTSUPP's own marketing
   * site is not in a workspace — there is one of it, and an anonymous visitor
   * has no account to scope by. Reaching this console IS the rule, which is the
   * case the field was declared nullable for.
   */
  {
    key: "pages",
    label: "Website pages",
    icon: "document",
    blurb: "The pages of maintsupp.com that are edited rather than coded.",
    capability: null,
  },
  /*
   * Website navigation (decision J, §77 item 11), added with its API
   * (`/api/site-navigation`) — a real read, a real write, a restore — and next to
   * Website pages because it is the same website. `capability: null` for the
   * pages entry's reason: it is MAINTSUPP's own site, so no workspace capability
   * can reach it; `platformAdmin` is the gate.
   */
  {
    key: "navigation",
    label: "Website navigation",
    icon: "menu",
    blurb: "The header menu and footer links of maintsupp.com: add, rename, reorder, hide and re-point them.",
    capability: null,
  },
  /*
   * Website copy (decision L, §77 item 9), added with its API
   * (`/api/site-content`) and beside the other website screens, because it edits
   * the pages that ship with the site — the homepage, `/contractors` and `/faqs`
   * — rather than the pages written in the CMS. `capability: null` for the reason
   * the pages entry gives: MAINTSUPP's own site is in no workspace, so no
   * workspace capability can reach it; `platformAdmin` is the gate.
   */
  {
    key: "copy",
    label: "Website copy",
    icon: "edit",
    blurb: "The words on the pages that ship with maintsupp.com: headings, introductions, the hero, the questions and each page's search-engine text.",
    capability: null,
  },
  /*
   * Website media (decision K, §77 item 12), added with its API
   * (`/api/cms-media` and its upload route) and beside the other two website
   * screens. `capability: null` for the same reason: MAINTSUPP's own site, whose
   * files live in a bucket of their own and belong to no workspace.
   */
  {
    key: "media",
    label: "Website media",
    icon: "image",
    blurb: "The images, video and PDFs the website uses: upload, describe, replace, archive and delete them.",
    capability: null,
  },
  /*
   * Website enquiries, added when its API arrived — the same rule, kept again.
   * `GET /api/leads` was a hard 501, so there genuinely was nothing behind a rail
   * entry; now there is a read, a status write and an audit trail.
   *
   * `capability: null` here for a STRONGER reason than the entry above, and it is
   * worth keeping both statements because they are not the same argument. A public
   * enquiry has no account, so the intake route once filed it under the PRIMARY
   * active organisation — measured, a client company's workspace. A workspace
   * capability would therefore have shown that customer every enquiry MAINTSUPP has
   * ever received from its own website, and `scopedDb` would have delivered it
   * correctly. New enquiries now go to a platform-owned intake workspace
   * (`db/website-leads-workspace.ts`), and `platformAdmin` remains the only honest
   * gate for reading any of them.
   */
  {
    key: "leads",
    label: "Website enquiries",
    icon: "inbox",
    blurb: "What the public enquiry form has taken, and where each one has got to.",
    capability: null,
  },
  /*
   * Contractor applications, added when its API arrived — the same rule again.
   * `contractor_applications` had a writer (the public /contractors form) and no
   * reader at all; now there is a read and a status write at
   * `/api/contractor-applications/inbox`. `capability: null` for the leads
   * entry's stronger reason: an anonymous application used to be filed under a
   * client company's workspace, so a workspace capability would have shown that
   * customer every contractor who applied to MAINTSUPP.
   */
  {
    key: "applications",
    label: "Contractor applications",
    icon: "wrench",
    blurb: "Who has applied to join the contractor network, and where each application has got to.",
    capability: null,
  },
  /*
   * Backups and recovery (§39), added with its API (`/api/admin/backups`) — the
   * rule kept once more. Visibility only: the database host takes the backups
   * and the portal cannot read their status, so the screen states that and what
   * it CAN see (database, storage, migration state) and offers no action.
   */
  {
    key: "backups",
    label: "Backups",
    icon: "shield",
    blurb: "What the portal can truthfully say about backups, the database, file storage and migrations.",
    capability: null,
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
