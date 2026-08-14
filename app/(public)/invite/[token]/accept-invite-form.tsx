"use client";

import { useState } from "react";

/**
 * The accept-invitation form — Stage 20.
 *
 * Two shapes, chosen by the server, not by this component:
 *
 *   - `existingAccount: false` — the invited address has no password yet, so
 *     the person sets one here and is signed straight in.
 *   - `existingAccount: true` — the address already belongs to somebody. No
 *     password field is offered at all, because the server will refuse to
 *     change a password through an invitation link (that would be an account
 *     takeover: see the POST handler). They sign in and reopen the link, and
 *     the membership is added without their credential being touched.
 *
 * The role is never sent from here. It is fixed on the invitation row and read
 * from the database at acceptance — there is nothing in this form that could
 * ask for a better one.
 */
export default function AcceptInviteForm({
  token,
  email,
  existingAccount,
}: {
  token: string;
  email: string;
  existingAccount: boolean;
}) {
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    // Checked here purely so the person is told immediately. The server does
    // not receive or trust this field — it only ever sees one password.
    if (!existingAccount && password !== confirm) {
      setError("Those passwords do not match.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/auth/invitations/${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            existingAccount ? {} : { password, fullName },
          ),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        redirectTo?: string;
      };

      if (!response.ok) {
        setError(payload.error ?? "This invitation could not be accepted.");
        setPassword("");
        setConfirm("");
        setPending(false);
        return;
      }

      // Full navigation: a session cookie has just been issued and the whole
      // dashboard has to be rendered with it.
      window.location.assign(payload.redirectTo ?? "/dashboard");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  if (existingAccount) {
    return (
      <form className="invite__form" onSubmit={submit}>
        <div aria-live="polite" aria-atomic="true">
          {error ? (
            <p className="invite__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <p className="invite__hint">
          <strong>{email}</strong> already has a MAINTSUPP account. Sign in with
          your existing password first, then return to this page to join the
          workspace. Your password is not changed.
        </p>
        <a
          className="invite__submit"
          href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
        >
          Sign in to continue
        </a>
        <button className="invite__submit" type="submit" disabled={pending}>
          {pending ? "Joining…" : "I am already signed in — join now"}
        </button>
      </form>
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

      <div className="invite__field">
        <label htmlFor="invite-name">Your name</label>
        <input
          id="invite-name"
          name="fullName"
          type="text"
          autoComplete="name"
          disabled={pending}
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          placeholder="Alex Morgan"
        />
      </div>

      <div className="invite__field">
        <label htmlFor="invite-password">Choose a password</label>
        <input
          id="invite-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          disabled={pending}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby="invite-password-hint"
        />
        <span className="invite__hint" id="invite-password-hint">
          At least 12 characters. Length beats symbols — a short phrase you can
          remember is stronger than a mangled word.
        </span>
      </div>

      <div className="invite__field">
        <label htmlFor="invite-confirm">Confirm password</label>
        <input
          id="invite-confirm"
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
        {pending ? "Setting up…" : "Accept invitation"}
      </button>
    </form>
  );
}
