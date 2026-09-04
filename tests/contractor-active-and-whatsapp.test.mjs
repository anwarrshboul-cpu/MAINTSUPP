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
 * W6 NOTE. That contradictory pair can no longer be CREATED: the contractor
 * PATCH refuses a stored `active:false` becoming true while the result still
 * carries `availability:"Inactive"` (`contractorResurrectionRefusal`,
 * app/api/workspace/route.ts). Restoring somebody now has to say what their
 * availability is. The display fix below is still load-bearing, because rows
 * written BEFORE that guard are still in the register wearing exactly this
 * pair — the guard is deliberately narrow and leaves them editable rather than
 * stranding them. So the state is legacy-only, not gone.
 *
 * TWO — a WhatsApp number, which the register had nowhere to put.
 *
 * Nullable, additive, and never derived from `phone`: the landline that takes
 * the calls is routinely not the mobile that takes the messages, and a landline
 * handed to wa.me opens on "the phone number shared via url is invalid".
 *
 * Source assertions, except the last. The behaviour behind them was verified
 * against a dev server by hand; what those protect is that the wiring stays
 * wired. The bracketed-trunk test at the end runs `contact-links.ts` for real,
 * because the defect it covers was in the digits that came out rather than in
 * any wiring a regex could see.
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
    /*
     * RE-POINTED: the statement moved, the rule did not.
     *
     * This matched the archive as a ONE-LINER. W2 gave the contractor verbs a
     * register — a section created from the Contractors template owns its own
     * roster — so the branch now resolves that register, refuses a contractor
     * this register does not hold with a 404 rather than a 200 that archived
     * nothing, and puts the scope in the predicate. It is a block, and the
     * one-line regex could not survive that.
     *
     * What it was protecting is unchanged and is still checked below: archiving
     * writes BOTH `active` and `availability`, neither half standing in for the
     * other, and it is still an update rather than a delete.
     */
    /\.set\(\{ active: false, availability: "Inactive", updatedAt: new Date\(\)\.toISOString\(\) \}\)/,
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

/*
 * The bracketed trunk digit, which is the one shape that produced a LINK that
 * was WRONG rather than a link that was absent.
 *
 * Every other refusal in `contact-links.ts` fails safe: it declines to build a
 * wa.me URL and the screen prints the stored value instead. `+44 (0) 20 7946
 * 0958` did not. It starts with `+`, so the country code is stated and the
 * module had nothing to strip — and the `0` the brackets mark as the digit you
 * do NOT dial internationally went through into `wa.me/4402079460958`, a
 * country code followed by a digit no British number has. That opens on "the
 * phone number shared via url is invalid", which is precisely the failure the
 * WhatsApp column exists to avoid.
 *
 * Behavioural rather than a regex over the source: the defect was in what the
 * digits came out as, and only running it can say.
 */
test("a bracketed trunk digit is dropped, and nothing else is", async () => {
  const { whatsappHref, telHref } = await import(
    new URL("../app/lib/contact-links.ts", import.meta.url)
  );

  assert.equal(
    whatsappHref("+44 (0) 20 7946 0958"),
    "https://wa.me/442079460958",
    "the bracketed 0 is not dialled internationally, so it is not in the link",
  );
  assert.equal(telHref("+44 (0) 20 7946 0958"), "tel:+442079460958");

  // Nothing that worked before moves.
  assert.equal(whatsappHref("+44 7700 900123"), "https://wa.me/447700900123");
  assert.equal(whatsappHref("0044 7700 900456"), "https://wa.me/447700900456");

  /*
   * And nothing that was refused becomes reachable. A bare national number
   * still needs a country nobody here may supply, and `(020)` is an area code
   * written the British way — three digits inside the brackets, not one — so
   * the narrow rule leaves every one of them alone.
   */
  assert.equal(whatsappHref("07812 224644"), null, "a bare trunk 0 is still not a country code");
  assert.equal(whatsappHref("(020) 7946 0958"), null, "an area code is not an international number");
  assert.equal(telHref("(020) 7946 0958"), "tel:02079460958", "and it keeps every digit for the dialler");

  /*
   * The half of this rule that matters more than the fix itself.
   *
   * Stripping the brackets UNCONDITIONALLY — which the first version of this
   * did — turns a NATIONAL number into a plausible international one. Removing
   * the zero from `(0)20 7946 0958` leaves `2079460958`, which no longer opens
   * with a trunk `0`, so it reads as already-international and resolves to a
   * live number in EGYPT; `(0)7812 224644` lands in RUSSIA. Both produced NO
   * link before the bracket rule existed. A confident link to a stranger's
   * phone is a worse failure than the invalid one it replaced, so the bracket
   * is only ever dropped when a `+` or a `00` has already named the country.
   */
  assert.equal(
    whatsappHref("(0)20 7946 0958"),
    null,
    "a bracketed trunk with NO stated country code must not become somebody else's number",
  );
  assert.equal(whatsappHref("(0)7812 224644"), null, "same, for a mobile");
  assert.equal(telHref("(0)20 7946 0958"), "tel:02079460958", "the dialler still gets the national number");

  // And the two shapes that DO state a country still resolve.
  assert.equal(whatsappHref("0044 (0) 20 7946 0958"), "https://wa.me/442079460958");
  assert.equal(whatsappHref("+44(0)7700900123"), "https://wa.me/447700900123");
});
