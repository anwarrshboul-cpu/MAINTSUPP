import { and, eq, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import { complianceDocuments } from "../../../../db/schema";
import { anonymousRefusal, scopedDb, scopedDbWithCapability } from "../../../lib/tenant-db";
import {
  readComplianceRegister,
  storeDocumentationBoards,
  withinOperationalEstate,
  type RegisterEntry,
} from "../../../lib/compliance-register";
import { expiryStatus } from "../../../lib/expiry-status";
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

/**
 * Which reminder a document has earned, or null when it is too far out to nag.
 *
 * THIS IS A CADENCE, NOT A STATUS. It answers "have we said anything about this
 * yet, and at what distance", which is a different question from
 * `expiryStatus`'s "is this certificate in date" — that one has a single amber
 * boundary at `EXPIRY_DUE_SOON_DAYS` (60) and it must not be confused with these
 * six. The 90/60/30/14/7/0 ladder is also the promise the marketing site makes
 * in as many words (app/(marketing)/_sections/content.ts:133,265), so it stays.
 *
 * Note for anyone rendering this: the `expiring` bucket below is `daysAway >= 0`
 * — every future date that has reached a stage — so "expiring" here means "has
 * crossed a reminder threshold", NOT the "Expiring soon" state the register
 * speaks. Do not label it with that phrase in the UI.
 */
function stageFor(daysAway: number): string | null {
  if (daysAway < 0) return "overdue";
  for (const stage of STAGES) {
    if (daysAway <= stage) return String(stage);
  }
  return null;
}

type Scanned = {
  id: string;
  site: string;
  kind: string;
  expiry: string;
  daysAway: number;
  stage: string;
  alreadyAlerted: boolean;
  /** The register this certificate is on — its board key. */
  board: string | null;
  /** That register's display name, which is what a reader can act on. */
  boardName: string | null;
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
 *
 * EVERY STORE DOCUMENTATION REGISTER, NOT THE CANONICAL BOARD ALONE.
 *
 * WHAT WAS WRONG THE SECOND TIME. A workspace section created from the Store
 * Documentation template provisions its OWN board, with a generated key
 * (`sec-<12hex>`) and the same 24 columns, four groups and twelve certificate
 * slots the canonical board has — seeded by the same `seedStoreDocumentationBoard`.
 * This scan asked `readComplianceRegister` for its default, which is the
 * canonical board and nothing else. So an instance would collect real
 * certificates, show them on its own Compliance Tracker with a real RAG state,
 * and never produce a single alert for any of them, for ever, silently. That is
 * the same shape of failure as the one described above — a digest that is loud
 * about one estate and silent about another — arriving through a board key
 * rather than through the wrong table, and it is WORSE than the original,
 * because the screen says the certificate is being watched.
 *
 * `storeDocumentationBoards` answers from `boards.kind`, never from a key
 * comparison, so a section instance is covered the moment it is created and
 * nothing here has to learn about it. What canonical users receive is unchanged:
 * the canonical board is always in the set and always scanned first.
 */
async function scan(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
): Promise<Scanned[]> {
  const today = new Date();
  const registers = await storeDocumentationBoards(db, orgId);
  const boardNameByKey = new Map(registers.map((board) => [board.key, board.name]));
  const { entries } = await readComplianceRegister(db, orgId, {
    today,
    boardIds: registers.map((board) => board.key),
  });
  const scanned: Scanned[] = [];

  // `row` rather than `entry`, because a register entry is a row of the
  // register whatever table it came out of, and the guard below is the one
  // Stage 7 pinned: a requirement marked "Not required" never alerts.
  for (const row of entries) {
    if (row.notRequired) continue;
    /*
     * ESTATE SCOPE. Europe and placeholder rows never alert, and a closed store
     * stays fully readable everywhere while generating no CURRENT operational
     * alert. The predicate lives with the register
     * (`withinOperationalEstate`) so there is one definition of the active UK
     * estate; it is applied HERE and not inside `readComplianceRegister`,
     * because the screens must keep showing the whole board.
     */
    if (!withinOperationalEstate(row)) continue;
    if (!row.expiry) continue;
    /*
     * ONE DATE PARSER FOR THE PLATFORM.
     *
     * This file used to own a private `daysBetween` built on `new Date(iso)`,
     * which is not the shape rule `dateOnlyValue` enforces everywhere else. Two
     * consequences, both real: a value this parser rejected was `continue`d and
     * so never alerted AGAIN, silently, for the life of the row — while the same
     * value still rendered on a screen through the register's own parser; and a
     * date-only string went through `new Date`, which anchors it to UTC
     * midnight, so the two could disagree by a day about when a certificate
     * lapsed. `expiryStatus` is the classifier the register, the board cells and
     * the Compliance Tracker all read, and its `daysRemaining` is counted in
     * whole UTC days from the same instant for every row in the scan.
     */
    const daysAway = expiryStatus(row.expiry, today).daysRemaining;
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
      board: row.boardId,
      /*
       * The board's NAME, not its key. `sec-9f2c1a4b7e60` is an address; the
       * person reading the digest at 07:00 knows the register as "Concession
       * documents", which is the word in the sidebar they have to click. A
       * register-only row has no board and gets null rather than a guess.
       */
      boardName: row.boardId ? (boardNameByKey.get(row.boardId) ?? row.boardId) : null,
      entry: row,
    });
  }

  /*
   * Soonest-lapsed first, ACROSS registers rather than register by register.
   *
   * A digest grouped by board would bury a certificate that expired eight
   * months ago under a second register's near-misses. Urgency is the only
   * ordering an operations team reads down; the board NAME on each row is what
   * says where to go, and it does not have to be the sort key to do that. The
   * board key breaks ties so the order is deterministic when two certificates
   * share an expiry date — an unstable digest reads as new news every morning.
   */
  scanned.sort(
    (left, right) =>
      left.expiry.localeCompare(right.expiry) ||
      (left.board ?? "").localeCompare(right.board ?? "") ||
      left.site.localeCompare(right.site, "en-GB") ||
      left.kind.localeCompare(right.kind, "en-GB"),
  );
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

  /*
   * A BOARD ROW WITH NO LINKED SITE GETS NO BOOKKEEPING ROW.
   *
   * `RegisterEntry.siteId` falls back to the BOARD ITEM ID when no site matches
   * by name (app/lib/compliance-register.ts — `siteId: linkedSiteId ?? store.id`),
   * and that is correct there: the register refuses to fuzzy-match, so an
   * unlinked row keeps its own identity rather than being attached to the wrong
   * store. What was NOT correct was writing that value into
   * `compliance_documents.site_id`, a NOT NULL column whose whole meaning is "a
   * site" — minting a row that claims `MN-1066` is a site.
   *
   * Nothing in the database stops it. There is no foreign key on
   * `compliance_documents.site_id`, by the deferred-FK convention this schema
   * uses, so the insert succeeds and the bad reference is permanent. On Staging
   * this is live, not hypothetical: both Store Documentation rows are titled
   * "New store", no site, monday name or alias matches that, so all 24 of their
   * register entries carry a board item id as their `siteId`.
   *
   * Skipping the write costs one thing and it is the honest cost: an unlinked
   * board row will be re-reported on every run instead of once, because there is
   * nowhere to record that we have mentioned it. That is the right way round. A
   * repeated alert about a real lapsed certificate is noise someone can fix by
   * linking the store; a fabricated site reference is data corruption nobody
   * will notice until something joins on it.
   */
  if (item.entry.siteId === itemId) return;

  await db
    .insert(complianceDocuments)
    .values({
      id: `board-${itemId}-${slotKey}`,
      organisationId: orgId,
      siteId: item.entry.siteId,
      kind: item.kind,
      /*
       * "Missing" is the column DEFAULT, and this row is bookkeeping — it exists
       * to hold `last_alert_stage` and nothing else.
       *
       * It used to write `item.entry.state`, which stamped a derived verdict into
       * a stored column as of the moment an email went out. That is precisely the
       * stale stored status the register was rebuilt to stop depending on, and
       * writing one here re-seeded it from the one place guaranteed to run
       * unattended. `readComplianceRegister` takes the state from the board and
       * reads only `not_required` back out of this table, so the value here is
       * inert — which is exactly why it must not pretend to be an answer.
       */
      status: "Missing",
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
    /*
     * WHICH register. Both spellings, and both are load-bearing: `board` is the
     * key a caller can put straight into `/api/board?board=` to go and look at
     * the row, `boardName` is what a person recognises. Publishing only the
     * name would make the GET useless to a script; publishing only the key
     * would make the email useless to a person.
     */
    board: item.board,
    boardName: item.boardName,
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
