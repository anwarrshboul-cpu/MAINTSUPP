import type { Metadata } from "next";

import { requirePageSession } from "../../../lib/page-guard";
import { requirePlatformAdmin } from "../../../lib/platform-guard";
import { PlatformShell } from "../platform-shell";

export const dynamic = "force-dynamic";

/**
 * Website copy — decision L (§77 item 9).
 *
 * The same two guards as every console screen, in the order that matters:
 * `requirePageSession` first so an anonymous visitor signs in and comes back
 * HERE; `requirePlatformAdmin` second so a signed-in member who is not platform
 * staff goes to their workspace. Listed in the rail because it arrives with
 * `app/api/site-content/route.ts`, gated on the same `scope.platformAdmin` this
 * route is.
 */
export const metadata: Metadata = {
  title: "Website copy",
};

export default async function AdminSiteCopyPage() {
  const session = await requirePageSession("/admin/copy");
  await requirePlatformAdmin();
  return (
    <PlatformShell
      section="copy"
      userName={session.user.fullName ?? session.user.email}
      userEmail={session.user.email}
    />
  );
}
