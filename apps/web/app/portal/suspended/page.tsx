import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState } from "../../../lib/session";
import SignOutButton from "../sign-out-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Account suspended",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The holding page for a deactivated account.
 *
 * Deactivating revokes every session in the same breath, so in practice someone
 * suspended mid-session is signed out rather than sent here — this page is what
 * they meet when they sign in again, and what a re-suspended account sees.
 *
 * It says nothing about why. That decision belongs to whoever made it, and a
 * page guessing at a reason is a page that gets it wrong in front of the person
 * least able to correct it.
 */
export default async function SuspendedPage() {
  const state = await getViewerState();
  if (state.kind === "signed-out") redirect("/portal");
  if (state.kind === "ok") redirect("/portal/dashboard");
  if (state.kind === "blocked" && state.status === "pending_approval") {
    redirect("/portal/awaiting-approval");
  }

  return (
    <main className="wrap">
      <div className="head">
        <span className="mark" aria-hidden="true">
          <svg viewBox="0 0 40 40" fill="none" width="26" height="26">
            <path d="M6 33V9l14 15" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M20 24 34 9v24" stroke="#12B4A8" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="brand">MAINT<strong>SUPP</strong></span>
      </div>

      <div className="card actions">
        <h1>This account is suspended</h1>
        <p className="muted">
          Access has been withdrawn by an administrator. Jobs, sites and history
          are unaffected — only this account cannot open them.
        </p>
        <p className="muted small">
          If you think that is a mistake, speak to whoever administers your
          MAINTSUPP account.
        </p>
        <SignOutButton className="btn btn--done" />
      </div>
    </main>
  );
}
