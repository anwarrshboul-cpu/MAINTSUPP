import Link from "next/link";
import { AuditLog } from "../../portal/views/audit-log";

export const dynamic = "force-dynamic";

/**
 * /dashboard/audit
 *
 * A static segment for the same reason as `/dashboard/teams`: it wins over the
 * `[[...section]]` catch-all without that file having to know this screen
 * exists. The permission gate lives on `/api/audit`, not here — a page that
 * hides a table it already fetched is not a gate.
 */
export default function AuditPage() {
  return (
    <main className="audit-page">
      <nav className="audit-page__crumbs">
        <Link href="/dashboard">← Dashboard</Link>
      </nav>
      <AuditLog />
    </main>
  );
}
