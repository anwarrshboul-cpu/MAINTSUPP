import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState } from "../../../lib/session";
import SignOutButton from "../sign-out-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Awaiting approval",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The holding page for an account that exists but holds no role.
 *
 * Outside the portal shell on purpose: there is no nav to draw, because there
 * is nothing this account may open. It re-checks state and forwards anyone who
 * has since been approved, so a stale tab left open overnight does not keep
 * telling someone to wait after they have been let in.
 */
export default async function AwaitingApprovalPage() {
  const state = await getViewerState();
  if (state.kind === "signed-out") redirect("/portal");
  if (state.kind === "ok") redirect("/portal/dashboard");
  if (state.kind === "blocked" && state.status === "suspended") {
    redirect("/portal/suspended");
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
        <h1>Your account is waiting for approval</h1>
        <p className="muted">
          An administrator reviews every new account and decides what it may see —
          which client, which stores, and whether it is staff or a contractor.
          Until then there is nothing to show you.
        </p>
        <p className="muted small">
          You will get an email when it is done. If it is urgent, ring your
          MAINTSUPP contact rather than creating a second account.
        </p>
        <SignOutButton className="btn btn--done" />
      </div>
    </main>
  );
}
