/**
 * WHAT A REMINDER EMAIL SAYS.
 *
 * Pure: it takes what the dispatcher already knows and returns a subject, an
 * HTML body and a plain-text alternative. No database, no clock, no fetch — so
 * the wording can be asserted in a test without standing a mail server up.
 *
 * ── THE PLAIN-TEXT PART IS NOT OPTIONAL ────────────────────────────────────
 *
 * `sendNotification` will derive one by stripping tags if none is supplied, and
 * for a reminder that derivation is not good enough: the three action links are
 * the entire point of the message, and a stripped-tag rendering turns
 * `<a href="...">Acknowledge</a>` into the bare word "Acknowledge" with the URL
 * gone. A recipient reading in plain text would be told to acknowledge and
 * given no way to. So the text part is written by hand with the URLs spelled
 * out.
 *
 * ── THE LINKS CARRY THE ONLY COPY OF THEIR TOKEN ───────────────────────────
 *
 * `reminder_tokens` stores a SHA-256 of each token and never the token itself,
 * so the string interpolated here exists in exactly one place afterwards: the
 * message. That is deliberate — a leaked database row must not be a working
 * "Mark renewed" link — and it is why this function is given the tokens rather
 * than being allowed to look them up.
 */

export type ReminderActionTokens = {
  ack: string;
  snooze: string;
  renew: string;
};

export type ReminderEmailInput = {
  subjectType: string;
  subjectId: string;
  /** The record's own title, when the caller has one. */
  title?: string | null;
  siteName?: string | null;
  /** `YYYY-MM-DD`, for a certificate. */
  expiryDate?: string | null;
  /** Signed, and negative once expired. Null when the record has no expiry. */
  daysRemaining?: number | null;
  customMessage?: string | null;
  occurrenceKey: string;
  tokens: ReminderActionTokens;
  /** Origin for the links. Falls back to a relative path when unset. */
  origin?: string | null;
};

export type ReminderEmailMessage = {
  subject: string;
  html: string;
  text: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * How the days-remaining line reads.
 *
 * Words, not just a number, and the distinction matters at zero and below:
 * "0 days remaining" is ambiguous between "due today" and "no time left", and
 * "-3 days remaining" is not English. A reader skimming on a phone gets the
 * state from the sentence rather than from the sign of an integer.
 */
export function daysRemainingLabel(days: number | null | undefined): string | null {
  if (days === null || days === undefined || !Number.isFinite(days)) return null;
  if (days > 1) return `${days} days remaining`;
  if (days === 1) return "1 day remaining";
  if (days === 0) return "Expires today";
  if (days === -1) return "Expired yesterday";
  return `Expired ${Math.abs(days)} days ago`;
}

export function reminderActionUrl(
  action: "ack" | "snooze" | "renew",
  token: string,
  origin?: string | null,
): string {
  const base = (origin ?? "").replace(/\/+$/, "");
  return `${base}/r/${action}/${encodeURIComponent(token)}`;
}

export function reminderEmail(input: ReminderEmailInput): ReminderEmailMessage {
  const what =
    input.subjectType === "certificate"
      ? "Certificate"
      : input.subjectType === "visit"
        ? "Planned visit"
        : input.subjectType === "job"
          ? "Job"
          : "Reminder";
  const title = (input.title ?? "").trim() || `${what} ${input.subjectId}`;
  const site = (input.siteName ?? "").trim();
  const remaining = daysRemainingLabel(input.daysRemaining);

  /*
   * Subject line. The site leads because a recipient who looks after thirty of
   * them reads the first two words and needs to know WHERE before WHAT.
   */
  const subject = [
    site ? `[${site}]` : null,
    title,
    remaining ? `— ${remaining}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const ackUrl = reminderActionUrl("ack", input.tokens.ack, input.origin);
  const snoozeUrl = reminderActionUrl("snooze", input.tokens.snooze, input.origin);
  const renewUrl = reminderActionUrl("renew", input.tokens.renew, input.origin);

  const lines: string[] = [];
  lines.push(`<p><strong>${escapeHtml(title)}</strong></p>`);
  if (site) lines.push(`<p>Site: ${escapeHtml(site)}</p>`);
  if (input.expiryDate) lines.push(`<p>Expiry date: ${escapeHtml(input.expiryDate)}</p>`);
  if (remaining) lines.push(`<p><strong>${escapeHtml(remaining)}</strong></p>`);
  if (input.customMessage) {
    lines.push(`<p>${escapeHtml(input.customMessage)}</p>`);
  }
  lines.push(
    `<p>` +
      `<a href="${ackUrl}">Acknowledge</a> &middot; ` +
      `<a href="${snoozeUrl}">Snooze 7 days</a> &middot; ` +
      `<a href="${renewUrl}">Mark renewed</a>` +
      `</p>`,
  );
  lines.push(
    `<p style="color:#6B7280;font-size:12px">Each link works once and expires in 30 days.</p>`,
  );

  const text = [
    title,
    site ? `Site: ${site}` : null,
    input.expiryDate ? `Expiry date: ${input.expiryDate}` : null,
    remaining,
    input.customMessage ? `\n${input.customMessage}` : null,
    "",
    `Acknowledge:   ${ackUrl}`,
    `Snooze 7 days: ${snoozeUrl}`,
    `Mark renewed:  ${renewUrl}`,
    "",
    "Each link works once and expires in 30 days.",
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");

  return { subject, html: lines.join("\n"), text };
}
