import type { Metadata } from "next";
import Link from "next/link";
import ResetForm from "./reset-form";

export const metadata: Metadata = {
  title: "Set a new password",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * `/portal/reset` — where the password-reset email lands.
 *
 * Like `/portal/verify`, this page did not exist while `POST /auth/forgot`
 * mailed `${WEB_URL}/portal/reset?token=…`, so password recovery sent people to
 * a 404 and no account could ever be recovered.
 *
 * The token is read here and handed to a client component, which posts it with
 * the new password. It is NOT spent on render — unlike verification, this token
 * has to survive until the reader has chosen a password, and consuming it on
 * page load would burn the link for anyone who opened it before they were
 * ready.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

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

      {token ? (
        <ResetForm token={token} />
      ) : (
        <div className="card">
          <h1>That link was not complete</h1>
          <p className="muted" style={{ marginTop: 8 }}>
            The address was missing its reset code. Open the link from your
            email again, or ask for a new one.
          </p>
          <Link className="btn" href="/portal">Back to sign in</Link>
        </div>
      )}
    </main>
  );
}
