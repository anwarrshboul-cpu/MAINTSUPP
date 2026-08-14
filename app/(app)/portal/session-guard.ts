"use client";

/**
 * When the session ends, go and sign in — do not sit there looking broken.
 *
 * The server side of this is `anonymousRefusal`: every workspace API now
 * answers 401 with `signIn: true` when the caller has no session, instead of
 * the 503 "temporarily unavailable" it used to give. That fixed what the
 * server SAYS. This is what the browser DOES about it.
 *
 * Without it, a dashboard whose session expired overnight renders empty panels
 * and error text on every screen at once, and the only way out is for somebody
 * to work out that "temporarily unavailable" meant "sign in again". There is
 * no in-app cue: the account menu still shows their name, because that came
 * from the page's server render, which happened while they were still signed
 * in.
 *
 * WHY A FETCH WRAPPER. This is a cross-cutting concern with dozens of call
 * sites — every manager, every board, every admin screen has its own loader,
 * and several are plain inline `fetch` calls. Handling it per call site means
 * handling it in most of them and silently missing the rest, and the ones
 * missed are exactly the screens somebody is looking at when it happens. One
 * wrapper cannot be missed.
 *
 * It is deliberately narrow:
 *
 *   - Only 401, and only with `signIn: true`. A 401 without the flag is a
 *     route saying "sign in to make this change" to somebody who IS signed in
 *     but lacks the capability; bouncing them to /login would be a lie and a
 *     loop.
 *   - Only same-origin `/api/…` requests. Nothing else is ours to interpret.
 *   - Never on the auth routes themselves. A failed sign-in answering 401 must
 *     show "those details did not match", not reload the page it is on.
 *   - Once. The first redirect wins; the twenty other in-flight requests that
 *     are about to fail the same way do nothing.
 *   - The response is returned untouched either way, so existing error
 *     handling still runs and nothing changes for callers.
 */

let installed = false;
let redirecting = false;

/** The path to come back to, so signing in returns them where they were. */
function returnTo() {
  return `${window.location.pathname}${window.location.search}`;
}

export function installSessionGuard() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init);
    if (response.status !== 401 || redirecting) return response;

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    // Same-origin API calls only. A relative URL is ours by definition; an
    // absolute one has to name this origin.
    let path: string;
    try {
      path = new URL(url, window.location.origin).pathname;
      if (new URL(url, window.location.origin).origin !== window.location.origin) {
        return response;
      }
    } catch {
      return response;
    }
    if (!path.startsWith("/api/")) return response;
    // Signing in, signing out and accepting an invitation all answer 401 in
    // their own right, and all of them mean something other than "your session
    // ended".
    if (path.startsWith("/api/auth/")) return response;

    /*
     * Read the flag from a CLONE. The caller still owns the body and will read
     * it themselves; consuming it here would hand them a used stream and turn
     * an expired session into a "body already read" crash.
     */
    let signIn = false;
    try {
      const payload = (await response.clone().json()) as { signIn?: unknown };
      signIn = payload?.signIn === true;
    } catch {
      // Not JSON, or no body. Not ours to act on.
    }
    if (!signIn) return response;

    redirecting = true;
    window.location.assign(`/login?next=${encodeURIComponent(returnTo())}`);
    return response;
  };
}
