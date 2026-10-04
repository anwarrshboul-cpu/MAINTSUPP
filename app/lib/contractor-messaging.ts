/**
 * Messages to contractors: sign-in codes and "you have a new job".
 *
 * Every channel is optional and independent — email through the product's
 * own sender (app/lib/notifications.ts), text and WhatsApp through Twilio
 * (app/lib/twilio.ts), and the app alert through push (app/lib/push-notify.ts).
 * Whatever is connected is used; nothing here can fail the write that called it.
 */

import type { getDb } from "../../db";
import type { ContractorRow } from "./contractor-auth";
import { normaliseIdentity } from "./contractor-auth";
import { emailShell, sendNotification } from "./notifications";
import { sendSms, sendWhatsAppJob, smsConfigured, whatsappConfigured } from "./twilio";

type Database = Awaited<ReturnType<typeof getDb>>;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export async function sendLoginCodeEmail(db: Database, contractor: ContractorRow, to: string, code: string) {
  return sendNotification(db, {
    organisationId: contractor.organisationId,
    channel: "email",
    event: "contractor.login_code",
    subjectType: "system",
    subjectId: contractor.id,
    to,
    subject: `${code} is your MAINTSUPP sign-in code`,
    body: emailShell(
      "Your sign-in code",
      `<p style="font-size:14px;line-height:1.55">Enter this code in the MAINTSUPP app to see your jobs. It works for 10 minutes.</p>
       <p style="font-size:32px;font-weight:800;letter-spacing:6px;margin:18px 0">${code}</p>
       <p style="font-size:12px;color:#667">If you didn't ask for this, you can ignore it.</p>`,
    ),
    text: `Your MAINTSUPP sign-in code is ${code}. It works for 10 minutes.`,
  }).catch(() => null);
}

/** Digits for Twilio from whatever is on the record (WhatsApp number first). */
function mobileDigits(contractor: ContractorRow, prefer: "whatsapp" | "phone") {
  const order = prefer === "whatsapp" ? [contractor.whatsappNumber, contractor.phone] : [contractor.phone, contractor.whatsappNumber];
  for (const value of order) {
    const identity = normaliseIdentity(value);
    if (identity?.startsWith("tel:")) return identity.slice(4);
  }
  return null;
}

/**
 * "You have a new job" — email, text and WhatsApp, each when it is connected
 * and the contractor's record has somewhere to send it. The app alert is sent
 * separately by push-notify, which also covers phones already signed in.
 */
export async function tellContractorAboutJob(
  db: Database,
  contractor: ContractorRow,
  job: { id: string; location: string; description: string },
  appUrl: string,
) {
  const place = job.location || "a site";
  const summary = job.description.replace(/\s+/g, " ").trim().slice(0, 140);

  const email = normaliseIdentity(contractor.email);
  if (email?.startsWith("email:")) {
    await sendNotification(db, {
      organisationId: contractor.organisationId,
      channel: "email",
      event: "contractor.job_assigned",
      subjectType: "job",
      subjectId: job.id,
      to: email.slice(6),
      subject: `New job ${job.id} · ${place}`,
      body: emailShell(
        `New job ${escapeHtml(job.id)}`,
        `<p style="font-size:14px;line-height:1.55"><strong>${escapeHtml(place)}</strong></p>
         <p style="font-size:14px;line-height:1.55">${escapeHtml(summary)}</p>
         <p><a href="${appUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#12b4a8;color:#04211f;font-weight:700;text-decoration:none">Open my jobs</a></p>`,
      ),
      text: `New job ${job.id} at ${place}: ${summary}\nOpen your jobs: ${appUrl}`,
    }).catch(() => null);
  }

  if (whatsappConfigured()) {
    const digits = mobileDigits(contractor, "whatsapp");
    if (digits) {
      const sent = await sendWhatsAppJob(digits, { job: job.id, place, link: appUrl });
      if (sent.ok) return;
    }
  }
  if (smsConfigured()) {
    const digits = mobileDigits(contractor, "phone");
    if (digits) await sendSms(digits, `MAINTSUPP: new job ${job.id} at ${place}. ${summary.slice(0, 80)} Open: ${appUrl}`);
  }
}
