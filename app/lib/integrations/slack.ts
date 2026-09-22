/**
 * §35b — what a Slack incoming webhook is sent: one plain line of text per
 * event, built from the same allowlisted payload a webhook receives.
 *
 * Slack reads `<…>` as a link or a mention and `&` as the start of an entity,
 * and every word here after the event name came from somebody's typing (a job
 * title, a status label). So all three are escaped — a job titled
 * `<!channel>` pages nobody. The link back to the job is added only when the
 * deployment knows its public address (`PUBLIC_APP_ORIGIN`); a link to
 * `localhost` in a client's Slack would be worse than none.
 *
 * No relative imports: the tests load this file directly.
 */

export function slackEscape(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type Payload = {
  type?: string;
  data?: {
    job?: { id?: string; reference?: string; title?: string; priority?: string | null; location?: string | null };
    change?: { from?: string | null; to?: string | null };
  };
};

export function slackMessage(payload: Payload, origin: string | null) {
  const job = payload.data?.job;
  const reference = slackEscape(job?.reference ?? job?.id ?? "a job");
  const title = slackEscape(job?.title ?? "");
  const where = job?.location ? ` — ${slackEscape(job.location)}` : "";
  const priority = job?.priority ? ` (${slackEscape(job.priority)})` : "";
  let text: string;
  if (payload.type === "job.created") {
    text = `New job ${reference}: ${title}${where}${priority}`;
  } else if (payload.type === "job.status_changed") {
    const from = slackEscape(payload.data?.change?.from ?? "no status");
    const to = slackEscape(payload.data?.change?.to ?? "no status");
    text = `Job ${reference} (${title}) moved from ${from} to ${to}`;
  } else {
    text = "MAINTSUPP test message: this Slack connection works.";
  }
  if (origin && job?.id) text += `\n<${origin}/dashboard/jobs?item=${encodeURIComponent(job.id)}|Open in MAINTSUPP>`;
  return { text };
}
