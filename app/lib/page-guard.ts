import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { effectiveCapabilities, resolvePermissions } from "./permissions";
import { governingModule, resolveModuleAccess } from "./portal-modules.ts";
import { readModuleOverrides, readSectionSurface } from "./portal-module-repository.ts";
import { scopedDb } from "./tenant-db";

/** Where a member lands when the module they asked for is not available. */
const MODULE_FALLBACK_PATH = "/dashboard";
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

/**
 * The section a protected page is about — refused before a single element.
 *
 * WHY THIS IS A SECOND GUARD RATHER THAN PART OF THE FIRST.
 *
 * `requirePageSession` answers "are you signed in". Until now that was the ONLY
 * question any portal page asked: `dashboard/[[...section]]/page.tsx` resolved
 * its section from a static table and rendered the shell for any member, and
 * every refusal happened later, per request, in the APIs. That is why a section
 * could be hidden from the sidebar and still render when typed into the address
 * bar — the hiding was a browser-side filter.
 *
 * Master Specification §19 asks for the other half: a module that is switched
 * off "should disappear from navigation; route access must also be blocked
 * appropriately". This is that block, and it is deliberately on the server, at
 * the route entry, where the decision can still be made.
 *
 * WHY IT REDIRECTS RATHER THAN 404s.
 *
 * The product already has an answer for a section it cannot draw, and it is
 * Overview: `page.tsx` falls back to it for an unknown slug, `portal-app.tsx`
 * falls back to it for an unknown key and rewrites the URL, and the sidebar
 * resolver refuses to leave a person with nothing visible. A disabled module is
 * the same situation — a link that was good yesterday — so it gets the same
 * answer rather than a dead end. `notFound()` would also leak that the section
 * exists but is off, which a redirect does not.
 *
 * THE COST, BOUNDED ON PURPOSE.
 *
 * This resolves tenant access and permissions, which `requirePageSession` does
 * not. It runs on DOCUMENT requests only — `/api/*` never renders a page, and
 * the portal is a shell that mounts once and then talks to APIs — so it is a
 * handful of times per session, not once per request. `page-guard.ts` explains
 * at length why none of this may move to middleware.
 */
export async function requireModuleAccess(
  sectionKey: string,
  pathname: string,
): Promise<void> {
  /*
   * NEVER REDIRECT A PAGE TO ITSELF — checked before anything else, because it is
   * the only failure here the browser rather than the product has to stop.
   *
   * Nothing reaches it through a switch: the fallback is `/dashboard`, whose
   * module is `overview`, and `overview` cannot be switched off. It IS reachable
   * through a capability — a role whose `board.view` has been revoked fails
   * `permitted` on every module including Overview — and that is precisely when a
   * loop would form. One comparison, ahead of the work, rather than a redirect
   * chain.
   */
  if (pathname === MODULE_FALLBACK_PATH) return;

  /*
   * WHICH MODULE GOVERNS THIS KEY, WHICH IS NOT ALWAYS THE KEY.
   *
   * Three indirections, and only the first is obvious:
   *
   *   1. a built-in section key IS its module;
   *   2. `units` is a second route onto the Assets screen — see `MODULE_ALIASES`;
   *   3. a `section:<slug>` key draws one of eight BUILT-IN surfaces, and every
   *      one of those eight is a module. That one needs a database read, so it is
   *      resolved inside the try below rather than here.
   *
   * A key none of the three describes — an account panel, a section whose surface
   * is a board — is not this guard's business. Saying nothing is correct;
   * refusing would break every screen the registry does not govern.
   */
  const direct = governingModule(sectionKey);
  const isWorkspaceSection = sectionKey.startsWith("section:");
  if (!direct && !isWorkspaceSection) return;

  let available = true;
  try {
    const request = new Request("https://maintsupp.local/", {
      headers: await headers(),
    });
    const scope = await scopedDb(request);

    /* Indirection 3. Resolved here because it is the only one that costs a query,
       and it is skipped for the eighteen keys that do not need it. */
    let governing = direct;
    if (!governing && isWorkspaceSection) {
      const surface = await readSectionSurface(scope.db, scope.orgId, sectionKey);
      governing = surface ? governingModule(surface) : null;
    }
    if (!governing) return;

    const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope);
    const overrides = await readModuleOverrides(scope.db, scope.orgId);
    available = resolveModuleAccess(
      governing,
      overrides,
      effectiveCapabilities(scope.actor.role, subject.capabilities, subject.siteRestricted),
      scope.actor.role,
    ).available;
  } catch {
    /*
     * FAILING OPEN, AND WHAT THAT DOES AND DOES NOT COST.
     *
     * An earlier version of this comment said "the APIs behind it enforce their
     * own capabilities regardless". Half of that is true and the half it implies
     * is not, so it is worth being exact.
     *
     * TRUE for the capability half: every module's own route holds the capability
     * it needs — `users.view` on `/api/admin/users`, `audit.read` on `/api/audit`,
     * the rank rule in `lib/finance/access.ts` — so rendering the shell for
     * somebody who may not read it yields a screen of refusals, not data.
     *
     * NOT TRUE for the switch: NO operational route consults the registry. Only
     * `/api/context`, `/api/portal-modules` and this function read it. So a
     * request that lands here costs exactly one document render of a module the
     * workspace has switched off, with working data behind it.
     *
     * That is accepted deliberately, because a switch is product configuration
     * and not an authorisation boundary. Failing closed would redirect every page
     * to Overview for the duration of a pooler-capacity event — the estate runs
     * two clients per instance against Supabase's fifteen, and `busyRefusal`
     * exists because that ceiling is reached — which turns a slow minute into a
     * portal that appears to have lost every screen.
     *
     * Note also that `readModuleOverrides` and `readSectionSurface` catch their
     * own failures and answer "no opinion", so a hiccup in the registry read never
     * reaches here at all. What reaches here is a tenancy or permission failure,
     * and the request has already passed `requirePageSession`.
     */
    return;
  }

  if (!available) redirect(MODULE_FALLBACK_PATH);
}
