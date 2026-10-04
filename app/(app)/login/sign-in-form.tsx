"use client";

import { useEffect, useState } from "react";

import {
  deviceUnlockAvailable,
  signInWithThisDevice,
  unlockLabel,
} from "../../lib/passkey-client";
import { useHydrated } from "../../lib/use-hydrated";

/**
 * The sign-in form — Stage 20.
 *
 * Three deliberate choices, all of them about not helping an attacker:
 *
 *   - Whatever the API says is what the user sees. This component never
 *     invents a friendlier message like "we don't recognise that email",
 *     because the server has gone to some trouble to make "no such account"
 *     and "wrong password" indistinguishable and a helpful client would give
 *     that away in one line of JSX.
 *   - The password never leaves this component except in the request body. It
 *     is not put in component state that survives the submit, not logged, and
 *     not placed in the URL — which is where a plain `<form method="get">`
 *     would have put it.
 *   - Navigation after success uses the server's `redirectTo`, not the raw
 *     `next` parameter. The server has already checked it is a path on this
 *     site; trusting the unsanitised one here would reintroduce the open
 *     redirect that `safeRedirectPath` exists to prevent.
 */
export default function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /* Until hydrated, a submit is native — see app/lib/use-hydrated.ts. */
  const hydrated = useHydrated();
  /*
   * FACE ID / FINGERPRINT — offered only on a device that has one ready, so a
   * desktop without Windows Hello is not shown a button that cannot work. The
   * password form is unchanged and always there.
   */
  const [unlock, setUnlock] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void deviceUnlockAvailable().then((available) => {
      if (active && available) setUnlock(unlockLabel());
    });
    return () => {
      active = false;
    };
  }, []);

  async function signInWithUnlock() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      window.location.assign(await signInWithThisDevice(next));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Face ID sign-in didn't work.");
      setPending(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, next }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        redirectTo?: string;
      };

      if (!response.ok) {
        setError(payload.error ?? "Sign-in failed. Try again.");
        setPassword("");
        setPending(false);
        return;
      }

      // A full navigation rather than a client-side route change: the session
      // cookie has just been set, and every server component on the next page
      // has to be rendered with it.
      window.location.assign(payload.redirectTo ?? "/dashboard");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <form className="login-form" method="post" onSubmit={submit} noValidate>
      {/* aria-live on a container that is always rendered, so the message is
          announced when it arrives rather than missed with the element. */}
      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="login-form__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="login-field">
        <label htmlFor="login-email">Work email</label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={pending}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
        />
      </div>

      <div className="login-field">
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <button className="login-form__submit" type="submit" disabled={pending || !hydrated}>
        {pending ? "Signing in…" : "Sign in"}
      </button>

      {unlock && (
        <button
          className="login-form__unlock"
          type="button"
          disabled={pending || !hydrated}
          onClick={() => void signInWithUnlock()}
        >
          Sign in with {unlock}
        </button>
      )}
    </form>
  );
}
