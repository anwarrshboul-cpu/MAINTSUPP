"use client";

import { useState } from "react";
import { api } from "../../lib/api";

type Mode = "sign-in" | "create" | "forgot";

/**
 * The portal front door, pointed at the Railway API.
 *
 * The session cookie is set by the API on its own origin, so every call here
 * goes through `api()` with `credentials: "include"` — and the token itself is
 * HttpOnly and never visible to this component.
 *
 * The `autocomplete` tokens are load-bearing: they are what makes a browser or
 * password manager offer to save the login and fill it next time, which on iOS
 * is what puts Face ID in front of the fill. That is the honest answer to the
 * brief's biometrics requirement — WebAuthn passkeys are not implemented, and
 * this is the documented alternative rather than a claim that they are.
 */
export default function PortalAuth() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  async function onSignIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const result = await api<{ status: string }>("/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
        persistent: form.get("persistent") === "on",
      }),
    });
    setPending(false);

    if (!result.ok) return setError(result.error);
    // A full navigation, not a client route change: the session cookie has just
    // been set and the next page is server-rendered with it.
    window.location.assign(
      result.data.status === "active" ? "/portal/dashboard" : "/portal/awaiting-approval",
    );
  }

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const result = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
        fullName: form.get("fullName"),
        phone: form.get("phone"),
        company: form.get("company"), // honeypot
      }),
    });
    setPending(false);

    if (!result.ok) return setError(result.error);
    setNotice(
      "Check your inbox and confirm your email address. An administrator then approves the account and assigns your access.",
    );
  }

  async function onForgot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const result = await api("/auth/forgot", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email") }),
    });
    setPending(false);

    if (!result.ok) return setError(result.error);
    setNotice("If that address has an account, a reset link is on its way. It expires in one hour.");
  }

  return (
    <div className="card actions">
      {mode !== "forgot" ? (
        <div className="tabs" role="tablist" aria-label="Portal access">
          <button
            type="button" role="tab" aria-selected={mode === "sign-in"}
            className={`tab${mode === "sign-in" ? " is-on" : ""}`}
            onClick={() => switchMode("sign-in")}
          >
            Sign in
          </button>
          <button
            type="button" role="tab" aria-selected={mode === "create"}
            className={`tab${mode === "create" ? " is-on" : ""}`}
            onClick={() => switchMode("create")}
          >
            Create account
          </button>
        </div>
      ) : (
        <h1>Reset your password</h1>
      )}

      <div aria-live="polite" aria-atomic="true">
        {error ? <p className="alert alert--bad" role="alert">{error}</p> : null}
        {notice ? <p className="alert alert--good">{notice}</p> : null}
      </div>

      {mode === "sign-in" ? (
        <form onSubmit={onSignIn}>
          <label htmlFor="in-email">Work email</label>
          <input
            id="in-email" name="email" type="email"
            /* `username`, not `email`: this is the account identifier, and it
               is the token that makes a manager store the pair together. */
            autoComplete="username" autoCapitalize="none" spellCheck={false}
            required disabled={pending} placeholder="you@company.com"
          />

          <label htmlFor="in-password">Password</label>
          <input
            id="in-password" name="password" type="password"
            autoComplete="current-password" required disabled={pending}
          />

          <label className="check">
            {/* Ticked by default, per the brief. Unticking drops the cookie's
                lifetime so the session dies with the browser. */}
            <input type="checkbox" name="persistent" defaultChecked disabled={pending} />
            <span>Keep me signed in</span>
          </label>

          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
          <button type="button" className="linkish" onClick={() => switchMode("forgot")}>
            Forgot your password?
          </button>
        </form>
      ) : null}

      {mode === "create" ? (
        <form onSubmit={onCreate}>
          <label htmlFor="up-name">Full name</label>
          <input id="up-name" name="fullName" type="text" autoComplete="name" required disabled={pending} />

          <label htmlFor="up-email">Work email</label>
          <input
            id="up-email" name="email" type="email" autoComplete="email"
            autoCapitalize="none" spellCheck={false} required disabled={pending}
            placeholder="you@company.com"
          />

          <label htmlFor="up-phone">Contact number <span className="muted">optional</span></label>
          <input id="up-phone" name="phone" type="tel" autoComplete="tel" disabled={pending} />

          <label htmlFor="up-password">Password</label>
          <input
            id="up-password" name="password" type="password"
            /* `new-password` prompts a manager to generate one, and stops it
               filling the existing password into a field that then fails the
               length check for reasons the user cannot see. */
            autoComplete="new-password" minLength={10} required disabled={pending}
          />
          <p className="muted small">At least 10 characters.</p>

          {/* Honeypot. Off-canvas rather than display:none — the better bots
              skip fields that are cheap to detect as invisible. */}
          <div className="trap" aria-hidden="true">
            <label htmlFor="up-company">Company</label>
            <input id="up-company" name="company" type="text" tabIndex={-1} autoComplete="off" />
          </div>

          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Creating account…" : "Create account"}
          </button>
          <p className="muted small">
            New accounts are reviewed by an administrator before access is granted.
          </p>
        </form>
      ) : null}

      {mode === "forgot" ? (
        <form onSubmit={onForgot}>
          <label htmlFor="fg-email">Work email</label>
          <input
            id="fg-email" name="email" type="email" autoComplete="username"
            autoCapitalize="none" spellCheck={false} required disabled={pending}
            placeholder="you@company.com"
          />
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send reset link"}
          </button>
          <button type="button" className="linkish" onClick={() => switchMode("sign-in")}>
            Back to sign in
          </button>
        </form>
      ) : null}
    </div>
  );
}
