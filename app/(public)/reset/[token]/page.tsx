import type { Metadata } from "next";
import { getD1 } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  resetProblem,
  resolveReset,
} from "../../../api/auth/password-resets/reset-tokens";
import SetPasswordForm from "./set-password-form";
/*
 * Deliberately the invitation stylesheet, not a copy of it. This is the same
 * page doing the same job for the same reader, and two stylesheets would drift
 * until the two links looked like they came from different products.
 *
 * Re-exported from a directory whose name has no brackets in it: Vite treats
 * `[` and `]` as glob syntax, and importing across `invite/[token]/` from here
 * fails to resolve.
 */
import inviteCss from "../reset.css?url";

// The URL contains the token, so it is a credential. Indexing it would publish
// working reset links, and a referrer would leak them to whatever the page
// links to.
export const metadata: Metadata = {
  title: "Set a new password | MAINTSUPP",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * /reset/[token] — the way back into an account.
 *
 * Resolved on the server before anything renders, so a spent or expired link
 * produces a page that says so rather than a form that flashes into view and
 * then fails. The reader here is somebody who cannot sign in and was handed
 * this link by an administrator; the one thing they need to know is whether to
 * ask for another one.
 *
 * Naming the state is safe even though /login refuses to say why it failed —
 * the reader already holds the token, so "this expired" tells them nothing
 * they could not learn by clicking it.
 */
export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await ensureDatabase();
  const { token } = await params;
  const d1 = await getD1();

  const { state, reset } = await resolveReset(d1, token);

  if (state !== "valid" || !reset) {
    return (
      <>
        <link rel="stylesheet" href={inviteCss} />
        <main className="invite">
          <span className="invite__brand">
            <span>MAINT</span><strong>SUPP</strong>
          </span>
          <div className="invite__card invite__card--closed">
            <div className="invite__icon" aria-hidden="true">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7.5v5.5M12 16.2v.2" />
              </svg>
            </div>
            <p className="invite__eyebrow">Password reset</p>
            <h1>This link cannot be used</h1>
            <p className="invite__lede">{resetProblem(state)}</p>
            <a className="invite__link" href="/login">
              Go to sign in
            </a>
          </div>
          <p className="invite__legal">
            Reset links are single use and expire after 24 hours. Nothing about
            the account is shown until a valid link is opened.
          </p>
        </main>
      </>
    );
  }

  const email = (reset.email ?? "").toLowerCase();
  const expires = reset.expires_at
    ? new Date(
        /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(reset.expires_at)
          ? `${reset.expires_at.replace(" ", "T")}Z`
          : reset.expires_at,
      )
    : null;

  return (
    <>
      <link rel="stylesheet" href={inviteCss} />
      <main className="invite">
        <span className="invite__brand">
          <span>MAINT</span><strong>SUPP</strong>
        </span>

        <div className="invite__card">
          <p className="invite__eyebrow">Password reset</p>
          <h1>Set a new password</h1>
          <p className="invite__lede">
            Choose a new password for this account. Everywhere it is currently
            signed in will be signed out.
          </p>

          <dl className="invite__facts">
            <dt>Account</dt>
            <dd>{email}</dd>
            {expires && !Number.isNaN(expires.getTime()) ? (
              <>
                <dt>Link expires</dt>
                <dd>
                  {expires.toLocaleString("en-GB", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </dd>
              </>
            ) : null}
          </dl>

          <SetPasswordForm token={token} email={email} />
        </div>

        <p className="invite__legal">
          Setting a password here does not sign you in — you will be asked for
          the new one, so it is the only thing that opens the account.
        </p>
      </main>
    </>
  );
}
