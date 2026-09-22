/**
 * `GET /api/admin/backups` — what the portal can TRUTHFULLY say about backups
 * and recovery (Master Specification §39: visibility only; no fake buttons).
 *
 * The database host (Supabase) takes the backups. Reading their status needs a
 * Supabase management token, which this deployment does not have, so the
 * honest answer about backups themselves is "not visible from here — look in
 * the provider's dashboard", and nothing on the screen may suggest otherwise.
 * What the portal CAN see is stated as measured:
 *   - which database it is running on (`databasePosture`);
 *   - whether file storage is the private bucket or a fallback (the same four
 *     `S3_*` variables the storage driver requires);
 *   - whether the database's migrations match this code: the fingerprint the
 *     last complete migration run stored (`schema_state`) against the one this
 *     build carries (`SCHEMA_FINGERPRINT`).
 *
 * Platform staff only — the same two conditions as every screen in /admin.
 * Read-only: there is no POST, and there must never be one without a real
 * operation behind it.
 */

import { getD1 } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import { SCHEMA_FINGERPRINT, SCHEMA_STATE_KEY } from "../../../../db/schema-fingerprint";
import { currentRuntime, databasePosture, S3_VARIABLES } from "../../../lib/integrations/posture";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    if (scope.platformAdmin !== true || !scope.authenticated) {
      return Response.json({ error: "This screen is for MAINTSUPP platform staff." }, { status: 403 });
    }

    const env = (process.env ?? {}) as Record<string, string | undefined>;
    const runtime = currentRuntime();
    const storageSet = S3_VARIABLES.filter((name) => Boolean(env[name]?.trim())).length;
    const storage =
      runtime === "workers"
        ? { name: "File storage — Cloudflare R2 (local development)", configured: true, detail: "Miniflare's local R2 binding." }
        : storageSet === S3_VARIABLES.length
          ? { name: "File storage — private Supabase bucket", configured: true, detail: "Reached over its S3 API. Every file is served through the portal's own access checks." }
          : storageSet > 0
            ? { name: "File storage — misconfigured", configured: false, detail: "Only some of the S3 settings are present, so uploads go to this server's own disk and do not survive a redeploy." }
            : { name: "File storage — this server's own disk", configured: false, detail: "No S3 storage is configured, so uploads go to this server's own disk and do not survive a redeploy." };

    const d1 = await getD1();
    const stored = (await d1
      .prepare("SELECT value, updated_at FROM schema_state WHERE key = ?")
      .bind(SCHEMA_STATE_KEY)
      .first()) as { value?: string; updated_at?: string } | null;
    const storedFingerprint = stored?.value ? stored.value.split(":")[0] : null;

    return Response.json({
      backups: {
        provider: "Supabase",
        visible: false,
        detail:
          "Backups of the database are taken by Supabase, the database host. The portal has no Supabase management token, so it cannot read their schedule or status. Check them in the Supabase dashboard (Database → Backups).",
      },
      database: databasePosture(env, runtime),
      storage,
      migrations: {
        codeFingerprint: SCHEMA_FINGERPRINT,
        storedFingerprint,
        appliedAt: stored?.updated_at ?? null,
        current: storedFingerprint === SCHEMA_FINGERPRINT,
      },
      omissions: [
        "No backup is started, restored or downloaded from here — the portal cannot do any of those, so it offers none of them.",
        "Backup schedule, retention and last-success time are not shown: reading them needs a Supabase management token, which is not configured.",
        "File storage is not backed up by the portal. The bucket's own durability is the provider's.",
      ],
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "The backup status could not be read." }, { status: 503 });
  }
}
