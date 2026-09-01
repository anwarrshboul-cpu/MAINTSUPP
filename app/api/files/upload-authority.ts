/**
 * WHO MAY STORE A DOCUMENT — the one answer both upload routes ask for.
 *
 * W07-01. Before this module the two routes decided it themselves, identically
 * and wrongly:
 *
 *     const isOperator = authenticated || demoIdentityAllowed();
 *
 * and then gated every authorisation branch on `!isOperator`. That reads as a
 * check and is the opposite of one. `authenticated` answers "did you prove who
 * you are", never "may you"; so any signed-in principal of any role — including
 * a `client`, whose capabilities are `board.view` and `data.export` and nothing
 * else — walked straight past the token binding, the allowed-kinds grant and the
 * expiry check to the R2 put. Measured on the running server: the same identity
 * that is answered 403 by `DELETE /api/files/[id]` was answered 201 by
 * `POST /api/files`. The destructive verb was guarded and the creating verb was
 * not.
 *
 * WHY A SHARED MODULE RATHER THAN THE SAME FIX TWICE. These two routes have
 * already drifted once on exactly this surface: `pending` and `submitted_via`
 * were written by the direct route and not by the multipart one, so every
 * contractor photograph over ~900 KB — which is every photograph a phone takes —
 * published itself straight onto the job while the small test files queued for
 * review. A rule that must hold on both paths belongs in one place that both
 * paths call.
 *
 * THE ORDER IS THE DESIGN.
 *
 * A token is consulted BEFORE a session, not after, and that single ordering is
 * what makes the fix safe. The obvious implementation — "if you are signed in
 * you must hold `board.edit`" — inverts the product: a signed-in `client` who
 * opens a public form link in the same browser would be REFUSED while an
 * anonymous stranger holding the identical link is ALLOWED. Signing in would
 * take away a permission, which is never right. Resolving the token first means
 * the grant a person is actually exercising is the one that answers for them,
 * and the capability check is reached only by a caller who presented no grant at
 * all — the dashboard.
 *
 * So:
 *   1. a contractor job link (`job_access_tokens`)      -> its own grant
 *   2. a public request/form token (`public_upload_token_hash` on the job row)
 *                                                       -> its own grant
 *   3. no token at all                                  -> `board.edit`
 *   4. otherwise                                        -> 403
 *
 * `demoIdentityAllowed()` disappears from the decision entirely, and that is the
 * point rather than a side effect. It was load-bearing only because the branch
 * turned on `authenticated`, which the sidebar's "Preview User / TESTING ACCESS"
 * switcher deliberately does not set — so the switcher had to be waved through
 * wholesale, which in development waved EVERYONE through wholesale, and the
 * routes became untestable: no local request could be told apart from an
 * authorised one. A capability is resolved from the actor's ROLE, in development
 * exactly as in production (`resolvePermissions`), so the demo switcher now gets
 * precisely the access the role it is previewing would get, and a local test
 * proves something about production for the first time.
 */

import { eq } from "drizzle-orm";
import { maintenanceRequests } from "../../../db/schema";
import {
  recordTokenUse,
  resolveJobToken,
  type EvidenceKind,
} from "../../lib/job-tokens";
import { requireCapability, resolvePermissions } from "../../lib/permissions";
import { demoIdentityAllowed } from "../../lib/tenant-access";
import { anonymousRefusal, type ScopedDatabase } from "../../lib/tenant-db";

type TokenScope = NonNullable<Awaited<ReturnType<typeof resolveJobToken>>>;

/** The grant a stored document was written under. Recorded, not just checked. */
export type UploadVia = "job-token" | "request-token" | "capability";

export type UploadAuthority =
  | { denied: Response; via?: never; token?: never }
  | { denied?: never; via: UploadVia; token: TokenScope | null };

/**
 * The job row the upload is being filed against, or null for a document with no
 * job at all — a contractor's insurance certificate, a site drawing. Both token
 * paths require one by construction (a token names a job); the capability path
 * does not, which is what W07-07 opened up.
 */
type WorkOrder = Pick<
  typeof maintenanceRequests.$inferSelect,
  "id" | "organisationId" | "publicUploadTokenHash" | "publicUploadTokenExpiresAt"
> | null;

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function refuse(error: string, status: number) {
  return Response.json({ error }, { status });
}

/**
 * The organisation an upload must be written into, resolved from the token when
 * there is one.
 *
 * Called BEFORE the job is looked up, because it decides which tenant the lookup
 * happens in. An anonymous caller's ambient `orgId` is always the PRIMARY
 * organisation whatever the token says, so looking the job up with that and
 * checking the token afterwards would leave nothing between a second tenant's
 * link and the first tenant's data except the two job ids happening not to
 * collide — and they are not guaranteed not to, because `/api/maintenance` mints
 * `MN-<n>` per organisation, so two tenants onboarded through the public form
 * hold identical ids.
 *
 * Returns the token as well, so the caller does not resolve it a second time.
 */
export async function resolveUploadTenant(
  db: ScopedDatabase["db"],
  ambientOrgId: string,
  uploadToken: string,
): Promise<{ orgId: string; token: TokenScope | null }> {
  if (!uploadToken) return { orgId: ambientOrgId, token: null };
  const token = await resolveJobToken(db, uploadToken);
  /*
   * A token that does not resolve leaves the ambient organisation alone rather
   * than refusing here. It may still be a legacy request-row token, which is
   * verified against the job itself and therefore cannot be checked until the
   * job has been found — and the job is found in the ambient tenant, which is
   * correct for that flow because a request-row token names its own job.
   */
  return { orgId: token ? token.organisationId : ambientOrgId, token };
}

/**
 * Decides whether this upload may proceed, and under which grant.
 *
 * `storedKind` is the kind that will ACTUALLY be written — after the column has
 * coerced it, not the kind the caller asked for. Checking the grant against the
 * requested kind was a real bug on both routes: the contractor page sends
 * `kind=issue` with the issue column's id, the direct route rewrote that to
 * "general" and then compared "general" against a link granted `issue`, and
 * answered 403 for a request the link plainly permitted.
 */
export async function resolveUploadAuthority(options: {
  request: Request;
  scope: ScopedDatabase;
  orgId: string;
  workOrder: WorkOrder;
  storedKind: string;
  uploadToken: string;
  /** Resolved by `resolveUploadTenant`, so it is not looked up twice. */
  jobToken: TokenScope | null;
}): Promise<UploadAuthority> {
  const { request, scope, orgId, workOrder, storedKind, uploadToken, jobToken } =
    options;

  /* ── 1. A contractor job link ─────────────────────────────────────────── */
  if (jobToken) {
    if (!workOrder) {
      return { denied: refuse("This link does not belong to that job.", 403) };
    }
    if (jobToken.requestId !== workOrder.id) {
      return { denied: refuse("This link does not belong to that job.", 403) };
    }
    /*
     * Belt and braces: the lookup above already used the token's organisation,
     * so this cannot fail. It is here so that a future change to either side
     * cannot quietly separate them.
     */
    if (jobToken.organisationId !== workOrder.organisationId) {
      return { denied: refuse("This link does not belong to that job.", 403) };
    }
    if (!jobToken.allowedKinds.includes(storedKind as EvidenceKind)) {
      return {
        denied: refuse(`This link cannot upload ${storedKind} evidence.`, 403),
      };
    }
    // Counts towards the link's usage so a coordinator can see whether the
    // contractor ever opened it.
    await recordTokenUse(scope.db, jobToken.id);
    return { via: "job-token", token: jobToken };
  }

  /* ── 2. A public request or form token, held on the job row ───────────── */
  if (uploadToken && workOrder) {
    const validUntil = workOrder.publicUploadTokenExpiresAt
      ? new Date(workOrder.publicUploadTokenExpiresAt).getTime()
      : 0;
    const suppliedHash = await sha256(uploadToken);
    const matches =
      Boolean(workOrder.publicUploadTokenHash) &&
      suppliedHash === workOrder.publicUploadTokenHash &&
      validUntil >= Date.now();
    if (matches) {
      /*
       * Deliberately narrower than a contractor link: this grant exists so
       * somebody submitting the public form can attach fault photographs, and
       * widening it would let any reporter link write completion evidence —
       * which is the record of work being signed off.
       */
      if (storedKind !== "issue") {
        return {
          denied: refuse("Public requests can only add issue evidence.", 403),
        };
      }
      return { via: "request-token", token: null };
    }
    /*
     * A token was presented and did not match anything. FALL THROUGH to the
     * capability check rather than refusing here — a signed-in coordinator whose
     * page happens to carry a stale token is still a coordinator, and refusing
     * them for holding a dead string would be the same class of mistake as
     * refusing a signed-in client who holds a live one. If they have no
     * capability either, step 3 refuses them, and its message is the accurate
     * one.
     */
  }

  /* ── 3. No grant presented: the dashboard. Prove the permission. ──────── */
  /*
   * `scopedDbWithCapability` cannot be used here, and that is worth saying
   * plainly because it is the obvious move. It calls `scopedDb(request)` WITHOUT
   * `allowAnonymous`, which THROWS for a caller with no session — and this route
   * must keep serving exactly such a caller through steps 1 and 2. So the two
   * halves it performs are done by hand: the authentication floor first, then
   * the capability. This is the pattern `PUT /api/files/[id]` already uses for
   * the same reason.
   */
  if (!scope.authenticated && !demoIdentityAllowed()) {
    /*
     * 401, not 403. There is a real difference for the caller: sign in and this
     * may succeed, whereas 403 says it never will. `anonymousRefusal` is the
     * codebase's own wording for it, so an expired session on the upload path
     * reads the same as an expired session everywhere else instead of looking
     * like a permissions problem.
     */
    return {
      denied:
        anonymousRefusal(undefined) ??
        refuse("Sign in to upload a document.", 401),
    };
  }

  const subject = await resolvePermissions(scope.db, orgId, scope.actor.role);
  const refusal = requireCapability(subject, "board.edit");
  if (refusal) return { denied: refusal };

  void request;
  return { via: "capability", token: null };
}

/**
 * Whether a document stored under this grant waits for a coordinator.
 *
 * Only a contractor link's upload is held: `pending` and `submitted_via` were
 * added for precisely that flow — "uploads through a public link land here
 * first, a coordinator accepts or rejects before they join the job's evidence
 * record". A signed-in operator's upload is not pending, and neither is a public
 * form's fault photograph, which is part of the request being reported rather
 * than evidence arriving against work already in progress.
 *
 * Expressed as a function of the grant rather than of `!isOperator` on purpose.
 * The old expression happened to agree with this one, and would have stopped
 * agreeing the moment a signed-in client used a contractor link — the review
 * queue would have silently skipped exactly the upload it exists to catch.
 */
export function pendingReview(via: UploadVia): boolean {
  return via === "job-token";
}
