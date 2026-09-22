import { and, desc, eq, inArray } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { contractorApplications, organisations } from "../../../../db/schema";
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
      };
    });

    return Response.json({
      canEdit: true,
      applications,
      statuses: APPLICATION_STATUSES,
      counts,
      open,
      omissions: APPLICATION_OMISSIONS,
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
