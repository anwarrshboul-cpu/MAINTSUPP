/**
 * `GET /api/v1/sites` — the workspace's active sites, for an API token with
 * `sites:read` (§35).
 *
 * The canonical site register only (`listSites`'s default-deny scope), active
 * sites only, narrowed by the token creator's site restriction. Each site is
 * passed through an ALLOWLIST rather than a redaction list: a site row carries
 * access instructions, manager contact details, landlord and billing fields,
 * and a machine integration gets none of them unless a later version decides it
 * should — a field added to the table tomorrow is not published by default.
 */

import { ensureDatabase } from "../../../../db/init";
import { apiJson, scopedDbWithApiToken } from "../../../lib/integrations/api-auth";
import { exposeSite } from "../../../lib/integrations/api-payloads";
import { memberSiteSet, withinMemberScope } from "../../../lib/member-site-scope";
import { listSites } from "../../../lib/sites-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithApiToken(request, "sites:read");
    if (guard.denied) return guard.denied;
    const { db, orgId, siteScope } = guard.api;
    const allowed = memberSiteSet(siteScope);
    const rows = (await listSites(db, orgId)).filter((row) => withinMemberScope(allowed, row.id));
    return apiJson({ sites: rows.map(exposeSite) });
  } catch {
    return apiJson({ error: "The sites API is temporarily unavailable." }, { status: 503 });
  }
}
