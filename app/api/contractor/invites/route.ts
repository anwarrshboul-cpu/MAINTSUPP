import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { contractors } from "../../../../db/schema";
import { recordAudit } from "../../../lib/audit";
import { createContractorInvite, normaliseIdentity } from "../../../lib/contractor-auth";
import { publicOrigin } from "../../../lib/public-origin";
import { anonymousRefusal, scopedDbWithCapability } from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * POST /api/contractor/invites — a personal link that signs ONE contractor in
 * to the MAINTSUPP app. `board.edit`, the authority that hands out job links.
 *
 * Returns the link and ready-made ways to send it — WhatsApp (wa.me, which
 * the office sends from its own WhatsApp, so no provider is needed), a text,
 * and an email — built from the contractor's own record.
 */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const body = (await request.json().catch(() => ({}))) as { contractorId?: unknown };
    const contractorId = typeof body.contractorId === "string" ? body.contractorId : "";
    const [contractor] = await db
      .select()
      .from(contractors)
      .where(and(eq(contractors.id, contractorId), eq(contractors.organisationId, orgId)))
      .limit(1);
    if (!contractor) return Response.json({ error: "Contractor not found." }, { status: 404 });
    if (!contractor.active) {
      return Response.json({ error: "This contractor is archived. Restore them first." }, { status: 409 });
    }

    const token = await createContractorInvite(db, {
      contractorId: contractor.id,
      organisationId: orgId,
      createdBy: guard.scope.identityEmail || guard.scope.actor.email || null,
    });
    const url = new URL(`/c/${token}`, publicOrigin(request)).toString();
    const greeting = contractor.contactName?.trim() || contractor.name;
    const message = `Hi ${greeting}, here is your MAINTSUPP app link. Open it once and your jobs will be there, with alerts: ${url}`;

    const phone = normaliseIdentity(contractor.whatsappNumber) ?? normaliseIdentity(contractor.phone);
    const digits = phone?.startsWith("tel:") ? phone.slice(4) : null;
    const email = normaliseIdentity(contractor.email);

    await recordAudit({
      db,
      organisationId: orgId,
      actor: { email: guard.scope.identityEmail || guard.scope.actor.email },
      action: "contractor.app_invite",
      entityType: "contractor",
      entityId: contractor.id,
      summary: `App invite link created for ${contractor.name}.`,
      request,
    }).catch(() => {});

    return Response.json({
      url,
      message,
      whatsapp: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null,
      sms: digits ? `sms:+${digits}?&body=${encodeURIComponent(message)}` : null,
      email: email?.startsWith("email:")
        ? `mailto:${email.slice(6)}?subject=${encodeURIComponent("Your MAINTSUPP app link")}&body=${encodeURIComponent(message)}`
        : null,
    });
  } catch (error) {
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: "The invite could not be created right now." }, { status: 503 });
  }
}
