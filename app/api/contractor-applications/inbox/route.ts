import { and, desc, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { contractorApplications, contractors, organisations } from "../../../../db/schema";
import { WEBSITE_LEADS_WORKSPACE_ID } from "../../../../db/website-leads-workspace";
import { DEMO_WORKSPACE_ID } from "../../../../db/demo-workspace";
import { DEMO_ORGANISATION_ID } from "../../../lib/tenant-access";
import { createContractorInvite } from "../../../lib/contractor-auth";
import { emailShell, sendNotification } from "../../../lib/notifications";
import { publicOrigin } from "../../../lib/public-origin";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";
import { auditActor, recordAudit } from "../../../lib/audit";
import {
  APPLICATION_OMISSIONS,
  APPLICATION_STATUSES,
  DEFAULT_APPLICATION_STATUS,
  applicationStatus,
  isApplicationStatus,
} from "../../../lib/application-status";

export const dynamic = "force-dynamic";

/**
 * The contractor applications inbox — Master Specification §12, for the public
 * /contractors form. Read by `/admin/applications`.
 *
 * Until now nothing read `contractor_applications` at all: the public route
 * wrote a row and an email, and the row was unreachable from then on.
 *
 * ⚠️ GATED ON PLATFORM STAFF, NOT A CAPABILITY — for the reason `GET /api/leads`
 * gives, and measured here as well: an anonymous application used to be filed
 * under the PRIMARY organisation, a real client company's workspace. A workspace
 * capability over these rows would have shown that customer every contractor who
 * ever applied to MAINTSUPP. New applications now go to the platform's intake
 * workspace; rows stored before that correction stay where they are until they
 * are re-homed deliberately, and this inbox reads across every workspace a
 * platform admin may see, naming the workspace each one is filed under.
 *
 * The public route stays write-only (`../route.ts` has no GET, and a test says
 * so): this read lives here, behind `platformAdmin`.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    if (scope.platformAdmin !== true || !scope.authenticated) {
      return Response.json(
        { error: "Contractor applications are read by MAINTSUPP platform staff." },
        { status: 403 },
      );
    }

    const rows = await scope.db
      .select()
      .from(contractorApplications)
      .where(inArray(contractorApplications.organisationId, scope.organisationIds))
      .orderBy(desc(contractorApplications.createdAt));

    const workspaces = scope.organisationIds.length
      ? await scope.db
          .select({ id: organisations.id, name: organisations.name })
          .from(organisations)
          .where(inArray(organisations.id, scope.organisationIds))
      : [];
    const workspaceNames = new Map(workspaces.map((row) => [row.id, row.name]));

    const counts: Record<string, number> = {};
    let open = 0;
    const applications = rows.map((row) => {
      const status = applicationStatus(row.status);
      counts[status.key] = (counts[status.key] ?? 0) + 1;
      if (!status.closed) open += 1;
      return {
        id: row.id,
        company: row.company,
        contactName: row.contactName,
        email: row.email,
        phone: row.phone,
        trades: parseList(row.trades),
        regions: row.regions,
        insured: row.insured,
        yearsTrading: row.yearsTrading ?? null,
        certifications: row.certifications ?? null,
        notes: row.notes ?? null,
        status: status.key,
        closed: status.closed,
        notifiedAt: row.notifiedAt ?? null,
        createdAt: row.createdAt,
        organisationId: row.organisationId,
        workspaceName: workspaceNames.get(row.organisationId) ?? null,
        documents: parseDocuments(row.documents),
        contractorId: row.contractorId ?? null,
      };
    });
    /* Where an approved contractor can be added (2026-10-04): every client
       workspace staff reach, never the intake or demo workspaces. */
    const registerWorkspaces = workspaces
      .filter((row) => !NOT_A_REGISTER.has(row.id))
      .sort((left, right) => left.name.localeCompare(right.name, "en-GB"));

    return Response.json({
      canEdit: true,
      applications,
      statuses: APPLICATION_STATUSES,
      counts,
      open,
      omissions: APPLICATION_OMISSIONS,
      registerWorkspaces,
    });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * Move one application to another status. Narrowed to the closed vocabulary in
 * `application-status.ts`; confined to the workspaces this platform admin may
 * read, so an id alone is not enough to reach a row; the optional reason goes in
 * the audit trail, because the row has no notes column.
 */
/**
 * POST { action: "add_to_register", id, organisationId, sendAppLink } —
 * APPROVE AND ADD (2026-10-04). An approved applicant becomes a row of that
 * workspace's Contractors register, built from what they told us; the
 * application is marked Approved and remembers the record. With `sendAppLink`
 * the contractor is emailed a personal MAINTSUPP app link (contractor-auth's
 * invite) so they can see the jobs that workspace assigns them.
 */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    if (scope.platformAdmin !== true || !scope.authenticated) {
      return Response.json(
        { error: "Contractor applications are managed by MAINTSUPP platform staff." },
        { status: 403 },
      );
    }
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      id?: unknown;
      organisationId?: unknown;
      sendAppLink?: unknown;
    } | null;
    if (body?.action !== "add_to_register") {
      return Response.json({ error: "Unknown action." }, { status: 400 });
    }
    const id = clean(body.id, 120);
    const organisationId = clean(body.organisationId, 120);
    if (!id || !organisationId || NOT_A_REGISTER.has(organisationId) || !scope.organisationIds.includes(organisationId)) {
      return Response.json({ error: "Choose the client workspace to add this contractor to." }, { status: 400 });
    }
    const [application] = await scope.db
      .select()
      .from(contractorApplications)
      .where(and(eq(contractorApplications.id, id), inArray(contractorApplications.organisationId, scope.organisationIds)))
      .limit(1);
    if (!application) {
      return Response.json({ error: "There is no application with that reference." }, { status: 404 });
    }
    const [workspace] = await scope.db
      .select({ id: organisations.id, name: organisations.name })
      .from(organisations)
      .where(and(eq(organisations.id, organisationId), eq(organisations.status, "active")))
      .limit(1);
    if (!workspace) return Response.json({ error: "That workspace is unavailable." }, { status: 404 });

    const slug = application.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "contractor";
    const contractorId = `contractor-${slug}-${crypto.randomUUID().slice(0, 8)}`;
    const certifications = (application.certifications ?? "")
      .split(/[,;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    await scope.db.insert(contractors).values({
      id: contractorId,
      organisationId,
      name: application.company,
      contactName: application.contactName,
      email: application.email,
      phone: application.phone,
      serviceCategories: application.trades || "[]",
      coverageAreas: JSON.stringify(
        application.regions.split(/[,;\n]/).map((entry) => entry.trim()).filter(Boolean),
      ),
      certifications: JSON.stringify(certifications),
      insuranceNotes: `Public liability insurance (applicant's answer): ${application.insured}`,
      notes: [
        `Joined from the website application of ${application.createdAt.slice(0, 10)}.`,
        application.yearsTrading ? `Years trading: ${application.yearsTrading}.` : "",
        application.notes ? `Applicant's note: ${application.notes}` : "",
      ].filter(Boolean).join(" "),
      active: true,
    });
    await scope.db
      .update(contractorApplications)
      .set({ status: "Approved", contractorId })
      .where(eq(contractorApplications.id, id));

    let appLink: string | null = null;
    if (body.sendAppLink === true) {
      const token = await createContractorInvite(scope.db, {
        contractorId,
        organisationId,
        createdBy: scope.identityEmail || null,
      });
      appLink = new URL(`/c/${token}`, publicOrigin(request)).toString();
      await sendNotification(scope.db, {
        organisationId,
        channel: "email",
        event: "contractor.app_invite",
        subjectType: "contractor-application",
        subjectId: id,
        to: application.email,
        subject: "Welcome to MAINTSUPP — your app link",
        body: emailShell(
          "You're on the MAINTSUPP contractor network",
          `<p style="font-size:14px;line-height:1.55">Hi ${escapeHtml(application.contactName)},</p>
           <p style="font-size:14px;line-height:1.55">Your application for <strong>${escapeHtml(application.company)}</strong> has been approved. Open this link on your phone to get the MAINTSUPP app — your jobs and new-job alerts will be there. It works for 14 days.</p>
           <p><a href="${appLink}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#12b4a8;color:#04211f;font-weight:700;text-decoration:none">Open the MAINTSUPP app</a></p>`,
        ),
        text: `Hi ${application.contactName},\n\nYour application for ${application.company} has been approved. Open this link on your phone to get the MAINTSUPP app (works for 14 days):\n${appLink}`,
      }).catch(() => null);
    }

    await recordAudit({
      db: scope.db,
      organisationId,
      actor: auditActor(scope),
      action: "contractor_application.added_to_register",
      entityType: "contractor",
      entityId: contractorId,
      summary: `Added ${application.company} to the Contractors register of ${workspace.name} from their application${appLink ? ", and emailed their app link" : ""}.`,
      detail: { applicationId: id, email: application.email },
      request,
    });
    return Response.json({ ok: true, contractorId, workspace: workspace.name, appLinkSent: Boolean(appLink) });
  } catch (error) {
    return unavailable(error);
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    if (scope.platformAdmin !== true || !scope.authenticated) {
      return Response.json(
        { error: "Contractor applications are managed by MAINTSUPP platform staff." },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => null)) as {
      id?: unknown;
      status?: unknown;
      reason?: unknown;
    } | null;
    const id = clean(body?.id, 120);
    if (!id) {
      return Response.json({ error: "Name the application to update." }, { status: 400 });
    }
    if (!isApplicationStatus(body?.status)) {
      return Response.json(
        { error: `A status must be one of ${APPLICATION_STATUSES.map((s) => s.key).join(", ")}.` },
        { status: 400 },
      );
    }
    const next = body.status;
    const reason = clean(body?.reason, 400);

    const [existing] = await scope.db
      .select()
      .from(contractorApplications)
      .where(
        and(
          eq(contractorApplications.id, id),
          inArray(contractorApplications.organisationId, scope.organisationIds),
        ),
      )
      .limit(1);
    if (!existing) {
      return Response.json({ error: "There is no application with that reference." }, { status: 404 });
    }

    const before = existing.status || DEFAULT_APPLICATION_STATUS;
    if (before !== next) {
      await scope.db
        .update(contractorApplications)
        .set({ status: next })
        .where(eq(contractorApplications.id, id));
    }

    await recordAudit({
      db: scope.db,
      // Against the workspace the row is filed under, where a later reader would look.
      organisationId: existing.organisationId,
      actor: auditActor(scope),
      action: before === next ? "contractor_application.status_reaffirmed" : "contractor_application.status_changed",
      entityType: "contractor_application",
      entityId: id,
      summary:
        before === next
          ? `Left the application from ${existing.company} at ${next}.`
          : `Moved the application from ${existing.company} from ${before} to ${next}.`,
      detail: { from: before, to: next, reason: reason || null, email: existing.email },
      request,
    });

    return Response.json({ ok: true, id, status: next });
  } catch (error) {
    return unavailable(error);
  }
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function unavailable(error?: unknown) {
  // A session that has ended is not an outage — the same helper every other route uses.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json({ error: "The applications are temporarily unavailable." }, { status: 503 });
}

/** A JSON array stored as text, or an empty list. Never a throw. */
function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/* Never a Contractors register: MAINTSUPP's own intake and demo workspaces. */
const NOT_A_REGISTER = new Set([WEBSITE_LEADS_WORKSPACE_ID, DEMO_WORKSPACE_ID, DEMO_ORGANISATION_ID]);

function parseDocuments(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.map((entry: { id: string; name: string; size: number }) => ({ id: entry.id, name: entry.name, size: entry.size }))
      : [];
  } catch {
    return [];
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
