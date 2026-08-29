import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Two things about the contractor register that a screenshot proved were wrong.
 *
 * ONE — "Active contractor" saved, and the list still said Inactive.
 *
 * It saved. Traced against a running server, `active` persisted true→false→true
 * every time. The register carries TWO states and the list line only ever
 * printed one of them: `active` is whether the contractor is on the register at
 * all — the flag the planned-work dropdown filters on — and `availability` is
 * whether one who IS on it can take work this week. The archive verb writes
 * both together (`active:false` AND `availability:"Inactive"`), but re-ticking
 * the box writes only `active`, so an un-archived contractor keeps the
 * availability the archive left behind and the subtitle read "Inactive" beside
 * a ticked, saved box. The fix is that the line now leads with the canonical
 * flag, so it cannot contradict it, and still shows availability beside it so
 * the stale value is visible as the separate field it is.
 *
 * TWO — a WhatsApp number, which the register had nowhere to put.
 *
 * Nullable, additive, and never derived from `phone`: the landline that takes
 * the calls is routinely not the mobile that takes the messages, and a landline
 * handed to wa.me opens on "the phone number shared via url is invalid".
 *
 * Source assertions only. The behaviour behind them was verified against a dev
 * server by hand; what this file protects is that the wiring stays wired.
 */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the contractor list cannot report a state that contradicts `active`", async () => {
  const form = await read("app/(app)/portal/workspace-data-manager.tsx");
  const subtitle = form.slice(form.indexOf("function recordSubtitle"));
  const line = subtitle.slice(subtitle.indexOf('if (tab === "contractor")'));
  const contractorLine = line.slice(0, line.indexOf("\n"));

  assert.match(
    contractorLine,
    /record\.active \? "Active" : "Archived"/,
    "the canonical flag has to be on the line, and first",
  );
  assert.match(
    contractorLine,
    /record\.availability/,
    "availability stays beside it — the two are not the same claim",
  );
  assert.ok(
    contractorLine.indexOf("record.active") < contractorLine.indexOf("record.availability"),
    "the record state leads; availability is the qualifier, not the headline",
  );
});

test("the Active checkbox says what it does, and what it does not do", async () => {
  const form = await read("app/(app)/portal/workspace-data-manager.tsx");
  // Every checkbox used to print the same "Available in the shared testing
  // workspace", which is what let Active and Availability read as one field.
  assert.match(form, /hint\?: string;/, "a per-field hint exists");
  assert.match(form, /\{field\.hint \?\? "Available in the shared testing workspace"\}/);
  const active = form.slice(form.indexOf('label: "Active contractor"'));
  assert.match(active.slice(0, 600), /hint: "[^"]*Availability[^"]*separate/i);
});

test("`active` and `availability` stay two columns, and archive writes both", async () => {
  const schema = await read("db/schema.ts");
  const table = schema.slice(schema.indexOf('sqliteTable(\n  "contractors"'));
  const body = table.slice(0, table.indexOf("export const maintenanceRequests"));
  assert.match(body, /availability: text\("availability"\)\.notNull\(\)\.default\("Available"\)/);
  assert.match(body, /active: integer\("active", \{ mode: "boolean" \}\)\.notNull\(\)\.default\(true\)/);

  const api = await read("app/api/workspace/route.ts");
  // The archive verb sets the record state AND stops the contractor reading as
  // bookable, in one statement. Neither half is a substitute for the other.
  assert.match(
    api,
    /entity === "contractor"\) await db\.update\(contractors\)\.set\(\{ active: false, availability: "Inactive"/,
  );
});

test("a WhatsApp number is carried end to end, and never copied from the phone", async () => {
  const schema = await read("db/schema.ts");
  assert.match(schema, /whatsappNumber: text\("whatsapp_number"\)/, "the column");

  const migration = await read("drizzle/0021_contractor_whatsapp.sql");
  assert.match(migration, /ALTER TABLE contractors ADD COLUMN whatsapp_number TEXT;/);

  // The migration file is the record; db/init.ts is what actually runs, against
  // both D1 and the Postgres mirror, guarded by PRAGMA table_info so it is
  // idempotent on a database that already has the column. Without this entry a
  // fresh database never gains it and every read of the column throws.
  const init = await read("db/init.ts");
  // `assert.ok`, not `assert.match`: a failed match prints the whole 110KB file
  // into the runner, and the one line that is missing is the message below.
  assert.ok(
    init.includes('["contractors", "whatsapp_number", "TEXT"]'),
    "db/init.ts needs the guarded ALTER, or a fresh database never gains the column",
  );

  const api = await read("app/api/workspace/route.ts");
  assert.match(api, /whatsappNumber: contractor\.whatsappNumber/, "read");
  assert.match(
    api,
    /whatsappNumber: optionalText\(data\.whatsappNumber, 80\)/,
    "created, capped like phone, and read from its OWN key",
  );
  assert.match(
    api,
    /\.\.\.supplied\(data, "whatsappNumber", \(value\) => optionalText\(value, 80\)\)/,
    "and updated behind `supplied`, so a partial PATCH cannot blank it",
  );
  assert.doesNotMatch(
    api,
    /whatsappNumber: optionalText\(data\.phone/,
    "the phone number is never silently promoted to a WhatsApp number",
  );

  const model = await read("app/lib/workspace-data.ts");
  assert.match(model, /whatsappNumber: string \| null;/);

  const form = await read("app/(app)/portal/workspace-data-manager.tsx");
  assert.match(
    form,
    /\{ key: "whatsappNumber", label: "WhatsApp number", type: "tel", placeholder: "[^"]+" \}/,
  );
  // `whatsappHref` refuses to guess a country code, so the field has to ask for
  // the international form rather than let somebody type what is on the van.
  const field = form.slice(form.indexOf('key: "whatsappNumber"'));
  assert.match(field.slice(0, 200), /\+44/, "the placeholder shows international format");
  assert.ok(
    form.indexOf('key: "whatsappNumber"') > form.indexOf('key: "phone", label: "Phone"'),
    "it sits directly under the phone number, where a coordinator looks",
  );
  // Without a default the key is absent from a new record's form and the create
  // POST never carries it.
  const defaults = form.slice(form.indexOf("contractor: { name:"));
  assert.match(defaults.slice(0, 400), /whatsappNumber: ""/);
});
