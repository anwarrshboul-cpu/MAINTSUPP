import { ensureDatabase } from "../../../db/init";
import { contractorApplications } from "../../../db/schema";
import { scopedDb } from "../../lib/tenant-db";
import {
  notificationTargets,
  sendNotification,
} from "../../lib/notifications";

export const dynamic = "force-dynamic";

/**
 * An application from the public /contractors page.
 *
 * WHY THIS IS ITS OWN ROUTE, and how narrow it is.
 *
 * It is public by definition — a contractor applying for work has no account —
 * so it takes the same `allowAnonymous` exemption the lead form and the
 * website's Report-a-Job form take, and it is written to be worth exactly that
 * much trust and no more:
 *
 *   · it writes ONE table, `contractor_applications`, and nothing else;
 *   · the tenant is pinned by `scopedDb`, never read from the payload;
 *   · every field is read individually — an unknown key in the body is not
 *     copied anywhere, because nothing here spreads the request object;
 *   · `trades` is intersected with a fixed list, so the column cannot hold a
 *     value the form never offered;
 *   · `insured` and `yearsTrading` are matched against their own enumerations;
 *   · every string is length-capped;
 *   · consent must be present, and is stored rather than assumed.
 *
 * It grants no read access. There is no GET: an application register is
 * operator data and does not belong on a public route, and adding one "for
 * convenience" is how a public write endpoint turns into a public database.
 */

/** Exactly the eleven the form offers, in the order it offers them. */
const TRADES = [
  "Electrical & lighting",
  "Plumbing & leaks",
  "Doors, locks & shutters",
  "HVAC & air conditioning",
  "Glazing",
  "Signage",
  "Drainage",
  "General maintenance & handyman",
  "Fire & compliance",
  "CCTV & security",
  "Other",
] as const;

const YEARS = ["<1", "1–3", "3–5", "5+"] as const;

/*
 * Deliberately permissive, and deliberately not a full RFC 5322 parser: the
 * point is to catch "dave@" and "dave at example.com", not to adjudicate
 * exotic-but-legal addresses. Anything that gets past this is answered by
 * whether the reply arrives.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;

    const company = clean(payload.company, 160);
    const contactName = clean(payload.contactName, 120);
    const email = clean(payload.email, 160);
    const phone = clean(payload.phone, 40);
    const regions = clean(payload.regions, 240);
    const insured = clean(payload.insured, 8);
    const yearsTrading = clean(payload.yearsTrading, 8);
    const certifications = clean(payload.certifications, 240);
    const notes = clean(payload.notes, 2000);
    const consent = payload.consent === true || payload.consent === "true";

    /* Intersected with the offered list, not merely filtered for length — an
       arbitrary string must not reach the column. */
    const submitted = Array.isArray(payload.trades) ? payload.trades : [];
    const trades = TRADES.filter((trade) => submitted.includes(trade));

    if (!company || !contactName || !email || !phone || !regions) {
      return Response.json(
        { error: "Company, contact name, email, phone and regions covered are all required." },
        { status: 400 },
      );
    }
    if (!EMAIL.test(email)) {
      return Response.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (!trades.length) {
      return Response.json({ error: "Choose at least one trade." }, { status: 400 });
    }
    if (insured !== "Yes" && insured !== "No") {
      return Response.json(
        { error: "Tell us whether public liability insurance is in place." },
        { status: 400 },
      );
    }
    if (yearsTrading && !YEARS.includes(yearsTrading as (typeof YEARS)[number])) {
      return Response.json({ error: "Choose how long you have been trading." }, { status: 400 });
    }
    if (!consent) {
      return Response.json(
        { error: "Please confirm you are happy for us to hold these details." },
        { status: 400 },
      );
    }

    await ensureDatabase();
    // Public by definition — an applying contractor has no account.
    const { db, orgId } = await scopedDb(request, { allowAnonymous: true });

    const id = crypto.randomUUID();
    await db.insert(contractorApplications).values({
      id,
      organisationId: orgId,
      company,
      contactName,
      email,
      phone,
      trades: JSON.stringify(trades),
      regions,
      insured,
      yearsTrading: yearsTrading || null,
      certifications: certifications || null,
      notes: notes || null,
      consent,
      status: "New",
    });

    /*
     * Tell somebody. Delivery failure never fails the application: it is
     * already saved, and losing a contractor because a mail provider was down
     * would be worse than a missed alert. `sendNotification` records a skipped
     * send in `notification_log` when no provider key is configured, which is
     * the state this deployment is in — so the row is the record of record and
     * the notification can be replayed once a key exists.
     */
    const { salesInbox } = notificationTargets();
    const summary = [
      `Company: ${company}`,
      `Contact: ${contactName}`,
      `Email: ${email}`,
      `Phone: ${phone}`,
      `Trades: ${trades.join(", ")}`,
      `Regions: ${regions}`,
      `Public liability insurance: ${insured}`,
      yearsTrading ? `Years trading: ${yearsTrading}` : "",
      certifications ? `Certifications: ${certifications}` : "",
      notes ? `Notes: ${notes}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const delivered = await sendNotification(db, {
      organisationId: orgId,
      channel: "email",
      event: "contractor.application",
      subjectType: "contractor-application",
      subjectId: id,
      to: salesInbox,
      subject: `Contractor application — ${company}`,
      body: `<pre style="font:14px/1.5 ui-monospace,monospace">${summary
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}</pre>`,
    });

    return Response.json({ ok: true, id, notified: delivered.ok }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("contractor application failed", message);
    return Response.json(
      { error: "Your application could not be submitted. Please try again in a moment." },
      { status: 503 },
    );
  }
}
