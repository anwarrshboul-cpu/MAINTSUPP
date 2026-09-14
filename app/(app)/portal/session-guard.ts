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
 *   - Once. The first redirect wins; the twenty other in-flight requests that
 *     are about to fail the same way do nothing.
 *
 * WHAT THIS IS NOT, SINCE 14 September 2026. It is no longer the only thing
 * standing between an anonymous browser and the dashboard. `app/lib/page-guard.ts`
 * now resolves the session on the SERVER, before any protected route renders,
 * so a signed-out visitor never reaches a screen this wrapper could rescue —
 * the case it used to be asked to handle, and could only handle two to three
 * seconds late and with the dashboard already painted.
 *
 * What is left for it is the case a server guard cannot catch: a session that
 * ends WHILE somebody is looking at a page that was correctly served to them.
 * The next client-side navigation or poll is the first thing to find out, and
 * that discovery still has to become one clean trip to /login.
 *
 * TWO THINGS CHANGED SO THAT IT IS ONE CLEAN TRIP.
 *
 *   - IN-FLIGHT REQUESTS ARE CANCELLED. A dashboard screen fires a dozen
 *     loaders at once. Without this, the first 401 starts the navigation and
 *     the other eleven carry on, land, and each hands its own loader an error
 *     to render on a page that is already leaving.
 *   - AND NOTHING AFTER THE DECISION IS HANDED BACK TO A CALLER. Once the
 *     redirect has been committed, this wrapper returns a promise that never
 *     settles, for the failing request and for anything started afterwards.
 *     That is deliberate and it is the mechanism: a loader whose promise never
 *     resolves never reaches its `catch`, never calls `setError`, and so never
 *     draws the "Your session has ended" card that used to appear on every
 *     widget at once. The string is a SERVER sentence in an API body — see
 *     `anonymousRefusal` in app/lib/tenant-db.ts — and it should never become
 *     a widget state; this is what stops it, without a timeout, a CSS rule or
 *     an opacity trick. The document is being replaced; work scheduled against
 *     the outgoing one has nowhere to go.
 *
 *   - A response that is NOT a session refusal is returned untouched, so
 *     existing error handling still runs and nothing changes for callers.
 */

let installed = false;
let redirecting = false;

/**
 * THE CLIENT'S AUTH STATE, NAMED — AND WHY THERE ARE ONLY TWO OF THEM.
 *
 * The report behind this work asked for a three-state client model,
 * `loading | authenticated | unauthenticated`, to replace a boolean. There was
 * no such boolean to replace: the portal shell has never held a client-side
 * auth flag, and the "loading" window the report describes was not a client
 * state at all. It was the server rendering the dashboard for a request it had
 * not authenticated, under the placeholder identity "Preview User".
 *
 * With `app/lib/page-guard.ts` in front of every protected route, an
 * unauthenticated browser is redirected before any markup exists, so the shell
 * only ever mounts for a session the server has already verified. "loading"
 * and "unauthenticated" are therefore not reachable states of this client —
 * inventing fields for them would be ceremony that can never be exercised, and
 * a neutral splash for a state that cannot occur is dead code.
 *
 * What IS reachable, and is the case no server guard can catch, is a session
 * that ends while somebody is looking at a page that was correctly served to
 * them. That is this flag. Exported so a caller can ask rather than infer.
 */
export function sessionIsEnding() {
  return redirecting;
}

/**
 * Every request this wrapper has started and not yet finished.
 *
 * Tracked so the first session refusal can cancel the rest. Entries are
 * removed as they settle, so this is bounded by concurrency and not by the
 * length of the session.
 */
const inFlight = new Set<AbortController>();

/**
 * A promise that never settles.
 *
 * Handed back for any request whose answer can no longer matter because the
 * browser is leaving. See the note above: this is how a caller is prevented
 * from rendering an error for a page that is being replaced.
 */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * The caller's abort signal and ours, as one.
 *
 * `AbortSignal.any` is the right tool and is present in every browser this
 * portal supports; the fallback forwards the caller's abort onto our own
 * controller so a caller that cancels still cancels, on a runtime that lacks
 * it. Either way OUR signal is live, which is what lets the refusal path
 * cancel a request somebody else started.
 */
function composedSignal(controller: AbortController, callerSignal?: AbortSignal | null) {
  if (!callerSignal) return controller.signal;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([callerSignal, controller.signal]);
  }
  if (callerSignal.aborted) controller.abort();
  else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

/** The path to come back to, so signing in returns them where they were. */
function returnTo() {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Commit to signing in again: cancel everything outstanding, then navigate.
 *
 * Idempotent. The first caller wins and every later one is a no-op, which is
 * the point — a dozen widgets discovering the same dead session must produce
 * one navigation, not a dozen.
 */
function beginSignIn() {
  if (redirecting) return;
  redirecting = true;
  for (const controller of inFlight) {
    // An abort here is expected, not exceptional: the wrapper swallows the
    // resulting rejection rather than letting it reach a loader's catch.
    try {
      controller.abort();
    } catch {
      // A controller that has already settled throws nothing useful.
    }
  }
  inFlight.clear();
  window.location.assign(`/login?next=${encodeURIComponent(returnTo())}`);
}

export function installSessionGuard() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // Already leaving. Nothing started now can be rendered by anything.
    if (redirecting) return neverSettles<Response>();

    const controller = new AbortController();
    const signal = composedSignal(controller, init?.signal);
    inFlight.add(controller);

    let response: Response;
    try {
      response = await original(input, { ...init, signal });
    } catch (error) {
      // The abort that `beginSignIn` fired is not an error a caller should see.
      if (redirecting) return neverSettles<Response>();
      throw error;
    } finally {
      inFlight.delete(controller);
    }

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

    beginSignIn();
    // Not `response`. Handing this back is what let every widget draw its own
    // "Your session has ended" card while the browser was already navigating.
    return neverSettles<Response>();
  };
}
