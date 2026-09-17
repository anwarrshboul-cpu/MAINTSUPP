"use client";

import { useRef, useState } from "react";
import { PasswordInput } from "./password-input";

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
 *
 * The two password fields can be revealed (see `password-input.tsx`), each on
 * its own control. Both go back to hidden before the form sends and when the
 * server refuses it (which also clears them). A mismatch caught here leaves
 * them exactly as they were — revealing the two is how a person spots the
 * typo. The typed passwords are read from the inputs at submit time and are
 * never held in React state, rendered, logged or put in a URL.
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
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState({ password: false, confirm: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function clearPasswords() {
    if (passwordRef.current) passwordRef.current.value = "";
    if (confirmRef.current) confirmRef.current.value = "";
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const password = passwordRef.current?.value ?? "";
    const confirm = confirmRef.current?.value ?? "";

    // Checked here purely so the person is told immediately. The server does
    // not receive or trust this field — it only ever sees one password.
    if (!existingAccount && password !== confirm) {
      setError("Those passwords do not match.");
      return;
    }

    // Hidden again before anything leaves, so the submission is of two
    // password fields — what a password manager expects to see.
    setShown({ password: false, confirm: false });
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
        clearPasswords();
        setShown({ password: false, confirm: false });
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

      <PasswordInput
        id="invite-password"
        name="password"
        label="Choose a password"
        revealLabel="password"
        shown={shown.password}
        onToggle={() => setShown((current) => ({ ...current, password: !current.password }))}
        disabled={pending}
        inputRef={passwordRef}
        describedBy="invite-password-hint"
      >
        <span className="invite__hint" id="invite-password-hint">
          At least 12 characters. Length beats symbols — a short phrase you can
          remember is stronger than a mangled word.
        </span>
      </PasswordInput>

      <PasswordInput
        id="invite-confirm"
        name="confirmPassword"
        label="Confirm password"
        revealLabel="password confirmation"
        shown={shown.confirm}
        onToggle={() => setShown((current) => ({ ...current, confirm: !current.confirm }))}
        disabled={pending}
        inputRef={confirmRef}
      />

      <button className="invite__submit" type="submit" disabled={pending}>
        {pending ? "Setting up…" : "Accept invitation"}
      </button>
    </form>
  );
}
