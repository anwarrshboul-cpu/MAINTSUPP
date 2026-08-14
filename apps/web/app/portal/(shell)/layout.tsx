import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import "../portal.css";
import { getViewerState } from "../../../lib/session";
import { navFor, ROLE_LABELS } from "../../../lib/portal";
import PortalNav from "./portal-nav";
import SignOutButton from "../sign-out-button";

/*
 * A route group, so `/portal` itself — the sign-in page — stays outside this
 * shell. Wrapping the login form in a signed-in chrome would mean rendering a
 * nav and a sign-out button for somebody who has neither.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // The portal is behind a session; nothing in it should ever be indexed or
  // previewed by a link unfurler.
  robots: { index: false, follow: false, nocache: true },
};

export default async function PortalShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const state = await getViewerState();

  if (state.kind === "signed-out") redirect("/portal");
  if (state.kind === "blocked") {
    redirect(
      state.status === "suspended" ? "/portal/suspended" : "/portal/awaiting-approval",
    );
  }

  if (state.kind === "unreachable") {
    /*
     * Not a redirect to the login page. "The API is down" and "you are signed
     * out" are different problems, and sending someone to sign in again when
     * their session is perfectly good wastes the one action that cannot help.
     */
    return (
      <main className="wrap">
        <div className="card card--empty">
          <h1>The portal is not reachable</h1>
          <p className="muted">{state.error}</p>
          <p className="muted small">
            Your session is unaffected. Reload once the service is back.
          </p>
        </div>
      </main>
    );
  }

  const { actor, fullName } = state.viewer;
  const nav = navFor(actor);
  const isOwner = actor.role === "owner";

  return (
    <div className="p-shell">
      <header className="p-top">
        <div className="p-top-row">
          <Link href="/portal/dashboard" className="p-top-brand">
            <span className="mark" aria-hidden="true">
              <svg viewBox="0 0 40 40" fill="none" width="24" height="24">
                <path d="M6 33V9l14 15" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M20 24 34 9v24" stroke="#12B4A8" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="brand">MAINT<strong>SUPP</strong></span>
          </Link>

          <div className="p-who">
            <span className="p-who-name" title={actor.email}>
              {fullName ?? actor.email}
            </span>
            <span className={`p-badge${isOwner ? " p-badge--owner" : ""}`}>
              {ROLE_LABELS[actor.role]}
            </span>
            <SignOutButton />
          </div>
        </div>

        <PortalNav items={nav} />
      </header>

      <main className="p-main">{children}</main>
    </div>
  );
}
