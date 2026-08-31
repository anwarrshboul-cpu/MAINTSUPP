import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import {
  maintenanceRequests as sampleRequests,
} from "../../lib/mock-data";
import type { RequestActivityEntry } from "../../lib/types";
import { exposeRequest } from "../../lib/request-payload";
import {
  attachmentCountsByRequest,
  pictureColumnsFor,
  withCountedAttachments,
} from "../../lib/attachment-counts";
import { ensureDatabase } from "../../../db/init";
import {
  jobAlertTemplate,
  notificationTargets,
  sendNotification,
} from "../../lib/notifications";
import {
  activityLog,
  attachments,
  itemActivity,
  maintenanceRequests,
  sites,
  workspaceSettings,
} from "../../../db/schema";
import { configuredValue } from "../../lib/options-repository";
import { priorityRule } from "../../lib/priority-rules";
import { unassignedSiteId } from "../../lib/site-reference";
import { PRIMARY_ORGANISATION_ID, anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../lib/tenant-db";
import { invalidRequestFields, requestFieldValues } from "../../lib/request-fields";
import { contractorLinkValues } from "../../lib/contractor-reference";
import {
  automationContext,
  dispatchAutomationEvents,
  itemCreatedEvent,
  requestFieldEvents,
} from "../../lib/automations";
import { sampleSeedingAllowed } from "../../lib/tenant-access";
function databaseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (process.env.NODE_ENV === "development") {
    return `Preview database error: ${message}`;
  }
  if (
    message.includes("no such table") ||
    message.includes("maintenance_requests")
  ) {
    return "The maintenance database is being prepared. Please retry in a moment.";
  }
  return "The maintenance workspace is temporarily unavailable.";
}

function trimString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function requestTitle(description: string) {
  const firstLine = description.split(/[.!?\n]/)[0]?.trim() || "Maintenance request";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

function exposeActivity(
  row: typeof activityLog.$inferSelect,
): RequestActivityEntry {
  let detail: Record<string, unknown> = {};
  if (row.detail) {
    try {
      const parsed = JSON.parse(row.detail) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        detail = parsed as Record<string, unknown>;
      }
    } catch {
      detail = {};
    }
  }

  return {
    id: row.id,
    action: row.action,
    actorEmail: row.actorEmail,
    detail,
    createdAt: row.createdAt,
  };
}

/**
 * One per-cell change, in the shape the drawer's Activity tab already reads.
 *
 * The action is namespaced `column.*` so the renderer can tell a cell edit
 * apart from a lifecycle event without inspecting the detail, and the column
 * key and both values travel in `detail` — which is what makes this row worth
 * showing at all. `actor_name` is a display name rather than an email here, so
 * it is passed as one and the reader is not asked to interpret it as an
 * address.
 */
function exposeItemActivity(
  row: typeof itemActivity.$inferSelect,
): RequestActivityEntry {
  return {
    id: row.id,
    action: row.columnKey ? "column.value_changed" : `item.${row.action}`,
    actorEmail: null,
    detail: {
      actorName: row.actorName,
      column: row.columnKey,
      from: row.valueBefore,
      to: row.valueAfter,
      board: row.boardId,
    },
    createdAt: row.createdAt,
  };
}

/** Sortable time for a stamp from either history table. Unreadable sorts last. */
function activityStamp(value: string) {
  const parsed = Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function optionalIsoDate(value: unknown) {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const parsed = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
      ? `${trimmed}T00:00:00.000Z`
      : trimmed,
  );
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function seedMaintenanceIfEmpty(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
) {
  await ensureDatabase();
  /*
   * The two free refusals come first, and that is the whole change.
   *
   * These three guards were in the opposite order, so every read of this route
   * paid a `count(*)` over `maintenance_requests` before discovering that it
   * was never allowed to seed anything. `sampleSeedingAllowed()` is
   * `NODE_ENV !== "production"`, so on the deployed portal the count was
   * ALWAYS wasted; on a workspace with 776 jobs it is wasted everywhere,
   * because a count that has to come back zero to matter cannot come back zero
   * once a single job exists.
   *
   * Measured against Supabase (`PG_D1_TRACE=1`), that count is one of six
   * statements a `GET /api/maintenance` issues and cost 19–61ms of the
   * request's 250–640ms — paid on every dashboard load and every board load,
   * for an outcome fixed before the query was sent.
   *
   * Nothing about WHEN seeding happens changes: the count still runs, and
   * still decides, in the one case where it can decide anything — a
   * development database whose primary organisation is empty.
   */
  if (orgId !== PRIMARY_ORGANISATION_ID) return;
  if (!sampleSeedingAllowed()) return;
  const [result] = await db
    .select({ value: count() })
    .from(maintenanceRequests)
    .where(eq(maintenanceRequests.organisationId, orgId));
  if (result.value > 0) return;

  // D1 keeps a conservative bound-variable limit. Seed one work order per
  // statement so first-run initialization stays inside that limit.
  for (const request of sampleRequests) {
    await db
      .insert(maintenanceRequests)
      .values({
        ...request,
        organisationId: orgId,
        createdByEmail: "seed@maintsupp.local",
      })
      .onConflictDoNothing();
  }
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    // `board.view` — the job list is the board. See the note in
    // `app/api/board/route.ts`.
    const guard = await scopedDbWithCapability(request, "board.view");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    await seedMaintenanceIfEmpty(db, orgId);
    const requestId = trimString(
      new URL(request.url).searchParams.get("id"),
      40,
    );

    if (requestId) {
      const [row] = await db
        .select()
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.id, requestId),
            eq(maintenanceRequests.organisationId, orgId),
            // Stage 23 — a job in the recycle bin is a 404 here, not a row.
            isNull(maintenanceRequests.deletedAt),
          ),
        )
        .limit(1);
      if (!row) {
        return Response.json({ error: "Request not found." }, { status: 404 });
      }

      /*
       * THE JOB'S HISTORY, FROM BOTH PLACES IT IS WRITTEN.
       *
       * `activity_log` records what happened to the request — created,
       * duplicated, archived, moved between groups — and is what this drawer
       * has always shown. `item_activity` records what happened to its CELLS,
       * with the column and the value on either side of the change, and is
       * written by POST/PATCH /api/board/items.
       *
       * WHY THEY ARE MERGED HERE RATHER THAN ONE OF THEM RETIRED. A completion
       * audit found `item_activity` written in one place and read in none, and
       * offered two ways out: surface it, or stop writing it. It is surfaced,
       * because it is the only store in this system that carries a per-column
       * before and after — `activity_log` has no column field at all, and
       * `audit_events` deliberately records changes to the SYSTEM rather than
       * to the work. "Priority went from Low to Urgent on Tuesday" was
       * recorded and unreadable; now it is in the drawer beside everything
       * else that happened to the job.
       *
       * Both are read-only here, both are capped, and the merge is by time so
       * the tab still answers "what happened, most recent first" — which is the
       * only question it exists to answer.
       */
      const [activities, cellChanges] = await Promise.all([
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.entityType, "maintenance_request"),
              eq(activityLog.entityId, requestId),
              eq(activityLog.organisationId, orgId),
            ),
          )
          .orderBy(desc(activityLog.createdAt))
          .limit(100),
        db
          .select()
          .from(itemActivity)
          .where(
            and(
              eq(itemActivity.requestId, requestId),
              eq(itemActivity.organisationId, orgId),
            ),
          )
          .orderBy(desc(itemActivity.createdAt))
          .limit(100),
      ]);

      const merged = [
        ...activities.map(exposeActivity),
        ...cellChanges.map(exposeItemActivity),
      ].sort((left, right) =>
        // Newest first. Both tables store ISO-8601 or SQLite's own
        // `YYYY-MM-DD HH:MM:SS`; neither sorts against the other lexically, so
        // the comparison is on parsed time. An unparseable stamp sorts last
        // rather than to the top, where it would look like the latest event.
        activityStamp(right.createdAt) - activityStamp(left.createdAt),
      );

      return Response.json({
        request: exposeRequest(row),
        activities: merged.slice(0, 100),
      });
    }

    // Paged, and the page reports whether there is more.
    //
    // This was a bare `.limit(250)` with nothing to say so. The board renders
    // whatever this returns, so once the monday import brought 744 jobs across,
    // the board quietly showed 250 of them and looked complete — the worst kind
    // of wrong, because the group counts and the totals all agreed with each
    // other. The cap is now explicit and the caller can walk past it.
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 1000, 1), 2000);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

    const rows = await db
      .select()
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          // Stage 23 — the main job feed. Without this the dashboard keeps
          // counting and listing jobs that are sitting in the recycle bin.
          isNull(maintenanceRequests.deletedAt),
        ),
      )
      .orderBy(desc(maintenanceRequests.requestedAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    /*
     * THE COUNTERS ARE COUNTED, not read off the row — the same treatment
     * `/api/board` now gets, and this is the other half of it.
     *
     * This is the portal grid's own row source: the mobile job card reads
     * `issueAttachmentCount` straight off these rows, and `board-filter.ts`,
     * `board-ordering.ts` and `board-csv.ts` all sort and export on them. Left
     * alone, the board would tell the truth about a job's photographs and the
     * grid beside it would keep repeating the boot back-fill's invention — a
     * worse state than both being wrong together, because only one of them
     * looks broken.
     *
     * `pictureColumnsFor` is one lookup per BOARD, not per row: every job in a
     * page shares its board's file columns, so the first row's answer serves
     * the whole page. An empty page skips both queries.
     */
    const pictureColumns = page.length
      ? await pictureColumnsFor(db, orgId, page[0].id)
      : undefined;
    const counted = await attachmentCountsByRequest(
      db,
      orgId,
      page.map((row) => row.id),
      pictureColumns,
    );

    return Response.json({
      requests: page.map((row) =>
        exposeRequest(withCountedAttachments(row, counted, row.id)),
      ),
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: databaseError(error) }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const payload = (await request.json()) as Record<string, unknown>;
    const location = trimString(payload.location, 120);
    const requester = trimString(payload.requester, 120);
    const contact = trimString(payload.contact, 80);
    const description = trimString(payload.description, 800);
    const category = trimString(payload.category, 80) || "Other";
    const priority = await configuredValue(db, orgId, "priority", payload.priority);
    const engineer = await configuredValue(
      db,
      orgId,
      "engineer_required",
      payload.engineer,
    );

    if (!location || !requester || !contact || description.length < 10) {
      return Response.json(
        {
          error:
            "Location, requester, contact details and a clear description are required.",
        },
        { status: 400 },
      );
    }

    await seedMaintenanceIfEmpty(db, orgId);
    /*
     * Only the `MN-1234` ids are numbered, and only they may be cast.
     *
     * Without the filter this casts the tail of EVERY id in the workspace. Two
     * other shapes exist — `req_<uuid>` from the import and `sd-001` from the
     * documentation board — and `cast('_6204b0…' as integer)` is not an error
     * in SQLite, which quietly yields 0. Postgres refuses it outright with
     * `invalid input syntax for type integer`, the route's catch answers "The
     * maintenance database is being prepared", and raising a job becomes
     * impossible with nothing naming the reason.
     *
     * So this was already wrong on SQLite — 776 rows contributing 0 to a MAX —
     * and merely survived because the wrong answer and the right one agreed
     * while no numbered id existed. `like` is one of the few predicates both
     * dialects spell identically.
     */
    const [latest] = await db
      .select({
        maxNumber: sql<number>`coalesce(max(cast(substr(${maintenanceRequests.id}, 4) as integer)), 1048)`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.organisationId, orgId),
          sql`${maintenanceRequests.id} like 'MN-%'`,
        ),
      );
    const id = `MN-${Number(latest.maxNumber ?? 1048) + 1}`;
    // Monday's form asks for "Date Requested" and makes it mandatory, so an
    // answer is honoured when given. Anything unparseable falls back to now
    // rather than rejecting a job that is otherwise complete.
    const submittedDate = trimString(payload.requestedAt, 32);
    const parsedDate = submittedDate ? new Date(submittedDate) : null;
    const requestedAt =
      parsedDate && !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : new Date().toISOString();
    // Monday's Priority column carries three labels — Urgent, Medium, Low.
    // The "High" branch this used to have matched nothing on the board, so
    // anything not Urgent silently fell through to the 120-hour Low target.
    // The hours themselves live in app/lib/priority-rules.ts, keyed on the
    // registry VALUE `configuredValue` resolved above — so renaming a
    // priority's display label cannot change its SLA.
    const slaRule = priorityRule(priority);
    const dueAt = new Date(
      Date.now() + slaRule.dueHours * 60 * 60 * 1000,
    ).toISOString();
    const [matchedSite] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(eq(sites.name, location), eq(sites.organisationId, orgId)),
      )
      .limit(1);
    if (!matchedSite) {
      return Response.json(
        { error: "Choose a site from this client workspace." },
        { status: 400 },
      );
    }
    const siteId = matchedSite.id;
    const uploadToken = null;
    const uploadTokenHash = uploadToken ? await sha256(uploadToken) : null;
    const uploadTokenExpiresAt = uploadToken
      ? new Date(Date.now() + 30 * 60 * 1000).toISOString()
      : null;

    const [created] = await db
      .insert(maintenanceRequests)
      .values({
        id,
        organisationId: orgId,
        siteId,
        source: "Portal form",
        title: requestTitle(description),
        description,
        location,
        requester,
        contact,
        category,
        engineer,
        tier: slaRule.tier,
        priority,
        stage: "Incoming",
        // Monday's first status. "Triage in progress" was one of six statuses
        // that existed only in this codebase, so every job raised through the
        // form landed on a chip the board could not render.
        status: "Pending Approval",
        contractor: null,
        assignee: null,
        requestedAt,
        dueAt,
        completedAt: null,
        nextUpdateAt: dueAt,
        cost: null,
        attachmentCount: 0,
        issueAttachmentCount: 0,
        completedAttachmentCount: 0,
        generalAttachmentCount: 0,
        publicUploadTokenHash: uploadTokenHash,
        publicUploadTokenExpiresAt: uploadTokenExpiresAt,
        commentCount: 0,
        createdByEmail: actor.email,
      })
      .returning();

    await db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: orgId,
      entityType: "maintenance_request",
      entityId: id,
      action: "request.created",
      actorEmail: actor.email,
      detail: JSON.stringify({ source: "Portal form", priority, location }),
    });

    // J4 / J5 — tell the coordinator. Urgent work is flagged in the subject so
    // it is visible in a notification preview without opening the message.
    //
    // As with leads, a delivery failure never fails the request: the job is
    // saved and the failure is recorded for replay.
    const { opsInbox } = notificationTargets();
    const alert = jobAlertTemplate({
      reference: created.reference,
      title: created.title,
      site: location,
      priority,
      requester: created.requester,
      contact: created.contact,
      description: created.description,
    });
    const alertResult = await sendNotification(db, {
      organisationId: orgId,
      channel: "email",
      event: (priority ?? "").toLowerCase() === "urgent" ? "job.urgent" : "job.created",
      subjectType: "job",
      subjectId: id,
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
      .where(eq(maintenanceRequests.id, id));

    // The job exists and its alert is logged; now the board's rules may run.
    // A rule that fails cannot undo either — see `dispatchAutomationEvent`.
    await dispatchAutomationEvents(automationContext(guard.scope, request), [
      itemCreatedEvent("maintenance", id, null),
    ]);

    return Response.json(
      {
        request: exposeRequest(created),
        notified: alertResult.ok,
        ...(uploadToken ? { uploadToken } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: databaseError(error) }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "board.edit");
    if (guard.denied) return guard.denied;
    const { actor, db, orgId } = guard.scope;
    const payload = (await request.json()) as Record<string, unknown>;
    const id = trimString(payload.id, 40);
    const stage = trimString(payload.stage, 30);
    const note = trimString(payload.note, 1000);
    const fields =
      payload.fields &&
      typeof payload.fields === "object" &&
      !Array.isArray(payload.fields)
        ? (payload.fields as Record<string, unknown>)
        : null;
    const validStages = new Set([
      "Incoming",
      "Booked",
      "Attention",
      "Completed",
    ]);

    if (!id || (!stage && !note && !fields)) {
      return Response.json(
        { error: "A request ID and an update are required." },
        { status: 400 },
      );
    }
    if (stage && !validStages.has(stage)) {
      return Response.json({ error: "Invalid workflow stage." }, { status: 400 });
    }

    /*
     * A value the field cannot hold is refused, not dropped.
     *
     * `requestFieldValues` throws malformed values away — deliberately, for
     * the automation engine, where a rule firing with an impossible value
     * should not take the run down. For a person's PATCH it is the wrong
     * answer: `{ tier: "abc" }` came back 200 with the row untouched, telling
     * the caller its edit had happened when it had not. A payload carrying one
     * bad field beside good ones wrote the good ones and stayed silent about
     * the rest, which is a partial write nobody asked for.
     *
     * Refusing the whole payload before anything is written is what makes the
     * 200 mean something. Unknown keys are still ignored and absent keys are
     * still absent, so every existing client is unaffected — the rules mirror
     * the coercion exactly. See `invalidRequestFields`.
     */
    if (fields) {
      const problems = invalidRequestFields(fields);
      if (problems.length) {
        return Response.json(
          { error: problems.join(" "), fields: problems },
          { status: 400 },
        );
      }
    }

    /*
     * J — a job in a gated category cannot be marked Completed without a
     * photograph of the finished work.
     *
     * Server-side, because this is the only place it can be true. The drawer
     * hides the control, the contractor page hides the control, and neither of
     * those is a rule — a PATCH from anything else closes the job regardless.
     *
     * Which categories are gated is the client's decision and is empty until
     * they make it (see `completionEvidenceCategories`), so this costs one
     * settings read and nothing else on a workspace that has not opted in.
     *
     * The check is on the CURRENT row's category, read from the database, not
     * on anything in the payload: a request that set `category` and `stage` in
     * the same PATCH could otherwise move itself into an ungated category on
     * the way past the gate.
     */
    if (stage === "Completed") {
      const [settingsRow] = await db
        .select({ settings: workspaceSettings.settings })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.organisationId, orgId))
        .limit(1);

      let gated: string[] = [];
      try {
        const parsed = JSON.parse(settingsRow?.settings ?? "{}") as {
          completionEvidenceCategories?: unknown;
        };
        gated = Array.isArray(parsed.completionEvidenceCategories)
          ? parsed.completionEvidenceCategories.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
      } catch {
        // Unreadable settings must not close the gate on everybody — a
        // corrupt row would stop the workspace working. It opens instead,
        // which is the same behaviour as not having opted in.
      }

      if (gated.length) {
        const [current] = await db
          .select({ category: maintenanceRequests.category })
          .from(maintenanceRequests)
          .where(
            and(
              eq(maintenanceRequests.id, id),
              eq(maintenanceRequests.organisationId, orgId),
            ),
          )
          .limit(1);

        const category = (current?.category ?? "").trim();
        if (category && gated.includes(category)) {
          const [evidence] = await db
            .select({ total: count() })
            .from(attachments)
            .where(
              and(
                eq(attachments.requestId, id),
                eq(attachments.organisationId, orgId),
                eq(attachments.kind, "completion"),
              ),
            );

          if ((evidence?.total ?? 0) === 0) {
            return Response.json(
              {
                error: `A photograph of the completed work is required before a ${category} job can be closed. Add one to "Picture of completed works".`,
                needsCompletionEvidence: true,
                category,
              },
              { status: 409 },
            );
          }
        }
      }
    }

    const values: Partial<typeof maintenanceRequests.$inferInsert> = {
      updatedAt: new Date().toISOString(),
      ...(stage
        ? {
            stage,
            completedAt:
              stage === "Completed" ? new Date().toISOString() : null,
          }
        : {}),
    };

    /*
     * A stage change no longer rewrites the Status column.
     *
     * It used to map the four stages onto four labels — Pending Approval, Job
     * Scheduled, Waiting for decisions, Job Completed. That map was added for a
     * good reason (the four labels it replaced were invented and the board
     * could not render them) but it was too broad: this board carries ELEVEN
     * statuses, and stage and status are separate columns in monday. Moving a
     * job to Booked turned "Waiting for parts" into "Job Scheduled", and
     * "Awaiting Landlord Approval", "Health And Safety Hold", "Third Party
     * Delay" and "Quote Received (waiting for Approval)" the same way — the
     * reason a job was stuck, deleted by the act of scheduling it.
     *
     * Found by a probe of the completion-evidence gate, which closed a real job
     * and overwrote "Waiting for payment"; the original was recovered from
     * `db/monday-export/api-pull/maintenance.json`.
     *
     * The map still applies where there is nothing to lose: a row with no
     * status at all gets one, which is what the original fix was for.
     */
    if (stage) {
      const [existing] = await db
        .select({ status: maintenanceRequests.status })
        .from(maintenanceRequests)
        .where(
          and(
            eq(maintenanceRequests.id, id),
            eq(maintenanceRequests.organisationId, orgId),
          ),
        )
        .limit(1);

      if (!existing?.status?.trim()) {
        values.status = {
          Incoming: "Pending Approval",
          Booked: "Job Scheduled",
          Attention: "Waiting for decisions",
          Completed: "Job Completed",
        }[stage];
      }
    }

    if (fields) {
      /*
       * One normaliser for a job's own columns — `requestFieldValues` in
       * app/lib/request-fields.ts — shared with the automation engine so a rule
       * that sets Priority applies the same trimming and caps this route does.
       */
      Object.assign(values, requestFieldValues(fields));

      // Re-parenting — "convert to subitem" and "move out of a subitem".
      //
      // Three refusals, because the board reads the tree on every render and a
      // bad edge is not recoverable from the UI:
      //   - an item cannot be its own parent,
      //   - the parent must exist in this organisation,
      //   - an item that already has children cannot become a child itself,
      //     which is monday's rule and also what keeps the tree one level deep.
      if (typeof fields.parentId === "string" || fields.parentId === null) {
        const parentId = trimString(fields.parentId, 64) || null;
        if (parentId === id) {
          return Response.json({ error: "An item cannot be its own parent." }, { status: 400 });
        }
        if (parentId) {
          const [parent] = await db
            .select({ id: maintenanceRequests.id, parentId: maintenanceRequests.parentId })
            .from(maintenanceRequests)
            .where(
              and(
                eq(maintenanceRequests.id, parentId),
                eq(maintenanceRequests.organisationId, orgId),
                isNull(maintenanceRequests.deletedAt),
              ),
            );
          if (!parent) {
            return Response.json({ error: "That parent item does not exist." }, { status: 404 });
          }
          if (parent.parentId) {
            return Response.json(
              { error: "Subitems cannot themselves have subitems." },
              { status: 409 },
            );
          }
          const [child] = await db
            .select({ id: maintenanceRequests.id })
            .from(maintenanceRequests)
            .where(
              and(
                eq(maintenanceRequests.parentId, id),
                eq(maintenanceRequests.organisationId, orgId),
                isNull(maintenanceRequests.deletedAt),
              ),
            )
            .limit(1);
          if (child) {
            return Response.json(
              { error: "This item has subitems of its own, so it cannot become one." },
              { status: 409 },
            );
          }
        }
        values.parentId = parentId;
      }

      /*
       * Attaching a job to a site — the manual assignment an unattached job is
       * waiting for.
       *
       * There was no way to do this. `siteId` is not in SYSTEM_FIELD_BY_KEY, so
       * the board cannot write it, and the one `update(...).set({ siteId })` in
       * the whole application was the monday importer. A job filed against the
       * wrong site, or against none, could not be moved without re-running an
       * import — while the website intake route's own comment promised it could
       * be reassigned in one edit.
       *
       * The site must be one THIS organisation owns, the same check the board's
       * create route makes and for the same reason: the row stays in the
       * actor's organisation, but its `site_id` would point across the tenant
       * boundary and corrupt every site-joined report and compliance count. A
       * site belonging to another tenant and an id that exists nowhere are
       * answered identically, so the status cannot be used to confirm that an
       * id is real.
       *
       * `null` clears it. `location` is whatever the caller sent in the same
       * payload and is applied above — this route never invents a name for a
       * site the caller did not name, and never blanks the text a person typed
       * just because an id arrived beside it.
       */
      if (typeof fields.siteId === "string" || fields.siteId === null) {
        const nextSiteId = trimString(fields.siteId, 64) || null;
        if (nextSiteId) {
          const [site] = await db
            .select({ id: sites.id })
            .from(sites)
            .where(and(eq(sites.id, nextSiteId), eq(sites.organisationId, orgId)));
          if (!site) {
            return Response.json({ error: "Site not found." }, { status: 404 });
          }
        }
        /*
         * Clearing a site has to be written the way the column can hold it.
         * Every other writer already asks `unassignedSiteId()` — this one sent
         * a raw `null`, which Postgres accepts and SQLite refuses, because
         * `site_id` is NOT NULL there and cannot be relaxed in place. The
         * refusal surfaced as a 503 whose dev body carried the failing
         * statement and every column name with it. Same rule as the rest:
         * NULL where the schema allows one, the sentinel where it does not.
         */
        values.siteId = nextSiteId ?? unassignedSiteId();
      }

      /*
       * Naming a contractor also REFERENCES one, where the register can say so
       * without guessing.
       *
       * `contractor` is free text and stays free text — it is the record of who
       * was named on the job, and this never rewrites it to a canonical
       * spelling. Beside it, `contractor_id` is recomputed from that same text
       * by `app/lib/contractor-reference.ts`: organisation-scoped, exact
       * `lower(trim())`, and only where EXACTLY ONE contractor carries the
       * name. That is not a new policy — it is the rule `db/init.ts:207-231`
       * already applies at boot, moved onto the write path so a job assigned a
       * second ago is linked as well as one imported last year.
       *
       * `contractorLinkValues` returns `{}` unless `contractor` is part of THIS
       * write, so a PATCH that changes a priority cannot disturb a link. When
       * it IS part of the write the id is DERIVED FROM IT, every time: unique
       * match wins, unknown and ambiguous both clear it. Leaving a previous id
       * behind would leave a job counted against a contractor it no longer
       * names, for ever and invisibly — the column is `ON DELETE SET NULL`
       * (db/init.ts:186) for the same reason.
       *
       * `orgId` is the caller's own organisation and the UPDATE below is scoped
       * to it, so a resolved contractor is always this tenant's.
       */
      const { link: contractorLink, ...contractorLinkFields } =
        await contractorLinkValues(db, orgId, values);
      Object.assign(values, contractorLinkFields);
      void contractorLink;
    }

    const [before] = await db
      .select()
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, id),
          eq(maintenanceRequests.organisationId, orgId),
        ),
      )
      .limit(1);

    let updated;
    if (stage || fields) {
      [updated] = await db
        .update(maintenanceRequests)
        .set(values)
        .where(
          and(
            eq(maintenanceRequests.id, id),
            eq(maintenanceRequests.organisationId, orgId),
          ),
        )
        .returning();
    }
    if (note) {
      [updated] = await db
        .update(maintenanceRequests)
        .set({
          commentCount: sql`${maintenanceRequests.commentCount} + 1`,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(maintenanceRequests.id, id),
            eq(maintenanceRequests.organisationId, orgId),
          ),
        )
        .returning();
    }
    if (!updated) {
      return Response.json({ error: "Request not found." }, { status: 404 });
    }

    await db.insert(activityLog).values({
      id: crypto.randomUUID(),
      organisationId: orgId,
      entityType: "maintenance_request",
      entityId: id,
      action: note
        ? "request.note_added"
        : fields
          ? "request.fields_changed"
          : "request.stage_changed",
      actorEmail: actor.email,
      detail: JSON.stringify(note ? { note } : fields ? { fields } : { stage }),
    });

    // Every board column that moved is one event; a rule reads them by the
    // board's own column keys. Told after the write, never before.
    let latest = updated;
    if (stage || fields) {
      const ran = await dispatchAutomationEvents(
        automationContext(guard.scope, request),
        requestFieldEvents("maintenance", before, updated),
      );
      /*
       * A rule may have written this same row again — "when status changes,
       * change status to X" is the ordinary case, and every Change status /
       * Set date / Move to group action does it too.
       *
       * `updated` is what the CALLER's own write returned, so answering with
       * it hands the board a value the database no longer holds: the grid
       * applies the response over its optimistic cell and goes on showing the
       * pre-automation value until somebody reloads. Re-read the row instead —
       * but only when a rule actually ran, so the ordinary edit still costs
       * one query.
       */
      if (ran > 0) {
        const [after] = await db
          .select()
          .from(maintenanceRequests)
          .where(
            and(
              eq(maintenanceRequests.id, id),
              eq(maintenanceRequests.organisationId, orgId),
            ),
          )
          .limit(1);
        if (after) latest = after;
      }
    }

    return Response.json({ request: exposeRequest(latest) });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: databaseError(error) }, { status: 503 });
  }
}
