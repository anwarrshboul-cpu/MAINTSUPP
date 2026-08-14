import { and, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { complianceDocuments } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import { readComplianceRegister, type RegisterEntry } from "../../../lib/compliance-register";
import {
  complianceDigestTemplate,
  notificationTargets,
  sendNotification,
} from "../../../lib/notifications";

export const dynamic = "force-dynamic";

/**
 * Warning thresholds in days. A document crossing one of these produces an
 * alert, and the stage it reached is recorded so the same warning is not sent
 * every day for three months.
 */
const STAGES = [90, 60, 30, 14, 7, 0] as const;

function stageFor(daysAway: number): string | null {
  if (daysAway < 0) return "overdue";
  for (const stage of STAGES) {
    if (daysAway <= stage) return String(stage);
  }
  return null;
}

function daysBetween(from: Date, iso: string) {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  target.setUTCHours(0, 0, 0, 0);
  return Math.round((target.getTime() - start.getTime()) / 86_400_000);
}

type Scanned = {
  id: string;
  site: string;
  kind: string;
  expiry: string;
  daysAway: number;
  stage: string;
  alreadyAlerted: boolean;
  /** Where the bookkeeping goes. See `recordStage`. */
  entry: RegisterEntry;
};

/**
 * What is expired or expiring, across the whole estate.
 *
 * WHAT WAS WRONG: this selected from `compliance_documents` joined to `sites`,
 * so its scan covered the 34 dates the sample seeder wrote against ten
 * fictional sites and none of the 42 the client's Store Documentation board
 * holds. Eleven certificates were lapsed on that board — Churchill Square -
 * Brighton's fire extinguisher, fire alarm, emergency lighting, sprinkler and
 * fire door (all 2026-06-24), the PLI at Mall of Netherlands (2024-02-18) and
 * Item 5 (2024-02-13), and the PAT certificates at Westfield White City
 * Bespoke, Highcross Leicester, Metrocentre - Gateshead and HQ — The Loom — and
 * not one of them could ever produce an alert, because none of those stores has
 * a row in `sites` or `compliance_documents` at all. The digest was loud about
 * fiction and silent about the estate.
 *
 * It now reads the same register the compliance screens read
 * (app/lib/compliance-register.ts), so an alert and a screen cannot disagree.
 */
async function scan(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
): Promise<Scanned[]> {
  const today = new Date();
  const { entries } = await readComplianceRegister(db, orgId, { today });
  const scanned: Scanned[] = [];

  // `row` rather than `entry`, because a register entry is a row of the
  // register whatever table it came out of, and the guard below is the one
  // Stage 7 pinned: a requirement marked "Not required" never alerts.
  for (const row of entries) {
    if (row.notRequired) continue;
    if (!row.expiry) continue;
    const daysAway = daysBetween(today, row.expiry);
    if (daysAway === null) continue;
    const stage = stageFor(daysAway);
    if (!stage) continue;

    scanned.push({
      id: row.id,
      site: row.siteName,
      kind: row.kind,
      expiry: row.expiry,
      daysAway,
      stage,
      alreadyAlerted: row.lastAlertStage === stage,
      entry: row,
    });
  }

  scanned.sort((left, right) => left.expiry.localeCompare(right.expiry));
  return scanned;
}

/**
 * Remember that this document has been warned about at this stage.
 *
 * `last_alert_stage` lives on `compliance_documents`, and most of the estate's
 * documents have no row there — they are board slots. So the first time a board
 * slot alerts, a row is created to hold the bookkeeping, keyed on the board item
 * and the slot (`board-sd-010-fire-alarm`) so it is stable across imports and
 * cannot collide with a hand-made record. It is INSERT-or-update-the-stage: no
 * existing row's site, requirement or expiry is ever overwritten, and the row it
 * writes is inert as far as the screens are concerned — `readComplianceRegister`
 * takes the expiry and the state from the board, and reads only `not_required`
 * back out of the register.
 */
async function recordStage(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  item: Scanned,
) {
  if (item.entry.registerId) {
    await db
      .update(complianceDocuments)
      .set({
        lastAlertAt: sql`CURRENT_TIMESTAMP`,
        lastAlertStage: item.stage,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(complianceDocuments.id, item.entry.registerId),
          eq(complianceDocuments.organisationId, orgId),
        ),
      );
    return;
  }

  const { itemId, slotKey } = item.entry;
  if (!itemId || !slotKey) return;
  await db
    .insert(complianceDocuments)
    .values({
      id: `board-${itemId}-${slotKey}`,
      organisationId: orgId,
      siteId: item.entry.siteId,
      kind: item.kind,
      status: item.entry.state,
      expiryDate: item.entry.expiry,
      attachmentId: null,
      notRequired: false,
      lastAlertAt: sql`CURRENT_TIMESTAMP`,
      lastAlertStage: item.stage,
    })
    .onConflictDoUpdate({
      target: complianceDocuments.id,
      set: {
        lastAlertAt: sql`CURRENT_TIMESTAMP`,
        lastAlertStage: item.stage,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
}

/**
 * The digest's own shape.
 *
 * `entry` is the whole register record — it carries the board item id, the slot
 * key and the backing `compliance_documents` id, which is what `recordStage`
 * needs and what nobody outside this module should see. Listing the fields that
 * DO go out, rather than spreading and deleting one, means a field added to
 * `RegisterEntry` later is not published by accident.
 */
function forDigest(item: Scanned) {
  return {
    id: item.id,
    site: item.site,
    kind: item.kind,
    expiry: item.expiry,
    daysAway: item.daysAway,
    stage: item.stage,
    alreadyAlerted: item.alreadyAlerted,
  };
}

/**
 * GET /api/notifications/compliance — what would be alerted, without sending.
 *
 * Useful on its own: it is the answer to "what is expired right now", which
 * nothing in the system could answer before.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    const scanned = await scan(db, orgId);

    return Response.json({
      expired: scanned
        .filter((item) => item.daysAway < 0)
        .map((item) => ({ ...forDigest(item), daysAgo: Math.abs(item.daysAway) })),
      expiring: scanned.filter((item) => item.daysAway >= 0).map(forDigest),
      thresholds: STAGES,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "The compliance scan is temporarily unavailable." },
      { status: 503 },
    );
  }
}

/**
 * POST /api/notifications/compliance — run the scan and send the digest.
 *
 * Intended for a Cloudflare Cron Trigger. Only documents that have crossed a
 * new threshold since the last run are alerted, so a document expiring in 90
 * days produces six emails over three months rather than ninety.
 *
 * The first run against the real board will report every lapsed certificate at
 * once, because none of them has ever been alerted on. That is the correct
 * behaviour and not a fault: it is the backlog the digest could not see.
 */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guard = await scopedDbWithCapability(request, "settings.edit");
    if (guard.denied) return guard.denied;
    const { db, orgId } = guard.scope;
    const url = new URL(request.url);
    const dryRun = url.searchParams.get("dryRun") === "true";

    const scanned = await scan(db, orgId);
    const fresh = scanned.filter((item) => !item.alreadyAlerted);

    if (fresh.length === 0) {
      return Response.json({ sent: false, reason: "Nothing has crossed a new threshold." });
    }

    const expired = fresh
      .filter((item) => item.daysAway < 0)
      .map((item) => ({ ...forDigest(item), daysAgo: Math.abs(item.daysAway) }));
    const expiring = fresh.filter((item) => item.daysAway >= 0).map(forDigest);

    if (dryRun) {
      return Response.json({ sent: false, dryRun: true, expired, expiring });
    }

    const template = complianceDigestTemplate({ expired, expiring });
    const { opsInbox } = notificationTargets();
    const result = await sendNotification(db, {
      organisationId: orgId,
      channel: "email",
      event: expired.length ? "compliance.expired" : "compliance.expiring",
      subjectType: "compliance",
      to: opsInbox,
      subject: template.subject,
      body: template.body,
    });

    // Record the stage reached only on success, so a failed send is retried
    // tomorrow rather than being silently marked as handled.
    if (result.ok) {
      for (const item of fresh) {
        await recordStage(db, orgId, item);
      }
    }

    return Response.json({
      sent: result.ok,
      status: result.status,
      error: result.error,
      expired: expired.length,
      expiring: expiring.length,
    });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json(
      { error: "The compliance alert is temporarily unavailable." },
      { status: 503 },
    );
  }
}
