/**
 * Who may change the workspace logo, and where its bytes live — shared by the
 * three logo routes so none of them can ask the question differently.
 *
 * `settings.edit`, the capability the brand colours already use
 * (`app/api/theme/route.ts`): a logo is the same kind of decision — it changes
 * what every colleague and every client in the workspace sees — so an
 * administrator who may recolour the brand may also put a mark on it, and one
 * who has had that capability withdrawn loses both.
 *
 * A signed-in account is required as well, as the theme route requires it: the
 * testing role switcher is a demo affordance any browser can use, and it must
 * not be a way to rebrand a workspace for everybody in it.
 */

import { requireCapability, resolvePermissions } from "../../../lib/permissions";
import { scopedDb, type ScopedDatabase } from "../../../lib/tenant-db";

export async function logoEditorScope(
  request: Request,
): Promise<{ denied: Response; scope?: never } | { denied?: never; scope: ScopedDatabase }> {
  const scope = await scopedDb(request);
  const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope);
  const refusal = requireCapability(subject, "settings.edit");
  if (refusal) return { denied: refusal };
  if (!scope.authenticated) {
    return { denied: Response.json({ error: "Sign in to make this change." }, { status: 401 }) };
  }
  return { scope };
}

/** Whether the caller may edit, for a read that answers either way. */
export async function canEditLogo(scope: ScopedDatabase): Promise<boolean> {
  const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope);
  return !requireCapability(subject, "settings.edit");
}

/** The private bucket — R2 locally, Supabase Storage over S3 deployed. */
export async function logoBucket(): Promise<R2Bucket | undefined> {
  const { env } = await import("cloudflare:workers");
  return (env as unknown as { BUCKET?: R2Bucket }).BUCKET;
}

export function storageUnavailable() {
  return Response.json({ error: "File storage is unavailable." }, { status: 503 });
}
