import type { Metadata } from "next";
import Link from "next/link";
import { API_URL } from "../../../lib/api";

export const metadata: Metadata = {
  title: "Confirm your email",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

/**
 * `/portal/verify` — where the confirmation email lands.
 *
 * This page did not exist, and its absence made the whole product unusable on a
 * fresh deployment: `POST /auth/register` mails
 * `${WEB_URL}/portal/verify?token=…`, and `POST /auth/sign-in` refuses any
 * account whose address is unconfirmed. So every new sign-up — the owner's
 * included, since the founding account is created through the ordinary form —
 * ended at a 404 with no way forward.
 *
 * The exchange happens on the SERVER, here, rather than in a client effect.
 * A one-time token in a URL is spent the moment it is used, and React's
 * development double-invocation would fire that request twice: the first call
 * consumes the token, the second sees it already spent, and the reader is told
 * their valid link has expired.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  let state: "ok" | "invalid" | "missing" | "unreachable" = "missing";

  if (token) {
    try {
      const response = await fetch(`${API_URL}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        cache: "no-store",
      });
      state = response.ok ? "ok" : "invalid";
    } catch {
      // The API being down is a different problem from a bad link, and telling
      // someone their link expired when the server is simply unreachable sends
      // them to request another one that will fail the same way.
      state = "unreachable";
    }
  }

  const copy = {
    ok: {
      title: "Email confirmed",
      body: "Your address is confirmed. Sign in to continue — an administrator assigns your access if this is a new account.",
    },
    invalid: {
      title: "That link has expired",
      body: "Confirmation links last 24 hours and can be used once. Sign in to have a new one sent.",
    },
    missing: {
      title: "That link was not complete",
      body: "The address was missing its confirmation code. Open the link from your email again, or sign in to request a new one.",
    },
    unreachable: {
      title: "We could not reach the server",
      body: "Your link is probably fine. Wait a moment and open it again.",
    },
  }[state];

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

      <div className="card">
        <h1>{copy.title}</h1>
        <p className="muted" style={{ marginTop: 8 }}>{copy.body}</p>
        <Link className="btn" href="/portal">
          {state === "ok" ? "Sign in" : "Back to sign in"}
        </Link>
      </div>
    </main>
  );
}
