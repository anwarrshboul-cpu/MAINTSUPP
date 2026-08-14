"use client";

import { useState } from "react";
import { api } from "../../lib/api";

/**
 * Sign out.
 *
 * The session cookie belongs to the API's origin, so only the API can clear it —
 * which is why this is a POST rather than a link, and why the navigation
 * afterwards is a full page load. A client-side route change would leave the
 * already-rendered server components on screen, still showing the board of the
 * person who just signed out.
 *
 * It navigates even when the call fails: the API clears the cookie for an
 * already-invalid session too, and a button that appears to do nothing is worse
 * than one that puts you back at the front door.
 *
 * `className` is a prop because this is used both inside the portal shell,
 * which loads portal.css, and on the holding pages, which deliberately do not.
 */
export default function SignOutButton({
  className = "p-signout",
  label = "Sign out",
}: {
  className?: string;
  label?: string;
}) {
  const [pending, setPending] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    await api("/auth/sign-out", { method: "POST" });
    window.location.assign("/portal");
  }

  return (
    <button type="button" className={className} onClick={signOut} disabled={pending}>
      {pending ? "Signing out…" : label}
    </button>
  );
}
