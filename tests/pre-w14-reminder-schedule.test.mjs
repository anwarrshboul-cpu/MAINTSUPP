/**
 * THE REMINDER ENGINE'S CORE MODEL — the arithmetic, the people and the ladder.
 *
 * Two acceptance criteria in the spec cannot be checked by looking at a screen,
 * because both of them are about a moment months away:
 *
 *   "An 08:00 reminder still sends at 08:00 local after the October clock
 *    change."
 *   "The same address must never receive two copies of one reminder."
 *
 * The first is the reason this file exists. A cascade anchored on a December
 * expiry has its 90-day step in BST and its 14-day step in GMT, so the two rows
 * must carry DIFFERENT UTC instants — 07:00Z and 08:00Z — to mean the same
 * thing to the person reading the email. Every plausible wrong implementation
 * (store the instant, add 86_400_000 × N, format at render time) passes a test
 * written in June and fails in November, which is why the fixtures below are
 * pinned to real dates either side of 25 October 2026 rather than to "today".
 *
 * The boundaries are the point throughout: the spring gap where a local time
 * does not exist, the autumn hour that happens twice, the cap that stops a
 * repeat, and the acknowledgement that stops it sooner. A test that asserted
 * "roughly 90 days before, roughly 8am" would catch none of them.
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

/*
 * Pure and importing nothing but each other, which is what lets all three be
 * loaded on their own — the same stubbing the other pre-W14 suites do, with
 * `cascade.ts`'s two relative imports pointed at the transpiled siblings.
 */
const scheduleUrl = asModule(transpile(await read("app/lib/reminders/schedule.ts")));
const recipientsUrl = asModule(transpile(await read("app/lib/reminders/recipients.ts")));

const schedule = await import(scheduleUrl);
const recipients = await import(recipientsUrl);
const cascade = await import(
  asModule(
    transpile(await read("app/lib/reminders/cascade.ts"))
      .replace(/from ["']\.\/schedule["']/g, `from "${scheduleUrl}"`)
      .replace(/from ["']\.\/recipients["']/g, `from "${recipientsUrl}"`),
  )
);

const LONDON = "Europe/London";
const ON_THE_DAY = { value: 0, unit: "day", direction: "on" };
const daysBefore = (value) => ({ value, unit: "day", direction: "before" });
const iso = (instant) => (instant ? instant.toISOString() : null);

/* ═══════════════════════════════════════ 1. the clock change, both sides ══ */

test("08:00 Europe/London is 07:00Z in BST and 08:00Z in GMT", () => {
  /*
   * The single assertion the whole engine rests on. These are not two
   * formattings of one instant — they are two DIFFERENT instants that a reader
   * in London experiences as the same time of day, which is exactly why the
   * wall clock has to be the stored intent and the instant the derived value.
   */
  const summer = schedule.reminderOccurrenceUtc("2026-06-15", ON_THE_DAY, "08:00", LONDON);
  assert.equal(iso(summer), "2026-06-15T07:00:00.000Z", "British Summer Time is UTC+1");
  assert.equal(schedule.wallClockInZone(summer, LONDON).time, "08:00");
  assert.equal(schedule.wallClockInZone(summer, LONDON).zoneLabel, "BST");

  const winter = schedule.reminderOccurrenceUtc("2026-12-15", ON_THE_DAY, "08:00", LONDON);
  assert.equal(iso(winter), "2026-12-15T08:00:00.000Z", "GMT is UTC+0");
  assert.equal(schedule.wallClockInZone(winter, LONDON).time, "08:00");
  assert.equal(schedule.wallClockInZone(winter, LONDON).zoneLabel, "GMT");
});

test("both 2026 transition days resolve, and neither drops an hour", () => {
  /* 29 March: the clocks went forward at 01:00 UTC, so 08:00 local is already
     BST. 25 October: they went back at 01:00 UTC, so 08:00 local is GMT. */
  assert.equal(
    iso(schedule.reminderOccurrenceUtc("2026-03-29", ON_THE_DAY, "08:00", LONDON)),
    "2026-03-29T07:00:00.000Z",
  );
  assert.equal(
    iso(schedule.reminderOccurrenceUtc("2026-10-25", ON_THE_DAY, "08:00", LONDON)),
    "2026-10-25T08:00:00.000Z",
  );
  /* And the day either side of each, so a one-day error in the transition
     lookup cannot hide behind a correct answer on the boundary itself. */
  assert.equal(
    iso(schedule.reminderOccurrenceUtc("2026-03-28", ON_THE_DAY, "08:00", LONDON)),
    "2026-03-28T08:00:00.000Z",
    "the Saturday before is still GMT",
  );
  assert.equal(
    iso(schedule.reminderOccurrenceUtc("2026-10-24", ON_THE_DAY, "08:00", LONDON)),
    "2026-10-24T07:00:00.000Z",
    "the Saturday before is still BST",
  );
});

test("a local time that does not exist is shifted forward, never dropped", () => {
  /*
   * 01:30 on 29 March 2026 is not a moment. Returning null would let a row
   * configured for 01:30 vanish once a year with no error anywhere; shifting
   * it forward by the gap sends it at 02:30, which is late by half an hour and
   * visible in the preview panel.
   */
  const gap = schedule.zonedWallClockToUtc("2026-03-29", "01:30", LONDON);
  assert.equal(iso(gap), "2026-03-29T01:30:00.000Z");
  const local = schedule.wallClockInZone(gap, LONDON);
  assert.equal(local.time, "02:30", "the skipped hour becomes the hour after it");
  assert.equal(local.date, "2026-03-29", "and it stays on the day it was asked for");
});

test("a local time that happens twice takes the earlier instant", () => {
  /*
   * 01:30 on 25 October 2026 occurs at 00:30Z in BST and again at 01:30Z in
   * GMT. Taking the first means a reminder is never quietly an hour late, and
   * — with `occurrenceKey` on the local day — the second occurrence cannot
   * produce a duplicate send either.
   */
  const ambiguous = schedule.zonedWallClockToUtc("2026-10-25", "01:30", LONDON);
  assert.equal(iso(ambiguous), "2026-10-25T00:30:00.000Z");
  assert.equal(schedule.wallClockInZone(ambiguous, LONDON).zoneLabel, "BST");
});

/* ══════════════════════════ 2. a cascade straddling the October change ══ */

test("the 90-day and 14-day steps land either side of October and both read 08:00", () => {
  /*
   * THE ACCEPTANCE CRITERION, as a cascade rather than as a single conversion.
   *
   * A certificate expiring 1 December 2026 puts its 90-day step on 2 September
   * (BST) and its 14-day step on 17 November (GMT). The clocks change between
   * them. Two different UTC instants, one wall clock — and if the two ever
   * agree on the instant, one of the two emails arrives at the wrong hour.
   */
  const rows = cascade.cascadeFromDefaults(
    [
      { step_key: "90-day", step_order: 1, offset_value: 90, offset_direction: "before", send_time: "08:00" },
      { step_key: "14-day", step_order: 4, offset_value: 14, offset_direction: "before", send_time: "08:00" },
    ],
    "2026-12-01",
    LONDON,
  );

  const byStep = Object.fromEntries(rows.map((row) => [row.stepKey, row]));
  assert.equal(iso(byStep["90-day"].occurrenceUtc), "2026-09-02T07:00:00.000Z");
  assert.equal(iso(byStep["14-day"].occurrenceUtc), "2026-11-17T08:00:00.000Z");
  assert.notEqual(
    byStep["90-day"].occurrenceUtc.getUTCHours(),
    byStep["14-day"].occurrenceUtc.getUTCHours(),
    "the two instants MUST differ, or one of them is an hour out",
  );

  const preview = cascade.previewCascade(rows, LONDON, new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(
    preview.map((entry) => [entry.stepKey, entry.localDate, entry.localTime, entry.zoneLabel]),
    [
      ["90-day", "2026-09-02", "08:00", "BST"],
      ["14-day", "2026-11-17", "08:00", "GMT"],
    ],
    "chronological, and 08:00 local on both sides of the clock change",
  );
  assert.ok(preview.every((entry) => entry.willSend && entry.warning === null));
});

test("the ladder's day arithmetic is exact, and a month offset clamps", () => {
  /* 90 days before 1 December is 2 September — a UTC-midnight subtraction. A
     local-instant subtraction lands on 23:00 the day before and turns 90 into
     89 the moment a clock change sits between the two dates. */
  assert.equal(schedule.shiftIsoDate("2026-12-01", daysBefore(90)), "2026-09-02");
  assert.equal(schedule.shiftIsoDate("2026-12-01", daysBefore(14)), "2026-11-17");
  assert.equal(schedule.shiftIsoDate("2026-11-01", daysBefore(8)), "2026-10-24");
  assert.equal(
    schedule.shiftIsoDate("2028-03-01", daysBefore(1)),
    "2028-02-29",
    "and it knows about leap days",
  );
  assert.equal(
    schedule.shiftIsoDate("2026-05-31", { value: 3, unit: "month", direction: "before" }),
    "2026-02-28",
    "three months before 31 May is the last of February, not the 3rd of March",
  );
  assert.equal(
    schedule.shiftIsoDate("2026-12-01", { value: 2, unit: "week", direction: "before" }),
    "2026-11-17",
  );
  assert.equal(
    schedule.shiftIsoDate("2026-12-01", { value: 90, unit: "day", direction: "on" }),
    "2026-12-01",
    "'on the day' ignores the value rather than letting a stray one move it",
  );
  assert.equal(schedule.shiftIsoDate("2026-02-31", daysBefore(1)), null, "no such date");
});

/* ═════════════════════════════════════════════════════ 3. quiet hours ══ */

const QUIET = { enabled: true, timezone: LONDON };

test("quiet hours defer a 22:00 send forward rather than dropping it", () => {
  /*
   * §7.4 defers, it never cancels. A suppressed reminder that is merely skipped
   * is a compliance certificate nobody was told about, and the row still reads
   * as though the system did its job.
   */
  const late = schedule.zonedWallClockToUtc("2026-11-18", "22:00", LONDON);
  assert.equal(schedule.isWithinQuietHours(late, QUIET), true, "22:00 is outside 07:00–19:00");

  const deferred = schedule.deferPastQuietHours(late, QUIET);
  assert.equal(iso(deferred), "2026-11-19T07:00:00.000Z");
  assert.equal(schedule.wallClockInZone(deferred, LONDON).time, "07:00");
  assert.ok(deferred.getTime() > late.getTime(), "forward, always — never backwards");
  assert.equal(schedule.isWithinQuietHours(deferred, QUIET), false);
});

test("an early send waits for the same morning, and the window's edges are fixed", () => {
  const early = schedule.zonedWallClockToUtc("2026-11-18", "05:00", LONDON);
  assert.equal(
    iso(schedule.deferPastQuietHours(early, QUIET)),
    "2026-11-18T07:00:00.000Z",
    "before the window opens, today still has a slot",
  );

  const open = schedule.zonedWallClockToUtc("2026-11-18", "07:00", LONDON);
  assert.equal(schedule.isWithinQuietHours(open, QUIET), false, "07:00 sends");
  assert.equal(
    iso(schedule.deferPastQuietHours(open, QUIET)),
    iso(open),
    "a permitted instant is returned untouched",
  );

  const close = schedule.zonedWallClockToUtc("2026-11-18", "19:00", LONDON);
  assert.equal(schedule.isWithinQuietHours(close, QUIET), true, "the window is half-open");
  assert.equal(
    schedule.isWithinQuietHours(schedule.zonedWallClockToUtc("2026-11-18", "18:59", LONDON), QUIET),
    false,
  );
});

test("weekend suppression carries a Friday night send to Monday morning", () => {
  const friday = schedule.zonedWallClockToUtc("2026-11-20", "22:00", LONDON);
  const settings = { ...QUIET, suppressWeekends: true };
  const deferred = schedule.deferPastQuietHours(friday, settings);
  assert.equal(iso(deferred), "2026-11-23T07:00:00.000Z", "Saturday and Sunday are skipped");
  assert.equal(schedule.wallClockInZone(deferred, LONDON).weekday, 1, "Monday");

  /* And with weekends permitted it is simply the next morning. */
  assert.equal(
    iso(schedule.deferPastQuietHours(friday, QUIET)),
    "2026-11-21T07:00:00.000Z",
  );
});

test("quiet hours are off unless an admin turned them on", () => {
  const late = schedule.zonedWallClockToUtc("2026-11-18", "22:00", LONDON);
  for (const settings of [null, undefined, {}, { enabled: false }]) {
    assert.equal(schedule.isWithinQuietHours(late, settings), false);
    assert.equal(iso(schedule.deferPastQuietHours(late, settings)), iso(late));
  }
});

/* ════════════════════════════════════════════════ 4. idempotency key ══ */

test("the occurrence key is the LOCAL day, so a double-fire is refused", () => {
  /*
   * `UNIQUE(reminder_id, occurrence_date)` only helps if two attempts at the
   * same send compute the same string. They do, because the key is derived from
   * the occurrence instant and not from when the cron happened to wake up.
   */
  const occurrence = schedule.reminderOccurrenceUtc("2026-11-17", ON_THE_DAY, "08:00", LONDON);
  assert.equal(schedule.occurrenceKey(occurrence, LONDON), "2026-11-17");
  assert.equal(
    schedule.occurrenceKey(new Date(occurrence.getTime()), LONDON),
    schedule.occurrenceKey(occurrence, LONDON),
    "the same occurrence keys the same however many times it is asked",
  );

  /* A 00:30 BST send is 23:30Z the day before. The key follows the LOCAL day,
     because that is the date the reader saw in the email. */
  const justAfterMidnight = schedule.zonedWallClockToUtc("2026-06-15", "00:30", LONDON);
  assert.equal(iso(justAfterMidnight), "2026-06-14T23:30:00.000Z");
  assert.equal(schedule.occurrenceKey(justAfterMidnight, LONDON), "2026-06-15");

  /* A three-day repeat lands on a different day, so the constraint that blocks
     the duplicate does not also block the chase. */
  const first = schedule.zonedWallClockToUtc("2026-11-17", "08:00", LONDON);
  const second = schedule.zonedWallClockToUtc("2026-11-20", "08:00", LONDON);
  assert.notEqual(schedule.occurrenceKey(first, LONDON), schedule.occurrenceKey(second, LONDON));
});

/* ═══════════════════════════════════════════════ 5. repeat until ack ══ */

const repeating = (overrides = {}) => ({
  repeat_enabled: 1,
  repeat_interval_days: 3,
  repeat_cap: 10,
  sends_count: 0,
  send_time: "08:00",
  timezone: LONDON,
  status: "pending",
  acknowledged_at: null,
  ...overrides,
});

test("a repeat re-fires on its interval, at the same local time", () => {
  const lastSent = schedule.zonedWallClockToUtc("2026-11-17", "08:00", LONDON);
  assert.equal(
    iso(schedule.nextRepeatOccurrence(repeating({ sends_count: 1 }), lastSent)),
    "2026-11-20T08:00:00.000Z",
  );

  /* Across the October change: three days after 08:00 BST on 24 October is
     08:00 GMT on 27 October, which is 73 hours later, not 72. Adding
     milliseconds would send this one at 07:00. */
  const beforeChange = schedule.zonedWallClockToUtc("2026-10-24", "08:00", LONDON);
  const next = schedule.nextRepeatOccurrence(repeating({ sends_count: 1 }), beforeChange);
  assert.equal(iso(next), "2026-10-27T08:00:00.000Z");
  assert.equal(schedule.wallClockInZone(next, LONDON).time, "08:00");
  assert.equal(next.getTime() - beforeChange.getTime(), 73 * 3_600_000);
});

test("a repeat stops at its cap and stops immediately on acknowledgement", () => {
  const lastSent = schedule.zonedWallClockToUtc("2026-11-17", "08:00", LONDON);

  assert.ok(schedule.nextRepeatOccurrence(repeating({ sends_count: 9 }), lastSent), "9 of 10");
  assert.equal(
    schedule.nextRepeatOccurrence(repeating({ sends_count: 10 }), lastSent),
    null,
    "the cap is a hard stop, not a soft one",
  );
  assert.equal(schedule.nextRepeatOccurrence(repeating({ sends_count: 11 }), lastSent), null);

  /* Acknowledgement wins over everything, including a cap with nine sends left.
     Somebody has said "I have this" — continuing is how an alert gets muted. */
  assert.equal(
    schedule.nextRepeatOccurrence(
      repeating({ sends_count: 1, acknowledged_at: "2026-11-17T09:14:00.000Z" }),
      lastSent,
    ),
    null,
    "acknowledged stops the loop on this step",
  );
  assert.equal(
    schedule.nextRepeatOccurrence(repeating({ sends_count: 1, status: "acknowledged" }), lastSent),
    null,
  );
  assert.equal(
    schedule.nextRepeatOccurrence(repeating({ sends_count: 1, status: "cancelled" }), lastSent),
    null,
  );
  assert.equal(
    schedule.nextRepeatOccurrence(repeating({ repeat_enabled: 0 }), lastSent),
    null,
    "off by default, and off means off",
  );
});

test("both databases' idea of true is understood", () => {
  /*
   * The same row is SQLite `1` locally and a Postgres boolean deployed. A
   * `=== 1` here would leave every repeat silently disabled on exactly one of
   * the two, which is the class of bug `db/sqlite-to-postgres.ts` exists for.
   */
  const lastSent = schedule.zonedWallClockToUtc("2026-11-17", "08:00", LONDON);
  for (const truthy of [1, true, "1", "true"]) {
    assert.ok(
      schedule.nextRepeatOccurrence(repeating({ repeat_enabled: truthy }), lastSent),
      `${JSON.stringify(truthy)} enables the repeat`,
    );
  }
  for (const falsy of [0, false, "0", "false", null, undefined]) {
    assert.equal(
      schedule.nextRepeatOccurrence(repeating({ repeat_enabled: falsy }), lastSent),
      null,
      `${JSON.stringify(falsy)} does not`,
    );
  }
});

test("a date in the past is flagged and never sent", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  const past = schedule.reminderOccurrenceUtc("2026-11-17", ON_THE_DAY, "08:00", LONDON);
  const future = schedule.reminderOccurrenceUtc("2026-11-18", ON_THE_DAY, "08:00", LONDON);
  assert.equal(schedule.isPastAndWillNotSend(past, now), true);
  assert.equal(schedule.isPastAndWillNotSend(future, now), false);
  assert.equal(schedule.isPastAndWillNotSend(now, now), false, "this instant has not passed");
  assert.equal(
    schedule.isPastAndWillNotSend(null, now),
    true,
    "a row with no calculable date is not sent either",
  );
});

/* ══════════════════════════════════════════════════════ 6. recipients ══ */

test("the same address never receives two copies, whatever its case", () => {
  /*
   * THE ACCEPTANCE CRITERION. The 14-day step's default recipients are the
   * renewal owner, the internal team, the client contact and the escalation
   * contact, and in a small operation those are frequently one person reached
   * four ways.
   */
  const resolved = recipients.resolveRecipients(
    [
      { group_key: "renewal-owner" },
      { group_key: "escalation-contact" },
      { email: "Foo@Example.com" },
      { email: "foo@example.com" },
      { email: "  FOO@EXAMPLE.COM  " },
    ],
    {
      groups: {
        "renewal-owner": { email: "foo@example.com", name: "Fran Owner" },
        "escalation-contact": [{ email: "FOO@example.com" }],
      },
    },
  );

  assert.equal(resolved.length, 1, "one mailbox, one email");
  assert.equal(resolved[0].email, "foo@example.com", "stored lowercased, so the log matches");
  assert.equal(resolved[0].name, "Fran Owner", "the name survives the de-duplication");
  assert.deepEqual(
    resolved[0].sources,
    ["renewal-owner", "escalation-contact", "direct"],
    "every route is recorded even though only one email is sent",
  );
});

test("groups are expanded from the context, in row order, at send time", () => {
  const resolved = recipients.resolveRecipients(
    [
      { group_key: "renewal-owner" },
      { group_key: "internal-team" },
      { user_id: "u-3" },
      { email: "external@contractor.co.uk" },
    ],
    {
      users: [
        { userId: "u-3", email: "cara@maintauk.co.uk", name: "Cara" },
        { userId: "u-9", email: "unused@maintauk.co.uk" },
      ],
      groups: {
        "renewal-owner": { userId: "u-9" },
        "internal-team": [
          { email: "alec@maintauk.co.uk", name: "Alec" },
          { email: "bea@maintauk.co.uk", name: "Bea" },
        ],
      },
    },
  );

  assert.deepEqual(
    resolved.map((entry) => entry.email),
    [
      "unused@maintauk.co.uk",
      "alec@maintauk.co.uk",
      "bea@maintauk.co.uk",
      "cara@maintauk.co.uk",
      "external@contractor.co.uk",
    ],
    "a group named by id alone is filled in from the user list",
  );
});

test("an empty group and an unknown one are reported, not silently dropped", () => {
  const plan = recipients.resolveRecipientPlan(
    [
      { group_key: "site-contact" },
      { group_key: "Renewal Owner" },
      { group_key: "the-night-manager" },
      { email: "not-an-address" },
      { user_id: "missing" },
    ],
    { groups: { "renewal-owner": { email: "fran@example.com" } } },
  );

  assert.deepEqual(plan.recipients.map((entry) => entry.email), ["fran@example.com"]);
  assert.deepEqual(plan.emptyGroups, ["site-contact"], "a role nobody holds is an operational hole");
  assert.deepEqual(plan.unknownGroups, ["the-night-manager"]);
  assert.deepEqual(
    plan.invalid.map((entry) => entry.value),
    ["not-an-address", "missing"],
  );
});

test("address validation is strict enough to catch a domain that cannot deliver", () => {
  for (const good of [
    "a@b.co",
    "fran.owner@maintauk.co.uk",
    "fran+renewals@example.com",
    "FRAN@EXAMPLE.COM",
    "  fran@example.com  ",
  ]) {
    assert.equal(recipients.isValidRecipientEmail(good), true, `${good} is deliverable`);
  }
  for (const bad of [
    "ops@maintauk",
    "ops@maintauk.",
    "@example.com",
    "ops@",
    "ops example@x.com",
    "ops@@example.com",
    ".ops@example.com",
    "ops..two@example.com",
    "",
    "   ",
    null,
    undefined,
    42,
  ]) {
    assert.equal(recipients.isValidRecipientEmail(bad), false, `${String(bad)} must block save`);
  }
});

test("save is blocked on a malformed address but not on an empty group", () => {
  /* A group that is empty today is still valid to save — resolving it late is
     the entire argument for dynamic groups. A typo never becomes valid. */
  assert.equal(recipients.validateRecipientRows([{ group_key: "site-contact" }]).ok, true);
  const blocked = recipients.validateRecipientRows([{ email: "ops@maintauk" }]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.invalid[0].value, "ops@maintauk");
  assert.equal(recipients.validateRecipientRows([{ group_key: "nope" }]).ok, false);
  assert.equal(recipients.validateRecipientRows([{}]).ok, false, "a row must name somebody");
});

test("the group vocabulary covers the certificate ladder and the job ladder", () => {
  /* One engine, not two — Module 2 §8 puts job reminders on the same rows. */
  for (const key of [
    "all-admins",
    "internal-team",
    "renewal-owner",
    "escalation-contact",
    "site-contact",
    "client-contact",
    "assigned-engineer",
    "job-owner",
  ]) {
    assert.equal(recipients.isDynamicGroupKey(key), true, `${key} is a group`);
  }
  assert.equal(recipients.normaliseGroupKey("Renewal Owner"), "renewal-owner");
  assert.equal(recipients.normaliseGroupKey("renewal_owner"), "renewal-owner");
  assert.equal(recipients.normaliseGroupKey("renewal owner "), "renewal-owner");
  assert.equal(recipients.normaliseGroupKey("nobody"), null);
  assert.equal(recipients.dynamicGroupLabel("renewal-owner"), "Renewal owner");
});

/* ══════════════════════════════════════════════ 7. the cascade moves ══ */

const DEFAULT_LADDER = [
  { step_key: "90-day", step_order: 1, offset_value: 90, offset_direction: "before", send_time: "08:00", recipient_groups_json: '["renewal-owner"]' },
  { step_key: "60-day", step_order: 2, offset_value: 60, offset_direction: "before", send_time: "08:00", recipient_groups_json: '["renewal-owner","internal-team"]' },
  { step_key: "30-day", step_order: 3, offset_value: 30, offset_direction: "before", send_time: "08:00" },
  { step_key: "14-day", step_order: 4, offset_value: 14, offset_direction: "before", send_time: "08:00", repeat_enabled: 1, repeat_interval_days: 3 },
  { step_key: "on-expiry", step_order: 5, offset_value: 0, offset_direction: "on", send_time: "08:00", repeat_enabled: 1, repeat_interval_days: 3 },
  { step_key: "retired", step_order: 6, offset_value: 7, offset_direction: "after", active: 0 },
];

test("a new certificate gets the ladder, in order, with its groups parsed", () => {
  const rows = cascade.cascadeFromDefaults(DEFAULT_LADDER, "2026-12-01", LONDON);
  assert.deepEqual(
    rows.map((row) => row.stepKey),
    ["90-day", "60-day", "30-day", "14-day", "on-expiry"],
    "a retired default is skipped without disturbing the rest",
  );
  assert.deepEqual(
    rows.map((row) => row.nextSendAt),
    [
      "2026-09-02T07:00:00.000Z",
      "2026-10-02T07:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-17T08:00:00.000Z",
      "2026-12-01T08:00:00.000Z",
    ],
    "07:00Z while it is BST, 08:00Z once it is GMT — 08:00 local throughout",
  );
  assert.deepEqual(rows[1].recipientGroups, ["renewal-owner", "internal-team"]);
  assert.equal(rows[3].repeatEnabled, true);
  assert.equal(rows[3].repeatIntervalDays, 3);
  assert.equal(rows[0].repeatEnabled, false, "steps 1–3 do not repeat");
  assert.ok(rows.every((row) => row.status === "pending" && row.isEnabled));
});

test("recalculateCascade leaves a sent row alone and moves a pending one", () => {
  /*
   * The acceptance criterion, modelled exactly. The expiry moves from 1
   * December to 15 December; the 90-day step has already gone out and must not
   * be touched, and the 14-day step has not and must follow.
   */
  const now = new Date("2026-09-10T09:00:00Z");
  const decisions = cascade.recalculateCascade(
    [
      {
        id: "r-90",
        step_key: "90-day",
        offset_value: 90,
        offset_direction: "before",
        send_time: "08:00",
        timezone: LONDON,
        sends_count: 1,
        next_send_at: "2026-09-02T07:00:00.000Z",
        status: "sent",
      },
      {
        id: "r-14",
        step_key: "14-day",
        offset_value: 14,
        offset_direction: "before",
        send_time: "08:00",
        timezone: LONDON,
        sends_count: 0,
        next_send_at: "2026-11-17T08:00:00.000Z",
        status: "pending",
      },
    ],
    "2026-12-15",
    { now, timezone: LONDON },
  );

  const sent = decisions.find((decision) => decision.id === "r-90");
  assert.equal(sent.action, "untouched");
  assert.equal(sent.status, "sent", "the status is not rewritten");
  assert.equal(
    sent.nextSendAt,
    "2026-09-02T07:00:00.000Z",
    "a delivered reminder is never re-sent or retracted",
  );
  assert.match(sent.reason, /never re-sent or retracted/);

  const pending = decisions.find((decision) => decision.id === "r-14");
  assert.equal(pending.action, "moved");
  assert.equal(pending.status, "pending");
  assert.equal(pending.previousSendAt, "2026-11-17T08:00:00.000Z");
  assert.equal(pending.nextSendAt, "2026-12-01T08:00:00.000Z", "14 days before 15 December");
  assert.equal(schedule.wallClockInZone(pending.occurrenceUtc, LONDON).time, "08:00");
});

test("a pending row whose new date has passed is cancelled, not fired", () => {
  /*
   * Pulling an expiry forward is the case that turns a helpful feature into a
   * burst of contradictory email: the cron selects on `next_send_at <= now`, so
   * three stale steps would all fire within the same hour. Cancelling them is
   * what "cancels superseded ones" has to mean.
   */
  const now = new Date("2026-11-10T09:00:00Z");
  const rows = ["90-day", "60-day", "14-day"].map((stepKey, index) => ({
    id: stepKey,
    step_key: stepKey,
    offset_value: [90, 60, 14][index],
    offset_direction: "before",
    send_time: "08:00",
    timezone: LONDON,
    sends_count: 0,
    next_send_at: "2027-01-01T08:00:00.000Z",
    status: "pending",
  }));

  const decisions = cascade.recalculateCascade(rows, "2026-12-01", { now, timezone: LONDON });
  assert.deepEqual(
    decisions.map((decision) => [decision.stepKey, decision.action]),
    [
      ["90-day", "cancelled"],
      ["60-day", "cancelled"],
      ["14-day", "moved"],
    ],
    "only the step still in the future survives",
  );
  assert.ok(decisions.every((decision) => decision.status !== "sent"));
  assert.match(decisions[0].reason, /Superseded/);
  assert.equal(decisions[2].nextSendAt, "2026-11-17T08:00:00.000Z");
});

test("an in-flight repeat and an already-cancelled row are both left alone", () => {
  const decisions = cascade.recalculateCascade(
    [
      {
        id: "chasing",
        step_key: "14-day",
        offset_value: 14,
        offset_direction: "before",
        send_time: "08:00",
        timezone: LONDON,
        sends_count: 2,
        next_send_at: "2026-11-23T08:00:00.000Z",
        status: "pending",
      },
      { id: "gone", step_key: "60-day", status: "cancelled", next_send_at: null },
    ],
    "2026-12-15",
    { now: new Date("2026-11-20T09:00:00Z"), timezone: LONDON },
  );

  assert.equal(decisions[0].action, "untouched");
  assert.equal(
    decisions[0].nextSendAt,
    "2026-11-23T08:00:00.000Z",
    "its remaining sends belong to the repeat loop, not to the anchor",
  );
  assert.match(decisions[0].reason, /repeat loop/);
  assert.equal(decisions[1].action, "untouched");
  assert.equal(decisions[1].status, "cancelled");
});

test("an unreadable anchor moves nothing", () => {
  const decisions = cascade.recalculateCascade(
    [
      {
        id: "r-14",
        step_key: "14-day",
        offset_value: 14,
        offset_direction: "before",
        next_send_at: "2026-11-17T08:00:00.000Z",
        status: "pending",
      },
    ],
    "not-a-date",
    { now: new Date("2026-09-10T09:00:00Z") },
  );
  assert.equal(decisions[0].action, "unchanged");
  assert.equal(decisions[0].nextSendAt, "2026-11-17T08:00:00.000Z");
});

/* ══════════════════════════════════════════════ 8. the preview panel ══ */

test("the preview warns in the spec's own words and refuses to say it will send", () => {
  const now = new Date("2026-10-01T09:00:00Z");
  const rows = cascade.cascadeFromDefaults(DEFAULT_LADDER, "2026-12-01", LONDON);
  const preview = cascade.previewCascade(rows, LONDON, now);

  const past = preview.find((entry) => entry.stepKey === "90-day");
  assert.equal(past.isPast, true);
  assert.equal(past.willSend, false);
  assert.equal(past.warning, cascade.PAST_REMINDER_WARNING);
  assert.equal(
    cascade.PAST_REMINDER_WARNING,
    "This date has already passed and won't be sent.",
    "the sentence §7.4 specifies, once, so every surface shows the same words",
  );

  const upcoming = preview.find((entry) => entry.stepKey === "14-day");
  assert.equal(upcoming.isPast, false);
  assert.equal(upcoming.willSend, true);
  assert.equal(upcoming.warning, null);
  assert.equal(upcoming.label, "14 days before");
  assert.equal(preview.find((entry) => entry.stepKey === "on-expiry").label, "On the day");
});

test("the preview is chronological, and undated rows sort last", () => {
  const preview = cascade.previewCascade(
    [
      { step_key: "later", next_send_at: "2026-12-01T08:00:00.000Z", status: "pending" },
      { step_key: "broken", next_send_at: null, status: "pending" },
      { step_key: "sooner", next_send_at: "2026-09-02T07:00:00.000Z", status: "pending" },
      { step_key: "off", next_send_at: "2026-11-17T08:00:00.000Z", status: "pending", is_enabled: 0 },
    ],
    LONDON,
    new Date("2026-01-01T00:00:00Z"),
  );

  assert.deepEqual(
    preview.map((entry) => entry.stepKey),
    ["sooner", "off", "later", "broken"],
    "a broken row must not bury the real ones at the top of the panel",
  );
  assert.equal(preview.at(-1).warning, "This reminder has no calculable date and won't be sent.");
  assert.equal(preview[1].stepKey, "off");
  assert.equal(preview[1].willSend, false, "a switched-off step is not sent");
  assert.match(preview[1].warning, /switched off/);
});
