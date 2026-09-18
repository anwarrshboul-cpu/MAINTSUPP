"use client";

import { useRef, useState } from "react";
import { PasswordInput } from "../../password-input";

/**
 * The set-a-new-password form.
 *
 * One shape, unlike the invitation form, because there is only one situation:
 * this account exists and its owner cannot get in. There is no name field —
 * a reset is not a chance to edit somebody's profile — and no email field,
 * because the account is fixed on the token and nothing typed here could
 * point it somewhere better.
 *
 * Both fields can be revealed, each on its own control, through the same
 * `PasswordInput` the invitation page uses — the person setting a password
 * they cannot see is exactly the person who most needs to check it. That
 * component is uncontrolled, so the passwords are read from the inputs at
 * submit time and are never held in React state, rendered, logged or put in a
 * URL; they were in state here before, which put the value into the markup.
 * Both go back to hidden before the form sends and when the server refuses it.
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
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState({ password: false, confirm: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  function clearPasswords() {
    if (passwordRef.current) passwordRef.current.value = "";
    if (confirmRef.current) confirmRef.current.value = "";
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const password = passwordRef.current?.value ?? "";
    const confirm = confirmRef.current?.value ?? "";

    // Checked here purely so the person is told immediately. The server never
    // receives this field — it only ever sees one password. A mismatch leaves
    // both fields exactly as they were, revealed or not: reading the two is how
    // a person spots the typo.
    if (password !== confirm) {
      setError("Those passwords do not match.");
      return;
    }

    // Hidden again before anything leaves, so the submission is of two password
    // fields — what a password manager expects to see.
    setShown({ password: false, confirm: false });
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
        clearPasswords();
        setShown({ password: false, confirm: false });
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

      <PasswordInput
        id="reset-password"
        name="password"
        label="New password"
        revealLabel="password"
        shown={shown.password}
        onToggle={() => setShown((current) => ({ ...current, password: !current.password }))}
        disabled={pending}
        inputRef={passwordRef}
        describedBy="reset-password-hint"
      >
        <span className="invite__hint" id="reset-password-hint">
          At least 12 characters. Length beats symbols — a short phrase you can
          remember is stronger than a mangled word.
        </span>
      </PasswordInput>

      <PasswordInput
        id="reset-confirm"
        name="confirmPassword"
        label="Confirm password"
        revealLabel="password confirmation"
        shown={shown.confirm}
        onToggle={() => setShown((current) => ({ ...current, confirm: !current.confirm }))}
        disabled={pending}
        inputRef={confirmRef}
      />

      <button className="invite__submit" type="submit" disabled={pending}>
        {pending ? "Setting…" : "Set new password"}
      </button>
    </form>
  );
}
