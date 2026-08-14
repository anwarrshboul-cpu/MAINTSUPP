/**
 * Outbound email.
 *
 * Resend over plain `fetch` — no SDK. The whole contract is one POST, and an
 * SDK would add a dependency plus a version to keep current for the sake of
 * about fifteen lines.
 *
 * With no `RESEND_API_KEY` set, mail is written to the console instead of sent.
 * That is what makes local development work without an email provider, and it
 * prints the link, so an invitation or password reset can be completed by
 * copying it out of the terminal. It is deliberately loud: silent success when
 * nothing was sent is how "the email never arrived" becomes a week of guessing.
 */

export type Mail = {
  to: string;
  subject: string;
  /** Plain text. Every message here is short enough not to need HTML. */
  text: string;
};

const FROM = process.env.MAIL_FROM ?? "MAINTSUPP <noreply@maintsupp.com>";

export type MailResult = { delivered: boolean; reason?: string };

export async function sendMail(mail: Mail): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY?.trim();

  if (!key) {
    console.log(
      `\n[mail:not-configured] would send to ${mail.to}\n` +
        `  subject: ${mail.subject}\n` +
        mail.text
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n") +
        "\n",
    );
    return { delivered: false, reason: "RESEND_API_KEY is not set" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
      // Without this a hung provider holds the request open until the platform
      // kills it, and the user watches a spinner instead of getting an answer.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[mail] ${response.status} ${body.slice(0, 300)}`);
      return { delivered: false, reason: `provider returned ${response.status}` };
    }
    return { delivered: true };
  } catch (error) {
    console.error("[mail] send failed", (error as Error).message);
    return { delivered: false, reason: (error as Error).message };
  }
}

/**
 * Mail failure must never fail the action that triggered it.
 *
 * An invitation whose email bounces is still a valid invitation, and a job
 * whose notification fails is still a job. Rolling the write back because the
 * mail provider had a bad minute loses real work; the link is recoverable from
 * the Members page either way.
 */
export function sendMailBestEffort(mail: Mail): void {
  void sendMail(mail).catch((error) => {
    console.error("[mail] unexpected", error);
  });
}

export const templates = {
  verifyEmail: (link: string): Omit<Mail, "to"> => ({
    subject: "Confirm your MAINTSUPP email address",
    text: `Confirm your email address to finish creating your MAINTSUPP account:\n\n${link}\n\nThe link expires in 24 hours. If you did not create an account, ignore this message.`,
  }),

  invitation: (link: string, inviter: string, role: string): Omit<Mail, "to"> => ({
    subject: "You have been invited to MAINTSUPP",
    text: `${inviter} has invited you to MAINTSUPP as ${role}.\n\nSet your password and sign in:\n\n${link}\n\nThe invitation expires in 14 days.`,
  }),

  passwordReset: (link: string): Omit<Mail, "to"> => ({
    subject: "Reset your MAINTSUPP password",
    text: `Set a new password for your MAINTSUPP account:\n\n${link}\n\nThe link expires in one hour and can be used once. If you did not ask for this, ignore this message — your password has not changed.`,
  }),

  approved: (role: string): Omit<Mail, "to"> => ({
    subject: "Your MAINTSUPP account is active",
    text: `Your account has been approved as ${role}. You can sign in now.`,
  }),

  jobUpdatedViaShareLink: (
    reference: string,
    title: string,
    what: string,
    link: string,
  ): Omit<Mail, "to"> => ({
    subject: `${reference} — ${what}`,
    text: `${what} on ${reference} (${title}).\n\nOpen the job:\n\n${link}`,
  }),
};
