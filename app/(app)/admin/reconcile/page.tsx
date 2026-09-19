import { redirect } from "next/navigation";
import { requireModuleAccess, requirePageSession } from "../../../lib/page-guard";

export const dynamic = "force-dynamic";

/*
 * The address Module 3 §4 names, pointed at the address this product uses.
 *
 * §4 asks for the reconciliation page at `/admin/reconcile`, and it is a redirect
 * into the workspace screen at `/dashboard/reconcile`.
 *
 * THIS COMMENT USED TO ARGUE THAT `/admin` DOES NOT EXIST. It said "this product
 * has no top-level `/admin` namespace at all" and that "building a second shell to
 * own one URL would give the reconciler its own copy of the navigation, the session
 * read and the theme." That reasoning was correct for what it was deciding — one
 * URL is not worth a shell — and it stopped being the whole picture when §5's
 * Platform Super Admin console arrived. `/admin` is now a real namespace with its
 * own shell, its own rail and its own guard (`app/lib/platform-guard.ts`), because
 * a console that answers across every client workspace is a different thing from a
 * page, and the cost is paid once rather than per URL.
 *
 * The record is kept rather than deleted, because the reversal is the interesting
 * part: the shell was built when there was a console to put in it, and not before.
 *
 * SO WHY IS THIS STILL A REDIRECT, NOT A CONSOLE SCREEN?
 *
 * Because the reconciler is not a platform view. It reports figures for ONE
 * workspace and offers a purge inside it, it answers to `settings.edit` rather than
 * to platform staff, and `/api/admin/reconcile` refuses outright outside
 * non-production. `PLATFORM_SECTIONS` says the same thing in its own header. Moving
 * it into the console would take a URL with a documented meaning and quietly change
 * it, and would put a workspace harness behind a door marked "platform".
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
