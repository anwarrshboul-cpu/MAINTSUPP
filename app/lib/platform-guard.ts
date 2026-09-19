import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { scopedDb } from "./tenant-db";

/**
 * THE SERVER SIDE OF "THIS CONSOLE IS NOT YOURS".
 *
 * `requirePageSession` in `page-guard.ts` answers "are you signed in". Every
 * screen under `/admin` needs a second, narrower answer — "are you MAINTSUPP
 * platform staff" — and it has to be given on the server, at the route entry,
 * for exactly the reason that module's header sets out at length: protected markup
 * produced for a request that should not have it is already gone, and nothing a
 * client does afterwards can recall it.
 *
 * WHAT DECIDES, AND WHY IT IS NOT A CAPABILITY
 *
 * `scopedDb(...).platformAdmin`, which `resolveTenantAccess` reads from the
 * `platform_admins` table and never from the request. It is the same value as
 * `crossOrganisation`, and it is what already makes a Super Admin's membership
 * list "every active organisation".
 *
 * A capability would be the wrong instrument. `can()` returns true for
 * `super_admin` before it reads anything at all, so a capability cannot
 * distinguish the platform's own staff from a workspace's most senior role — and
 * the console's whole point is the distinction. The capability each screen's API
 * enforces still enforces it; `PLATFORM_SECTIONS` records which, so the console
 * and the API cannot drift.
 *
 * WHERE A REFUSAL GOES, AND WHY IT IS NOT A 404
 *
 * `/dashboard`. An Owner who follows a link to `/admin` is a legitimate user of
 * this product who has arrived somewhere that is not for them, and the workspace
 * is where they belong — the same answer `/admin/reconcile` already gives, and the
 * same answer the portal gives for any section it cannot draw.
 *
 * `notFound()` was considered and rejected: this console's existence is not a
 * secret (the sign-in page, the marketing site and the docs all refer to MAINTSUPP
 * operating the platform), and a 404 for a URL that plainly exists sends people to
 * support to report a broken link.
 *
 * WHY THIS FAILS CLOSED, UNLIKE THE MODULE GUARD
 *
 * A module switch is product configuration: if the registry cannot be read, the
 * worst case is a screen the workspace meant to hide, and the APIs behind it still
 * enforce every capability. This is not that. Platform-admin is an authorisation
 * boundary, and the screens behind it read across every client's data. So an
 * unresolvable request is refused rather than admitted. The cost of failing closed
 * here is that platform staff see the workspace for one request during a database
 * incident; the cost of failing open is a cross-tenant console rendered on a
 * hiccup, and those are not comparable.
 */

/** Where a request that is not platform staff is sent. */
export const PLATFORM_FALLBACK_PATH = "/dashboard";

/**
 * Allow the request through only if it belongs to MAINTSUPP platform staff.
 *
 * Call AFTER `requirePageSession`, so an anonymous visitor is sent to sign in
 * rather than to the workspace — a redirect to `/dashboard` would bounce them to
 * `/login?next=/dashboard` and lose the address they actually asked for.
 *
 * `redirect()` throws, so nothing after a refusal runs and nothing the caller
 * would have rendered is produced. It is called OUTSIDE the try below, because
 * catching it would swallow the control-flow signal and render the page anyway —
 * the standard version of this bug.
 */
export async function requirePlatformAdmin(): Promise<void> {
  let allowed = false;
  try {
    /* The URL is a placeholder. `scopedDb` reads the cookie header and nothing
       else from it — the same construction `pageSession()` uses, which is proven
       in production. */
    const scope = await scopedDb(
      new Request("https://maintsupp.local/", { headers: await headers() }),
    );
    allowed = scope.platformAdmin === true;
  } catch {
    /* Fail closed. See the header: this is an authorisation boundary, not a
       configuration switch, and the screens behind it read every client's data. */
    allowed = false;
  }

  if (!allowed) redirect(PLATFORM_FALLBACK_PATH);
}
