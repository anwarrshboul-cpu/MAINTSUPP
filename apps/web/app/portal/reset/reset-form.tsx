"use client";

import { useState } from "react";
import { api } from "../../../lib/api";

/**
 * Choosing a new password, having arrived from a reset link.
 *
 * The confirmation field is checked here and only here: the server receives one
 * password and has nothing to compare it against, so a typed-twice mismatch is
 * the client's job. Everything else — length, whether the token is live — is
 * the server's, and its message is shown verbatim rather than reworded.
 */
export default function ResetForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      return setError("The two passwords do not match.");
    }

    setPending(true);
    setError(null);
    const result = await api("/auth/reset", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
    setPending(false);

    if (!result.ok) return setError(result.error);
    setDone(true);
  }

  if (done) {
    return (
      <div className="card">
        <h1>Password changed</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          {/* Stated because it is a security property people should be able to
              rely on: completing a reset ends every other session, which is the
              whole point of resetting a password you think is compromised. */}
          You are signed out everywhere else. Sign in with your new password.
        </p>
        <a className="btn" href="/portal">Sign in</a>
      </div>
    );
  }

  return (
    <div className="card actions">
      <h1>Set a new password</h1>

      <div aria-live="polite" aria-atomic="true">
        {error ? <p className="alert alert--bad" role="alert">{error}</p> : null}
      </div>

      <form onSubmit={submit}>
        <label htmlFor="reset-password">New password</label>
        <input
          id="reset-password" name="password" type="password"
          autoComplete="new-password" minLength={10} required disabled={pending}
        />
        <p className="muted small">At least 10 characters.</p>

        <label htmlFor="reset-confirm">Confirm new password</label>
        <input
          id="reset-confirm" name="confirm" type="password"
          autoComplete="new-password" minLength={10} required disabled={pending}
        />

        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save password"}
        </button>
      </form>
    </div>
  );
}
