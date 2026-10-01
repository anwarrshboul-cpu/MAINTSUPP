import { useSyncExternalStore } from "react";

/**
 * Whether React has hydrated this component in the browser — false in the server
 * HTML and during hydration, true after.
 *
 * WHY THE CREDENTIAL FORMS NEED IT
 *
 * A form's `onSubmit` only exists once its JavaScript has run. Before that, a
 * click or an Enter is a NATIVE submission, and a `<form>` with no method is a
 * GET: the browser navigated to `/login?email=…&password=…`, putting the
 * password into the address bar, the history, the server's request log and the
 * next page's Referer. On a slow connection that window is seconds long; QA hit
 * it on 2026-10-01 simply by typing before the bundle loaded. The sign-in,
 * set-password and accept-invitation forms keep their submit button disabled
 * until this is true (a disabled default button also blocks Enter-to-submit),
 * and declare `method="post"` so even a submission that slips past cannot put a
 * field in a query string.
 */
const subscribe = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
