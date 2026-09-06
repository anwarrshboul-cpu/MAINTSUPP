import { redirect } from "next/navigation";

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
export default function AdminReconcileRedirect() {
  redirect("/dashboard/reconcile");
}
