/**
 * `GET /api/versions?subject=&key=&limit=20&before=<n>` — a versioned setting's
 * history, newest first (§38).
 *
 * Who may read it is who may edit the setting: `settings.edit` for the brand
 * colours and the default dashboard, `navigation.edit` for the modules and the
 * default sidebar. The workspace is the caller's own, from the tenancy
 * resolver — never from the request — so another workspace's history is never
 * reachable. The snapshots themselves are never sent: a version is restored by
 * the setting's OWN save route with `{ restoreVersion }`, which loads the
 * snapshot server-side and records the restore as a new version.
 *
 * `current` marks the versions whose state equals what is in force now.
 *
 * §38b — a WEBSITE PAGE is installation-wide (one website, no workspace): its
 * history is read only by MAINTSUPP platform staff — the same rule, and the
 * same two conditions, as `/api/site-pages` — and is filtered on
 * `organisation_id IS NULL`. `?subject=site_page&deleted=1` lists the pages
 * whose latest version is a deletion, so a deleted page can be found and
 * brought back.
 */

import { ensureDatabase } from "../../../db/init";
import { versionSubject, VERSION_SUBJECTS } from "../../lib/config-versions-model";
import { listConfigVersions, listDeletedKeys, stateDigest } from "../../lib/config-versions";
import { liveSnapshot } from "../../lib/config-versions-live";
import { databaseSafeFailure } from "../../lib/database-failure";
import { requireCapability, resolvePermissions } from "../../lib/permissions";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const scope = await scopedDb(request);
    const platformStaff = scope.platformAdmin === true && scope.authenticated;

    if (url.searchParams.get("subject") === "site_page" && url.searchParams.get("deleted") === "1") {
      if (!platformStaff) return Response.json({ error: "The website is administered by MAINTSUPP platform staff." }, { status: 403 });
      return Response.json({ deleted: await listDeletedKeys(scope.db, "site_page") });
    }

    const target = versionSubject(url.searchParams.get("subject"), url.searchParams.get("key"));
    if (!target) return Response.json({ error: "Name a setting that has a version history." }, { status: 400 });
    const definition = VERSION_SUBJECTS[target.subject];
    const installation = definition.scope === "installation";
    if (installation) {
      if (!platformStaff) return Response.json({ error: "The website is administered by MAINTSUPP platform staff." }, { status: 403 });
    } else {
      const permissions = await resolvePermissions(scope.db, scope.orgId, scope.actor.role, scope.siteScope);
      const refusal = requireCapability(permissions, definition.capability as "settings.edit" | "navigation.edit");
      if (refusal) return refusal;
    }
    const organisationId = installation ? null : scope.orgId;

    const limit = Number(url.searchParams.get("limit") ?? 20);
    const before = Number(url.searchParams.get("before") ?? 0);
    const liveDigest = await stateDigest(await liveSnapshot(scope.db, organisationId, target.subject, target.key));
    const history = await listConfigVersions(
      scope.db,
      { organisationId, subject: target.subject, key: target.key },
      { limit: Number.isInteger(limit) ? limit : 20, before: Number.isInteger(before) && before > 0 ? before : null, liveDigest },
    );
    return Response.json({ subject: target.subject, key: target.key, label: definition.label, ...history });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    const safe = databaseSafeFailure(error, "The version history is temporarily unavailable.", 503);
    return Response.json({ error: safe.message }, { status: safe.status });
  }
}
