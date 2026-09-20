import type { Metadata } from "next";

import { requirePageSession } from "../../../lib/page-guard";
import { requirePlatformAdmin } from "../../../lib/platform-guard";
import { PlatformShell } from "../platform-shell";

export const dynamic = "force-dynamic";

/**
 * Website enquiries — Master Specification §12.
 *
 * TWO GUARDS, IN THIS ORDER, AND THE ORDER IS THE POINT.
 *
 * `requirePageSession` first, so an anonymous visitor is sent to sign in and comes
 * back to THIS address. `requirePlatformAdmin` second, so a signed-in member who is
 * not platform staff is sent to the workspace. Reversing them would bounce an
 * anonymous request to `/dashboard`, which would bounce it to
 * `/login?next=/dashboard` — losing the address they actually asked for. Every
 * screen in this console carries the same pair for the same reason, and
 * `tests/platform-admin-shell.test.mjs` asserts both calls on every entry.
 *
 * WHY THIS IS IN THE PLATFORM CONSOLE AND NOT THE PORTAL.
 *
 * Because the enquiries are MAINTSUPP's, not a workspace's. The intake route files a
 * public submission under the primary active organisation — which, measured, is a
 * client company's workspace — so the rows carry an `organisation_id` that does not
 * describe who they belong to. A portal section gated on a workspace capability
 * would have shown that client every enquiry MAINTSUPP has received from its own
 * website. `app/api/leads/route.ts` records the measurement in full.
 *
 * It is also why this screen is listed at all: `platform-sections.ts` refuses a rail
 * entry that leads nowhere, and this one arrived with a real read and a real write.
 */
export const metadata: Metadata = {
  title: "Website enquiries",
};

export default async function AdminLeadsPage() {
  const session = await requirePageSession("/admin/leads");
  await requirePlatformAdmin();
  return (
    <PlatformShell
      section="leads"
      /* From the session the guard already resolved, so the topbar carries a name
         before any fetch lands. `AccountShell` shows "Account" until `/api/account`
         answers; there is no reason to make a reader watch that here. */
      userName={session.user.fullName ?? session.user.email}
      userEmail={session.user.email}
    />
  );
}
