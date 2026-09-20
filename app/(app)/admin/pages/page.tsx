import type { Metadata } from "next";

import { requirePageSession } from "../../../lib/page-guard";
import { requirePlatformAdmin } from "../../../lib/platform-guard";
import { PlatformShell } from "../platform-shell";

export const dynamic = "force-dynamic";

/**
 * Website pages — Master Specification §6–9.
 *
 * TWO GUARDS, IN THIS ORDER, AND THE ORDER IS THE POINT.
 *
 * `requirePageSession` first, so an anonymous visitor is sent to sign in and comes
 * back to THIS address. `requirePlatformAdmin` second, so a signed-in member who is
 * not platform staff is sent to the workspace. Reversing them would bounce an
 * anonymous request to `/dashboard`, which would bounce it to
 * `/login?next=/dashboard` — losing the address they actually asked for. The four
 * screens that came before this one carry the same pair for the same reason, and
 * `tests/platform-admin-shell.test.mjs` asserts both calls on every entry.
 *
 * WHY THIS SCREEN IS LISTED AT ALL, WHEN FOUR OTHERS ARE NOT.
 *
 * `platform-sections.ts` refuses a rail entry for Branding, Integrations, Billing
 * and platform Settings, in its own words: "A rail entry is a promise that there is
 * something behind it. Each arrives with its API or not at all." This one arrives
 * with `app/api/site-pages/route.ts` — a real read, a real write and a real delete,
 * gated on the same `scope.platformAdmin` this route is — so listing it keeps that
 * rule rather than bending it.
 */
export const metadata: Metadata = {
  title: "Website pages",
};

export default async function AdminSitePagesPage() {
  const session = await requirePageSession("/admin/pages");
  await requirePlatformAdmin();
  return (
    <PlatformShell
      section="pages"
      /* From the session the guard already resolved, so the topbar carries a name
         before any fetch lands. `AccountShell` shows "Account" until `/api/account`
         answers; there is no reason to make a reader watch that here. */
      userName={session.user.fullName ?? session.user.email}
      userEmail={session.user.email}
    />
  );
}
