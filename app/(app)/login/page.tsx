import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getD1 } from "../../../db";
import { ensureDatabase } from "../../../db/init";
import { BrandMark } from "../../components";
import {
  ensureOwnerAccount,
  getSession,
  safeRedirectPath,
} from "../../lib/auth-session";
import SignInForm from "./sign-in-form";
import loginFormCss from "./login-form.css?url";

// A sign-in page has nothing to offer a search engine and everything to lose
// from being one: indexed login forms are what phishing kits clone.
export const metadata: Metadata = {
  title: "Sign in | MAINTSUPP",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * /login — Stage 20.
 *
 * This page used to be `redirect("/dashboard")`, which was an honest
 * description of a product with no accounts. It is now a real form.
 *
 * The page is a server component and the form is a client one, so the password
 * field never exists anywhere the server rendered — and, more usefully, the
 * "are you already signed in" check happens here, before any HTML is produced.
 * Someone with a live session who navigates to /login is sent on rather than
 * shown a form they do not need.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await ensureDatabase();

  // Provisions the owner account on first visit, so a fresh database has
  // somebody who can sign in. Idempotent, and it never resets a password that
  // has already been changed — see `ensureOwnerAccount`.
  await ensureOwnerAccount(await getD1()).catch(() => {
    // A seeding failure must still render the form: existing accounts work.
  });

  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  // Sanitised on the way in as well as on the way out. This value is echoed
  // into the client component, so an unchecked one would be a stored redirect
  // target sitting in the page for the browser to follow.
  const next = safeRedirectPath(rawNext);

  const request = new Request("https://maintsupp.local/login", {
    headers: await headers(),
  });
  const session = await getSession(request);
  if (session) redirect(next);

  return (
    <>
      <link rel="stylesheet" href={loginFormCss} />
      <main className="login-page">
        <div className="login-page__brand">
          <BrandMark />
        </div>

        <div className="login-card">
          <div className="login-card__icon" aria-hidden="true">
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
              <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
              <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
              <circle cx="12" cy="15.5" r="1.2" />
            </svg>
          </div>

          <p className="login-card__eyebrow">MAINTSUPP Operations</p>
          <h1>Sign in</h1>
          <p className="login-card__subtitle">
            Use the email your workspace administrator invited.
          </p>

          <SignInForm next={next} />

          <div className="login-card__assurance">
            <span>
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3 4 6.5v5c0 4.6 3.2 8.6 8 9.5 4.8-.9 8-4.9 8-9.5v-5Z" />
              </svg>
              Sessions expire after 7 days idle, 30 days absolute
            </span>
            <span>
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m5 12 5 5L20 7" />
              </svg>
              Passwords are hashed, never stored or emailed
            </span>
          </div>

          <p className="login-form__note">
            No account? Workspace access is invitation only — ask your
            administrator to send you an invite link.
          </p>
        </div>
      </main>
    </>
  );
}
