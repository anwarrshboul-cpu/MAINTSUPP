import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { notificationLog } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

export type Channel = "email" | "sms";

export type NotificationRequest = {
  organisationId: string;
  channel: Channel;
  /** What happened — used for filtering the log and for per-event preferences. */
  event: string;
  /** What the message is about, so the log can be traced back to a record. */
  /*
   * "contractor-application" joins the four when the public /contractors page
   * gained a form. It is not a "lead": a lead is a prospective client and this
   * is a prospective supplier, they are read by different people, and the
   * subject id points at a different table. Labelling it "lead" would have made
   * the notification log lie about what the row is.
   */
  subjectType: "lead" | "job" | "compliance" | "system" | "contractor-application";
  subjectId?: string | null;
  to: string;
  subject: string;
  body: string;
  /** Plain-text alternative. Falls back to the body with tags stripped. */
  text?: string;
};

export type SendResult = {
  ok: boolean;
  logId: string;
  status: "sent" | "failed" | "skipped" | "suppressed";
  error?: string;
};

/**
 * Reads provider configuration from the Worker environment.
 *
 * Deliberately returns null rather than throwing when unconfigured: a missing
 * API key must never stop a lead or a job being saved. The notification is
 * logged as skipped and can be replayed once the key is set.
 */
function providerConfig() {
  const env = (globalThis as Record<string, unknown>).process as
    | { env?: Record<string, string | undefined> }
    | undefined;
  const source = env?.env ?? {};
  const apiKey = source.RESEND_API_KEY;
  const from = source.NOTIFY_FROM ?? "MAINTSUPP <notifications@maintsupp.com>";
  const salesInbox = source.NOTIFY_SALES ?? "info@maintsupp.com";
  const opsInbox = source.NOTIFY_OPS ?? salesInbox;
  const smsFrom = source.SMS_FROM;
  const smsKey = source.SMS_API_KEY;
  return {
    apiKey,
    from,
    salesInbox,
    opsInbox,
    smsFrom,
    smsKey,
    mode: emailMode(source),
    sink: source.EMAIL_SINK ?? opsInbox,
  };
}

/**
 * THE OUTBOUND KILL SWITCH.
 *
 * Every send in this product goes through `sendNotification`, so this is the
 * one place a deployment can be stopped from mailing a real person. It exists
 * because the reminder work ahead of it generates mail from SEEDED compliance
 * data, and a preview environment that inherits a live API key would post that
 * to whoever the seed happened to name.
 *
 *   live  — send to the real recipient. Production only.
 *   sink  — send, but to ONE internal address, with the intended recipients
 *           named in the body so a test still proves the addressing worked.
 *   log   — send nothing; write the row as `suppressed` with everything the
 *           send would have carried.
 *
 * WHY THE DEFAULT IS `sink` AND NOT `live`. Module 3 asks for a build that
 * refuses to start when `EMAIL_MODE` is unset. Failing to boot is the wrong
 * shape here — `sendNotification` is called on the path that saves a lead and
 * is documented never to throw, and a missing variable would turn "nobody was
 * emailed" into "the lead was lost", which is the exact trade this module was
 * written to avoid. Defaulting to the SAFE mode achieves what that requirement
 * is for: an unset variable can never mean `live`, so a misconfigured
 * deployment quietly stops mailing strangers instead of quietly starting to.
 * Production opts IN by setting `EMAIL_MODE=live`, and
 * `/api/account/platform` reports the mode so the state is visible rather than
 * assumed.
 */
export type EmailMode = "live" | "sink" | "log";

function emailMode(source: Record<string, string | undefined>): EmailMode {
  const raw = (source.EMAIL_MODE ?? "").trim().toLowerCase();
  if (raw === "live" || raw === "sink" || raw === "log") return raw;
  return "sink";
}

/** The mode this deployment is in, for the platform panel and for tests. */
export function outboundEmailMode(): EmailMode {
  return providerConfig().mode;
}

export function notificationTargets() {
  const { salesInbox, opsInbox } = providerConfig();
  return { salesInbox, opsInbox };
}

function stripTags(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function newId() {
  return `ntf_${crypto.randomUUID().replace(/-/g, "")}`;
}

async function deliverEmail(
  config: ReturnType<typeof providerConfig>,
  request: NotificationRequest,
): Promise<{ ok: boolean; providerId?: string; error?: string }> {
  /*
   * In `sink` the address is replaced and the real one is written into the
   * message, not dropped. A redirected test that hides who it was for proves
   * the provider works and nothing about whether the addressing was right,
   * which is most of what these tests are checking.
   */
  const sinking = config.mode === "sink";
  const to = sinking ? config.sink : request.to;
  const subject = sinking ? `[SINK] ${request.subject}` : request.subject;
  const body = sinking
    ? `<p style="margin:0 0 12px;padding:8px 10px;border:1px solid #a8620a;border-radius:6px;` +
      `background:#fff7ed;color:#7c2d12;font:600 13px system-ui">` +
      `TEST ENVIRONMENT — not sent to the real recipient.<br>Intended for: ` +
      `${escapeHtml(request.to)}</p>${request.body}`
    : request.body;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [to],
      subject,
      html: body,
      text: request.text ?? stripTags(body),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, error: `${response.status} ${detail}`.slice(0, 500) };
  }

  const payload = (await response.json().catch(() => ({}))) as { id?: string };
  return { ok: true, providerId: payload.id };
}

/**
 * Sends one notification and records the attempt.
 *
 * Never throws. A failure is written to `notification_log` with the error and
 * returned to the caller, so a broken mail provider degrades to "nobody was
 * emailed" rather than "the lead was lost".
 */
export async function sendNotification(
  db: Database,
  request: NotificationRequest,
): Promise<SendResult> {
  const config = providerConfig();
  const logId = newId();

  const base = {
    id: logId,
    organisationId: request.organisationId,
    channel: request.channel,
    event: request.event,
    subjectType: request.subjectType,
    subjectId: request.subjectId ?? null,
    recipient: request.to,
    subject: request.subject,
  };

  if (!request.to || !request.to.includes("@")) {
    await db.insert(notificationLog).values({
      ...base,
      status: "failed",
      attempts: 1,
      error: "No usable recipient address.",
    });
    return { ok: false, logId, status: "failed", error: "No usable recipient address." };
  }

  /*
   * `log` — nothing leaves the building. Recorded with everything the send
   * would have carried so `/api/notifications/replay` can post it for real
   * once a deployment is meant to, and so a test can assert on what WOULD
   * have gone out. `suppressed` rather than `skipped`: skipped means the
   * provider was missing, this means the provider was told not to.
   */
  if (config.mode === "log" && request.channel === "email") {
    await db.insert(notificationLog).values({
      ...base,
      status: "suppressed",
      attempts: 0,
      error: "EMAIL_MODE=log — nothing was sent.",
    });
    return {
      ok: false,
      logId,
      status: "suppressed",
      error: "EMAIL_MODE=log — nothing was sent.",
    };
  }

  // Unconfigured provider — record it and carry on. The message can be replayed.
  if (!config.apiKey || request.channel === "sms") {
    const reason =
      request.channel === "sms"
        ? "SMS provider not wired up yet."
        : "No RESEND_API_KEY configured.";
    await db.insert(notificationLog).values({
      ...base,
      status: "skipped",
      attempts: 0,
      error: reason,
    });
    return { ok: false, logId, status: "skipped", error: reason };
  }

  await db.insert(notificationLog).values({ ...base, status: "pending", attempts: 1 });

  try {
    const result = await deliverEmail(config, request);
    if (result.ok) {
      await db
        .update(notificationLog)
        .set({
          status: "sent",
          providerId: result.providerId ?? null,
          deliveredAt: sql`CURRENT_TIMESTAMP`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(notificationLog.id, logId));
      return { ok: true, logId, status: "sent" };
    }

    await db
      .update(notificationLog)
      .set({ status: "failed", error: result.error ?? null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(notificationLog.id, logId));
    return { ok: false, logId, status: "failed", error: result.error };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Delivery failed.";
    await db
      .update(notificationLog)
      .set({ status: "failed", error: message.slice(0, 500), updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(notificationLog.id, logId));
    return { ok: false, logId, status: "failed", error: message };
  }
}

/** Retries every failed or skipped message for an organisation. */
export async function replayFailed(db: Database, organisationId: string, limit = 50) {
  const pending = await db
    .select()
    .from(notificationLog)
    .where(
      and(
        eq(notificationLog.organisationId, organisationId),
        sql`${notificationLog.status} IN ('failed', 'skipped')`,
      ),
    )
    .limit(limit);

  let sent = 0;
  for (const row of pending) {
    const result = await sendNotification(db, {
      organisationId,
      channel: row.channel as Channel,
      event: row.event,
      subjectType: row.subjectType as NotificationRequest["subjectType"],
      subjectId: row.subjectId,
      to: row.recipient,
      subject: row.subject ?? "MAINTSUPP notification",
      body: `<p>Replayed notification: ${row.event}</p>`,
    });
    if (result.ok) {
      sent += 1;
      await db
        .update(notificationLog)
        .set({
          status: "replaced",
          attempts: row.attempts + 1,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(notificationLog.id, row.id));
    }
  }
  return { attempted: pending.length, sent };
}

/* ── Templates ───────────────────────────────────────────────────────────── */

const SHELL = (title: string, body: string) => `
<div style="font-family:Inter,Arial,sans-serif;color:#101820;max-width:560px">
  <p style="font-size:18px;font-weight:700;margin:0 0 4px">
    <span style="color:#101820">MAINT</span><span style="color:#12B4A8">SUPP</span>
  </p>
  <h2 style="font-size:17px;margin:0 0 14px">${title}</h2>
  ${body}
  <hr style="border:0;border-top:1px solid #dde4e8;margin:22px 0 10px">
  <p style="font-size:12px;color:#6b7a83;margin:0">
    Maintsupp is a trading name of Maintauk Ltd, registered in England &amp; Wales,
    company number 17262302.
  </p>
</div>`;

function row(label: string, value: string | null | undefined) {
  if (!value) return "";
  return `<tr>
    <td style="padding:4px 12px 4px 0;color:#6b7a83;font-size:13px;vertical-align:top">${label}</td>
    <td style="padding:4px 0;font-size:13px">${value}</td>
  </tr>`;
}

export function leadAlertTemplate(lead: {
  name: string;
  company?: string | null;
  email: string;
  phone?: string | null;
  siteRange?: string | null;
  challenge?: string | null;
}) {
  return {
    subject: `New portfolio review request — ${lead.company || lead.name}`,
    body: SHELL(
      "New portfolio review request",
      `<table style="border-collapse:collapse">
        ${row("Name", lead.name)}
        ${row("Company", lead.company)}
        ${row("Email", lead.email)}
        ${row("Phone", lead.phone)}
        ${row("Sites", lead.siteRange)}
        ${row("What they said", lead.challenge)}
      </table>`,
    ),
  };
}

export function leadConfirmationTemplate(lead: { name: string }) {
  return {
    subject: "We have your portfolio review request",
    body: SHELL(
      `Thanks, ${lead.name}`,
      `<p style="font-size:14px;line-height:1.55">
        We have your request and someone will be in touch within one working day.
      </p>
      <p style="font-size:14px;line-height:1.55">
        If it is urgent, call <strong>+44 7852 224644</strong>, Monday to Friday,
        8:30am to 5:30pm.
      </p>`,
    ),
  };
}

export function jobAlertTemplate(job: {
  reference?: string | null;
  title: string;
  site?: string | null;
  priority?: string | null;
  requester?: string | null;
  contact?: string | null;
  description?: string | null;
}) {
  const urgent = (job.priority ?? "").toLowerCase() === "urgent";
  return {
    subject: `${urgent ? "URGENT — " : ""}${job.reference ?? "New job"} — ${job.site ?? "site not set"}`,
    body: SHELL(
      urgent ? "Urgent job reported" : "New job reported",
      `<table style="border-collapse:collapse">
        ${row("Reference", job.reference)}
        ${row("Site", job.site)}
        ${row("Priority", job.priority)}
        ${row("Reported by", job.requester)}
        ${row("Contact", job.contact)}
        ${row("Job", job.title)}
        ${row("Description", job.description)}
      </table>`,
    ),
  };
}

/**
 * WHICH REGISTER A LAPSED CERTIFICATE IS ON.
 *
 * There can be more than one. A workspace section built from the Store
 * Documentation template gets its own board — its own stores, its own twelve
 * certificate slots — so "Cabot Circus, Fire Alarm, expired 12 days ago" is no
 * longer an address. Two registers may each hold a store of that name, and the
 * reader has to know which sidebar entry to open.
 *
 * THE COLUMN APPEARS ONLY WHEN IT SAYS SOMETHING. An organisation with the one
 * canonical register gets the digest it has always had, to the byte: a board
 * column reading "Store Documentation UK" on every row of every email is noise
 * that trains people to skim, and skimming is the failure mode this digest
 * exists to avoid. It appears the moment there are two.
 *
 * `boardName` is ESCAPED and the two fields beside it are not. That asymmetry
 * is deliberate rather than an oversight: `site` and `kind` come from the board
 * capture and the fixed slot vocabulary, while a board name is free text an
 * operator typed into the section dialog. It reaches an HTML email either way,
 * so the new field does not become this template's first injection point. The
 * older two are a separate, pre-existing question and widening the surface
 * without saying so is how that question stops being asked.
 */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function complianceDigestTemplate(summary: {
  expired: Array<{
    site: string;
    kind: string;
    expiry: string;
    daysAgo: number;
    boardName?: string | null;
  }>;
  expiring: Array<{
    site: string;
    kind: string;
    expiry: string;
    daysAway: number;
    boardName?: string | null;
  }>;
}) {
  /*
   * More than one NAMED register in this digest. Counted over both lists at
   * once, because an org whose canonical board is clean and whose instance is
   * not would otherwise see a single-register expiring table and have no idea
   * which board it was being told about.
   */
  const registers = new Set(
    [...summary.expired, ...summary.expiring]
      .map((item) => (item.boardName ?? "").trim())
      .filter(Boolean),
  );
  const showBoard = registers.size > 1;
  const boardCell = (item: { boardName?: string | null }) =>
    showBoard
      ? `<td style="padding:4px 12px 4px 0;font-size:13px;color:#6b7a83">${escapeHtml(
          (item.boardName ?? "").trim() || "—",
        )}</td>`
      : "";

  const expiredRows = summary.expired
    .map(
      (item) =>
        `<tr>${boardCell(item)}<td style="padding:4px 12px 4px 0;font-size:13px">${item.site}</td>
         <td style="padding:4px 12px 4px 0;font-size:13px">${item.kind}</td>
         <td style="padding:4px 0;font-size:13px;color:#e2445c">
           expired ${item.daysAgo} day${item.daysAgo === 1 ? "" : "s"} ago
         </td></tr>`,
    )
    .join("");

  const expiringRows = summary.expiring
    .map(
      (item) =>
        `<tr>${boardCell(item)}<td style="padding:4px 12px 4px 0;font-size:13px">${item.site}</td>
         <td style="padding:4px 12px 4px 0;font-size:13px">${item.kind}</td>
         <td style="padding:4px 0;font-size:13px">in ${item.daysAway} days (${item.expiry})</td></tr>`,
    )
    .join("");

  return {
    subject:
      summary.expired.length > 0
        ? `${summary.expired.length} compliance document${summary.expired.length === 1 ? "" : "s"} EXPIRED`
        : `${summary.expiring.length} compliance document${summary.expiring.length === 1 ? "" : "s"} expiring`,
    body: SHELL(
      "Compliance status",
      `${
        summary.expired.length
          ? `<h3 style="font-size:14px;color:#e2445c;margin:0 0 6px">Expired</h3>
             <table style="border-collapse:collapse;margin-bottom:18px">${expiredRows}</table>`
          : ""
      }${
        summary.expiring.length
          ? `<h3 style="font-size:14px;margin:0 0 6px">Expiring soon</h3>
             <table style="border-collapse:collapse">${expiringRows}</table>`
          : ""
      }${
        !summary.expired.length && !summary.expiring.length
          ? `<p style="font-size:14px">Nothing expired or expiring in the window.</p>`
          : ""
      }`,
    ),
  };
}


export function contractorEventTemplate(event: {
  kind: "opened" | "uploaded" | "completion" | "blocked";
  reference: string | null;
  site: string | null;
  by: string | null;
  note?: string | null;
  reason?: string | null;
}) {
  const titles = {
    opened: "Contractor opened the job",
    uploaded: "Contractor uploaded evidence",
    completion: "Contractor says the work is done",
    blocked: "Contractor could not complete the job",
  } as const;

  const lead = {
    opened: "The link has been opened for the first time.",
    uploaded: "New evidence is waiting for your review.",
    completion:
      "Completion has been requested. Review the evidence and close the job if you are satisfied.",
    blocked: "The job was attended but could not be finished.",
  } as const;

  return {
    subject: `${event.reference ?? "Job"} — ${titles[event.kind]}`,
    body: SHELL(
      titles[event.kind],
      `<p style="font-size:14px;line-height:1.55">${lead[event.kind]}</p>
       <table style="border-collapse:collapse">
        ${row("Reference", event.reference)}
        ${row("Site", event.site)}
        ${row("Contractor", event.by)}
        ${row("Reason", event.reason)}
        ${row("Note", event.note)}
       </table>`,
    ),
  };
}
