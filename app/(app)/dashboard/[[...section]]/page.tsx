import { headers } from "next/headers";
import { getSession } from "../../../lib/auth-session";
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
  units: "units",
  sites: "stores",
  "store-documentation": "store-documentation",
  contractors: "contractors",
  compliance: "compliance",
  documents: "documents",
  reports: "reports",
  settings: "settings",
  team: "team",
  admin: "admin-users",
  audit: "audit",
  "recycle-bin": "recycle-bin",
  "admin/roles": "admin-roles",
  "admin/clients": "admin-clients",
};

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
   * Who is actually looking at this.
   *
   * These were the literals "Preview User" / "preview@maintsupp.local", which
   * was honest while there was no way to sign in and is not any more: a signed-in
   * owner was greeted by somebody else's name. `getSession` never throws and
   * returns null when there is no session, so the preview identity survives for
   * an unauthenticated browser — which is still how the dashboard is demoed.
   */
  const session = await getSession(
    new Request("https://maintsupp.local/dashboard", {
      headers: await headers(),
    }),
  );

  return (
    <PortalApp
      userName={session?.user.fullName?.trim() || session?.user.email || "Preview User"}
      userEmail={session?.user.email ?? "preview@maintsupp.local"}
      initialSection={initialSection}
    />
  );
}
