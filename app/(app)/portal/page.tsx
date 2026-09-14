import { redirect } from "next/navigation";
import { requirePageSession } from "../../lib/page-guard";

export const dynamic = "force-dynamic";

/**
 * /portal — the portal's old address, forwarded to /dashboard.
 *
 * AUTH IS RESOLVED HERE, NOT AT THE FAR END. This was a bare
 * `redirect("/dashboard")`, which meant an anonymous visitor to /portal was
 * bounced INTO a protected route before anybody had asked whether they were
 * signed in, and met the login screen only after the dashboard had rendered
 * and its API calls had failed. One redirect became three navigations and a
 * visible leak.
 *
 * Asking first costs one session read and sends an anonymous visitor straight
 * to /login, with `next=/dashboard` so signing in lands them where /portal was
 * taking them anyway.
 */
export default async function PortalPage() {
  await requirePageSession("/dashboard");
  redirect("/dashboard");
}
