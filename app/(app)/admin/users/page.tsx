import type { Metadata } from "next";

import { requirePageSession } from "../../../lib/page-guard";
import { requirePlatformAdmin } from "../../../lib/platform-guard";
import { PlatformShell } from "../platform-shell";

export const dynamic = "force-dynamic";

/**
 * Users & access — Master Specification §5.
 *
 * Who is in which workspace, and at what role.
 *
 * TWO GUARDS, IN THIS ORDER, AND THE ORDER IS THE POINT.
 *
 * `requirePageSession` first, so an anonymous visitor is sent to sign in and comes
 * back to THIS address. `requirePlatformAdmin` second, so a signed-in member who is
 * not platform staff is sent to the workspace. Reversing them would bounce an
 * anonymous request to `/dashboard`, which would bounce it to
 * `/login?next=/dashboard` — losing the address they actually asked for.
 *
 * Both are server-side, at the route entry, before an element is produced.
 * `page-guard.ts` explains at length why this cannot be middleware, and
 * `platform-guard.ts` explains why this one fails CLOSED where the module guard
 * fails open.
 *
 * `tests/platform-admin-shell.test.mjs` enumerates all five entries and asserts
 * both calls on each, and `tests/portal-auth-guard.test.mjs` already walks every
 * `page.tsx` under `app/` for the first of them.
 */
export const metadata: Metadata = {
  title: "Users & access",
};

export default async function AdminUsersPage() {
  const session = await requirePageSession("/admin/users");
  await requirePlatformAdmin();
  return (
    <PlatformShell
      section="users"
      /* From the session the guard already resolved, so the topbar carries a name
         before any fetch lands. `AccountShell` shows "Account" until `/api/account`
         answers; there is no reason to make a reader watch that here. */
      userName={session.user.fullName ?? session.user.email}
      userEmail={session.user.email}
    />
  );
}
