import Link from "next/link";
import { requirePageSession } from "../../../lib/page-guard";
import { TeamsManager } from "../../portal/views/teams-manager";

export const dynamic = "force-dynamic";

/**
 * /dashboard/teams
 *
 * A static segment rather than another entry in the `[[...section]]` catch-all,
 * so this screen owns its own URL without editing the shell that renders every
 * other section. Next resolves the more specific route first, so `/dashboard`
 * and its sections are untouched.
 */
export default async function TeamsPage() {
  /*
   * The workspace team list is workspace data, so it is behind the same server
   * guard as every other screen under /dashboard. See `app/lib/page-guard.ts`.
   */
  await requirePageSession("/dashboard/teams");
  return (
    <main className="teams-page">
      <nav className="teams-page__crumbs">
        <Link href="/dashboard">← Dashboard</Link>
      </nav>
      <TeamsManager />
    </main>
  );
}
