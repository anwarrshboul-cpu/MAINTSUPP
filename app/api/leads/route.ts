import { getD1 } from "../../../db";
import { ensureDatabase } from "../../../db/init";
import { leads, organisations } from "../../../db/schema";
import { WEBSITE_LEADS_WORKSPACE_ID } from "../../../db/website-leads-workspace";
import { anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import { auditActor, recordAudit } from "../../lib/audit";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  leadAlertTemplate,
  leadConfirmationTemplate,
  notificationTargets,
  sendNotification,
} from "../../lib/notifications";
import {
  DEFAULT_LEAD_STATUS,
  isLeadStatus,
  LEAD_OMISSIONS,
  LEAD_STATUSES,
  leadStatus,
} from "../../lib/lead-status";
import {
  publicRetryAfter,
  recordPublicAttempt,
  requestIp,
  tooManyAttempts,
} from "../../lib/auth-session";
import { LEAD_SUBMISSIONS } from "../../lib/form-throttle";

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * The inbox — Master Specification §12.
 *
 * THIS REPLACED A HARD 501. The endpoint used to answer *"Lead export is disabled
 * while public testing is active."* to every caller, so intake, storage and
 * notification were all finished and **nothing could read an enquiry back**. A lead
 * arrived, an email went out, and the row was then unreachable by any surface in the
 * product.
 *
 * ⚠️ WHY THIS IS GATED ON PLATFORM STAFF AND EMPHATICALLY NOT ON A CAPABILITY.
 *
 * Because these rows belong to the platform, not to the workspace whose id they
 * carry — and that was measured rather than assumed. A public enquiry has no account,
 * so `POST` resolves its scope with `allowAnonymous: true`, and an anonymous request
 * resolves to the PRIMARY active organisation. That constant,
 * `org_000000000000000000000001`, names **a client company's workspace** on this
 * installation, and all 8 leads stored before this correction sit in it.
 *
 * A `leads.view` capability granted to workspace roles would therefore have shown
 * that customer's Owner every enquiry MAINTSUPP has ever received from its own
 * website, including the names and email addresses of their competitors. `scopedDb`'s
 * organisation filter would have delivered it correctly and the leak would have
 * looked like the feature working.
 *
 * `scope.platformAdmin` is the gate, exactly as the website CMS decided, for the same
 * underlying reason: the row says it belongs to an organisation and the truth is that
 * it belongs to the platform.
 *
 * WHAT IS FIXED, AND WHAT IS NOT, STATED PRECISELY.
 *
 * **A NEW enquiry is no longer mis-filed.** `POST` below writes to a dedicated
 * platform-owned intake workspace, resolved by a fixed id — see
 * `db/website-leads-workspace.ts`.
 *
 * **The rows stored BEFORE that correction are still under the customer's
 * workspace** until they are re-homed, which is a data change to a customer's tenant
 * and is a separate, individually-verified operation rather than something a read
 * path does. The inbox reads across every workspace a platform admin may see, so
 * both the old and the new rows appear either way, and the screen names the workspace
 * each one is filed under.
 *
 * WHY IT READS ACROSS WORKSPACES. `scope.organisationIds` is already widened for a
 * platform admin — `crossOrganisation: platformAdmin` — so `inArray` over it is
 * the same instrument `GET /api/audit` uses. Reading only the current workspace
 * would strand every lead the day the primary organisation changes.
 */
/**
 * The gate, as its own function because a second reader now needs exactly it.
 *
 * `GET` and the CSV export (`app/api/leads/csv/route.ts`) must answer the same
 * question about the same caller. Restating the check in the export would be one
 * edit away from the leak the header above describes at length, so the check is
 * written once and imported.
 */
export function platformLeadsRefusal(
  scope: Awaited<ReturnType<typeof scopedDb>>,
  /* The sentence differs by verb — reading an enquiry and moving its status are
     different things to be told you may not do — so the caller supplies it. The
     RULE is not the caller's to vary, which is the whole point of the function. */
  message = "The website's enquiries are read by MAINTSUPP platform staff.",
): Response | null {
  if (scope.platformAdmin === true && scope.authenticated) return null;
  return Response.json({ error: message }, { status: 403 });
}

export type LeadEnquiry = {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string | null;
  siteRange: string;
  services: string[];
  regions: string[];
  challenge: string;
  status: string;
  closed: boolean;
  notifiedAt: string | null;
  notifyAttempts: number;
  createdAt: string;
  organisationId: string;
  workspaceName: string | null;
};

/**
 * Every enquiry this reader may see, newest first, with its workspace named.
 *
 * Exported for the CSV export, which must be the same rows in the same order as
 * the screen — a spreadsheet that disagrees with the inbox it was downloaded
 * from is worse than no spreadsheet.
 */
export async function readLeadEnquiries(
  scope: Awaited<ReturnType<typeof scopedDb>>,
): Promise<{ enquiries: LeadEnquiry[]; counts: Record<string, number>; open: number }> {
  const rows = await scope.db
    .select()
    .from(leads)
    .where(inArray(leads.organisationId, scope.organisationIds))
    .orderBy(desc(leads.createdAt));

  /* Which workspace each lead landed in, named rather than shown as an opaque id
     — because "these are all filed under a client" is the fact a reader of this
     screen most needs to be able to see for themselves. */
  const workspaces = scope.organisationIds.length
    ? await scope.db
        .select({ id: organisations.id, name: organisations.name })
        .from(organisations)
        .where(inArray(organisations.id, scope.organisationIds))
    : [];
  const workspaceNames = new Map(workspaces.map((row) => [row.id, row.name]));

  const counts: Record<string, number> = {};
  let open = 0;
  const enquiries = rows.map((row) => {
    const status = leadStatus(row.status);
    counts[status.key] = (counts[status.key] ?? 0) + 1;
    if (!status.closed) open += 1;
    return {
      id: row.id,
      name: row.name,
      company: row.company,
      email: row.email,
      phone: row.phone ?? null,
      siteRange: row.siteRange,
      /* Stored as JSON text by `POST`. Parsed here rather than on the screen, so a
         row written before the form stopped asking — which stores "[]" — reads as
         an empty list instead of the two characters. */
      services: parseList(row.services),
      regions: parseList(row.regions),
      challenge: row.challenge,
      status: status.key,
      closed: status.closed,
      notifiedAt: row.notifiedAt ?? null,
      notifyAttempts: row.notifyAttempts,
      createdAt: row.createdAt,
      organisationId: row.organisationId,
      workspaceName: workspaceNames.get(row.organisationId) ?? null,
    };
  });
  return { enquiries, counts, open };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const refusal = platformLeadsRefusal(scope);
    if (refusal) return refusal;

    const { enquiries, counts, open } = await readLeadEnquiries(scope);

    return Response.json({
      canEdit: true,
      enquiries,
      statuses: LEAD_STATUSES,
      counts,
      open,
      /* Printed by the screen rather than restated there, so the two cannot drift. */
      omissions: LEAD_OMISSIONS,
    });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * Move one enquiry to another status.
 *
 * The status is narrowed against the closed vocabulary in `lead-status.ts`, so a
 * request cannot invent one — the column is `TEXT` and the database would accept
 * anything, which would make both the filter and the totals on the screen untrue.
 *
 * THE REASON GOES IN THE AUDIT TRAIL, because there is nowhere else for it. A lead
 * has no notes column and this phase adds no migration, so an optional sentence
 * explaining a change is recorded as audit `detail` and read back from there. That
 * is not a workaround: a note about why something changed belongs with the record of
 * the change rather than overwriting a field on the row.
 */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const refusal = platformLeadsRefusal(
      scope,
      "The website's enquiries are managed by MAINTSUPP platform staff.",
    );
    if (refusal) return refusal;

    const body = (await request.json().catch(() => null)) as {
      id?: unknown;
      status?: unknown;
      reason?: unknown;
    } | null;
    const id = clean(body?.id, 120);
    if (!id) {
      return Response.json({ error: "Name the enquiry to update." }, { status: 400 });
    }
    if (!isLeadStatus(body?.status)) {
      return Response.json(
        {
          error: `A status must be one of ${LEAD_STATUSES.map((s) => s.key).join(", ")}.`,
        },
        { status: 400 },
      );
    }
    const next = body.status;
    const reason = clean(body?.reason, 400);

    /* Scoped to the workspaces this platform admin may read, so an id alone is not
       enough to reach a row — the same confinement the read uses. */
    const [existing] = await scope.db
      .select()
      .from(leads)
      .where(and(eq(leads.id, id), inArray(leads.organisationId, scope.organisationIds)))
      .limit(1);
    if (!existing) {
      return Response.json({ error: "There is no enquiry with that reference." }, { status: 404 });
    }

    const before = existing.status || DEFAULT_LEAD_STATUS;
    if (before !== next) {
      await scope.db.update(leads).set({ status: next }).where(eq(leads.id, id));
    }

    await recordAudit({
      db: scope.db,
      /* Against the workspace the lead is filed under, not the actor's, because that
         is where the row lives and where a later reader would look for it. */
      organisationId: existing.organisationId,
      actor: auditActor(scope),
      action: before === next ? "lead.status_reaffirmed" : "lead.status_changed",
      entityType: "lead",
      entityId: id,
      summary:
        before === next
          ? `Left the enquiry from ${existing.company} at ${next}.`
          : `Moved the enquiry from ${existing.company} from ${before} to ${next}.`,
      detail: { from: before, to: next, reason: reason || null, email: existing.email },
      request,
    });

    return Response.json({ ok: true, id, status: next });
  } catch (error) {
    return unavailable(error);
  }
}

/** A JSON array stored as text, or an empty list. Never a throw. */
export function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function unavailable(error?: unknown) {
  // A session that has ended is not an outage — the same helper every other route uses.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json(
    { error: "The enquiries are temporarily unavailable." },
    { status: 503 },
  );
}

export async function POST(request: Request) {
  try {
    /*
     * THROTTLED FIRST, per address, before the body is read — so a honeypot hit
     * counts too. The honeypot below stops a bot driving the page; it says
     * nothing about a script posting here, and every accepted lead writes a row
     * and queues two emails. See `LEAD_SUBMISSIONS`.
     */
    await ensureDatabase();
    const d1 = await getD1();
    const address = requestIp(request);
    const wait = await publicRetryAfter(d1, LEAD_SUBMISSIONS, address);
    if (wait > 0) return tooManyAttempts(wait);
    await recordPublicAttempt(d1, LEAD_SUBMISSIONS, address);

    const payload = (await request.json()) as Record<string, unknown>;
    const name = clean(payload.name, 120);
    const company = clean(payload.company, 160);
    const email = clean(payload.email, 180).toLowerCase();
    const phone = clean(payload.phone, 80);
    const siteRange = clean(payload.siteRange, 40);
    const services = Array.isArray(payload.services)
      ? payload.services.map((value) => clean(value, 80)).filter(Boolean)
      : [];
    const regions = Array.isArray(payload.regions)
      ? payload.regions.map((value) => clean(value, 80)).filter(Boolean)
      : [];
    const challenge = clean(payload.challenge, 900);

    /*
     * `services` is no longer required, because the form no longer asks.
     *
     * It was a "which service lines interest you" multi-select on step 1 of the
     * old three-step form — a question put to the reader before the page had
     * told them what any of the lines cost. The rebuilt CTA drops it, and a
     * required field with no control behind it is a 400 nobody can fix. It is
     * still READ and still stored: anything that does send it keeps working,
     * which matters because `leads.services` already holds rows.
     *
     * `regions` and `challenge` are no longer required either, for exactly
     * the same reason: the form stopped asking.
     *
     * The CTA dropped "Regions", "Approx. maintenance issues per month" and
     * "Biggest problem right now". `regions` was the first of those; the
     * other two were glued into `challenge` by the form, because `challenge`
     * was once a free-text box and this check went on demanding 20 characters
     * of it long after the box was gone. With no control behind either,
     * keeping them required would have made every submission from the only
     * page that posts here a 400 nobody can fix — and the alternative,
     * sending a placeholder long enough to clear the floor, would have
     * written a sentence the visitor never said into a sales inbox.
     *
     * Both are still READ, still stored and still notified: anything that
     * does send them keeps working, and `leads.regions` / `leads.challenge`
     * are NOT NULL columns with existing rows behind them. Absent, they
     * store as "[]" and "" — an unanswered question recorded as unanswered,
     * which is honest in a way an invented answer is not. `leadAlertTemplate`
     * already drops a row whose value is empty, so a lead with no challenge
     * shows no "What they said" line rather than an empty one.
     *
     * Everything else stays required. Those five are all on the form.
     */
    if (!name || !company || !/^\S+@\S+\.\S+$/.test(email) || !siteRange) {
      return Response.json({ error: "Complete the required portfolio and contact details." }, { status: 400 });
    }

    /*
     * THE HONEYPOT, READ HERE RATHER THAN ONLY IN THE BROWSER.
     *
     * `final-cta.tsx` renders an off-screen `website` field and returns early
     * when it is filled. That stops a bot driving the form and nothing at all
     * about one posting to this route directly, which never looked at the
     * field — so the check that existed was a hint rather than a gate.
     *
     * Harmless while no key is configured and nothing can be delivered. The
     * moment one is, every submission becomes an email into a real inbox with
     * text the sender chose, so the gate belongs on this side.
     *
     * The answer is a 201 shaped like a real one, with an id that is not a
     * row. A 400 saying "you filled the hidden field" teaches the next attempt
     * to leave it empty; a silent accept costs the sender the same effort and
     * tells them nothing. Nothing is written and nothing is sent.
     */
    if (clean(payload.website, 200)) {
      return Response.json(
        { lead: { id: crypto.randomUUID() }, notified: false, confirmationSent: false },
        { status: 201 },
      );
    }

    // The database was ensured at the top of this handler, for the throttle.
    // The public lead form has no account behind it by definition.
    const { db } = await scopedDb(request, { allowAnonymous: true });

    /*
     * ⚠️ THE WORKSPACE THIS IS FILED UNDER, AND WHY IT IS NOT `orgId`.
     *
     * `scopedDb` still resolves the scope — that is what the two tenancy surveys
     * require, and it is how the database handle is obtained. But its `orgId` for an
     * anonymous request is `PRIMARY_ORGANISATION_ID`, a hard-coded constant that on
     * this installation names **Sunnamusk UK, a real client company**. Writing
     * MAINTSUPP's own sales enquiries there filed the platform's pipeline inside a
     * customer's tenant; measured, all 8 stored leads sat in it.
     *
     * So the destination is resolved from the DATABASE, by the fixed id of a
     * platform-owned internal workspace — never from the request, and never from
     * organisation ordering. `ensureWebsiteLeadsWorkspace` creates it on the boot
     * path, which the `ensureDatabase()` above has just run.
     *
     * THERE IS NO FALLBACK TO A CUSTOMER WORKSPACE, and that is the deliberate
     * trade-off. If the intake workspace cannot be found this refuses with a 503 and
     * the submitter is asked to try again, rather than silently filing a stranger's
     * contact details into a client's workspace. Losing one submission to a state the
     * boot path makes almost impossible is a smaller harm than re-introducing the
     * fault this route was corrected for.
     */
    const [intake] = await db
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.id, WEBSITE_LEADS_WORKSPACE_ID))
      .limit(1);
    if (!intake) {
      console.error(
        "[leads] the website-leads intake workspace is missing; refusing rather than filing under a customer",
      );
      return Response.json(
        { error: "The portfolio review request could not be saved." },
        { status: 503 },
      );
    }

    const [created] = await db.insert(leads).values({
      id: crypto.randomUUID(),
      organisationId: intake.id,
      name,
      company,
      email,
      phone: phone || null,
      siteRange,
      services: JSON.stringify(services),
      regions: JSON.stringify(regions),
      challenge,
      status: "New",
    }).returning();

    // J2 / J3 — tell sales, and confirm to the prospect.
    //
    // Notification failure must never fail the request: the lead is already
    // saved, and losing it because a mail provider was down would be worse than
    // not sending the alert. Failures are recorded in notification_log and can
    // be replayed from /api/notifications/replay.
    const { salesInbox } = notificationTargets();
    const alert = leadAlertTemplate({
      name, company, email, phone, siteRange, challenge,
    });
    const [alertResult, confirmationResult] = await Promise.all([
      sendNotification(db, {
        organisationId: intake.id,
        channel: "email",
        event: "lead.created",
        subjectType: "lead",
        subjectId: created.id,
        to: salesInbox,
        /* Reply goes to the person who filled the form, not to the send-only
           address the alert came from. Their address is already in the body;
           this is what makes it actionable without copying it out by hand. */
        replyTo: email,
        subject: alert.subject,
        body: alert.body,
      }),
      (async () => {
        const confirmation = leadConfirmationTemplate({ name });
        return sendNotification(db, {
          organisationId: intake.id,
          channel: "email",
          event: "lead.confirmation",
          subjectType: "lead",
          subjectId: created.id,
          to: email,
          subject: confirmation.subject,
          body: confirmation.body,
        });
      })(),
    ]);

    await db
      .update(leads)
      .set({
        notifiedAt: alertResult.ok ? sql`CURRENT_TIMESTAMP` : null,
        notifyAttempts: 1,
      })
      .where(eq(leads.id, created.id));

    return Response.json(
      {
        lead: created,
        notified: alertResult.ok,
        confirmationSent: confirmationResult.ok,
      },
      { status: 201 },
    );
  } catch {
    return Response.json({ error: "The portfolio review request could not be saved." }, { status: 503 });
  }
}
