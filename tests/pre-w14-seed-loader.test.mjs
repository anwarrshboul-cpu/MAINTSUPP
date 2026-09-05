/**
 * THE LOADER, THE RECONCILER, AND THE TWO GATES IN FRONT OF THEM.
 *
 * `tests/pre-w14-seed-reconcile.test.mjs` next door protects the two halves of
 * the harness that never touch a database — the generated dataset and the
 * independently computed expected values. This suite protects the half that
 * does: writing those rows in, counting them back out with the APPLICATION's
 * own functions, and refusing to do either against production.
 *
 * Four things carry the weight here.
 *
 *  1. THE ISOLATION SURVIVES THE WRITE. Module 3 §1 asked for a second D1
 *     database as the primary boundary and the owner ruled that out, so the
 *     boundary is the demo organisation, `is_seed`, the `zzdemo-` id prefix and
 *     two production guards — and `loader.ts` is the ONLY code in the product
 *     that writes demo rows into the client's database. Every layer is pinned
 *     below, including the one that is easy to lose in a refactor: the
 *     organisation is a CONSTANT and not an argument.
 *
 *  2. THE SEED RUN IS AS DANGEROUS AS THE PURGE. It deletes before it writes,
 *     because §7 wants two consecutive runs to be byte-identical. Both entry
 *     points must therefore call BOTH guards, and both must call
 *     `assertEmailModeSafe` — §2.1's strict reading, which lives at the seed
 *     entry point on purpose.
 *
 *  3. THE HISTORY THE LOADER INVENTS MUST BE THE HISTORY THE HARNESS EXPECTS.
 *     §3.3 does not describe a fresh cascade; it describes an estate with
 *     history ("2 escalations sent", "cap reached"). The loader simulates that
 *     from the product's own `cascadeFromDefaults` and the real
 *     `REMINDER_DEFAULTS_SEED`, and the totals are compared against
 *     `computeExpectedValues`, which was written apart from it and knows
 *     nothing about how the rows are stored.
 *
 *  4. THE RECONCILER USES THE APPLICATION'S LADDER, NOT A SECOND COPY. If
 *     `bandForStoredCertificate` ever stopped going through
 *     `certificateExpiryBand`, every band row on the page would go green and
 *     mean nothing.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

/** Comments stripped, for the pins that are about what the CODE does. */
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Comment prose, unwrapped, so a pin can match a sentence a line break split. */
const proseOnly = (source) => source.replace(/\n\s*\*\s?/g, " ");

/* ─────────────────────────────────────────────────────────── the stubbing ── */

/*
 * `loader.ts` and `reconcile.ts` are not pure — they exist to talk to a
 * database — so they cannot be imported the way the three modules next door
 * can. Their DB-facing imports are replaced with stubs and their PURE ones are
 * pointed at the real transpiled modules, which is the same technique the other
 * pre-W14 suites use and is what lets the arithmetic below be checked with no
 * server, no Miniflare and no fixtures to clean up.
 *
 * The stubs are deliberately inert. Nothing below calls a function that would
 * touch one; a stub that started answering queries would be a fake database,
 * and a test against a fake database proves the fake works.
 */
const drizzleStub = asModule(`
  const chunk = (strings, ...values) => ({ strings, values });
  chunk.raw = (text) => ({ raw: text });
  chunk.join = (parts, sep) => ({ parts, sep });
  export const sql = chunk;
  export const and = (...parts) => ({ and: parts });
  export const eq = (a, b) => ({ eq: [a, b] });
  export const or = (...parts) => ({ or: parts });
  export const like = (a, b) => ({ like: [a, b] });
  export const inArray = (a, b) => ({ inArray: [a, b] });
  export const asc = (a) => a;
  export const desc = (a) => a;
  export const isNull = (a) => ({ isNull: a });
  export const lte = (a, b) => ({ lte: [a, b] });
`);

const schemaStub = asModule(
  [
    "attachments",
    "calendarEvents",
    "complianceDocuments",
    "contractors",
    "jobStatusMap",
    "maintenanceGroupItems",
    "maintenanceGroups",
    "maintenanceRequests",
    "reminderDefaults",
    "reminderDispatch",
    "reminderRecipients",
    "reminderRules",
    "reminderTokens",
    "sites",
    "users",
  ]
    .map(
      (name) =>
        `export const ${name} = new Proxy({ __table: "${name}" }, { get: (t, k) => t[k] ?? { column: String(k) } });`,
    )
    .join("\n"),
);

const tenantAccessStub = asModule(
  `export const DEMO_ORGANISATION_ID = "org_000000000000000000000002";
   export const PRIMARY_ORGANISATION_ID = "org_000000000000000000000001";`,
);
const repositoryStub = asModule(
  `export const listDefaults = async () => [];
   export const listDueReminders = async () => [];`,
);

const datasetUrl = asModule(transpile(await read("app/lib/seed/dataset.ts")));
const expectedUrl = asModule(transpile(await read("app/lib/seed/expected.ts")));
const guardsUrl = asModule(transpile(await read("app/lib/seed/guards.ts")));
const batchingUrl = asModule(transpile(await read("app/lib/sql-batching.ts")));
const scheduleUrl = asModule(transpile(await read("app/lib/reminders/schedule.ts")));
const recipientsUrl = asModule(transpile(await read("app/lib/reminders/recipients.ts")));
const cascadeUrl = asModule(
  transpile(await read("app/lib/reminders/cascade.ts"))
    .replace(/from ["']\.\/schedule["']/g, `from "${scheduleUrl}"`)
    .replace(/from ["']\.\/recipients["']/g, `from "${recipientsUrl}"`),
);
const calendarTypesUrl = asModule(
  transpile(await read("app/(app)/portal/calendar-item-types.ts")),
);
const statusMapUrl = asModule(transpile(await read("app/(app)/portal/job-status-map.ts")));

const loaderUrl = asModule(
  transpile(await read("app/lib/seed/loader.ts"))
    .replace(/from ["']drizzle-orm["']/g, `from "${drizzleStub}"`)
    .replace(/from ["']\.\.\/\.\.\/\.\.\/db\/schema["']/g, `from "${schemaStub}"`)
    .replace(/from ["']\.\.\/sql-batching["']/g, `from "${batchingUrl}"`)
    .replace(/from ["']\.\.\/tenant-access["']/g, `from "${tenantAccessStub}"`)
    .replace(/from ["']\.\.\/reminders\/cascade["']/g, `from "${cascadeUrl}"`)
    .replace(/from ["']\.\.\/reminders\/repository["']/g, `from "${repositoryStub}"`)
    .replace(/from ["']\.\/dataset["']/g, `from "${datasetUrl}"`)
    .replace(/from ["']\.\/guards["']/g, `from "${guardsUrl}"`),
);

const reconcileUrl = asModule(
  transpile(await read("app/lib/seed/reconcile.ts"))
    .replace(/from ["']drizzle-orm["']/g, `from "${drizzleStub}"`)
    .replace(/from ["']\.\.\/\.\.\/\.\.\/db\/schema["']/g, `from "${schemaStub}"`)
    .replace(
      /from ["']\.\.\/\.\.\/\(app\)\/portal\/calendar-item-types["']/g,
      `from "${calendarTypesUrl}"`,
    )
    .replace(
      /from ["']\.\.\/\.\.\/\(app\)\/portal\/job-status-map["']/g,
      `from "${statusMapUrl}"`,
    )
    .replace(/from ["']\.\.\/reminders\/repository["']/g, `from "${repositoryStub}"`)
    .replace(/from ["']\.\/dataset["']/g, `from "${datasetUrl}"`)
    .replace(/from ["']\.\/loader["']/g, `from "${loaderUrl}"`),
);

const dataset = await import(datasetUrl);
const expected = await import(expectedUrl);
const cascade = await import(cascadeUrl);
const loader = await import(loaderUrl);
const reconcile = await import(reconcileUrl);

const TODAY = "2026-09-05";
const built = dataset.buildSeedDataset(TODAY);
const values = expected.computeExpectedValues(built, TODAY);

/* ───────────────────────────────────────────────────── 1. the isolation ── */

test("seeded rows go to the demo organisation, and that is not an argument", async () => {
  /*
   * The layer that replaces the second D1 database Module 3 asked for. If this
   * ever becomes a parameter, a caller can point the loader at the client's
   * organisation and every other layer becomes decoration.
   */
  assert.equal(loader.SEED_ORGANISATION_ID, "org_000000000000000000000002");

  const source = codeOnly(await read("app/lib/seed/loader.ts"));
  assert.match(
    source,
    /export const SEED_ORGANISATION_ID = DEMO_ORGANISATION_ID;/,
    "the organisation must be a constant taken from the tenancy module, not a literal or a parameter",
  );
  assert.doesNotMatch(
    source,
    /organisationId:\s*(orgId|options\.\w+|input\.\w+)/,
    "no row may take its organisation from the caller",
  );
});

test("no seeded row takes the real client's legacy id", async () => {
  /*
   * `client_id` defaults to `sunnamusk-uk` on four of the tables written here.
   * A seeded row that took the default would be filed under the REAL client's
   * legacy key — invisible to every organisation-scoped query, and waiting for
   * the first report that groups by it.
   */
  assert.equal(loader.SEED_LEGACY_CLIENT_ID, "zzdemo-seed");
  const source = codeOnly(await read("app/lib/seed/loader.ts"));
  assert.doesNotMatch(source, /sunnamusk/i, "the real client's key must not appear here");
  assert.equal(
    (source.match(/legacyClientId: SEED_LEGACY_CLIENT_ID/g) ?? []).length,
    5,
    "every legacy-scoped insert must name it: sites, jobs, board placements, certificates, attachments",
  );
});

test("nothing in the loader or the reconciler names a real job reference", async () => {
  /* The `MN-` series is the client's live numbering and is forbidden as a QA
     fixture. Seeded jobs are `ZZD-Jnnn` and certificates are `ZZD-nnnn`. */
  for (const file of [
    "app/lib/seed/loader.ts",
    "app/lib/seed/reconcile.ts",
    "app/api/admin/seed/route.ts",
    "app/api/admin/reconcile/route.ts",
    "scripts/seed.mjs",
  ]) {
    assert.doesNotMatch(await read(file), /\bMN-\d+/i, `${file} names a real job reference`);
  }
});

test("the deviation from Module 3 §1 is recorded where the writing happens", async () => {
  const prose = proseOnly(await read("app/lib/seed/loader.ts"));
  assert.match(prose, /DEVIATION FROM MODULE 3/, "the loader must say what it did not do");
  assert.match(prose, /do not introduce D1\/R2/i, "and quote the instruction it followed");
});

/* ──────────────────────────────────────────────────────── 2. the gates ── */

test("both entry points call BOTH guards before touching a row", async () => {
  const source = await read("app/lib/seed/loader.ts");

  const seedBody = source.slice(
    source.indexOf("export async function loadSeedDataset"),
    source.indexOf("/* -------------------------------------------------------------- the purge -- */"),
  );
  const purgeBody = source.slice(source.indexOf("export async function purgeSeedData"));

  for (const [name, body] of [
    ["loadSeedDataset", seedBody],
    ["purgeSeedData", purgeBody],
  ]) {
    assert.match(
      body,
      /assertEmailModeSafe\(/,
      `${name} must refuse an unset EMAIL_MODE — §2.1's strict reading lives at the seed entry point`,
    );
    assert.match(
      body,
      /assertPurgeAllowed\(/,
      `${name} must pass both production checks; a seed run DELETES first and is as dangerous as a purge`,
    );
    /* The guard call must come before the first write, not after it. */
    assert.ok(
      body.indexOf("assertPurgeAllowed(") < body.indexOf("deleteSeedRows("),
      `${name} evaluates the guard after it has already started deleting`,
    );
  }
});

test("the seed API refuses before it reads, so `verify` is guarded too", async () => {
  const source = await read("app/api/admin/seed/route.ts");
  assert.match(source, /scopedDbWithCapability\(request, "settings\.edit"\)/);
  assert.match(source, /assertEmailModeSafe\(/);
  assert.match(source, /assertPurgeAllowed\(/);
  /*
   * `verify` never reaches the loader, so without the route's own copy of the
   * two gates it would be the one action here that ran against production.
   */
  assert.ok(
    source.indexOf("assertPurgeAllowed(") < source.indexOf('body.action === "purge"'),
    "the guards must be evaluated before any action branches",
  );
  assert.match(
    source,
    /status: report\.failed > 0 \? 409 : 200/,
    "seed:verify exits on the status code alone; a CI step that parses a table eventually stops failing",
  );
});

test("the reconcile API is admin-only and refuses off a preview deployment", async () => {
  const source = await read("app/api/admin/reconcile/route.ts");
  assert.match(source, /scopedDbWithCapability\(request, "settings\.edit"\)/);
  assert.match(source, /assertPurgeAllowed\(/);
  assert.match(source, /status: 403/);
  /* It must not compute its expectations twice. The whole harness rests on the
     two sides being produced by different code. */
  assert.match(source, /computeExpectedValues\(dataset, today\)/);
  const reconcileSource = codeOnly(await read("app/lib/seed/reconcile.ts"));
  assert.doesNotMatch(
    reconcileSource,
    /computeExpectedValues/,
    "reconcile.ts must never compute the expected values it is comparing against",
  );
  assert.match(
    codeOnly(await read("app/lib/seed/reconcile.ts")),
    /import type \{[^}]*ExpectedValues[^}]*\} from "\.\/expected"/,
    "expected.ts may be imported for its TYPE and nothing else",
  );
});

test("the reconciler classifies with the application's own functions", async () => {
  /*
   * The pin that keeps the page honest. Counting bands with a `CASE WHEN` in
   * SQL would be a second copy of the ladder, and every band row would then
   * agree with itself.
   */
  const source = codeOnly(await read("app/lib/seed/reconcile.ts"));
  assert.match(source, /certificateExpiryBand\(/, "the calendar's own ladder");
  assert.match(source, /jobChipAppearance\(/, "the board's own status resolution");
  assert.match(source, /jobIsOverdue\(/, "the calendar's own overdue overlay rule");
  assert.match(source, /jobStatusIndex\(/, "over job_status_map rows read from the database");
  assert.match(source, /listDueReminders\(/, "and the cron's own select, for §4.3");
});

/* ───────────────────────────────────────────── 3. the purge is complete ── */

test("the purge deletes children before parents, or Postgres refuses it", async () => {
  /*
   * `maintenance_group_items` carries a foreign key to `maintenance_requests`
   * and `compliance_documents.attachment_id` references `attachments`. On
   * SQLite with foreign keys off the wrong order is silent; on Postgres it is a
   * constraint violation, and a purge that half-runs is worse than one that
   * refuses outright.
   */
  const source = await read("app/lib/seed/loader.ts");
  const body = source.slice(
    source.indexOf("async function deleteSeedRows"),
    source.indexOf("/** The bucket binding"),
  );
  const order = [...body.matchAll(/await record\("([a-z_]+)"/g)].map((match) => match[1]);

  assert.deepEqual(
    order,
    [
      "reminder_tokens",
      "reminder_dispatch",
      "reminder_recipients",
      "reminder_rules",
      "maintenance_group_items",
      "compliance_documents",
      "calendar_events",
      "attachments",
      "maintenance_requests",
      "sites",
      "contractors",
      "users",
    ],
    "the delete order is a dependency order, not a list somebody tidied alphabetically",
  );
  assert.ok(
    order.indexOf("maintenance_group_items") < order.indexOf("maintenance_requests"),
    "placements reference the jobs they place",
  );
  assert.ok(
    order.indexOf("compliance_documents") < order.indexOf("attachments"),
    "compliance_documents.attachment_id references attachments",
  );
});

test("every table the seed writes is a table the purge clears", async () => {
  const source = await read("app/lib/seed/loader.ts");
  const purged = new Set(
    [...source.matchAll(/await record\("([a-z_]+)"/g)].map((match) => match[1]),
  );
  const reported = [...source.matchAll(/\{ table: "([a-z_]+)", rows:/g)].map((m) => m[1]);
  assert.ok(reported.length > 0, "the seed must report what it inserted");
  for (const table of reported) {
    assert.ok(purged.has(table), `${table} is written by the seed and never purged`);
  }
  /* And the two the seed writes without reporting a count for. */
  assert.ok(purged.has("maintenance_group_items"), "board placements are seeded rows too");
});

test("the purge finds a row by flag OR by id prefix, never by flag alone", async () => {
  /*
   * The third net. `is_seed` is the contract; the `zzdemo-` prefix catches a row
   * whose flag was never set — an insert that failed halfway, or a table
   * somebody added the columns to later. A purge that removed only the rows it
   * could prove were seeded would leave exactly the rows a purge exists for.
   */
  const source = await read("app/lib/seed/loader.ts");
  const body = source.slice(
    source.indexOf("async function deleteSeedRows"),
    source.indexOf("/** The bucket binding"),
  );
  const flagged = (body.match(/is_seed = \$\{1\}|isSeed, true/g) ?? []).length;
  const prefixed = (body.match(/like\(\w+\.\w+, prefix\)/g) ?? []).length;
  assert.ok(flagged >= 7, `expected the flag on every seed-marked table, found ${flagged}`);
  assert.ok(prefixed >= 10, `expected the prefix net on every table, found ${prefixed}`);
});

test("the boolean flag is bound and never written as a literal", async () => {
  /*
   * `db/sqlite-to-postgres.ts` rewrites boolean literals inside `INSERT …
   * VALUES` and does NOT rewrite them inside `UPDATE … SET`. A literal
   * `is_seed = 1` therefore works locally and answers "column is_seed is of
   * type boolean but expression is of type integer" deployed — the exact
   * one-codebase-two-databases trap this repository warns about.
   */
  const source = codeOnly(await read("app/lib/seed/loader.ts"));
  assert.match(source, /SET is_seed = \$\{1\}/, "the flag must be a bound parameter");
  assert.doesNotMatch(
    source,
    /SET is_seed = 1\b/,
    "a baked-in literal is rewritten for INSERT and not for UPDATE",
  );
});

/* ──────────────────────────────────── 4. the history the loader invents ── */

/**
 * `REMINDER_DEFAULTS_SEED`, read out of `db/init.ts` itself.
 *
 * Read rather than restated, because the point of this section is to check the
 * LOADER against `expected.ts`, and a third hand-written copy of the ladder
 * would only prove that the copy agrees with itself. If somebody changes the
 * seeded cascade in `db/init.ts`, these numbers move and this test is where the
 * disagreement surfaces.
 */
async function certificateDefaults() {
  const source = await read("db/init.ts");
  const start = source.indexOf("const REMINDER_DEFAULTS_SEED");
  assert.notEqual(start, -1, "REMINDER_DEFAULTS_SEED must still be where the harness looks");
  const block = source.slice(start, source.indexOf("\n];", start));
  const rows = [...block.matchAll(
    /\{ scope: "certificate", key: "([^"]+)", value: (-?\d+), direction: "([^"]+)", groups: (\[[^\]]*\]), repeat: (\d), interval: (\d+), cap: (\d+) \}/g,
  )];
  assert.equal(rows.length, 6, "the certificate cascade is six steps: 90, 60, 30, 14, expiry, overdue");
  return rows.map((match, index) => ({
    step_key: match[1],
    step_order: index,
    offset_value: Number(match[2]),
    offset_unit: "day",
    offset_direction: match[3],
    send_time: "08:00",
    recipient_groups_json: match[4].replace(/'/g, '"'),
    repeat_enabled: Number(match[5]),
    repeat_interval_days: Number(match[6]),
    repeat_cap: Number(match[7]),
    active: 1,
  }));
}

test("the loader's simulated cascade totals are the ones expected.ts predicts", async () => {
  /*
   * THE STRONGEST CHECK IN THIS FILE.
   *
   * §3.3 does not describe a fresh ladder; it describes an estate with history
   * — "2 escalations sent", "cap reached, flagged for review". `seededRuleState`
   * is where the loader invents that history, and `expected.ts` predicts the
   * totals from the specification with no knowledge of how a row is stored.
   * The two are compared here, through the PRODUCT'S OWN `cascadeFromDefaults`
   * and the real `REMINDER_DEFAULTS_SEED`, so a change to any of the three
   * shows up rather than cancelling out.
   */
  const defaults = await certificateDefaults();

  const pending = {};
  const dueToday = {};
  const sent = {};
  let escalations = 0;
  let capReached = 0;
  let cascading = 0;
  let rules = 0;

  for (const certificate of built.certificates) {
    if (certificate.expiryDate === null) continue;
    if (certificate.renewalStatus === "superseded") continue;
    cascading += 1;
    const offset = dataset.daysBetween(TODAY, certificate.expiryDate);
    for (const row of cascade.cascadeFromDefaults(defaults, certificate.expiryDate, "Europe/London")) {
      rules += 1;
      const state = loader.seededRuleState(row, offset, TODAY);
      /* `d90` in the database, `90` in the specification. One letter. */
      const step = row.stepKey.replace(/^d(?=\d)/, "");
      if (state.status === "sent") sent[step] = (sent[step] ?? 0) + 1;
      else if (dataset.daysBetween(TODAY, state.occurrenceDate) === 0)
        dueToday[step] = (dueToday[step] ?? 0) + 1;
      else pending[step] = (pending[step] ?? 0) + 1;

      if (step === "overdue") {
        escalations += state.sendsCount;
        if (state.sendsCount >= row.repeatCap) capReached += 1;
      }
    }
  }

  assert.equal(cascading, values.reminders.cascade_certificates, "48 dated, non-superseded");
  assert.equal(rules, cascading * 6, "one row per step per cascading certificate");

  /*
   * `expected.ts` initialises every step to zero; the tally above only creates
   * a key when it counts one. Zeroing the tally rather than pruning the
   * expectation, so a step that SHOULD be zero and is not still fails.
   */
  const zeroed = (counted) => {
    const filled = {};
    for (const step of Object.keys(values.reminders.by_step)) filled[step] = counted[step] ?? 0;
    return filled;
  };

  assert.deepEqual(zeroed(pending), values.reminders.by_step);
  assert.deepEqual(zeroed(dueToday), values.reminders.due_today_by_step);
  assert.deepEqual(zeroed(sent), values.reminders.sent_by_step);

  /* §3.3's own words, as numbers: 0 escalations at −1, 2 at −14, the cap at −60. */
  assert.equal(escalations, values.reminders.overdue_escalations_total);
  assert.equal(capReached, values.reminders.overdue_cap_reached);
});

test("the stored defaults are translated into the names the cascade reads", async () => {
  /*
   * A SEAM THAT WOULD HAVE FAILED SILENTLY.
   *
   * `cascadeFromDefaults` reads `ReminderDefaultRow`, whose fields are the
   * DATABASE's names — it was written to be handed rows straight off a
   * `d1.prepare(...).all()`. `listDefaults` goes through the drizzle query
   * builder and returns camelCase. Hand it over unmapped and every field reads
   * as `undefined` and falls back: offset 0, direction "before", no recipients,
   * repeats off — so all six steps land on the expiry date, every reminder
   * count in §4.1 is wrong, and nothing throws.
   *
   * The loader bridges it, so this asserts the bridge exists and that the
   * unmapped shape really is the disaster described.
   */
  const source = codeOnly(await read("app/lib/seed/loader.ts"));
  assert.match(source, /function asDefaultRow\(/, "the seam must be bridged in one place");
  assert.match(source, /\.map\(asDefaultRow\)/, "and every stored row must go through it");

  const anchor = dataset.addDays(TODAY, 30);
  const camelCase = [
    {
      stepKey: "d90",
      stepOrder: 0,
      offsetValue: 90,
      offsetUnit: "day",
      offsetDirection: "before",
      sendTime: "08:00",
      recipientGroupsJson: '["renewal-owner"]',
      repeatEnabled: false,
      repeatIntervalDays: 3,
      repeatCap: 10,
      active: true,
    },
  ];

  /* Unmapped: one step, on the anchor itself, reaching nobody. */
  const unmapped = cascade.cascadeFromDefaults(camelCase, anchor, "Europe/London");
  assert.equal(unmapped[0].offsetValue, 0, "the offset is lost");
  assert.deepEqual(unmapped[0].recipientGroups, [], "and so are the recipients");
  assert.equal(unmapped[0].nextSendAt.slice(0, 10), anchor, "so it would fire on the expiry date");

  /* Mapped, through the loader's own bridge: 90 days before, to one group. */
  const mapped = cascade.cascadeFromDefaults(
    camelCase.map((row) => ({
      step_key: row.stepKey,
      step_order: row.stepOrder,
      offset_value: row.offsetValue,
      offset_unit: row.offsetUnit,
      offset_direction: row.offsetDirection,
      send_time: row.sendTime,
      recipient_groups_json: row.recipientGroupsJson,
      repeat_enabled: row.repeatEnabled,
      repeat_interval_days: row.repeatIntervalDays,
      repeat_cap: row.repeatCap,
      active: row.active,
    })),
    anchor,
    "Europe/London",
  );
  assert.equal(mapped[0].offsetValue, 90);
  assert.deepEqual(mapped[0].recipientGroups, ["renewal-owner"]);
  assert.equal(mapped[0].nextSendAt.slice(0, 10), dataset.addDays(anchor, -90));
});

test("a step whose date has passed is written as sent, and only then", async () => {
  const defaults = await certificateDefaults();
  const row = cascade.cascadeFromDefaults(defaults, dataset.addDays(TODAY, 90), "Europe/London")
    .find((entry) => entry.stepKey === "d90");
  assert.ok(row, "the 90-day step must exist");

  /* A certificate expiring in exactly 90 days puts its 90-day step on TODAY. */
  const onTheDay = loader.seededRuleState(row, 90, TODAY);
  assert.equal(onTheDay.status, "pending", "due today has not been sent");
  assert.equal(onTheDay.sendsCount, 0);
  assert.equal(onTheDay.occurrenceDate, TODAY);

  /* And a day either side, so a shifted comparison cannot pass one and fail nothing. */
  const yesterday = cascade
    .cascadeFromDefaults(defaults, dataset.addDays(TODAY, 89), "Europe/London")
    .find((entry) => entry.stepKey === "d90");
  assert.equal(loader.seededRuleState(yesterday, 89, TODAY).status, "sent");

  const tomorrow = cascade
    .cascadeFromDefaults(defaults, dataset.addDays(TODAY, 91), "Europe/London")
    .find((entry) => entry.stepKey === "d90");
  assert.equal(loader.seededRuleState(tomorrow, 91, TODAY).status, "pending");
});

test("the overdue escalation count comes from the row, not from a constant", async () => {
  /*
   * `repeat_interval_days` and `repeat_cap` are DATA — an admin edits them. A
   * loader that hard-coded 7 and 8 would keep writing the old history after
   * somebody changed the ladder, and the reconciliation would then disagree for
   * a reason nobody could find.
   */
  const defaults = await certificateDefaults();
  const overdue = cascade
    .cascadeFromDefaults(defaults, dataset.addDays(TODAY, -60), "Europe/London")
    .find((entry) => entry.stepKey === "overdue");
  assert.equal(overdue.repeatIntervalDays, 7);
  assert.equal(overdue.repeatCap, 8);
  assert.equal(loader.seededRuleState(overdue, -60, TODAY).sendsCount, 8, "the cap");

  /* Halve the interval and the answer must double, capped. */
  const faster = { ...overdue, repeatIntervalDays: 30, repeatCap: 8 };
  assert.equal(loader.seededRuleState(faster, -60, TODAY).sendsCount, 2);

  const atFourteen = cascade
    .cascadeFromDefaults(defaults, dataset.addDays(TODAY, -14), "Europe/London")
    .find((entry) => entry.stepKey === "overdue");
  assert.equal(loader.seededRuleState(atFourteen, -14, TODAY).sendsCount, 2, "§3.3: 2 escalations");

  /* Each row must be built from ITS OWN certificate's anchor — the state is a
     fact about that row's date, not about the offset it is handed. */
  const atOne = cascade
    .cascadeFromDefaults(defaults, dataset.addDays(TODAY, -1), "Europe/London")
    .find((entry) => entry.stepKey === "overdue");
  assert.equal(
    loader.seededRuleState(atOne, -1, TODAY).status,
    "pending",
    "at −1 the overdue step is 6 days away and has not fired",
  );
  assert.equal(loader.seededRuleState(atOne, -1, TODAY).sendsCount, 0);
});

/* ─────────────────────────────── 5. the reconciler's own classification ── */

test("the app's ladder over the stored rows reproduces the harness's bands", async () => {
  /*
   * The reconciliation in miniature, and the one comparison that proves the
   * page is worth reading: `bandForStoredCertificate` goes through
   * `certificateExpiryBand`, the calendar's ladder, over rows shaped as the
   * database stores them — and lands on exactly the histogram `expected.ts`
   * computed from §3.3.
   */
  const counts = {};
  for (const certificate of built.certificates) {
    const band = reconcile.bandForStoredCertificate(
      { expiryDate: certificate.expiryDate, renewalStatus: certificate.renewalStatus },
      TODAY,
    );
    counts[band] = (counts[band] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    valid: 5,
    d90: 8,
    d60: 8,
    d30: 8,
    d14: 11,
    expired: 8,
    superseded: 2,
    undated: 10,
  });
  for (const [band, count] of Object.entries(values.certificates_by_window)) {
    assert.equal(counts[band] ?? 0, count, `${band} disagrees with expected.ts`);
  }
});

test("a stored certificate is read as superseded from the ROW, not from the date", async () => {
  /*
   * The documented divergence, asserted here rather than hidden. The
   * application's `certificateExpiryBand` takes a number of days and has no
   * superseded state; supersession is a fact about `renewal_status`, and a
   * screen that wants §3.3's seventh state has to read the row.
   */
  const expiry = dataset.addDays(TODAY, -120);
  assert.equal(
    reconcile.bandForStoredCertificate({ expiryDate: expiry, renewalStatus: "current" }, TODAY),
    "expired",
  );
  assert.equal(
    reconcile.bandForStoredCertificate({ expiryDate: expiry, renewalStatus: "superseded" }, TODAY),
    "superseded",
  );
  /* Case and padding, because `renewal_status` is text a person can type. */
  assert.equal(
    reconcile.bandForStoredCertificate({ expiryDate: expiry, renewalStatus: " Superseded " }, TODAY),
    "superseded",
  );
});

test("a timestamp column and a date column read as the same day", async () => {
  /*
   * `due_at` is written as `YYYY-MM-DD` and `requested_at` as a full ISO
   * instant, and the register has rows of both shapes from the monday import.
   * A comparison that did not slice would put a job in the wrong SLA bucket for
   * every row of the other shape.
   */
  const asDate = reconcile.bandForStoredCertificate(
    { expiryDate: dataset.addDays(TODAY, 90), renewalStatus: null },
    TODAY,
  );
  const asTimestamp = reconcile.bandForStoredCertificate(
    { expiryDate: `${dataset.addDays(TODAY, 90)}T23:30:00.000Z`, renewalStatus: null },
    TODAY,
  );
  assert.equal(asDate, "d90");
  assert.equal(asTimestamp, "d90", "a late-evening timestamp is still the same day");
});

test("the comparison decides red, green and grey and nothing else", () => {
  const pass = reconcile.compareMetric({
    key: "k", section: "s", metric: "m", expected: 5, actual: 5, query: "q",
  });
  assert.equal(pass.status, "pass");
  assert.equal(pass.difference, 0);

  const fail = reconcile.compareMetric({
    key: "k", section: "s", metric: "m", expected: 5, actual: 4, query: "q",
  });
  assert.equal(fail.status, "fail");
  assert.equal(fail.difference, -1, "the sign says which way, which is half the diagnosis");

  /*
   * A metric this schema cannot answer is NOT a pass. §3.2's twenty contacts
   * have no table; showing them green would be the kind of number this whole
   * harness exists to catch.
   */
  const unmeasured = reconcile.compareMetric({
    key: "k", section: "s", metric: "m", expected: 20, actual: null, query: "q",
  });
  assert.equal(unmeasured.status, "not-measured");
  assert.equal(unmeasured.difference, null);

  const summary = reconcile.summarise([pass, fail, unmeasured]);
  assert.deepEqual(summary, { passed: 1, failed: 1, notMeasured: 1, passRate: 50 });
  assert.equal(
    reconcile.summarise([unmeasured]).passRate,
    null,
    "a pass rate over nothing measured is not 100%, it is not a number",
  );
});

test("the record ids are capped, so a failing row is diagnosable and not a dump", () => {
  const many = Array.from({ length: 400 }, (_, index) => `zzdemo-job-${index}`);
  const row = reconcile.compareMetric({
    key: "k", section: "s", metric: "m", expected: 1, actual: 2, query: "q", actualIds: many,
  });
  assert.equal(row.actualIds.length, 25);
});

/* ──────────────────────────────────────────── 6. the attachment fixtures ── */

test("a seeded PDF is a real one-page document of the stated length", () => {
  const descriptor = built.attachments.find((file) => file.mimeType === "application/pdf");
  assert.ok(descriptor, "the dataset must carry PDF fixtures");
  const bytes = loader.seedFileBytes(descriptor);
  assert.equal(bytes.byteLength, descriptor.byteLength, "byte_size must be the truth");

  const text = Buffer.from(bytes).toString("latin1");
  assert.match(text, /^%PDF-1\.4\n/, "a viewer reads the header first");
  assert.match(text, /%%EOF\n$/, "and the trailer last");
  assert.match(text, /\/Type\/Page\b/, "one page, so the evidence viewer has something to open");
});

test("the fixture bytes are deterministic, which is what makes a bug report usable", () => {
  for (const descriptor of built.attachments.slice(0, 8)) {
    const first = loader.seedFileBytes(descriptor);
    const second = loader.seedFileBytes(descriptor);
    assert.deepEqual(Buffer.from(first), Buffer.from(second));
    assert.equal(first.byteLength, descriptor.byteLength);
  }
  /* Two different fixtures must not be the same bytes, or the filler is a
     constant and the seed is not exercising distinct objects. */
  const [a, b] = built.attachments.filter((file) => file.mimeType === "image/jpeg");
  assert.notDeepEqual(Buffer.from(loader.seedFileBytes(a)), Buffer.from(loader.seedFileBytes(b)));
});

test("the object key is prefixed so a bucket listing can find and purge it", async () => {
  const descriptor = built.attachments[0];
  const key = loader.seedObjectKey(built.seedBatchId, descriptor);
  assert.ok(key.startsWith(`${loader.SEED_ORGANISATION_ID}/seed/${built.seedBatchId}/`));
  assert.match(key, /zzdemo-file-\d+/);

  /*
   * Objects are removed BY PREFIX and never by ids remembered from the rows.
   * The rows are deleted in the same operation, so a purge that listed keys out
   * of the database first would leave one object behind for every row that had
   * already gone — the exact orphan `is_seed` on `attachments` exists to find.
   */
  const source = codeOnly(await read("app/lib/seed/loader.ts"));
  assert.match(source, /bucket\.list\(\{ prefix/, "the purge lists by prefix");
  assert.match(source, /\$\{SEED_ORGANISATION_ID\}\/seed\//, "under the demo organisation's own prefix");
});

/* ──────────────────────────────────────────────────────── 7. seed:travel ── */

test("travelling rebuilds at a later day rather than shifting stored dates", async () => {
  /*
   * §5: "seed:travel is how you test the cascade without waiting 90 days".
   * Adding 30 to every stored date would move the certificates and the clock
   * together and change nothing; rebuilding at a later `today` is what carries
   * a certificate across a band boundary, which is the whole exercise.
   */
  assert.equal(loader.travelTo(TODAY, 30), "2026-10-05");
  assert.equal(loader.travelTo(TODAY, -30), "2026-08-06");
  assert.equal(loader.travelTo(TODAY, 0), TODAY);

  const future = dataset.buildSeedDataset(loader.travelTo(TODAY, 30));
  const futureValues = expected.computeExpectedValues(future, loader.travelTo(TODAY, 30));
  assert.deepEqual(
    futureValues.certificates_by_window,
    values.certificates_by_window,
    "the bands hold, because the whole estate moved with the clock — which is what makes seed:travel a test of the CASCADE and not of the bands",
  );
  assert.notEqual(future.seedBatchId, built.seedBatchId, "a different day is a different batch");

  const source = proseOnly(await read("app/lib/seed/loader.ts"));
  assert.match(source, /REBUILDING AT A DIFFERENT `today`/);
});

/* ─────────────────────────────────────────────── 8. the commands and page ── */

test("package.json carries the five commands §5 names, and nothing else moved", async () => {
  const raw = await read("package.json");
  const parsed = JSON.parse(raw);
  assert.deepEqual(
    {
      seed: parsed.scripts.seed,
      "seed:purge": parsed.scripts["seed:purge"],
      "seed:verify": parsed.scripts["seed:verify"],
      "seed:cron": parsed.scripts["seed:cron"],
      "seed:travel": parsed.scripts["seed:travel"],
    },
    {
      seed: "node scripts/seed.mjs seed",
      "seed:purge": "node scripts/seed.mjs purge",
      "seed:verify": "node scripts/seed.mjs verify",
      "seed:cron": "node scripts/seed.mjs cron",
      "seed:travel": "node scripts/seed.mjs travel",
    },
  );
  /* The file's own line endings are CRLF and there is no .gitattributes; a
     rewrite that normalised them would make the diff unreadable. */
  assert.ok(raw.includes("\r\n"), "package.json is CRLF and must stay CRLF");
});

test("seed:verify exits non-zero on a mismatch, because CI branches on that", async () => {
  const source = await read("scripts/seed.mjs");
  assert.match(source, /process\.exit\(body\.report\.failed > 0 \? 1 : 0\)/);
  /* And the script itself enforces nothing: the gates live on the route, where
     they cannot be skipped by running a different script. */
  assert.doesNotMatch(
    codeOnly(source),
    /assertPurgeAllowed|assertEmailModeSafe/,
    "scripts/seed.mjs must not re-implement a guard; it prints the server's refusal",
  );
});

test("seed:cron drives the real dispatcher rather than a second copy of one", async () => {
  const source = await read("scripts/seed.mjs");
  assert.match(source, /\/api\/cron\/reminders/);
  /*
   * The word `sendNotification` appears in what the script PRINTS, telling the
   * operator where the kill switch lives. What must not appear is a call to
   * one, or a mail transport of its own: a second place that decides whether
   * mail leaves the building is a second place to get it wrong.
   */
  assert.doesNotMatch(codeOnly(source), /sendNotification\s*\(/);
  assert.doesNotMatch(codeOnly(source), /(nodemailer|resend|smtp|sendgrid|postmark)/i);
  assert.doesNotMatch(
    codeOnly(source),
    /reminder_dispatch|claimDispatch/,
    "the script must not reach past the endpoint into the dispatch ledger",
  );
});

test("the panel shows §4.2's five columns, the headline and the re-run", async () => {
  const source = await read("app/(app)/portal/views/reconcile-panel.tsx");
  for (const column of ["Metric", "Expected", "Actual", "Difference", "Result"]) {
    assert.match(source, new RegExp(`>\\s*\\n?\\s*${column}\\s*\\n?\\s*<`), `the ${column} column`);
  }
  assert.match(source, /Pass rate/);
  assert.match(source, /Failures/);
  assert.match(source, /Re-run/);
  assert.match(source, /Last run \{timeText\(report\.ranAt\)\}/, "and when it last ran");
  /* A failing row expands to the query and the ids behind both sides. */
  assert.match(source, /Expected records/);
  assert.match(source, /Actual records/);
  assert.match(source, /row\.query/);
});

test("colour is never the only signal on the reconciliation table", async () => {
  /*
   * A red cross and a green tick are unreadable to a reader who cannot separate
   * the hues. Every row carries the word as well, and the difference column
   * carries a sign.
   */
  const source = await read("app/(app)/portal/views/reconcile-panel.tsx");
  assert.match(source, /pass: "Pass"/);
  assert.match(source, /fail: "Fail"/);
  assert.match(source, /"not-measured": "Not measured"/);
  assert.match(source, /row\.difference > 0 \? `\+\$\{row\.difference\}`/);
});

test("the panel's stylesheet uses tokens and only the agreed breakpoints", async () => {
  const css = await read("app/(app)/portal/views/reconcile-panel.css");

  const widths = [...css.matchAll(/@media[^{]*?(\d+)px/g)].map((match) => match[1]);
  for (const width of widths) {
    assert.ok(
      ["640", "767", "768", "1024", "1280"].includes(width),
      `${width}px is not one of the five widths this repository allows`,
    );
  }

  /*
   * No colour literals. The workspace has a dark theme, and a hex in a view
   * stylesheet is a colour that is right in one theme and wrong in the other —
   * which is how the neutral chip ended up at 1.39:1 on white.
   */
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(declarations, /#[0-9a-fA-F]{3,8}\b/, "no hex colours");
  assert.doesNotMatch(declarations, /\brgba?\(/, "no raw rgb() either");
  assert.match(declarations, /var\(--red-600\)/);
  assert.match(declarations, /var\(--green-700\)/);
});

/* ───────────────────────────────────────────────── 9. against the server ── */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";

async function reachable() {
  try {
    const response = await fetch(`${BASE}/api/admin/reconcile`, {
      headers: { cookie: "maintsupp_demo_role=super_admin" },
    });
    return response.status !== 404;
  } catch {
    return false;
  }
}

test("the live routes exist and answer the guards, not a stack trace", async (t) => {
  /*
   * Skips rather than fails with no server, like the other ~32 live suites.
   *
   * What this proves is narrow and worth having: that both routes are mounted,
   * that the capability check resolves, and that a deployment which has not
   * said what it is gets the guard's own sentence rather than a 500. On the
   * local Miniflare dev server no environment variable is readable at all —
   * `.dev.vars` reaches neither `process.env` nor the worker bindings there,
   * which is also why `/api/cron/reminders` answers "CRON_SECRET is unset" — so
   * the refusal below IS the expected local outcome, and the seeding path can
   * only be exercised where variables reach the runtime.
   */
  if (!(await reachable())) {
    t.skip("no dev server on " + BASE);
    return;
  }

  const cookie = "maintsupp_demo_role=super_admin";

  const reconcileResponse = await fetch(`${BASE}/api/admin/reconcile`, { headers: { cookie } });
  assert.ok(
    [200, 403].includes(reconcileResponse.status),
    `expected 200 or a guarded 403, got ${reconcileResponse.status}`,
  );
  const reconcileBody = await reconcileResponse.json();
  if (reconcileResponse.status === 403) {
    assert.ok(Array.isArray(reconcileBody.checks), "a refusal must name both checks");
    assert.equal(reconcileBody.checks.length, 2, "two checks, always both evaluated");
    assert.ok(
      reconcileBody.checks.some((check) => check.name === "database"),
      "including the one that asked the database who it is",
    );
  } else {
    assert.ok(Array.isArray(reconcileBody.report.rows));
  }

  const seedResponse = await fetch(`${BASE}/api/admin/seed`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ action: "verify" }),
  });
  assert.ok(
    [200, 403, 409].includes(seedResponse.status),
    `expected 200, 409 or a guarded 403, got ${seedResponse.status}`,
  );
});

test("an unknown action is refused before anything is read", async (t) => {
  if (!(await reachable())) {
    t.skip("no dev server on " + BASE);
    return;
  }
  const response = await fetch(`${BASE}/api/admin/seed`, {
    method: "POST",
    headers: { cookie: "maintsupp_demo_role=super_admin", "content-type": "application/json" },
    body: JSON.stringify({ action: "drop-everything" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /action must be one of/);
});
