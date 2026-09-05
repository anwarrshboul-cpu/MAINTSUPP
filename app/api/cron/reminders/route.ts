/**
 * `POST|GET /api/cron/reminders` — the hourly reminder dispatcher.
 *
 * HOURLY, NOT DAILY, and that is a requirement rather than a preference: every
 * reminder row carries its own send time, so a daily run would deliver an 08:00
 * reminder and a 17:00 reminder at whatever single moment the schedule fired
 * and make the per-row time decorative.
 *
 * ── WHAT THIS ROUTE IS ALLOWED TO DECIDE, AND WHAT IT IS NOT ───────────────
 *
 * It decides nothing about dates. `app/lib/reminders/schedule.ts` owns every
 * question of the form "when", including the two that are genuinely hard — what
 * 08:00 Europe/London means in UTC on either side of a clock change, and what
 * counts as the same occurrence when the scheduler fires twice. This file is
 * the plumbing: select, claim, resolve, send, record.
 *
 * That split is why the arithmetic is testable without a database and why this
 * file has no dates in it.
 *
 * ── THE SEQUENCE IS CLAIM, THEN SEND. NEVER THE REVERSE ────────────────────
 *
 * `claimDispatch` inserts the (rule, occurrence) row and returns null when it
 * already existed. Sending first and recording afterwards would mean a crash
 * between the two sends the reminder again on the next run, which for a
 * "certificate expires in 14 days" cascade is how a client receives the same
 * warning nine times. Claiming first means the worst case is a reminder that is
 * marked as handled and never arrives — visible in the dispatch log as a row
 * with no `sent_at`, and recoverable — rather than one that arrives repeatedly
 * and cannot be recalled.
 *
 * ── EMAIL_MODE IS NOT CONSULTED HERE ───────────────────────────────────────
 *
 * Every send goes through `sendNotification`, which owns the kill switch and
 * writes `notification_log`. This route does not check the mode, does not have
 * a "if preview then skip" branch, and must not grow one: a second place that
 * decides whether mail leaves the building is a second place to get it wrong,
 * and the failure mode is mail reaching a real client from a test environment.
 *
 * ── AN UNSCOPED HANDLE, FOR THE SAME REASON THE RETENTION SWEEP HAS ONE ────
 *
 * A scheduler has no session and therefore no organisation. `listDueReminders`
 * spans tenants deliberately and every row carries its own `organisation_id`,
 * which is what every write below is keyed by.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import { ensureDatabase } from "../../../../db/init";
import {
  complianceDocuments,
  maintenanceRequests,
  memberships,
  sites,
  users,
} from "../../../../db/schema";
import { authoriseCron, resolveCronSecret } from "../../../lib/cron-auth";
import { sendNotification } from "../../../lib/notifications";
import type { RecipientContext, RecipientPerson } from "../../../lib/reminders/recipients";
import { resolveRecipients } from "../../../lib/reminders/recipients";
import {
  claimDispatch,
  issueActionToken,
  listDueReminders,
  noteSendOnRule,
  recordDispatchResult,
} from "../../../lib/reminders/repository";
import {
  nextRepeatOccurrence,
  occurrenceKey,
  type ReminderRuleRow,
} from "../../../lib/reminders/schedule";
import { readReminderSettings } from "../../../lib/reminders/settings";
import { deferPastQuietHours } from "../../../lib/reminders/schedule";
import { reminderEmail } from "../../../lib/reminders/template";

export const dynamic = "force-dynamic";

/**
 * How many rules one invocation will process.
 *
 * Bounded for the same reason the retention sweep is bounded: a scheduled
 * invocation that holds itself open until the work is gone is one that a large
 * backlog turns into a timeout, and a timeout mid-loop leaves claimed-but-unsent
 * rows behind. Whatever is left is still due and is still first in line next
 * hour.
 */
const BATCH = 100;

/** A token link lasts 30 days, per the specification. */
const TOKEN_DAYS = 30;

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * The people a dynamic group resolves to, looked up AT SEND TIME.
 *
 * This is the whole reason `reminder_recipients` stores group keys rather than
 * addresses. A cascade written in January and firing in December reaches
 * whoever holds the role in December — the renewal owner who has since changed,
 * the admin who has since joined — and a resolved-at-save copy of a staff list
 * would quietly stop being true the first time somebody left.
 */
async function buildContext(
  db: Db,
  organisationId: string,
  subjectType: string,
  subjectId: string,
): Promise<RecipientContext> {
  const staff = await db
    .select({ id: users.id, email: users.email, name: users.fullName, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organisationId, organisationId), eq(users.active, true)));

  const asPerson = (row: { id: string; email: string | null; name: string | null }): RecipientPerson => ({
    userId: row.id,
    email: row.email,
    name: row.name,
  });

  const admins = staff
    .filter((row: { role: string | null }) => (row.role ?? "").toLowerCase().includes("admin") || (row.role ?? "").toLowerCase() === "owner")
    .map(asPerson);
  const internal = staff.map(asPerson);

  const groups: RecipientContext["groups"] = {
    "all-admins": admins,
    "internal-team": internal,
  };

  if (subjectType === "certificate") {
    const [record] = await db
      .select()
      .from(complianceDocuments)
      .where(
        and(
          eq(complianceDocuments.id, subjectId),
          eq(complianceDocuments.organisationId, organisationId),
        ),
      )
      .limit(1);
    if (record) {
      groups["renewal-owner"] = record.renewalOwnerEmail
        ? { email: record.renewalOwnerEmail }
        : null;
      groups["escalation-contact"] = record.escalationEmail
        ? { email: record.escalationEmail }
        : null;
      if (record.siteId) {
        const [site] = await db
          .select()
          .from(sites)
          .where(eq(sites.id, record.siteId))
          .limit(1);
        /*
         * A site's contact is whatever the site record carries. Nothing is
         * invented when it carries none — `resolveRecipientPlan` reports an
         * empty group rather than dropping it silently, so an operator can see
         * that a step reached fewer people than it named.
         */
        /*
         * `manager_email` is the only site column that is reliably an ADDRESS.
         * `access_contact` and `out_of_hours_contact` were imported from a
         * monday column that mixed emails, portal URLs, phone numbers and the
         * string "N/A" in one cell — see their note in db/schema.ts — so
         * treating either as an address would post reminders at a phone number
         * and record a delivery failure nobody caused.
         */
        const contact = site?.managerEmail ?? null;
        groups["site-contact"] = contact && contact.includes("@") ? { email: contact } : null;
      }
    }
  }

  if (subjectType === "job" || subjectType === "visit") {
    const [job] = await db
      .select()
      .from(maintenanceRequests)
      .where(
        and(
          eq(maintenanceRequests.id, subjectId),
          eq(maintenanceRequests.organisationId, organisationId),
        ),
      )
      .limit(1);
    if (job) {
      const assignee = (job.assignee ?? "").includes("@") ? job.assignee : null;
      groups["assigned-engineer"] = assignee ? { email: assignee } : null;
      const owner = (job.createdByEmail ?? "").includes("@") ? job.createdByEmail : null;
      groups["job-owner"] = owner ? { email: owner } : null;
    }
  }

  return { users: internal, groups };
}

/** The recipient rows for a batch of rules, in one query rather than N. */
async function recipientsByRule(db: Db, ruleIds: readonly string[]) {
  if (ruleIds.length === 0) return new Map<string, Array<Record<string, unknown>>>();
  const { reminderRecipients } = await import("../../../../db/schema");
  const rows = await db
    .select()
    .from(reminderRecipients)
    .where(inArray(reminderRecipients.reminderId, [...ruleIds]));
  const grouped = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows as Array<Record<string, unknown> & { reminderId: string }>) {
    const list = grouped.get(row.reminderId) ?? [];
    list.push(row);
    grouped.set(row.reminderId, list);
  }
  return grouped;
}

export type DispatchOutcome = {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Moved to the next permitted slot by quiet hours. Not sent, not lost. */
  deferred: number;
  more: boolean;
};

/**
 * Push a rule's next send into the permitted window.
 *
 * `status` stays `pending` and no dispatch is claimed, so the reminder is still
 * owed — which is the entire difference between deferring and suppressing.
 */
async function noteQuietHoursDeferral(
  db: Db,
  organisationId: string,
  reminderId: string,
  nextSendAt: string,
): Promise<void> {
  const { reminderRules } = await import("../../../../db/schema");
  const { and, eq } = await import("drizzle-orm");
  await db
    .update(reminderRules)
    .set({ nextSendAt, updatedAt: new Date().toISOString() })
    .where(
      and(eq(reminderRules.id, reminderId), eq(reminderRules.organisationId, organisationId)),
    );
}

async function runDispatch(nowIso: string): Promise<DispatchOutcome> {
  await ensureDatabase();
  const db = await getDb();

  const due = (await listDueReminders(db, nowIso, BATCH)) as ReminderRuleRow[] &
    Array<Record<string, string | number | boolean | null>>;
  const outcome: DispatchOutcome = {
    considered: due.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    more: due.length === BATCH,
  };
  if (due.length === 0) return outcome;

  const recipientRows = await recipientsByRule(
    db,
    due.map((rule) => String(rule.id)),
  );

  for (const rule of due) {
    const organisationId = String(rule.organisationId);
    const reminderId = String(rule.id);
    const subjectType = String(rule.subjectType);
    const subjectId = String(rule.subjectId);
    const dueAt = rule.nextSendAt ? new Date(String(rule.nextSendAt)) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime())) {
      outcome.skipped += 1;
      continue;
    }

    /*
     * QUIET HOURS DEFER, THEY DO NOT CANCEL.
     *
     * If this send falls outside the permitted window the rule's `next_send_at`
     * is moved to the next slot and NOTHING is dispatched this run. Note what
     * is deliberately not done: no dispatch row is claimed, so the reminder is
     * not marked as handled — a suppressed compliance reminder is a reminder
     * that did not happen, and §7.4 asks for a delay rather than a loss.
     */
    const settings = await readReminderSettings(db, organisationId);
    const permitted = deferPastQuietHours(dueAt, settings.quietHours);
    if (permitted.getTime() !== dueAt.getTime()) {
      await noteQuietHoursDeferral(db, organisationId, reminderId, permitted.toISOString());
      outcome.deferred += 1;
      continue;
    }

    const key = occurrenceKey(dueAt, String(rule.timezone ?? "Europe/London"));
    if (!key) {
      outcome.skipped += 1;
      continue;
    }

    /* Claim BEFORE sending. See the header. */
    const dispatchId = await claimDispatch(db, organisationId, reminderId, key);
    if (!dispatchId) {
      outcome.skipped += 1;
      continue;
    }

    try {
      const context = await buildContext(db, organisationId, subjectType, subjectId);
      const resolved = resolveRecipients(
        (recipientRows.get(reminderId) ?? []) as never,
        context,
      );
      const addresses = resolved
        .map((entry) => entry.email)
        .filter((email): email is string => Boolean(email));

      if (addresses.length === 0) {
        /*
         * No recipients is not a failure of sending — nothing was attempted —
         * but it must not read as a success either. Recorded as `failed` with
         * the reason, so a step configured only with a group nobody is in shows
         * up in the dispatch log rather than looking delivered.
         */
        await recordDispatchResult(db, dispatchId, {
          status: "failed",
          error: "The reminder resolved to no recipients.",
        });
        outcome.failed += 1;
      } else {
        const tokens = {
          ack: await issueActionToken(db, organisationId, {
            reminderId,
            subjectType,
            subjectId,
            action: "ack",
            expiresAt: new Date(Date.now() + TOKEN_DAYS * 86_400_000).toISOString(),
          }),
          snooze: await issueActionToken(db, organisationId, {
            reminderId,
            subjectType,
            subjectId,
            action: "snooze",
            expiresAt: new Date(Date.now() + TOKEN_DAYS * 86_400_000).toISOString(),
          }),
          renew: await issueActionToken(db, organisationId, {
            reminderId,
            subjectType,
            subjectId,
            action: "renew",
            expiresAt: new Date(Date.now() + TOKEN_DAYS * 86_400_000).toISOString(),
          }),
        };

        const message = reminderEmail({
          subjectType,
          subjectId,
          customMessage: rule.customMessage ? String(rule.customMessage) : null,
          occurrenceKey: key,
          tokens,
        });

        let anyFailed = false;
        let providerId: string | null = null;
        for (const address of addresses) {
          const result = await sendNotification(db, {
            organisationId,
            channel: "email",
            event: "reminder",
            /*
             * `compliance` for a certificate, `job` otherwise. The log's
             * `subject_type` vocabulary is fixed and adding a value to it here
             * would make an existing filter silently miss these rows.
             */
            subjectType: subjectType === "certificate" ? "compliance" : "job",
            subjectId,
            to: address,
            subject: message.subject,
            body: message.html,
            text: message.text,
          });
          if (!result.ok && result.status !== "suppressed" && result.status !== "skipped") {
            anyFailed = true;
          }
          providerId = providerId ?? null;
        }

        await recordDispatchResult(db, dispatchId, {
          status: anyFailed ? "failed" : "sent",
          providerMessageId: providerId,
          recipients: addresses,
          error: anyFailed ? "At least one recipient could not be sent to." : null,
        });
        if (anyFailed) outcome.failed += 1;
        else outcome.sent += 1;
      }
    } catch (error) {
      await recordDispatchResult(db, dispatchId, {
        status: "failed",
        error: error instanceof Error ? error.message : "The reminder could not be sent.",
      });
      outcome.failed += 1;
    }

    /*
     * Advance the rule whatever happened.
     *
     * A failed send must not leave `next_send_at` in the past: the row would be
     * selected again on the very next run, and the claim would refuse it every
     * time — a rule stuck permanently "due" and permanently skipped. Retry
     * belongs to the repeat interval and to the operator, not to a loop that
     * cannot make progress.
     *
     * THE FIELD NAMES ARE TRANSLATED HERE, AND THEY HAVE TO BE. `schedule.ts`
     * reads snake_case (`repeat_enabled`, `sends_count`) because it is written
     * against the column names and is loaded by tests with no drizzle; drizzle
     * hands back camelCase. Spreading the row straight in compiles perfectly
     * and reads `undefined` for every one of these, so `flagIsTrue` sees no
     * repeat flag and NO reminder ever repeats — a silent failure with nothing
     * red anywhere. Mapped explicitly so the mismatch cannot come back.
     */
    const next = nextRepeatOccurrence(
      {
        id: reminderId,
        step_key: rule.stepKey ? String(rule.stepKey) : null,
        is_enabled: rule.isEnabled,
        offset_value: Number(rule.offsetValue ?? 0),
        offset_unit: String(rule.offsetUnit ?? "day"),
        offset_direction: String(rule.offsetDirection ?? "before"),
        send_time: String(rule.sendTime ?? "08:00"),
        timezone: String(rule.timezone ?? "Europe/London"),
        repeat_enabled: rule.repeatEnabled,
        repeat_interval_days: Number(rule.repeatIntervalDays ?? 3),
        repeat_cap: Number(rule.repeatCap ?? 10),
        sends_count: Number(rule.sendsCount ?? 0) + 1,
        next_send_at: rule.nextSendAt ? String(rule.nextSendAt) : null,
        status: String(rule.status ?? "pending"),
        acknowledged_at: rule.acknowledgedAt ? String(rule.acknowledgedAt) : null,
      },
      dueAt,
    );
    await noteSendOnRule(
      db,
      organisationId,
      reminderId,
      next instanceof Date ? next.toISOString() : null,
    );
  }

  return outcome;
}

export async function POST(request: Request) {
  const refusal = authoriseCron(request, "reminders", await resolveCronSecret());
  if (refusal) return refusal;
  try {
    const outcome = await runDispatch(new Date().toISOString());
    return Response.json({ ok: true, ...outcome, ranAt: new Date().toISOString() });
  } catch (error) {
    console.error("[/api/cron/reminders]", error);
    return Response.json(
      { error: "The reminder dispatch could not complete." },
      { status: 503 },
    );
  }
}

/** Vercel Cron issues a GET. Same work, same authentication. */
export async function GET(request: Request) {
  return POST(request);
}
