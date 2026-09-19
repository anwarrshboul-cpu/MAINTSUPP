import { redirect } from "next/navigation";
import { requireModuleAccess, requirePageSession } from "../../../lib/page-guard";

export const dynamic = "force-dynamic";

/*
 * The address Module 3 §4 names, pointed at the address this product uses.
 *
 * §4 asks for the reconciliation page at `/admin/reconcile`. This product has
 * no top-level `/admin` namespace at all — every administration screen lives
 * under `/dashboard`, including the nested ones (`/dashboard/admin/roles`,
 * `/dashboard/admin/clients`), and the surface itself is a section of the one
 * portal shell rather than a page of its own. Building a second shell to own
 * one URL would give the reconciler its own copy of the navigation, the session
 * read and the theme.
 *
 * So the spec's URL is a redirect. Typing it, or following it out of the
 * module document, lands on the page; the authorisation is unchanged, because
 * it is enforced by `/api/admin/reconcile` and not by the route.
 *
 * Same shape as `app/(app)/portal/page.tsx`, which redirects the old portal
 * address to `/dashboard` for the same reason.
 */
export default async function AdminReconcileRedirect() {
  /*
   * Auth is resolved BEFORE the forward, for the same reason `/portal` now
   * does it: bouncing an anonymous visitor into a protected route and letting
   * the far end sort it out is what produced the dashboard-then-login flash.
   * `next` is the destination, not this address, so signing in lands on the
   * reconciler rather than back on a redirect.
   */
  await requirePageSession("/dashboard/reconcile");
  /*
   * And the module, here rather than only at the far end.
   *
   * The catch-all guards `/dashboard/reconcile` too, so this is not the only
   * check — it is the one that keeps the forward honest. Without it a workspace
   * with Reconcile switched off would be sent to a URL whose sole purpose is to
   * bounce it straight back to Overview, and the address bar would flicker
   * through a screen the workspace does not have.
   */
  await requireModuleAccess("reconcile", "/dashboard/reconcile");
  redirect("/dashboard/reconcile");
}
