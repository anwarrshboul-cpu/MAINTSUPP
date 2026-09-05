/**
 * WRITING THE SEED DATASET INTO THE DATABASE — and taking it out again.
 *
 * ── AN ARCHITECTURAL DEVIATION FROM MODULE 3, ON THE OWNER'S INSTRUCTION ───
 *
 * Module 3 §1/§1.1 asks for a second Cloudflare D1 database and a second R2
 * bucket so seeded rows physically cannot reach real ones. This build does NOT
 * do that, on the owner's explicit instruction: "use the CURRENT architecture,
 * do not introduce D1/R2". The reasoning is written out at length in the
 * headers of `./dataset.ts` and `./guards.ts` and is not repeated here; what
 * matters at this file is the consequence. THIS MODULE IS THE ONLY CODE IN THE
 * PRODUCT THAT WRITES DEMO ROWS INTO THE SAME DATABASE AS THE CLIENT'S 744 REAL
 * JOBS AND 31 REAL STORES, so every layer that replaces the missing physical
 * boundary has to be true HERE or it is true nowhere:
 *
 *   (a) every row is written into the DEMO organisation, never the primary one.
 *       `SEED_ORGANISATION_ID` is a constant, not an argument, and no caller
 *       can point this at another tenant;
 *   (b) every row carries `is_seed = 1` and the batch id;
 *   (c) every id begins `zzdemo-`, which is the third net — it finds a row in a
 *       table whose seed columns somebody forgot to add;
 *   (d) every store name begins `ZZ-DEMO — ` and every address is
 *       `@example.com`, both by construction in `./dataset.ts`;
 *   (e) a delete — which is the first half of every seed run, not only of a
 *       purge — passes BOTH production guards in `./guards.ts` first.
 *
 * ── WHY A SEED RUN DELETES BEFORE IT WRITES, AND WHY THAT IS GUARDED ───────
 *
 * §7 asks that `npm run seed` produce byte-identical data on two consecutive
 * runs. An insert-only loader cannot: the second run either duplicates
 * everything or fails on a primary key. So a seed run begins with the same
 * delete a purge performs, which means A SEED RUN IS AS DANGEROUS AS A PURGE
 * and is gated by the same two checks. Treating "seed" as the harmless verb and
 * "purge" as the dangerous one is exactly the mistake that would let somebody
 * seed a production database.
 *
 * The delete removes EVERY seeded row rather than only this batch's. A run on a
 * different `today` mints a different batch id, so batch-scoped deletion would
 * quietly accumulate a second estate every time somebody used `seed:travel`.
 *
 * ── EMAIL_MODE IS CHECKED HERE, STRICTLY ──────────────────────────────────
 *
 * `assertEmailModeSafe` refuses an unset mode outright, which is §2.1's letter.
 * `emailMode()` in `app/lib/notifications.ts` deliberately does not — it
 * defaults to `sink`, because it sits on the path that saves a lead and must
 * never throw. Both are right for where they are. This is the seed entry point:
 * it has no lead to lose, seeded certificates generate a reminder cascade, and
 * stopping is free. See the long note in `./guards.ts`.
 *
 * ── THE CASCADE COMES FROM THE PRODUCT'S OWN ENGINE ───────────────────────
 *
 * `cascadeFromDefaults` in `app/lib/reminders/cascade.ts` builds the reminder
 * rows, from `reminder_defaults` rows read out of the database. Nothing here
 * re-implements the ladder. A seeded cascade computed by a second copy of the
 * arithmetic would prove that the copy works and say nothing at all about the
 * product — and the reminder counts are one of the numbers §4.1 reconciles.
 */

import { and, eq, like, or, sql } from "drizzle-orm";
import {
  attachments,
  calendarEvents,
  complianceDocuments,
  contractors,
  maintenanceGroupItems,
  maintenanceGroups,
  maintenanceRequests,
  reminderDispatch,
  reminderRecipients,
  reminderRules,
  reminderTokens,
  sites,
  users,
} from "../../../db/schema";
import { chunkRows } from "../sql-batching";
import { DEMO_ORGANISATION_ID } from "../tenant-access";
import {
  cascadeFromDefaults,
  type CascadeRow,
  type ReminderDefaultRow,
} from "../reminders/cascade";
import { listDefaults } from "../reminders/repository";
import {
  SEED_ID_PREFIX,
  addDays,
  daysBetween,
  type IsoDate,
  type SeedAttachment,
  type SeedCertificate,
  type SeedDataset,
  type SeedJob,
} from "./dataset";
import { assertEmailModeSafe, assertPurgeAllowed, type PurgeEnvironment } from "./guards";

/* eslint-disable @typescript-eslint/no-explicit-any -- the drizzle handle is
   assembled per-driver and importing its type here would drag the D1 binding
   into a module the tests load on its own. Every statement below is shaped by
   the schema imports, which is where the real type safety lives. */
type Db = any;

/**
 * THE ONE ORGANISATION SEEDED DATA MAY LIVE IN.
 *
 * A constant and not a parameter. The demo organisation exists already
 * (`ensureDemoClientOrganisation` in `db/init.ts` creates it, and `db/init.ts`
 * seeds its `job_status_map` and `reminder_defaults` alongside every other
 * active organisation), it holds no operational data of its own, and every
 * query in the product is organisation-scoped — so a seeded row in it cannot
 * reach a client-facing screen even if a `WHERE is_seed = 0` were forgotten.
 * Making this an argument would turn the strongest layer of the isolation into
 * something a caller could get wrong.
 */
export const SEED_ORGANISATION_ID = DEMO_ORGANISATION_ID;

/**
 * `client_id` on the legacy-scoped tables.
 *
 * Those columns default to `sunnamusk-uk`, which is the REAL client. Letting a
 * seeded row take that default would file demo data under the client's own
 * legacy key — invisible in every organisation-scoped query and waiting for the
 * first report that reads `client_id`. A value nothing else uses instead.
 */
export const SEED_LEGACY_CLIENT_ID = "zzdemo-seed";

/** The board seeded jobs are placed on, so they render rather than vanish. */
const SEED_BOARD_ID = "maintenance";

/** The zone the product schedules reminders in. `db/init.ts` seeds 08:00 here. */
const SEED_TIMEZONE = "Europe/London";

/* ------------------------------------------------------------- the report -- */

export type SeedTableCount = {
  readonly table: string;
  readonly rows: number;
};

export type SeedLoadReport = {
  readonly ok: true;
  readonly seedBatchId: string;
  readonly today: IsoDate;
  readonly organisationId: string;
  readonly emailMode: string;
  readonly deleted: readonly SeedTableCount[];
  readonly inserted: readonly SeedTableCount[];
  readonly storage: {
    readonly available: boolean;
    readonly objectsWritten: number;
    readonly note: string;
  };
  readonly warnings: readonly string[];
};

export type SeedRefusal = {
  readonly ok: false;
  /** Which gate said no, so an operator is not left guessing between two. */
  readonly refusedBy: "email-mode" | "production-guard";
  readonly reason: string;
  readonly checks?: readonly { name: string; passed: boolean; observed: string; reason: string }[];
};

export type PurgeReport = {
  readonly ok: true;
  readonly organisationId: string;
  readonly deleted: readonly SeedTableCount[];
  readonly totalRows: number;
  readonly storage: { readonly objectsDeleted: number; readonly note: string };
};

/* ----------------------------------------------------- environment reading -- */

/**
 * The variables the two guards read, from BOTH places this product keeps them.
 *
 * `globalThis.process.env` is where every deployed target holds configuration —
 * Vercel and Railway both run the Node shim, and `authoriseCron`,
 * `providerConfig()` and `environmentValue()` all read it directly. It is also
 * EMPTY on the local Miniflare dev server: `nodejs_compat` without a recent
 * compatibility date does not project a Worker's text bindings onto
 * `process.env`, so `.dev.vars` reaches `env` and nothing else. Measured, not
 * assumed — a local `/api/admin/seed` read `EMAIL_MODE` as unset with
 * `EMAIL_MODE="log"` sitting in `.dev.vars`.
 *
 * Reading only `process.env` would therefore make the whole module refuse
 * locally for a reason that is an artefact of the dev runtime, and the fix
 * somebody would reach for is an override that also covers the real case. So
 * the Worker's own bindings are read as a fallback.
 *
 * NAMED KEYS ONLY, and that restriction is load-bearing. `env` in
 * `db/node-workers-env.ts` exposes `DB` and `BUCKET` as GETTERS that open the
 * database and the bucket on first touch; enumerating the object would connect
 * to Postgres as a side effect of asking what environment this is.
 */
const GUARD_VARIABLES = [
  "EMAIL_MODE",
  "ENVIRONMENT",
  "VERCEL_ENV",
  "NODE_ENV",
  "PG_D1_URL",
  "DATABASE_URL",
  "D1_SQLITE_PATH",
] as const;

export async function platformVars(): Promise<Record<string, string | undefined>> {
  const holder = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const fromProcess = holder?.env ?? {};

  let fromBindings: Record<string, string | undefined> = {};
  try {
    /* Suppressed rather than added to the project's tsc count, the way
       `hasBinding` in app/api/account/platform/route.ts does it: this is a
       Workers runtime module with no local type declarations. */
    // @ts-expect-error — Workers runtime module, resolved at run time only.
    const { env } = await import("cloudflare:workers");
    const bag = env as unknown as Record<string, unknown>;
    for (const key of GUARD_VARIABLES) {
      const value = bag[key];
      if (typeof value === "string") fromBindings[key] = value;
    }
  } catch {
    /* No Workers runtime module — a plain Node process. `process.env` is the
       whole answer there, which is the deployed case. */
    fromBindings = {};
  }

  /* `process.env` wins: a real process environment is what an operator set on
     the deployment, and a binding is what the local dev file happens to say. */
  return { ...fromBindings, ...fromProcess };
}

/**
 * WHAT THE DATABASE SAYS ABOUT ITSELF, ASKED RATHER THAN ASSUMED.
 *
 * `checkDatabase` in `./guards.ts` is explicit that it wants a value that came
 * back over the connection and not one copied out of a settings screen, so this
 * asks. `current_database()` exists on Postgres and does not exist on SQLite,
 * which makes the query itself the adapter test: if it answers, this is the
 * deployed Postgres; if it throws, this is Miniflare's local file and the
 * adapter alone is what the guard reads.
 */
export async function askDatabaseIdentity(db: Db): Promise<{
  name?: string | null;
  host?: string | null;
  schema?: string | null;
  adapter?: "d1-sqlite" | "postgres" | null;
}> {
  const vars = await platformVars();
  try {
    const answer = await db.get(
      sql`SELECT current_database() AS name, current_schema() AS schema`,
    );
    const row = (answer ?? {}) as { name?: string; schema?: string };
    let host: string | null = null;
    try {
      const url = vars.PG_D1_URL ?? vars.DATABASE_URL;
      if (url) host = new URL(url).hostname;
    } catch {
      /* An unparseable URL names nothing; the guard then reads name and schema
         alone and refuses if neither carries a marker, which is correct. */
      host = null;
    }
    return {
      name: row.name ?? null,
      host,
      schema: row.schema ?? null,
      adapter: "postgres",
    };
  } catch {
    return {
      /* Miniflare's binding name, or the sqlite file the Node shim opened. */
      name: vars.D1_SQLITE_PATH ?? "DB",
      host: null,
      schema: null,
      adapter: "d1-sqlite",
    };
  }
}

/** The two halves `assertPurgeAllowed` reads, kept disjoint as it requires. */
export async function purgeEnvironment(db: Db): Promise<PurgeEnvironment> {
  return { vars: await platformVars(), database: await askDatabaseIdentity(db) };
}

/* --------------------------------------------------------- row projection -- */

/**
 * The stage a seeded job sits in on the board.
 *
 * `stage` is the board's own grouping column and is NOT the status: the four
 * groups `db/init.ts` seeds are Incoming, Booked, Attention and Completed,
 * while `status` carries the twelve monday labels. Mapping one onto the other
 * is what puts a seeded job in a group a person recognises instead of in a
 * group named after a status.
 */
function stageForStatus(status: string): string {
  if (status === "Completed" || status === "Cancelled") return "Completed";
  if (status === "Scheduled" || status === "Booked") return "Booked";
  return "Incoming";
}

/**
 * `users.role`, from the dataset's four-way split onto this product's three.
 *
 * §3.2 asks for 2 admins, 4 staff/engineers and 2 client users. This product's
 * role vocabulary is `super_admin | admin | client` and has no engineer, so the
 * engineers land on `client` — the LEAST privileged mapping available, chosen
 * deliberately. No seeded user is given a membership row or a password, so none
 * of them can sign in at all and the role is a label rather than a grant; when
 * a label has to be wrong in one direction, it should be wrong downwards.
 */
function roleForSeedUser(role: string): string {
  return role === "admin" ? "admin" : "client";
}

/**
 * The compliance register's own status word for a certificate.
 *
 * Derived from the row rather than from the date, because a superseded
 * certificate 120 days past its expiry is history and not an outstanding
 * failure — the same distinction `certificateBand` draws in `./expected.ts`.
 */
function complianceStatusFor(certificate: SeedCertificate, today: IsoDate): string {
  if (certificate.renewalStatus === "superseded") return "Superseded";
  if (certificate.expiryDate === null) return "Received";
  return daysBetween(today, certificate.expiryDate) < 0 ? "Expired" : "Valid";
}

/** `YYYY-MM-DD` as a timestamp, so a text date column and a text timestamp
    column never hold two different shapes of the same day. */
function atNine(date: IsoDate): string {
  return `${date}T09:00:00.000Z`;
}

/* ------------------------------------------------------------ file bytes -- */

/**
 * Deterministic bytes for one attachment fixture.
 *
 * A PDF fixture is a REAL one-page document: the structure below opens in a
 * viewer, and the padding that brings it up to the descriptor's byte length is
 * a PDF comment, which is legal anywhere outside a stream. That matters because
 * the evidence viewer and the certificate download are two of the paths §6 asks
 * a human to walk, and a file that will not open tests neither.
 *
 * AN IMAGE FIXTURE IS FILLER AND WILL NOT DECODE. It has the right name, type,
 * size and download path, and it will render as a broken image. Generating a
 * real photograph needs a real photograph — a binary this repository would then
 * be shipping, in a repository that is public — and the alternative of writing
 * a valid encoder here would be several hundred lines to make a grey square.
 * The limitation is recorded rather than hidden: an image fixture exercises the
 * upload, the row, the count and the byte size, and not the decoder.
 */
export function seedFileBytes(descriptor: SeedAttachment): Uint8Array {
  const size = Math.max(64, descriptor.byteLength);
  if (descriptor.mimeType === "application/pdf") {
    const body =
      "%PDF-1.4\n" +
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n" +
      "trailer<</Root 1 0 R>>\n";
    const tail = "\n%%EOF\n";
    /*
     * The structure, plus the one `%` that opens the padding comment, is the
     * smallest a valid document can be. A descriptor asking for less than that
     * gets the minimum rather than a truncated file — `byteLength` in
     * `./dataset.ts` starts at 8 KiB, so the floor is never reached in practice
     * and exists so this cannot be made to emit a broken PDF. Every character
     * here is ASCII, so a character is a byte and the length is exact.
     */
    const minimum = body.length + tail.length + 1;
    const target = Math.max(size, minimum);
    /* One comment line of `#` — deterministic, ignorable by every reader. */
    const comment = `%${"#".repeat(target - minimum)}`;
    return new TextEncoder().encode(`${body}${comment}${tail}`);
  }

  /*
   * Filler, from the descriptor's own `contentSeed` so two runs write the same
   * bytes. A cheap linear congruential step rather than a hash: nothing here is
   * a secret, and the only property required is reproducibility.
   */
  const bytes = new Uint8Array(size);
  let state = (descriptor.contentSeed >>> 0) || 1;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    bytes[index] = (state >>> 16) & 0xff;
  }
  return bytes;
}

/** Where a seeded object lives in the bucket. Prefixed so a listing shows it. */
export function seedObjectKey(batchId: string, descriptor: SeedAttachment): string {
  return `${SEED_ORGANISATION_ID}/seed/${batchId}/${descriptor.id}-${descriptor.filename}`;
}

/* ------------------------------------------------------------ the writing -- */

async function insertRows(db: Db, table: unknown, rows: readonly unknown[], width: number) {
  for (const chunk of chunkRows(rows, width)) {
    await db.insert(table as never).values(chunk as never);
  }
  return rows.length;
}

/**
 * Stamp `is_seed` and `seed_batch_id` on the tables drizzle does not model them
 * on.
 *
 * `db/init.ts` adds both columns to `sites`, `contractors`, `users` and
 * `attachments`, and `BOOLEAN_COLUMNS` in `db/sqlite-to-postgres.ts` lists
 * `is_seed` for all four — but `db/schema.ts` declares them only on
 * `maintenance_requests`, `compliance_documents` and `calendar_events`, and
 * this workstream does not own `db/schema.ts`. So the four are written by a
 * statement rather than by the query builder.
 *
 * THE FLAG IS BOUND, NEVER WRITTEN AS A LITERAL. `db/sqlite-to-postgres.ts`
 * rewrites boolean literals inside `INSERT … VALUES` and does NOT rewrite them
 * inside `UPDATE … SET`; a literal `is_seed = 1` would therefore work locally
 * and answer "column is_seed is of type boolean but expression is of type
 * integer" deployed. A BOUND parameter is typed by the column it is assigned
 * to, which is the documented mechanism the whole shim rests on.
 */
async function stampSeedColumns(
  db: Db,
  table: "sites" | "contractors" | "users" | "attachments",
  ids: readonly string[],
  batchId: string,
): Promise<void> {
  if (ids.length === 0) return;
  const target = sql.raw(table);
  for (const chunk of chunkRows(ids, 1)) {
    await db.run(
      sql`UPDATE ${target} SET is_seed = ${1}, seed_batch_id = ${batchId}
          WHERE id IN (${sql.join(chunk.map((id) => sql`${id}`), sql`, `)})`,
    );
  }
}

/**
 * Delete every seeded row, in dependency order, and count what went.
 *
 * The predicate is `is_seed = 1 OR id LIKE 'zzdemo-%'` wherever both are
 * available: the flag is the contract and the prefix is the net that catches a
 * row whose flag was never set — an insert that failed halfway, or a table
 * somebody added the columns to later. A purge that removed only the rows it
 * could prove were seeded would leave exactly the rows a purge exists for.
 *
 * ORDER MATTERS AND IS NOT COSMETIC. `maintenance_group_items` carries a
 * foreign key to `maintenance_requests`, and `compliance_documents.attachment_id`
 * references `attachments`, so children go first. On SQLite with foreign keys
 * off the wrong order is silent; on Postgres it is a constraint violation, and
 * a purge that half-runs is worse than one that refuses.
 */
async function deleteSeedRows(db: Db): Promise<SeedTableCount[]> {
  const prefix = `${SEED_ID_PREFIX}%`;
  const deleted: SeedTableCount[] = [];
  /*
   * Both spellings, because the row count is reported by two layers.
   *
   * `meta.changes` is a real count on both adapters — `db/node-d1.ts` and
   * `db/node-pg-d1.ts` each say so in as many words — and drizzle surfaces it as
   * `rowsAffected` on some driver versions. A shape neither name fits reports
   * ZERO rows for a delete that ran, which is a misleading report and not a
   * failed purge: the statement has already executed by the time this reads it.
   */
  const record = async (table: string, run: () => Promise<unknown>) => {
    const result = (await run()) as { rowsAffected?: number; meta?: { changes?: number } };
    const rows = Number(result?.rowsAffected ?? result?.meta?.changes ?? 0);
    deleted.push({ table, rows: Number.isFinite(rows) ? rows : 0 });
  };

  /* Reminder rows first: they hang off certificates by `subject_id` and have no
     seed columns of their own, so the id prefix is the only handle. */
  await record("reminder_tokens", () =>
    db.delete(reminderTokens).where(like(reminderTokens.reminderId, prefix)),
  );
  await record("reminder_dispatch", () =>
    db.delete(reminderDispatch).where(like(reminderDispatch.reminderId, prefix)),
  );
  await record("reminder_recipients", () =>
    db.delete(reminderRecipients).where(like(reminderRecipients.reminderId, prefix)),
  );
  await record("reminder_rules", () =>
    db
      .delete(reminderRules)
      .where(or(like(reminderRules.id, prefix), like(reminderRules.subjectId, prefix))),
  );

  await record("maintenance_group_items", () =>
    db.delete(maintenanceGroupItems).where(like(maintenanceGroupItems.requestId, prefix)),
  );
  await record("compliance_documents", () =>
    db
      .delete(complianceDocuments)
      .where(
        or(eq(complianceDocuments.isSeed, true), like(complianceDocuments.id, prefix)),
      ),
  );
  await record("calendar_events", () =>
    db
      .delete(calendarEvents)
      .where(or(eq(calendarEvents.isSeed, true), like(calendarEvents.id, prefix))),
  );
  await record("attachments", () =>
    db.delete(attachments).where(or(sql`is_seed = ${1}`, like(attachments.id, prefix))),
  );
  await record("maintenance_requests", () =>
    db
      .delete(maintenanceRequests)
      .where(
        or(eq(maintenanceRequests.isSeed, true), like(maintenanceRequests.id, prefix)),
      ),
  );
  await record("sites", () =>
    db.delete(sites).where(or(sql`is_seed = ${1}`, like(sites.id, prefix))),
  );
  await record("contractors", () =>
    db.delete(contractors).where(or(sql`is_seed = ${1}`, like(contractors.id, prefix))),
  );
  await record("users", () =>
    db.delete(users).where(or(sql`is_seed = ${1}`, like(users.id, prefix))),
  );

  return deleted;
}

/** The bucket binding, or null when this deployment has no object storage. */
async function bucketOrNull(): Promise<{
  put: (key: string, body: ArrayBuffer | Uint8Array, options?: unknown) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
  list: (options?: unknown) => Promise<{ objects?: Array<{ key: string }> }>;
} | null> {
  try {
    // @ts-expect-error — Workers runtime module, resolved at run time only.
    const { env } = await import("cloudflare:workers");
    const runtime = env as unknown as { BUCKET?: unknown };
    return (runtime.BUCKET as never) ?? null;
  } catch {
    return null;
  }
}

/**
 * Remove the seeded objects from storage.
 *
 * By PREFIX and never by remembered key. The rows carrying the keys are deleted
 * in the same operation, so a purge that listed keys from the database first
 * would leave an object behind for every row that had already gone — the exact
 * orphan `is_seed` on `attachments` was added to make findable.
 */
async function deleteSeedObjects(batchId: string | null): Promise<number> {
  const bucket = await bucketOrNull();
  if (!bucket) return 0;
  const prefix = batchId
    ? `${SEED_ORGANISATION_ID}/seed/${batchId}/`
    : `${SEED_ORGANISATION_ID}/seed/`;
  let removed = 0;
  try {
    const listing = await bucket.list({ prefix, limit: 1000 });
    for (const object of listing.objects ?? []) {
      await bucket.delete(object.key);
      removed += 1;
    }
  } catch {
    /* Storage that cannot be listed is reported as zero rather than failing the
       purge: the ROWS are the thing a client could see, and leaving them in
       place because a bucket was unreachable is the worse outcome. */
    return removed;
  }
  return removed;
}

/* ------------------------------------------------------------ the cascade -- */

/**
 * The state one cascade row is in on the day the seed is written.
 *
 * §3.3 does not describe a set of certificates with a fresh, entirely pending
 * ladder; it describes an estate with history — "2 escalations sent", "cap
 * reached". A loader that wrote every step as pending would produce a database
 * in a state the product never reaches, and every `sent` figure in §4.1 would
 * reconcile to zero on both sides and prove nothing.
 *
 * So a step whose occurrence is in the past is written as ALREADY SENT, and the
 * overdue step's `sends_count` is the number of weekly escalations that would
 * have fired by now — from the ROW'S OWN `repeat_interval_days` and
 * `repeat_cap`, which came from `reminder_defaults`, not from a constant here.
 */
/**
 * A `reminder_defaults` row, from drizzle's names into the cascade's.
 *
 * NOT COSMETIC, and the bug it prevents is silent. `cascadeFromDefaults` reads
 * `ReminderDefaultRow`, whose fields are the DATABASE'S names — `step_key`,
 * `offset_value`, `recipient_groups_json` — because it was written to be handed
 * rows straight off a `d1.prepare(...).all()`. `listDefaults` in
 * `../reminders/repository.ts` uses the drizzle query builder, which returns
 * `stepKey`, `offsetValue`, `recipientGroupsJson`. Every field of an unmapped
 * row therefore reads as `undefined` and falls back to its default: offset 0,
 * direction "before", no recipients, repeats off — so all six steps would land
 * on the expiry date, every reminder count in §4.1 would be wrong, and nothing
 * would have thrown.
 *
 * This module is `listDefaults`'s first caller, so the seam is bridged here
 * rather than in the repository, which this workstream does not own. Both
 * spellings are accepted so it keeps working if that changes.
 */
function asDefaultRow(row: Record<string, unknown>): ReminderDefaultRow {
  const pick = (camel: string, snake: string) => row[camel] ?? row[snake];
  return {
    step_key: pick("stepKey", "step_key") as string | null,
    step_order: pick("stepOrder", "step_order") as number | null,
    offset_value: pick("offsetValue", "offset_value") as number | null,
    offset_unit: pick("offsetUnit", "offset_unit") as string | null,
    offset_direction: pick("offsetDirection", "offset_direction") as string | null,
    send_time: pick("sendTime", "send_time") as string | null,
    recipient_groups_json: pick("recipientGroupsJson", "recipient_groups_json") as string | null,
    repeat_enabled: pick("repeatEnabled", "repeat_enabled"),
    repeat_interval_days: pick("repeatIntervalDays", "repeat_interval_days") as number | null,
    repeat_cap: pick("repeatCap", "repeat_cap") as number | null,
    active: row.active,
  };
}

export function seededRuleState(
  row: CascadeRow,
  certificateOffsetDays: number,
  today: IsoDate,
): { status: "pending" | "sent"; sendsCount: number; occurrenceDate: IsoDate | null } {
  const occurrenceDate = row.nextSendAt ? row.nextSendAt.slice(0, 10) : null;
  if (!occurrenceDate) return { status: "pending", sendsCount: 0, occurrenceDate: null };
  if (daysBetween(today, occurrenceDate) >= 0) {
    return { status: "pending", sendsCount: 0, occurrenceDate };
  }
  if (row.stepKey === "overdue") {
    const interval = Math.max(1, row.repeatIntervalDays);
    const cap = Math.max(1, row.repeatCap);
    const sends = Math.min(cap, Math.floor(-certificateOffsetDays / interval));
    return { status: "sent", sendsCount: Math.max(1, sends), occurrenceDate };
  }
  return { status: "sent", sendsCount: 1, occurrenceDate };
}

/* --------------------------------------------------------------- the load -- */

export type SeedLoadOptions = {
  /** Written into every audit-ish column so the rows say who made them. */
  readonly actorEmail?: string | null;
  /** Skip the object writes. The rows are the thing the harness counts. */
  readonly withFiles?: boolean;
};

/**
 * Write one dataset into the demo organisation, replacing whatever is there.
 *
 * Returns a refusal rather than throwing when a gate says no, for the same
 * reason `assertPurgeAllowed` returns a decision: the caller is an HTTP route
 * and a CLI, both of which want to PRINT the reason, and a thrown error would
 * arrive at a generic catch that flattens it to "temporarily unavailable".
 */
export async function loadSeedDataset(
  db: Db,
  dataset: SeedDataset,
  options: SeedLoadOptions = {},
): Promise<SeedLoadReport | SeedRefusal> {
  const email = assertEmailModeSafe((await platformVars()).EMAIL_MODE);
  if (!email.safe) {
    return { ok: false, refusedBy: "email-mode", reason: email.reason };
  }

  const decision = assertPurgeAllowed(await purgeEnvironment(db));
  if (!decision.allowed) {
    return {
      ok: false,
      refusedBy: "production-guard",
      /* A seed run DELETES first, so it is held to the purge's standard. */
      reason: decision.reason,
      checks: decision.checks.map((check) => ({ ...check })),
    };
  }

  const batchId = dataset.seedBatchId;
  const today = dataset.today;
  const actorEmail = options.actorEmail ?? null;
  const warnings: string[] = [];

  /* -- out with the old, objects included ------------------------------- */

  const deleted = await deleteSeedRows(db);
  await deleteSeedObjects(null);

  /* -- sites ------------------------------------------------------------ */

  const contactByStore = new Map(
    dataset.contacts
      .filter((contact) => contact.storeId !== null)
      .map((contact) => [contact.storeId as string, contact]),
  );

  const siteRows = dataset.stores.map((store, index) => {
    const contact = contactByStore.get(store.id);
    return {
      id: store.id,
      organisationId: SEED_ORGANISATION_ID,
      legacyClientId: SEED_LEGACY_CLIENT_ID,
      name: store.name,
      type: store.type,
      region: store.region,
      lifecycle: "Current",
      address: store.address,
      manager: store.manager,
      slug: store.id,
      code: `ZZD-S${String(index + 1).padStart(2, "0")}`,
      siteTypeValue: store.type,
      status: "active",
      city: store.city,
      country: "United Kingdom",
      position: index,
      active: true,
      managerName: contact?.fullName ?? store.manager,
      managerEmail: contact?.email ?? null,
      notes: "Seeded demonstration site. Not a real store.",
      createdAt: atNine(today),
      updatedAt: atNine(today),
    };
  });
  await insertRows(db, sites, siteRows, 22);
  await stampSeedColumns(db, "sites", siteRows.map((row) => row.id), batchId);

  /* -- users ------------------------------------------------------------ */

  const userRows = dataset.users.map((user) => ({
    id: user.id,
    organisationId: SEED_ORGANISATION_ID,
    email: user.email,
    fullName: user.fullName,
    role: roleForSeedUser(user.role),
    active: true,
    createdAt: atNine(today),
    updatedAt: atNine(today),
  }));
  await insertRows(db, users, userRows, 8);
  await stampSeedColumns(db, "users", userRows.map((row) => row.id), batchId);

  /* -- contractors ------------------------------------------------------ */

  const contractorRows = dataset.contractors.map((contractor) => ({
    id: contractor.id,
    organisationId: SEED_ORGANISATION_ID,
    name: contractor.name,
    email: contractor.email,
    serviceCategories: JSON.stringify([contractor.trade]),
    coverageAreas: JSON.stringify(["UK"]),
    certifications: JSON.stringify([]),
    availability: "Available",
    active: true,
    notes: "Seeded demonstration contractor. Not a real supplier.",
    createdAt: atNine(today),
    updatedAt: atNine(today),
  }));
  await insertRows(db, contractors, contractorRows, 12);
  await stampSeedColumns(db, "contractors", contractorRows.map((row) => row.id), batchId);

  /* -- jobs ------------------------------------------------------------- */

  const storeById = new Map(dataset.stores.map((store) => [store.id, store]));
  const jobRows = dataset.jobs.map((job: SeedJob, index: number) => ({
    id: job.id,
    organisationId: SEED_ORGANISATION_ID,
    legacyClientId: SEED_LEGACY_CLIENT_ID,
    siteId: job.storeId,
    source: "Seed data",
    title: job.title,
    /* `ZZD-` and never `MN-`: the client's live numbering is forbidden as a
       fixture, and a seeded row reusing one would file demo data under a real
       record. Asserted in tests/pre-w14-seed-reconcile.test.mjs. */
    reference: `ZZD-J${String(index + 1).padStart(3, "0")}`,
    description: `Seeded job ${index + 1}. Not a real work order.`,
    location: storeById.get(job.storeId)?.name ?? job.storeId,
    requester: job.contact,
    contact: job.contact,
    category: job.category,
    engineer: job.assignee ?? "Unassigned",
    priority: job.priority,
    stage: stageForStatus(job.status),
    status: job.status,
    assignee: job.assignee,
    requestedAt: atNine(job.raisedAt),
    dueAt: job.dueAt,
    completedAt: job.completedAt,
    scheduledDate: job.scheduledDate,
    isSeed: true,
    seedBatchId: batchId,
    archived: false,
    createdByEmail: actorEmail,
    createdAt: atNine(job.raisedAt),
    /* The product has no `last_status_change_at`; `updated_at` is what a "no
       status change for 14+ days" question actually reads, so §3.4's five stale
       jobs are expressed here or nowhere. */
    updatedAt: atNine(job.lastStatusChangeAt),
  }));
  await insertRows(db, maintenanceRequests, jobRows, 26);

  /* -- board placement, so a seeded job is not invisible ---------------- */

  const groups = await db
    .select({ id: maintenanceGroups.id, stageKey: maintenanceGroups.stageKey })
    .from(maintenanceGroups)
    .where(
      and(
        eq(maintenanceGroups.organisationId, SEED_ORGANISATION_ID),
        eq(maintenanceGroups.boardId, SEED_BOARD_ID),
      ),
    );
  const groupByStage = new Map(
    (groups as Array<{ id: string; stageKey: string | null }>).map((group) => [
      group.stageKey ?? "",
      group.id,
    ]),
  );
  const fallbackGroup = (groups as Array<{ id: string }>)[0]?.id ?? null;
  if (!fallbackGroup) {
    /*
     * A job with no placement row is on no board and does not appear in
     * /api/board/items at all. Said out loud rather than left as an empty
     * screen somebody debugs for an afternoon.
     */
    warnings.push(
      "The demo organisation has no maintenance board groups, so seeded jobs were " +
        "written without a board placement and will not appear on the board. " +
        "seedBoardStructure() in db/init.ts creates them on the next boot.",
    );
  } else {
    const placements = jobRows.map((job, index) => ({
      requestId: job.id,
      organisationId: SEED_ORGANISATION_ID,
      legacyClientId: SEED_LEGACY_CLIENT_ID,
      boardId: SEED_BOARD_ID,
      groupId: groupByStage.get(job.stage) ?? fallbackGroup,
      position: index,
      createdAt: atNine(today),
      updatedAt: atNine(today),
    }));
    await insertRows(db, maintenanceGroupItems, placements, 8);
  }

  /* -- certificates ----------------------------------------------------- */

  const certificateRows = dataset.certificates.map((certificate) => ({
    id: certificate.id,
    organisationId: SEED_ORGANISATION_ID,
    legacyClientId: SEED_LEGACY_CLIENT_ID,
    siteId: certificate.storeId,
    kind: certificate.kind,
    status: complianceStatusFor(certificate, today),
    expiryDate: certificate.expiryDate,
    notRequired: false,
    reference: certificate.reference,
    issuedBy: certificate.issuedBy,
    issueDate: certificate.issueDate,
    nextInspectionDate: certificate.expiryDate,
    renewalOwnerEmail: certificate.renewalOwnerEmail,
    escalationEmail: certificate.escalationEmail,
    costPence: certificate.costPence,
    remedialsRequired: certificate.remedialsRequired,
    renewalStatus: certificate.renewalStatus,
    supersededById: certificate.supersededById,
    isSeed: true,
    seedBatchId: batchId,
    createdAt: atNine(today),
    updatedAt: atNine(today),
  }));
  await insertRows(db, complianceDocuments, certificateRows, 22);

  /* -- calendar items --------------------------------------------------- */

  const eventRows = [...dataset.notes, ...dataset.plannedVisits].map((item) => ({
    id: item.id,
    organisationId: SEED_ORGANISATION_ID,
    title: item.title,
    notes: item.notes,
    siteId: item.storeId,
    startsOn: item.startsOn,
    endsOn: item.endsOn,
    allDay: true,
    category: item.category,
    createdByEmail: actorEmail,
    createdAt: atNine(today),
    updatedAt: atNine(today),
    archived: false,
    /* Standalone by construction: `request_id` unset means this row owns its
       own schedule, which is the invariant app/(app)/portal/planned-visit.ts
       holds. A seeded visit that named a job AND carried a date would be the
       two-copies row that module exists to refuse. */
    requestId: null,
    visitType: item.visitType,
    assignedTo: item.assignedTo,
    contractorId: item.contractorId,
    isSeed: true,
    seedBatchId: batchId,
  }));
  await insertRows(db, calendarEvents, eventRows, 20);

  /* -- attachments and their bytes -------------------------------------- */

  const certificateById = new Map(dataset.certificates.map((row) => [row.id, row]));
  const visitById = new Map(dataset.plannedVisits.map((row) => [row.id, row]));
  const jobById = new Map(dataset.jobs.map((row) => [row.id, row]));

  const attachmentRows = dataset.attachments.map((file) => {
    const job = file.subjectType === "job" ? jobById.get(file.subjectId) : null;
    const certificate =
      file.subjectType === "certificate" ? certificateById.get(file.subjectId) : null;
    const visit = file.subjectType === "visit" ? visitById.get(file.subjectId) : null;
    return {
      id: file.id,
      organisationId: SEED_ORGANISATION_ID,
      legacyClientId: SEED_LEGACY_CLIENT_ID,
      requestId: job ? job.id : null,
      /*
       * A certificate and a visit are both SITE-anchored here. `attachments`
       * has no compliance-document column and no calendar-event column — the
       * link runs the other way, `compliance_documents.attachment_id` — so the
       * site is the anchor that exists rather than one invented for the fixture.
       */
      siteId: certificate?.storeId ?? visit?.storeId ?? null,
      kind: file.subjectType === "job" ? "issue" : "general",
      objectKey: seedObjectKey(batchId, file),
      originalName: file.filename,
      contentType: file.mimeType,
      byteSize: file.byteLength,
      uploadedByEmail: actorEmail,
      pending: false,
      /* Marked in the TITLE as well as the filename: the suite's convention,
         because a filename-substring sweep has repeatedly eaten other fixtures. */
      title: `ZZ-DEMO — ${file.filename}`,
      documentType: file.subjectType === "certificate" ? "Certificate" : null,
      versionNo: 1,
      isCurrent: true,
      createdAt: atNine(today),
    };
  });
  await insertRows(db, attachments, attachmentRows, 20);
  await stampSeedColumns(db, "attachments", attachmentRows.map((row) => row.id), batchId);

  /* Link each certificate to the file filed against it, so the register's
     download opens something rather than nothing. */
  for (const file of dataset.attachments) {
    if (file.subjectType !== "certificate") continue;
    await db
      .update(complianceDocuments)
      .set({ attachmentId: file.id })
      .where(
        and(
          eq(complianceDocuments.organisationId, SEED_ORGANISATION_ID),
          eq(complianceDocuments.id, file.subjectId),
        ),
      );
  }

  let objectsWritten = 0;
  const bucket = options.withFiles === false ? null : await bucketOrNull();
  if (bucket) {
    for (const file of dataset.attachments) {
      const bytes = seedFileBytes(file);
      await bucket.put(seedObjectKey(batchId, file), bytes, {
        httpMetadata: {
          contentType: file.mimeType,
          contentDisposition: `inline; filename="${file.filename}"`,
        },
        customMetadata: { seedBatchId: batchId, isSeed: "1" },
      });
      objectsWritten += 1;
    }
  } else if (options.withFiles !== false) {
    warnings.push(
      "No BUCKET binding is attached, so the 40 attachment rows were written " +
        "with no bytes behind them and every seeded download will 404.",
    );
  }

  /* -- the reminder cascade, from the product's own engine --------------- */

  const storedDefaults = (await listDefaults(db, SEED_ORGANISATION_ID, "certificate")) as Array<
    Record<string, unknown>
  >;
  const defaults = (storedDefaults ?? []).map(asDefaultRow);
  if (defaults.length === 0) {
    warnings.push(
      "reminder_defaults holds no certificate cascade for the demo organisation, " +
        "so no reminders were generated. seedReminderDefaults() in db/init.ts " +
        "writes them on the next boot.",
    );
  }

  const ruleRows: Array<Record<string, unknown>> = [];
  const recipientRows: Array<Record<string, unknown>> = [];
  for (const certificate of dataset.certificates) {
    /* §3.3: a superseded certificate's cascade is CANCELLED, and an undated one
       has no anchor to measure from. Neither gets rows at all. */
    if (certificate.expiryDate === null) continue;
    if (certificate.renewalStatus === "superseded") continue;

    const offset = daysBetween(today, certificate.expiryDate);
    const cascade = cascadeFromDefaults(defaults, certificate.expiryDate, SEED_TIMEZONE);
    for (const row of cascade) {
      const state = seededRuleState(row, offset, today);
      const ruleId = `${SEED_ID_PREFIX}rem-${certificate.id.replace(SEED_ID_PREFIX, "")}-${row.stepKey}`;
      ruleRows.push({
        id: ruleId,
        organisationId: SEED_ORGANISATION_ID,
        subjectType: "certificate",
        subjectId: certificate.id,
        stepKey: row.stepKey,
        isEnabled: row.isEnabled,
        offsetValue: row.offsetValue,
        offsetUnit: row.offsetUnit,
        offsetDirection: row.offsetDirection,
        sendTime: row.sendTime,
        timezone: row.timezone,
        repeatEnabled: row.repeatEnabled,
        repeatIntervalDays: row.repeatIntervalDays,
        repeatCap: row.repeatCap,
        sendsCount: state.sendsCount,
        channel: "email",
        nextSendAt: row.nextSendAt,
        status: state.status,
        createdByEmail: actorEmail,
        createdAt: atNine(today),
        updatedAt: atNine(today),
      });
      for (const group of row.recipientGroups) {
        recipientRows.push({
          id: `${ruleId}-${group}`,
          organisationId: SEED_ORGANISATION_ID,
          reminderId: ruleId,
          userId: null,
          email: null,
          /* GROUP KEYS, never addresses — resolved at send time, which is what
             keeps a cascade written today reaching whoever owns the renewal in
             ninety days. The same rule `reminder_defaults` holds. */
          groupKey: group,
          createdAt: atNine(today),
        });
      }
    }
  }
  await insertRows(db, reminderRules, ruleRows, 24);
  await insertRows(db, reminderRecipients, recipientRows, 6);

  return {
    ok: true,
    seedBatchId: batchId,
    today,
    organisationId: SEED_ORGANISATION_ID,
    emailMode: email.mode,
    deleted,
    inserted: [
      { table: "sites", rows: siteRows.length },
      { table: "users", rows: userRows.length },
      { table: "contractors", rows: contractorRows.length },
      { table: "maintenance_requests", rows: jobRows.length },
      { table: "compliance_documents", rows: certificateRows.length },
      { table: "calendar_events", rows: eventRows.length },
      { table: "attachments", rows: attachmentRows.length },
      { table: "reminder_rules", rows: ruleRows.length },
      { table: "reminder_recipients", rows: recipientRows.length },
    ],
    storage: {
      available: Boolean(bucket),
      objectsWritten,
      note: bucket
        ? "PDF fixtures are valid one-page documents; image fixtures are byte filler and will not decode."
        : "No object storage is attached to this deployment.",
    },
    warnings,
  };
}

/* -------------------------------------------------------------- the purge -- */

/**
 * Delete every seeded row and every seeded object, or refuse and say why.
 *
 * §5: "`seed:purge` must refuse to run when `ENVIRONMENT === 'production'`,
 * checking the environment variable AND the database name. Two independent
 * checks, because one will eventually be misconfigured." Both are evaluated
 * here, both are reported, and neither can rescue the other — see `./guards.ts`.
 */
export async function purgeSeedData(db: Db): Promise<PurgeReport | SeedRefusal> {
  const email = assertEmailModeSafe((await platformVars()).EMAIL_MODE);
  if (!email.safe) {
    return { ok: false, refusedBy: "email-mode", reason: email.reason };
  }

  const decision = assertPurgeAllowed(await purgeEnvironment(db));
  if (!decision.allowed) {
    return {
      ok: false,
      refusedBy: "production-guard",
      reason: decision.reason,
      checks: decision.checks.map((check) => ({ ...check })),
    };
  }

  const deleted = await deleteSeedRows(db);
  const objectsDeleted = await deleteSeedObjects(null);

  return {
    ok: true,
    organisationId: SEED_ORGANISATION_ID,
    deleted,
    totalRows: deleted.reduce((total, entry) => total + entry.rows, 0),
    storage: {
      objectsDeleted,
      note: `Objects removed by prefix ${SEED_ORGANISATION_ID}/seed/.`,
    },
  };
}

/* ---------------------------------------------------------------- travel -- */

/**
 * The day a `seed:travel` run should rebuild for.
 *
 * Travelling is REBUILDING AT A DIFFERENT `today`, not mutating stored rows.
 * Every date in `./dataset.ts` is an offset from its argument, so a dataset
 * built at `today + 30` is what the estate would have looked like had thirty
 * days passed — including the certificates that crossed a band boundary, which
 * is the whole point of the exercise and is unreachable by adding 30 to every
 * stored date (that moves the certificates and the clock together and changes
 * nothing).
 */
export function travelTo(today: IsoDate, days: number): IsoDate {
  return addDays(today, Math.trunc(days));
}

/** Ids seeded rows use, exposed so a caller can explain a count. */
export function seededSubjectIds(dataset: SeedDataset): {
  certificates: string[];
  jobs: string[];
} {
  return {
    certificates: dataset.certificates.map((row) => row.id),
    jobs: dataset.jobs.map((row) => row.id),
  };
}
