import { and, eq, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { attachments, maintenanceRequests } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import {
  DEFAULT_EXPIRY_DAYS,
  createJobToken,
  listJobTokens,
  revokeJobToken,
} from "../../../lib/job-tokens";

export const dynamic = "force-dynamic";

function text(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function unavailable(error?: unknown) {
  // A session that has ended is not an outage: 503 tells a browser to retry
  // something no amount of retrying will fix, and blames the workspace for
  // what a person fixes by signing in. See `anonymousRefusal`.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json(
    { error: "Contractor links are temporarily unavailable." },
    { status: 503 },
  );
}

/** GET /api/board/links?requestId=… — every link issued for a job. */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const url = new URL(request.url);
    const requestId = text(url.searchParams.get("requestId"), 64);
    if (!requestId) return bad("A job id is required.");

    const tokens = await listJobTokens(db, orgId, requestId);

    // Z12 — evidence waiting for a coordinator to accept or reject.
    const pending = await db
      .select({
        id: attachments.id,
        name: attachments.originalName,
        kind: attachments.kind,
        submittedVia: attachments.submittedVia,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.organisationId, orgId),
          eq(attachments.requestId, requestId),
          eq(attachments.pending, true),
        ),
      );

    const [job] = await db
      .select({
        completionRequestedAt: maintenanceRequests.completionRequestedAt,
        completionRequestedBy: maintenanceRequests.completionRequestedBy,
        completionNote: maintenanceRequests.completionNote,
        // K — served to the coordinator who accepts the completion, which is
        // the one place the signature is any use.
        completionSignature: maintenanceRequests.completionSignature,
        completionSignedAt: maintenanceRequests.completionSignedAt,
        completionSignedBy: maintenanceRequests.completionSignedBy,
        blockedReason: maintenanceRequests.blockedReason,
      })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, requestId),
          eq(maintenanceRequests.organisationId, orgId),
          // Stage 23 — no contractor link for a job sitting in the recycle bin.
          isNull(maintenanceRequests.deletedAt),
        ),
      );

    return Response.json({
      links: tokens,
      pendingEvidence: pending,
      completion: job ?? null,
      defaultExpiryDays: DEFAULT_EXPIRY_DAYS,
    });
  } catch (error) {
    return unavailable(error);
  }
}

/** POST /api/board/links — issue a link. The plaintext is returned once. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor, authenticated } = guard.scope;
    /*
     * Issuing a link is issuing a credential.
     *
     * The token itself is sound — 32 CSPRNG bytes, stored as a SHA-256 digest,
     * expiry clamped to 1..90 days, revocation honoured — but minting one was
     * guarded by `scopedDb` alone, which resolves a tenant and never refuses.
     * Anyone who could reach this route could hand themselves a URL that opens
     * a job with no login at all.
     */
    if (!authenticated) {
      return bad("Sign in to issue a contractor link.", 401);
    }
    const body = await request.json().catch(() => ({}));
    const requestId = text(body.requestId, 64);
    if (!requestId) return bad("A job id is required.");

    const [job] = await db
      .select({ id: maintenanceRequests.id })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, requestId),
          eq(maintenanceRequests.organisationId, orgId),
          // Stage 23 — no contractor link for a job sitting in the recycle bin.
          isNull(maintenanceRequests.deletedAt),
        ),
      );
    if (!job) return bad("Job not found.", 404);

    /*
     * "viewer" is the Fix Tracker's read-only Copy Link; anything else is a
     * contractor working link. Allowlisted, so a typo cannot invent a third
     * audience with undefined behaviour. `createJobToken` itself strips every
     * write right off a viewer grant, whatever else the body says.
     */
    const audience = body.audience === "viewer" ? "viewer" : "contractor";
    const { token, scope } = await createJobToken(db, {
      organisationId: orgId,
      requestId,
      audience,
      label: text(body.label, 80),
      allowedKinds: body.allowedKinds,
      canComment: body.canComment !== false,
      canRequestCompletion: body.canRequestCompletion !== false,
      expiryDays: Number(body.expiryDays) || DEFAULT_EXPIRY_DAYS,
      createdBy: actor.displayName || undefined,
    });

    const origin = new URL(request.url).origin;
    const url = `${origin}/j/${token}`;

    return Response.json(
      {
        id: scope.id,
        url,
        expiresAt: scope.expiresAt,
        allowedKinds: scope.allowedKinds,
        // The plaintext token appears here and nowhere else, ever.
        warning:
          "This link grants access to the job without a login. It is shown once.",
      },
      { status: 201 },
    );
  } catch (error) {
    return unavailable(error);
  }
}

/** PATCH /api/board/links — accept or reject pending evidence. Z12. */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId, actor } = guard.scope;
    const body = await request.json().catch(() => ({}));
    const attachmentId = text(body.attachmentId, 64);
    if (!attachmentId) return bad("An attachment id is required.");

    if (body.decision === "reject") {
      await db
        .delete(attachments)
        .where(
          and(
            eq(attachments.id, attachmentId),
            eq(attachments.organisationId, orgId),
            eq(attachments.pending, true),
          ),
        );
      return Response.json({ ok: true, decision: "rejected" });
    }

    await db
      .update(attachments)
      .set({
        pending: false,
        reviewedAt: sql`CURRENT_TIMESTAMP`,
        reviewedBy: actor.displayName || "Workspace",
      })
      .where(
        and(eq(attachments.id, attachmentId), eq(attachments.organisationId, orgId)),
      );

    return Response.json({ ok: true, decision: "accepted" });
  } catch (error) {
    return unavailable(error);
  }
}

/** DELETE /api/board/links?id=… — revoke immediately. */
export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const url = new URL(request.url);
    const id = text(url.searchParams.get("id"), 64);
    if (!id) return bad("A link id is required.");

    await revokeJobToken(db, orgId, id);
    return Response.json({ ok: true, revoked: true });
  } catch (error) {
    return unavailable(error);
  }
}
