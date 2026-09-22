import type { Metadata } from "next";

import { requirePageSession } from "../../../lib/page-guard";
import { requirePlatformAdmin } from "../../../lib/platform-guard";
import { PlatformShell } from "../platform-shell";

export const dynamic = "force-dynamic";

/**
 * Search across every workspace — the owner's optional follow-up to §36, which
 * shipped single-workspace on purpose.
 *
 * The same two guards as every console screen, in the order that matters:
 * `requirePageSession` first so an anonymous visitor signs in and comes back
 * HERE; `requirePlatformAdmin` second so a signed-in member who is not platform
 * staff goes to their own workspace. The route behind it
 * (`app/api/admin/search/route.ts`) gates on the same `scope.platformAdmin`, and
 * the portal's own `/api/search` is untouched and still single-workspace.
 */
export const metadata: Metadata = {
  title: "Search workspaces",
};

export default async function AdminSearchPage() {
  const session = await requirePageSession("/admin/search");
  await requirePlatformAdmin();
  return (
    <PlatformShell
      section="search"
      userName={session.user.fullName ?? session.user.email}
      userEmail={session.user.email}
    />
  );
}
