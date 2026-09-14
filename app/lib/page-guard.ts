import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  getSession,
  safeRedirectPath,
  type AuthenticatedSession,
} from "./auth-session";

/**
 * THE SERVER SIDE OF "YOU ARE NOT SIGNED IN".
 *
 * Before this module the portal had exactly one thing standing between an
 * anonymous browser and the operations dashboard, and it was on the wrong side
 * of the wire: `portal/session-guard.ts`, a client fetch wrapper that waits for
 * an API call to answer 401 and only then navigates to /login.
 *
 * What that produced, measured against this repository on 14 September 2026 —
 * `curl -s http://localhost:5173/dashboard` with no cookie:
 *
 *   1. GET /portal answered 307 to /dashboard without ever asking who was
 *      asking.
 *   2. GET /dashboard answered 200 with 47,663 bytes of the authenticated
 *      shell — "Operations centre", "Good morning", "Job Intelligence" — and
 *      seven copies of the literal "Preview User". `getSession` WAS called on
 *      that page, but only to pick a name, and a null session fell through to
 *      a placeholder identity instead of to a redirect.
 *   3. Twelve API calls then returned 401, each widget drew its own "Your
 *      session has ended" card, and the fetch wrapper finally redirected —
 *      two to three seconds after the dashboard was already on screen.
 *
 * Step 2 is the defect. Protected markup was PRODUCED for an unauthenticated
 * request; everything after it is the system noticing too late. No amount of
 * client-side work fixes that, because the HTML has already left the building.
 *
 * So the guard moves to where the decision can still be made: the server entry
 * of every protected route, before a single element is returned. A missing or
 * invalid session produces a redirect and no body.
 *
 * WHY NOT MIDDLEWARE. The report that asked for this suggested middleware, and
 * middleware is the usual answer. It is the wrong one here. `getSession` reads
 * the `sessions` table through the D1 interface, which deployed is Supabase
 * Postgres over `db/node-pg-d1.ts` — a Node connection, on a session pooler
 * with a hard client ceiling (see `docs/DEPLOYMENT-PORTAL.md`). Putting that
 * read in a middleware layer would either need a second database path for the
 * edge, or would add a connection to every request that reaches the app. The
 * page entries already run in the Node runtime that owns the pool, and one of
 * them was already calling `getSession` successfully in production. Reusing
 * exactly that call is the smaller, provable change, and it keeps ONE session
 * implementation shared by the pages and the API — which is the property that
 * actually matters here: the server guard and `requireSession` cannot disagree
 * about what a valid session is, because they are the same function.
 *
 * WHAT STOPS THE NEXT PAGE FORGETTING. `tests/portal-auth-guard.test.mjs`
 * enumerates every `page.tsx` under `app/(app)` and fails unless each one
 * either calls `requirePageSession` or is named on an explicit public
 * allowlist with a reason written next to it. A protected route added without
 * a guard is a red test, not a silent leak.
 */

/** Where an unauthenticated visitor is sent. */
export const LOGIN_PATH = "/login";

/**
 * The sign-in URL that comes back to `pathname` afterwards.
 *
 * `safeRedirectPath` is applied on the way OUT as well as on the way in. These
 * paths are built from route params, which are attacker-controlled — a link to
 * `/dashboard/<anything>` is a link anybody can send — so the value is
 * sanitised here, encoded into the query, and sanitised a second time by
 * `app/(app)/login/page.tsx` when it reads `?next=`. Two independent checks on
 * the one value that decides where a browser lands after authenticating.
 */
export function loginRedirect(pathname: string) {
  return `${LOGIN_PATH}?next=${encodeURIComponent(safeRedirectPath(pathname))}`;
}

/**
 * The session behind the current request, or null.
 *
 * A thin wrapper over `getSession` that builds the `Request` the shared
 * implementation expects out of the incoming headers. The URL is a placeholder:
 * `getSession` reads the cookie header and nothing else from it.
 */
export async function pageSession(): Promise<AuthenticatedSession | null> {
  return getSession(
    new Request("https://maintsupp.local/", { headers: await headers() }),
  );
}

/**
 * The session behind the current request — or a redirect to sign in.
 *
 * `redirect()` throws, so nothing after this call runs and nothing the caller
 * would have rendered is ever produced. Callers must NOT wrap it in a
 * try/catch that swallows the thrown control-flow signal.
 */
export async function requirePageSession(
  pathname: string,
): Promise<AuthenticatedSession> {
  const session = await pageSession();
  if (session) return session;
  redirect(loginRedirect(pathname));
}
