import type { Metadata } from "next";

import { requirePageSession } from "../../../lib/page-guard";
import { requirePlatformAdmin } from "../../../lib/platform-guard";
import { PlatformShell } from "../platform-shell";

export const dynamic = "force-dynamic";

/**
 * Contractor applications — Master Specification §12, for the /contractors form.
 *
 * The same two guards as every screen in this console, in the same order:
 * `requirePageSession` first so an anonymous visitor signs in and comes back HERE,
 * `requirePlatformAdmin` second so a signed-in member who is not platform staff is
 * sent to the workspace. The applications are MAINTSUPP's, not a workspace's —
 * `app/api/contractor-applications/inbox/route.ts` records why.
 */
export const metadata: Metadata = {
  title: "Contractor applications",
};

export default async function AdminApplicationsPage() {
  const session = await requirePageSession("/admin/applications");
  await requirePlatformAdmin();
  return (
    <PlatformShell
      section="applications"
      userName={session.user.fullName ?? session.user.email}
      userEmail={session.user.email}
    />
  );
}
