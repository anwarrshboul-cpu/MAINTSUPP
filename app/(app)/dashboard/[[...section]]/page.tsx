import type { Metadata } from "next";

import { requireModuleAccess, requirePageSession } from "../../../lib/page-guard";
import PortalApp, { type Section } from "../../portal/portal-app";

export const dynamic = "force-dynamic";

/*
 * URL segment to section, on the SERVER.
 *
 * This is the second copy of a map `portal-app.tsx` also holds as
 * `sectionRoutes`, and the two must agree: this one decides what a typed URL,
 * a reload or a shared link resolves to, while that one decides what the
 * address bar says after a click in the sidebar. A section added to one and
 * not the other works until somebody reloads, and then quietly lands on
 * Overview — which is exactly what the recycle bin did on the day it was added.
 * `tests/column-drag-and-recovery.test.mjs` now holds them level.
 */
const routes: Record<string, Section> = {
  overview: "overview",
  jobs: "maintenance",
  planned: "calendar",
  assets: "assets",
  /* The address the asset register used to live at. It resolves to the
     `units` section, whose screen IS the Assets screen — see `sectionMeta`
     in portal-app.tsx — so an old bookmark lands on the real thing. */
  units: "units",
  sites: "stores",
  "store-documentation": "store-documentation",
  contractors: "contractors",
  compliance: "compliance",
  documents: "documents",
  "invoice-tracker": "invoice-tracker",
  reports: "reports",
  settings: "settings",
  team: "team",
  admin: "admin-users",
  audit: "audit",
  reconcile: "reconcile",
  "recycle-bin": "recycle-bin",
  "admin/roles": "admin-roles",
  "admin/clients": "admin-clients",
};

/*
 * The tab title for each section: the sidebar's own label, so a row of browser
 * tabs says which screen each one is instead of all reading the site's
 * strapline. `sectionMeta` in portal-app.tsx holds these labels, but it lives in
 * a client module whose values a server file cannot read, so they are restated
 * here — `tests/phase10-a11y-fixes.test.mjs` holds the two level. A section
 * missing from this table (a workspace's own `s/<slug>`, which this file
 * resolves without a database) keeps the default title rather than a wrong one.
 */
const titles: Partial<Record<Section, string>> = {
  overview: "Overview",
  maintenance: "Jobs",
  calendar: "Planned",
  assets: "Assets",
  units: "Assets",
  stores: "Sites",
  "store-documentation": "Store Documentation",
  contractors: "Contractors",
  compliance: "Compliance",
  documents: "Documents",
  "invoice-tracker": "Invoice Tracker",
  reports: "Reports",
  settings: "Settings",
  team: "Team",
  "admin-users": "Users",
  audit: "Audit",
  reconcile: "Reconcile",
  "recycle-bin": "Recycle Bin",
  "admin-roles": "Roles",
  "admin-clients": "All clients",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}): Promise<Metadata> {
  const { section } = await params;
  const slug = section?.join("/") || "overview";
  const resolved = routes[slug] ?? routes[section?.[0] ?? ""];
  const title = resolved ? titles[resolved] : undefined;
  return title ? { title } : {};
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  /*
   * Joined, not just the first segment.
   *
   * The administration screens are nested — `/dashboard/admin/roles` and
   * `/dashboard/admin/clients` — and keying off `section?.[0]` alone resolved
   * both of them to the users screen, so the account menu's Administration link
   * worked but the two beneath it silently landed somewhere else. The single
   * segment still matches because the map holds "admin" as well.
   */
  const slug = section?.join("/") || "overview";
  /*
   * Stage 23 — `/dashboard/s/<slug>` is a section this workspace added.
   *
   * Namespaced under `s/` so a workspace section can never take a route a
   * built-in one owns, nor be given one by a later release. The key is passed
   * through unchecked on purpose: `portal-app` draws it only if the workspace
   * catalogue actually contains it, so a stale bookmark lands on Overview
   * rather than on a blank screen, and this file needs no database.
   */
  const workspaceSection =
    section?.[0] === "s" && section[1] ? `section:${section[1]}` : null;
  const initialSection =
    workspaceSection ?? routes[slug] ?? routes[section?.[0] ?? ""] ?? "overview";

  /*
   * WHO IS ASKING — AND WHETHER THEY GET A PAGE AT ALL.
   *
   * This used to be a `getSession` call whose null case fell through to the
   * literals "Preview User" / "preview@maintsupp.local". That was honest while
   * there was no way to sign in, and it quietly became the whole of the auth
   * hole once there was: an anonymous GET of this route was answered with
   * 47,663 bytes of the operations shell under a placeholder identity, and the
   * only thing that eventually sent the visitor to /login was a client fetch
   * wrapper reacting to the twelve 401s that followed.
   *
   * `requirePageSession` redirects instead. It throws, so nothing below runs
   * and no element of this tree is ever produced for a browser without a
   * session — which is the actual fix. See `app/lib/page-guard.ts`.
   *
   * The path is rebuilt from the same segments the section was resolved from,
   * so signing in returns the visitor to the screen they asked for rather than
   * to the Overview. It is sanitised inside `loginRedirect` and again by the
   * login page, because route params are attacker-supplied.
   *
   * THE QUERY DOES NOT GO WITH IT, AND THAT IS THE FRAMEWORK, NOT A CHOICE.
   *
   * `session-guard.ts` carries `window.location.search` on the client half of
   * this feature, so the obvious thing was to read `searchParams` here and
   * make the two agree. Measured on vinext 0.0.50, it cannot be done. A page's
   * redirect is thrown during `probePage()` in `entries/app-rsc-entry.js`,
   * which builds the props from
   * `collectAppPageSearchParams(searchParams).searchParamsObject` — a key that
   * function does not return, so the value is `undefined` and the page sees
   * `{}`. Measured on `/dashboard/jobs?filter=open&view=chart` and on a static
   * segment, `/dashboard/teams?zz=1`: both arrive as `{}`. `headers()` is no
   * way round it either — the whole header set a page can see is accept,
   * accept-encoding, accept-language, connection, host, sec-fetch-mode,
   * user-agent and x-forwarded-host, and not one of them carries the URL.
   *
   * So a filtered deep link comes back from sign-in as its bare path. Written
   * down rather than left as a puzzle, because the fix LOOKS like a two-line
   * change and silently does nothing: the first attempt shipped a source-level
   * test that passed green while the behaviour was broken, and only a runtime
   * assertion caught it.
   */
  const session = await requirePageSession(
    section?.length ? `/dashboard/${section.join("/")}` : "/dashboard",
  );

  /*
   * AND WHETHER THIS WORKSPACE STILL HAS THAT MODULE.
   *
   * `initialSection` above is resolved from a static table and passed through
   * unchecked — deliberately, so a stale bookmark lands on Overview rather than
   * a blank screen. That is the right answer for a key that never existed. It is
   * the wrong one for a module an administrator has switched off, or one this
   * actor's role may not reach: until now both rendered the shell and left the
   * refusing to the APIs inside it.
   *
   * Every built-in section except `team` routes through this file, so this is
   * the one place that has to remember. `tests/portal-auth-guard.test.mjs`
   * enumerates every page and is extended to say so.
   */
  await requireModuleAccess(
    initialSection,
    section?.length ? `/dashboard/${section.join("/")}` : "/dashboard",
  );

  return (
    <PortalApp
      userName={session.user.fullName?.trim() || session.user.email}
      userEmail={session.user.email}
      /* The account's own `users.timezone`, so the Overview greeting reads the
         viewer's clock rather than whichever region this instance runs in. */
      userTimeZone={session.user.timezone}
      initialSection={initialSection}
    />
  );
}
