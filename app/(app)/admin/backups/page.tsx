import type { Metadata } from "next";

import { requirePageSession } from "../../../lib/page-guard";
import { requirePlatformAdmin } from "../../../lib/platform-guard";
import { PlatformShell } from "../platform-shell";

export const dynamic = "force-dynamic";

/**
 * Backups and recovery — Master Specification §39, visibility only.
 *
 * The same two guards as every screen in this console, in the same order:
 * `requirePageSession` first so an anonymous visitor signs in and comes back HERE,
 * `requirePlatformAdmin` second so a signed-in member who is not platform staff is
 * sent to the workspace. `/api/admin/backups` records what the screen can and
 * cannot truthfully show.
 */
export const metadata: Metadata = {
  title: "Backups",
};

export default async function AdminBackupsPage() {
  const session = await requirePageSession("/admin/backups");
  await requirePlatformAdmin();
  return (
    <PlatformShell
      section="backups"
      userName={session.user.fullName ?? session.user.email}
      userEmail={session.user.email}
    />
  );
}
