/**
 * The workspace's brand colours, as a `:root` block, for `app/(app)/layout.tsx`.
 *
 * WHY THE COST OF THIS IS ACCEPTABLE, HAVING CHECKED
 *
 * `page-guard.ts` argues at length against putting a database read in middleware,
 * because `getSession` reaches Supabase Postgres over a session pooler with a
 * hard client ceiling and middleware runs on every request. That argument is
 * right and it was the first thing weighed here.
 *
 * It does not apply to this call, for one reason: **the layout renders on
 * document requests only.** `/api/*` never renders it, and the portal is a shell
 * — `PortalApp` mounts once and everything afterwards is an API call. So this
 * costs one resolution per full page load, a handful of times per session,
 * rather than once per request.
 *
 * `theme-repository.ts` deliberately does NOT cache the read, and its header
 * explains why: the per-isolate cache it first carried made a saved colour
 * invisible on other serverless instances for up to thirty seconds, which reads
 * as a save that failed. One indexed lookup on a rare path is the better trade.
 *
 * THE TWO EARLY RETURNS ARE THE POINT
 *
 * No session cookie means no workspace, so `/login` and every anonymous request
 * do **zero** database work and render no element. And any failure — an ended
 * session, a workspace the actor has no access to, a database hiccup — returns
 * the empty string rather than throwing. This function decides what colour the
 * product is; it must never be the reason a page fails to render. The worst
 * outcome it can produce is the palette that ships in `globals.css`, which is
 * exactly what every workspace sees today.
 *
 * WHY NOT `session.organisationId`
 *
 * It would be one indexed read instead of a resolution, and it is wrong twice
 * over: `setSessionOrganisation` has no callers, so the column is written at
 * sign-in and never updated — the theme would not follow a workspace switch —
 * and it is not filtered through `isAllowed`, so it is not the value the rest of
 * the product means by "this workspace". `resolveTenantAccess` is the one place
 * that answers that question and this asks it there.
 */

import { headers } from "next/headers";

import { ensureDatabase } from "../../db/init";
/* Imported rather than restated: a second copy of the cookie name would keep
   working after the real one changed, and would fail by silently skipping the
   theme on every request — the quietest possible break. */
import { SESSION_COOKIE } from "./auth-session";
import { scopedDb } from "./tenant-db";
import { readThemeOverrides } from "./theme-repository.ts";
import { resolveThemeCss } from "./theme-tokens.ts";

export async function organisationThemeCss(): Promise<string> {
  try {
    const incoming = await headers();
    const cookie = incoming.get("cookie");
    /* No session, no workspace, nothing to override — and, more importantly, no
       database work on the sign-in page or for a crawler. */
    if (!cookie || !cookie.includes(`${SESSION_COOKIE}=`)) return "";

    await ensureDatabase();

    /* The same synthetic request `pageSession()` builds, for the same reason:
       the shared resolver takes a `Request` and reads only its headers. */
    const scope = await scopedDb(
      new Request("https://maintsupp.local/", { headers: incoming }),
    );

    const overrides = await readThemeOverrides(scope.db, scope.orgId);
    return resolveThemeCss(overrides);
  } catch (error) {
    /* Deliberately swallowed. See the header: a theme lookup must not be able
       to take a page down, and the fallback is the shipped palette. */
    console.error("[theme-render] falling back to the shipped palette", error);
    return "";
  }
}
