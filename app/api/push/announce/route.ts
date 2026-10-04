import { ensureDatabase } from "../../../../db/init";
import { recordAudit } from "../../../lib/audit";
import {
  type AnnouncementAudience,
  countAnnouncementReach,
  sendAnnouncement,
} from "../../../lib/push-notify";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";
import { pushConfigured } from "../../../lib/web-push";

export const dynamic = "force-dynamic";

/**
 * /api/push/announce — an announcement to the app's phones (owner, 2026-10-04).
 *
 *   GET   how many phones each audience reaches right now;
 *   POST  { audience: "clients" | "contractors" | "both", title, body }.
 *
 * `settings.edit` (Owner and Admin): a message to every client and contractor
 * is the workspace speaking, not one person.
 */

const AUDIENCES = new Set<AnnouncementAudience>(["clients", "contractors", "both"]);

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const reach = await countAnnouncementReach(guard.scope.db, guard.scope.orgId);
    return Response.json({ configured: pushConfigured(), reach });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "Announcements can't be loaded right now." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    if (!pushConfigured()) {
      return Response.json({ error: "Phone alerts are not set up on this server." }, { status: 409 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      audience?: unknown;
      title?: unknown;
      body?: unknown;
    };
    const audience = typeof body.audience === "string" ? (body.audience as AnnouncementAudience) : null;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!audience || !AUDIENCES.has(audience)) {
      return Response.json({ error: "Choose who it goes to." }, { status: 400 });
    }
    if (!title || title.length > 80) {
      return Response.json({ error: "Give it a title of up to 80 characters." }, { status: 400 });
    }
    if (!text || text.length > 240) {
      return Response.json({ error: "Write a message of up to 240 characters." }, { status: 400 });
    }
    const { db, orgId } = guard.scope;
    const result = await sendAnnouncement(db, orgId, { audience, title, body: text });
    await recordAudit({
      db,
      organisationId: orgId,
      actor: { email: guard.scope.identityEmail || guard.scope.actor.email },
      action: "push.announcement",
      entityType: "workspace",
      entityId: orgId,
      summary: `Announcement to ${audience} sent to ${result.sent} of ${result.devices} phones: ${title}`,
      request,
    }).catch(() => {});
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "The announcement could not be sent right now." }, { status: 503 });
  }
}
