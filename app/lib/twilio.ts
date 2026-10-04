/**
 * TEXT AND WHATSAPP, THROUGH TWILIO — switched on by environment variables.
 *
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   the account (both required)
 *   TWILIO_SMS_FROM                         a Twilio number, "+447…" — job texts
 *   TWILIO_VERIFY_SID                       a Verify service "VA…" — sign-in
 *                                           codes by SMS or WhatsApp, with
 *                                           Twilio's own approved templates
 *   TWILIO_WHATSAPP_FROM                    "+44…" WhatsApp sender — job alerts
 *   TWILIO_WHATSAPP_JOB_TEMPLATE            content template "HX…" for a job
 *                                           alert ({{1}} job, {{2}} place,
 *                                           {{3}} link). WhatsApp only lets a
 *                                           business START a conversation with
 *                                           an approved template.
 *
 * Nothing here throws: every function answers `{ ok, error }`, and with the
 * variables missing every function answers "not configured" so the product
 * carries on (the office can still send a WhatsApp themselves — see the
 * contractor app invite).
 */

type Result = { ok: true; id?: string } | { ok: false; error: string };

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function account() {
  const sid = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  return sid && token ? { sid, token } : null;
}

export function smsConfigured() {
  return Boolean(account() && env("TWILIO_SMS_FROM"));
}

export function verifyConfigured() {
  return Boolean(account() && env("TWILIO_VERIFY_SID"));
}

export function whatsappConfigured() {
  return Boolean(account() && env("TWILIO_WHATSAPP_FROM") && env("TWILIO_WHATSAPP_JOB_TEMPLATE"));
}

async function post(url: string, form: Record<string, string>): Promise<Result> {
  const credentials = account();
  if (!credentials) return { ok: false, error: "Twilio is not connected." };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${credentials.sid}:${credentials.token}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      message?: string;
      valid?: boolean;
    };
    if (!response.ok) return { ok: false, error: payload.message ?? `Twilio answered ${response.status}.` };
    return { ok: true, id: payload.sid ?? payload.status };
  } catch {
    return { ok: false, error: "Twilio could not be reached." };
  }
}

/** An international number for Twilio: "+44…". `digits` is E.164 without "+". */
const e164 = (digits: string) => `+${digits.replace(/\D/g, "")}`;

export async function sendSms(toDigits: string, body: string): Promise<Result> {
  const credentials = account();
  const from = env("TWILIO_SMS_FROM");
  if (!credentials || !from) return { ok: false, error: "Text messages are not connected." };
  return post(`https://api.twilio.com/2010-04-01/Accounts/${credentials.sid}/Messages.json`, {
    To: e164(toDigits),
    From: from,
    Body: body.slice(0, 600),
  });
}

export async function sendWhatsAppJob(
  toDigits: string,
  variables: { job: string; place: string; link: string },
): Promise<Result> {
  const credentials = account();
  const from = env("TWILIO_WHATSAPP_FROM");
  const template = env("TWILIO_WHATSAPP_JOB_TEMPLATE");
  if (!credentials || !from || !template) return { ok: false, error: "WhatsApp is not connected." };
  return post(`https://api.twilio.com/2010-04-01/Accounts/${credentials.sid}/Messages.json`, {
    To: `whatsapp:${e164(toDigits)}`,
    From: `whatsapp:${from.replace(/^whatsapp:/, "")}`,
    ContentSid: template,
    ContentVariables: JSON.stringify({ 1: variables.job, 2: variables.place, 3: variables.link }),
  });
}

/** Sends a sign-in code by SMS or WhatsApp through Twilio Verify. */
export async function startVerification(toDigits: string, channel: "sms" | "whatsapp"): Promise<Result> {
  const service = env("TWILIO_VERIFY_SID");
  if (!account() || !service) return { ok: false, error: "Codes by text are not connected." };
  return post(`https://verify.twilio.com/v2/Services/${service}/Verifications`, {
    To: e164(toDigits),
    Channel: channel,
  });
}

/** Checks a code Twilio Verify sent. */
export async function checkVerification(toDigits: string, code: string): Promise<boolean> {
  const service = env("TWILIO_VERIFY_SID");
  if (!account() || !service) return false;
  const result = await post(`https://verify.twilio.com/v2/Services/${service}/VerificationCheck`, {
    To: e164(toDigits),
    Code: code,
  });
  return result.ok && result.id === "approved";
}
