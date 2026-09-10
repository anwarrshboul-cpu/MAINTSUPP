import { eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { maintenanceRequests } from "../../../db/schema";
import { exposeRequest } from "../../lib/request-payload";
import {
  jobAlertTemplate,
  notificationTargets,
  sendNotification,
} from "../../lib/notifications";
import { DEFAULT_BOARD_KEY } from "../../lib/board-registry";
import { automationContext, dispatchAutomationEvents, itemCreatedEvent } from "../../lib/automations";
import { createSubmission, resolveSubmissionSite } from "../../lib/submission-service";
import { PRIMARY_ORGANISATION_ID, scopedDb } from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

/**
 * The website's own "Report a job" form.
 *
 * WHY THIS IS NOT `/api/maintenance`
 *
 * That route requires `board.edit`, and it is right to: it is the authenticated
 * "raise a job" endpoint used from inside the product, and loosening it would
 * make every board in every tenant writable by anyone who could guess a
 * payload. The marketing form posted to it anyway, so a logged-out visitor —
 * which is every visitor — got `401 Your session has ended`. The form could
 * never submit.
 *
 * WHY NOT `/api/forms/[token]/submit` EITHER
 *
 * That is the other public path, and it is the right one for a SHARED LINK: the
 * tenant comes from the form, and the questions are data an operator edits in
 * the builder. This form is neither — its fields are fixed in the page, and
 * routing it through a builder form would mean the home page silently breaking
 * the day somebody hid a question.
 *
 * So this is a third, deliberately narrow surface, and the narrowness is the
 * security argument:
 *
 *   · the tenant is PINNED. It is never read from the payload and never from a
 *     cookie, so no request can steer a job into another workspace;
 *   · every field is length-capped and validated here, not only in the browser;
 *   · `priority` and `engineer` are canonicalised through the organisation's
 *     own option registry, so an arbitrary string cannot invent a board value
 *     or buy itself a shorter SLA;
 *   · `source` is "Website form", which is what tells a coordinator this came
 *     from outside and nobody has vetted it.
 *
 * ── WHAT MOVED, AND WHAT STAYED ───────────────────────────────────────────
 *
 * The paragraph that used to end this comment said "three routes now create a
 * job, and whoever changes the shape of one should look at the other two". It
 * was wrong twice over: there were FIVE, and asking each author to remember the
 * others is precisely the arrangement that let three copies of `requestTitle`
 * drift apart and left this route without a placement, without a retry on a
 * lost id race, and without the option resolver that matches a renamed label.
 *
 * The whole middle of a submission now lives in `app/lib/submission-service.ts`
 * and every door calls it. What did NOT move is everything above: this route
 * still owns its own tenancy pin, its own field caps and its own refusal, and
 * `resolveSubmissionSite` is still called with the default `CANONICAL_REGISTER`
 * scope because an anonymous reporter cannot name a register.
 */

function trimString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Matches the digest `/api/files` computes when it verifies an upload token. */
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const payload = (await request.json()) as Record<string, unknown>;

    const location = trimString(payload.location, 120);
    const requester = trimString(payload.requester, 120);
    const contact = trimString(payload.contact, 80);
    const description = trimString(payload.description, 2000);
    const category = trimString(payload.category, 80) || "Other";
    /*
     * THE JOB'S NAME, SENT BY THE FORM — and this is a defect being closed, not
     * a new capability.
     *
     * The page assembles a FIVE-LINE description: the P-code, then the fault,
     * then the site address, then the access window, then who reported it. The
     * title was derived from the first line of that blob, so every job this
     * form has ever raised was called "[P1] Critical, site unsafe or cannot
     * trade" — the urgency band, identical across every P1 report in the
     * workspace, and never a word about the fault. A board of them is
     * unreadable and none of them can be found by searching for what broke.
     *
     * The blob itself is deliberately unchanged: the P-code stays at the top
     * because it is what triage reads first, and the postcode and access window
     * have no column of their own. Only the NAME is now sent separately.
     *
     * It is still only a suggestion. `createSubmission` caps it, and a request
     * that omits it falls back to the description exactly as before, so a stale
     * cached copy of the page keeps working.
     */
    const title = trimString(payload.title, 200);

    if (!location || !requester || !contact || description.length < 10) {
      return Response.json(
        { error: "Site, your name, a contact number and a description are all required." },
        { status: 400 },
      );
    }

    // The website form has no account behind it by definition — the same
    // exemption the public lead form takes, and for the same reason.
    const scope = await scopedDb(request, { allowAnonymous: true });
    const { db } = scope;
    // PINNED. An anonymous caller resolves to the primary tenant anyway; this
    // makes it true regardless of what any cookie on the request claims.
    const orgId = PRIMARY_ORGANISATION_ID || scope.orgId;

    /*
     * The site a public report belongs to.
     *
     * The form asks for a site by NAME in a free-text box, because the
     * alternative — a picker — would publish the list of every site under
     * contract to anyone who loaded the home page.
     *
     * A typed name will therefore sometimes match nothing. Refusing the report
     * is the wrong answer: a shop with water coming through the ceiling, typing
     * "Oxford St" where the row says "Sunnamusk Oxford Street", would be turned
     * away. So an unmatched name is filed with NO site, and the words they
     * actually typed are kept in `location`.
     *
     * The ladder — exact, then case-insensitive, then this organisation's own
     * aliases — is `resolveSubmissionSite`, and it is now the same ladder the
     * authenticated doors climb. It used to live only here, on the one caller
     * that cannot show a picker or let anyone correct a mistake, while an
     * operator typing a store's previous name into "raise a job" was refused.
     *
     * The scope is left at its default, `CANONICAL_REGISTER`, and on this route
     * that is a security boundary rather than a tidiness rule. THIS ENDPOINT IS
     * PUBLIC: a stranger names a location as free text, and unscoped, that
     * string matched every site in the organisation — so naming a site inside a
     * custom Sites SECTION attached the submission to it. An anonymous reporter
     * cannot name a register, so the only one they can mean is the workspace's
     * own. See `app/lib/register-scope.ts`.
     */
    const site = await resolveSubmissionSite(db, { organisationId: orgId, location });

    /*
     * The single-use grant that lets the reporter attach the photographs they
     * were just told were mandatory. Only the HASH is stored, and it expires in
     * thirty minutes — long enough for a few phone videos over a shop's wifi,
     * dead long before it is worth anything out of a browser history.
     * `/api/files` already knows how to accept it.
     */
    const uploadToken = crypto.randomUUID().replace(/-/g, "");

    const submission = await createSubmission(db, {
      organisationId: orgId,
      /*
       * The canonical job board, named rather than assumed. This route wrote no
       * placement at all and left `ensureBoardState` to file the row onto
       * whichever board somebody opened next — which returns early for
       * `store-documentation` and for every generated register before it reaches
       * the filing loop, so on some workspaces "next" meant never.
       */
      boardId: DEFAULT_BOARD_KEY,
      // Nobody signed in, so nobody is credited. Attributing this to an account
      // that was not there would be worse than leaving it null.
      actor: null,
      source: "Website form",
      explicitTitle: title,
      description,
      location,
      requester,
      contact,
      category,
      priority: payload.priority,
      engineer: payload.engineer,
      // No site rather than an invented one. The submitted text is kept above.
      siteId: site?.id ?? null,
      publicUploadTokenHash: await sha256(uploadToken),
      publicUploadTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });
    const created = submission.request;

    // Delivery failure never fails the request: the job is saved, and losing it
    // because a mail provider was down would be worse than a missed alert.
    const { opsInbox } = notificationTargets();
    const alert = jobAlertTemplate({
      /*
       * `displayReference`, not `created.reference`. Four of the five doors
       * leave `reference` NULL — every screen in the product renders
       * `reference ?? id` for exactly that reason — so reading the column raw
       * put "New job — Aldgate" in the subject of every alert this route and
       * `/api/maintenance` have ever sent, with no job named in it.
       */
      reference: submission.displayReference,
      title: created.title,
      site: location,
      priority: submission.priority,
      requester: created.requester,
      contact: created.contact,
      description: created.description,
    });
    const alertResult = await sendNotification(db, {
      organisationId: orgId,
      channel: "email",
      event: submission.priority.toLowerCase() === "urgent" ? "job.urgent" : "job.created",
      subjectType: "job",
      subjectId: created.id,
      to: opsInbox,
      subject: alert.subject,
      body: alert.body,
    });

    await db
      .update(maintenanceRequests)
      .set({
        notifiedAt: alertResult.ok ? sql`CURRENT_TIMESTAMP` : null,
        notifyAttempts: 1,
      })
      .where(eq(maintenanceRequests.id, created.id));

    /*
     * THE BOARD'S OWN RULES, which this route never ran.
     *
     * `item_created` was dispatched by `/api/maintenance`, `/api/board/items`
     * and `createBoardItem`, and by neither public door. So a workspace whose
     * owner had built "when an item is created, notify the duty coordinator"
     * got it for every job raised from inside the product and for none of the
     * ones raised by a member of the public standing in front of the fault —
     * exactly inverted.
     *
     * The actor is anonymous and stays anonymous: the engine records the run
     * against nobody, which is the truth. A rule that fails cannot undo the job
     * — see `dispatchAutomationEvent`.
     */
    await dispatchAutomationEvents(
      /*
       * The scope's OWN actor, which for an anonymous caller is the anonymous
       * one. Substituting a made-up display name here would put a person who
       * does not exist in the run history; the engine already knows how to
       * record a run against nobody.
       *
       * `orgId` is the PINNED organisation, not `scope.orgId`, so the rules that
       * run are the primary tenant's own even if a stray cookie resolved
       * somewhere else.
       */
      automationContext({ ...scope, orgId }, request),
      [itemCreatedEvent(DEFAULT_BOARD_KEY, created.id, null, submission.group?.id ?? null)],
    );

    return Response.json(
      { request: exposeRequest(created), notified: alertResult.ok, uploadToken },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("report-job submission failed", message);
    return Response.json(
      { error: "Your report could not be submitted. Please try again in a moment." },
      { status: 503 },
    );
  }
}
