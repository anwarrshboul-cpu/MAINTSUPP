"use client";

import { useState } from "react";

/**
 * The set-a-new-password form.
 *
 * One shape, unlike the invitation form, because there is only one situation:
 * this account exists and its owner cannot get in. There is no name field —
 * a reset is not a chance to edit somebody's profile — and no email field,
 * because the account is fixed on the token and nothing typed here could
 * point it somewhere better.
 *
 * On success it does NOT navigate into the dashboard, because the server does
 * not issue a session. Being made to sign in with the password just chosen is
 * the point: it keeps the password the only thing that opens the account, and
 * it proves on the spot that the new one works.
 */
export default function SetPasswordForm({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    // Checked here purely so the person is told immediately. The server never
    // receives this field — it only ever sees one password.
    if (password !== confirm) {
      setError("Those passwords do not match.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/auth/password-resets/${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };

      if (!response.ok) {
        setError(payload.error ?? "This password could not be set.");
        // Cleared on failure so a rejected password is not left on screen for
        // whoever walks past next.
        setPassword("");
        setConfirm("");
        setPending(false);
        return;
      }

      setDone(true);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="invite__form">
        <p className="invite__hint">
          The password for <strong>{email}</strong> has been changed, and every
          device that was signed in has been signed out. Sign in with the new
          password.
        </p>
        <a className="invite__submit" href="/login">
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <form className="invite__form" onSubmit={submit} noValidate>
      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="invite__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {/* Present, hidden, and read-only: a password manager needs to know which
          account this password belongs to, and there is no visible field to
          tell it. */}
      <input
        type="email"
        name="email"
        value={email}
        readOnly
        autoComplete="username"
        hidden
      />

      <div className="invite__field">
        <label htmlFor="reset-password">New password</label>
        <input
          id="reset-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          disabled={pending}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby="reset-password-hint"
        />
        <span className="invite__hint" id="reset-password-hint">
          At least 12 characters. Length beats symbols — a short phrase you can
          remember is stronger than a mangled word.
        </span>
      </div>

      <div className="invite__field">
        <label htmlFor="reset-confirm">Confirm password</label>
        <input
          id="reset-confirm"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          disabled={pending}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>

      <button className="invite__submit" type="submit" disabled={pending}>
        {pending ? "Setting…" : "Set new password"}
      </button>
    </form>
  );
}
