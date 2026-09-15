/**
 * The header greeting tells the time, and it is the viewer's time.
 *
 * WHAT WAS WRONG. At 16:44 BST on 14 September 2026 the live dashboard read
 * "Good morning, MAINTSUPP" while the same browser reported local hour 16 in
 * Europe/London.
 *
 * WHICH OF THE THREE CANDIDATE CAUSES IT ACTUALLY WAS. The report asked whether
 * the string was hardcoded, computed from the server's clock, or frozen in a
 * cached render. It was the FIRST, and only the first:
 * `sectionMeta.overview.title` in `portal-app.tsx` was the literal
 * `"Good morning"`, printed by the topbar as `${meta.title}, ${firstName}`. No
 * clock was read at all. The other two are ruled out by construction and both
 * facts are pinned below — the route is `dynamic = "force-dynamic"`, and the
 * shell is a client component, so nothing about it is prerendered or revalidated.
 *
 * Three halves, in the order they are worth reading:
 *
 *   · the BUCKETS, exhaustively, at every hour and at all eight boundaries the
 *     report names, in several real timezones and across a DST change;
 *   · the SOURCE, pinning that the greeting is derived rather than typed, that
 *     the zone comes from the account and never from the server's environment,
 *     and that the fallback chain is the one that was asked for;
 *   · the LIVE page, which skips when no dev server answers.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER_EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const OWNER_PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

/* `greeting.ts` imports nothing, so it transpiles and loads on its own — no
   dependency substitution, unlike the calendar suites. */
const greeting = await import(asModule(transpile(await read("app/lib/greeting.ts"))));

const {
  FALLBACK_TIME_ZONE,
  browserTimeZone,
  greetingAt,
  greetingForHour,
  isValidTimeZone,
  localHourIn,
  msUntilNextLocalHour,
  resolveTimeZone,
} = greeting;

/* ------------------------------------------------------------------ */
/* Finding a real instant that reads as a given wall-clock time         */
/* ------------------------------------------------------------------ */

/** How far `timeZone` is from UTC at this instant, in milliseconds. */
function zoneOffsetMs(timeZone, at) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - at.getTime();
}

/**
 * The UTC instant at which `timeZone` reads `localIso` on its own wall clock.
 *
 * Two passes, because the offset can itself depend on the instant — which is
 * the entire point of testing this across a DST change rather than assuming
 * Europe/London is UTC.
 */
function instantAtLocal(timeZone, localIso) {
  const target = Date.parse(`${localIso}Z`);
  let guess = new Date(target);
  for (let pass = 0; pass < 3; pass += 1) {
    guess = new Date(target - zoneOffsetMs(timeZone, guess));
  }
  return guess;
}

/* ------------------------------------------------------------------ */
/* The buckets                                                         */
/* ------------------------------------------------------------------ */

test("every hour of the day lands in the bucket the brief names", () => {
  const expected = {
    "Good morning": [5, 6, 7, 8, 9, 10, 11],
    "Good afternoon": [12, 13, 14, 15, 16, 17],
    "Good evening": [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4],
  };
  // Exhaustive rather than sampled: 24 hours is small enough that there is no
  // excuse for testing seven of them.
  for (const [greetingText, hours] of Object.entries(expected)) {
    for (const hour of hours) {
      assert.equal(greetingForHour(hour), greetingText, `hour ${hour}`);
    }
  }
  const covered = Object.values(expected).flat().sort((a, b) => a - b);
  assert.deepEqual(covered, Array.from({ length: 24 }, (_, i) => i));
});

test("the eight boundaries in the brief, on a real clock in Europe/London", () => {
  // Winter: Europe/London is GMT, so local == UTC. The DST case is next.
  const cases = [
    ["2026-01-15T04:59:00", "Good evening"],
    ["2026-01-15T05:00:00", "Good morning"],
    ["2026-01-15T11:59:00", "Good morning"],
    ["2026-01-15T12:00:00", "Good afternoon"],
    ["2026-01-15T17:59:00", "Good afternoon"],
    ["2026-01-15T18:00:00", "Good evening"],
    ["2026-01-15T23:59:00", "Good evening"],
    ["2026-01-15T00:00:00", "Good evening"],
  ];
  for (const [local, expected] of cases) {
    const at = instantAtLocal("Europe/London", local);
    assert.equal(localHourIn("Europe/London", at), Number(local.slice(11, 13)), local);
    assert.equal(greetingAt(at, "Europe/London"), expected, local);
  }
});

test("the same eight boundaries hold under BST, so the offset is not assumed", () => {
  /*
   * July, when Europe/London is UTC+1. If anything in this module reached for
   * UTC — or for a fixed offset — this is the test that fails: the instant for
   * local 12:00 is 11:00Z, and a UTC reading would call it morning.
   */
  for (const [local, expected] of [
    ["2026-07-15T04:59:00", "Good evening"],
    ["2026-07-15T05:00:00", "Good morning"],
    ["2026-07-15T11:59:00", "Good morning"],
    ["2026-07-15T12:00:00", "Good afternoon"],
    ["2026-07-15T17:59:00", "Good afternoon"],
    ["2026-07-15T18:00:00", "Good evening"],
    ["2026-07-15T23:59:00", "Good evening"],
    ["2026-07-15T00:00:00", "Good evening"],
  ]) {
    const at = instantAtLocal("Europe/London", local);
    assert.equal(greetingAt(at, "Europe/London"), expected, `BST ${local}`);
  }

  // And the offset really was +1: local noon is 11:00 UTC.
  const noon = instantAtLocal("Europe/London", "2026-07-15T12:00:00");
  assert.equal(noon.getUTCHours(), 11, "July noon in London is 11:00 UTC");
  const januaryNoon = instantAtLocal("Europe/London", "2026-01-15T12:00:00");
  assert.equal(januaryNoon.getUTCHours(), 12, "January noon in London is 12:00 UTC");
});

test("one instant, many timezones, three different greetings", () => {
  /*
   * THE ACTUAL DEFECT, as a test. A single moment is morning in one place and
   * evening in another, so a greeting computed anywhere but the viewer's own
   * zone is wrong for somebody — and the zone a serverless platform runs in is
   * nobody's in particular.
   */
  const at = instantAtLocal("Europe/London", "2026-09-14T16:44:00"); // the report
  assert.equal(greetingAt(at, "Europe/London"), "Good afternoon", "the reported case");

  const readings = {
    "Europe/London": "Good afternoon", //  16:44
    "America/New_York": "Good morning", //  11:44 — a us-east deployment
    "America/Los_Angeles": "Good morning", // 08:44 — a us-west one
    "Asia/Tokyo": "Good evening", //         00:44 next day
    "Australia/Sydney": "Good morning", //   01:44 next day -> evening bucket
  };
  assert.equal(greetingAt(at, "Europe/London"), readings["Europe/London"]);
  assert.equal(greetingAt(at, "America/New_York"), "Good morning");
  assert.equal(greetingAt(at, "America/Los_Angeles"), "Good morning");
  assert.equal(greetingAt(at, "Asia/Tokyo"), "Good evening");

  // Three distinct answers for one instant is the whole argument.
  const distinct = new Set(
    ["Europe/London", "America/New_York", "Asia/Tokyo"].map((zone) =>
      greetingAt(at, zone),
    ),
  );
  assert.equal(distinct.size, 3);
});

test("a timezone where it is 09:00, 15:00 and 21:00 reads as the brief says", () => {
  for (const [zone, local, expected] of [
    ["America/New_York", "2026-03-10T09:00:00", "Good morning"],
    ["America/New_York", "2026-03-10T15:00:00", "Good afternoon"],
    ["America/New_York", "2026-03-10T21:00:00", "Good evening"],
    ["Asia/Kolkata", "2026-03-10T09:00:00", "Good morning"],
    ["Asia/Kolkata", "2026-03-10T15:00:00", "Good afternoon"],
    ["Asia/Kolkata", "2026-03-10T21:00:00", "Good evening"],
    ["Pacific/Auckland", "2026-03-10T09:00:00", "Good morning"],
    ["Pacific/Auckland", "2026-03-10T15:00:00", "Good afternoon"],
    ["Pacific/Auckland", "2026-03-10T21:00:00", "Good evening"],
  ]) {
    const at = instantAtLocal(zone, local);
    assert.equal(greetingAt(at, zone), expected, `${zone} ${local}`);
  }
});

test("midnight is 0 and not 24", async () => {
  /*
   * `hour12: false` renders midnight as "24" in several locales, and
   * `greetingForHour(24)` falls through to "Good evening" — right by accident
   * at midnight and wrong as soon as anybody edits the buckets. The module asks
   * for `hourCycle: "h23"` to make it 0.
   */
  for (const zone of ["Europe/London", "America/New_York", "Asia/Tokyo"]) {
    const at = instantAtLocal(zone, "2026-05-20T00:00:00");
    assert.equal(localHourIn(zone, at), 0, `${zone} midnight`);
    assert.equal(greetingAt(at, zone), "Good evening");
  }
  const source = await read("app/lib/greeting.ts");
  assert.match(source, /hourCycle: "h23"/);
});

/* ------------------------------------------------------------------ */
/* Resolving the zone                                                  */
/* ------------------------------------------------------------------ */

test("the account's stored timezone wins, and rubbish falls back to the UK", () => {
  assert.equal(resolveTimeZone("America/Chicago"), "America/Chicago");
  assert.equal(resolveTimeZone("Europe/Paris"), "Europe/Paris");
  assert.equal(resolveTimeZone("UTC"), "UTC");

  for (const bad of [null, undefined, "", "   ", "Not/AZone", "GMT+1:00", 42, {}]) {
    assert.equal(resolveTimeZone(bad), FALLBACK_TIME_ZONE, String(bad));
  }
  // The UK, because the business is a UK one — not because it is the server's.
  assert.equal(FALLBACK_TIME_ZONE, "Europe/London");
});

test("isValidTimeZone does not throw on anything a database can hold", () => {
  for (const value of [null, undefined, "", 0, 1, [], {}, "x".repeat(400), "Mars/Olympus"]) {
    assert.equal(isValidTimeZone(value), false, String(value));
  }
  assert.equal(isValidTimeZone("Europe/London"), true);
});

test("the browser fallback is a separate function, so the server cannot reach it", async () => {
  /*
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` returns the SERVER's
   * zone when it runs on the server, which is the single answer this feature
   * must never give. Keeping it out of `resolveTimeZone` is what makes that
   * structural rather than a matter of remembering.
   */
  const source = await read("app/lib/greeting.ts");
  // Comments stripped first: the slice runs up to `browserTimeZone`, whose own
  // docstring says the word, and a docstring explaining the rule is not a
  // violation of it.
  const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const resolveBody = body.slice(
    body.indexOf("export function resolveTimeZone"),
    body.indexOf("export function browserTimeZone"),
  );
  assert.doesNotMatch(resolveBody, /resolvedOptions/);
  assert.match(source, /export function browserTimeZone/);
  assert.match(source, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);

  // It still works where it is allowed to run.
  const zone = browserTimeZone();
  assert.ok(zone === null || isValidTimeZone(zone));
});

/* ------------------------------------------------------------------ */
/* Not going stale                                                     */
/* ------------------------------------------------------------------ */

test("the refresh lands on the top of the next hour, in the viewer's zone", () => {
  const at = instantAtLocal("Europe/London", "2026-09-14T16:44:30");
  const ms = msUntilNextLocalHour(at, "Europe/London");
  // 15 minutes 30 seconds to 17:00.
  assert.equal(ms, (15 * 60 + 30) * 1000);

  // A zone offset by half an hour has its own minute, so the wake-up has to
  // read the minute THERE rather than off the Date.
  const india = msUntilNextLocalHour(at, "Asia/Kolkata");
  assert.equal(india, (45 * 60 + 30) * 1000, "Asia/Kolkata is +05:30");
  const nepal = msUntilNextLocalHour(at, "Asia/Kathmandu");
  assert.equal(nepal, (30 * 60 + 30) * 1000, "Asia/Kathmandu is +05:45");
});

test("the timer can never be zero, however the clock lands", () => {
  for (const local of ["2026-09-14T16:59:59", "2026-09-14T00:00:00", "2026-09-14T12:00:00"]) {
    const at = instantAtLocal("Europe/London", local);
    const ms = msUntilNextLocalHour(at, "Europe/London");
    assert.ok(ms >= 1_000, `${local} gave ${ms}ms`);
    assert.ok(ms <= 3_600_000, `${local} gave ${ms}ms`);
  }
});

test("waiting that long actually changes the greeting at a boundary", () => {
  // The point of the timer: from 11:30 the next wake is 11:00->12:00, and the
  // greeting on the far side of it is different.
  const at = instantAtLocal("Europe/London", "2026-09-14T11:30:00");
  assert.equal(greetingAt(at, "Europe/London"), "Good morning");
  const next = new Date(at.getTime() + msUntilNextLocalHour(at, "Europe/London"));
  assert.equal(localHourIn("Europe/London", next), 12);
  assert.equal(greetingAt(next, "Europe/London"), "Good afternoon");
});

/* ------------------------------------------------------------------ */
/* Source                                                              */
/* ------------------------------------------------------------------ */

test("the greeting is no longer a literal anywhere in the shell", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const code = portal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const literal of ["Good morning", "Good afternoon", "Good evening"]) {
    assert.ok(
      !code.includes(`"${literal}"`),
      `${literal} is typed into portal-app.tsx — it must be derived`,
    );
  }
  // And the section's own title is a label again, not a time of day.
  assert.match(portal, /title: "Overview"/);
  assert.match(portal, /`\$\{greeting\}, \$\{displayUserName\.split\(" "\)\[0\]\}`/);
  assert.match(portal, /const greeting = useGreeting\(userTimeZone\)/);
});

test("the zone comes from the account, and the page hands it over", async () => {
  const page = await read("app/(app)/dashboard/[[...section]]/page.tsx");
  assert.match(page, /userTimeZone=\{session\.user\.timezone\}/);

  const session = await read("app/lib/auth-session.ts");
  assert.match(session, /timezone: row\.timezone \?\? "Europe\/London"/);
  assert.match(session, /u\.timezone\s+AS timezone/);

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /userTimeZone\?: string \| null;/);
});

test("nothing is cached, so the greeting cannot be frozen at render time", async () => {
  /*
   * The second and third hypotheses in the report. Both are answered by
   * construction rather than by a cache header: the route opts out of every
   * static path, and the shell is a client component whose value is recomputed
   * on each render and refreshed on the hour.
   */
  const page = await read("app/(app)/dashboard/[[...section]]/page.tsx");
  assert.match(page, /export const dynamic = "force-dynamic";/);
  assert.doesNotMatch(page, /export const revalidate/);
  assert.doesNotMatch(page, /generateStaticParams/);

  const portal = await read("app/(app)/portal/portal-app.tsx");
  assert.match(portal, /^"use client";/);

  const hook = await read("app/(app)/portal/use-greeting.ts");
  assert.match(hook, /^"use client";/);
  // Recomputed per render from an instant, never from a remembered "today".
  assert.match(hook, /greetingAt\(new Date\(at\), timeZone\)/);
  assert.match(hook, /msUntilNextLocalHour/);
});

test("the first render is the right greeting, not a neutral one to be corrected", async () => {
  /*
   * The brief forbids showing a wrong greeting and then fixing it. That is
   * avoided by computing from the STORED zone, which the server has too — so
   * both renders produce the same string and there is nothing to correct. A
   * `useState(null)` seeded from an effect would reintroduce exactly the
   * flicker being designed out.
   */
  const hook = await read("app/(app)/portal/use-greeting.ts");
  // The zone is known at first render on BOTH sides: the stored preference when
  // there is one, and otherwise a `useSyncExternalStore` whose server snapshot
  // is the UK fallback and whose client snapshot is the browser's own zone —
  // which is how the browser value arrives without a hydration mismatch and
  // without writing state from an effect.
  assert.match(hook, /const stored = isValidTimeZone\(storedTimeZone\) \? storedTimeZone : null;/);
  assert.match(hook, /useSyncExternalStore\(subscribe, browserSnapshot, serverSnapshot\)/);
  assert.match(hook, /const timeZone = stored \?\? browser;/);
  assert.match(hook, /function serverSnapshot\(\) \{\s*\r?\n\s*return FALLBACK_TIME_ZONE;/);
  assert.match(hook, /useState\(\(\) => Date\.now\(\)\)/);
  // Nothing starts empty and gets filled in, which is what would flicker.
  assert.doesNotMatch(hook, /useState<[^>]*>\(null\)/);
  assert.doesNotMatch(hook, /useState\(""\)/);
  /*
   * And the zone is never written from an effect. The first draft did exactly
   * that and `react-hooks/set-state-in-effect` caught it — the rule is about
   * cascading renders, which on this component is the flicker by another name.
   */
  const effects = hook.slice(hook.indexOf("useEffect("));
  assert.doesNotMatch(effects, /setTimeZone/);
});

/* ------------------------------------------------------------------ */
/* Live                                                                */
/* ------------------------------------------------------------------ */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/login`, {
      signal: AbortSignal.timeout(6_000),
      redirect: "manual",
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function signIn() {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!response.ok) return null;
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");
  return cookie || null;
}

test("the rendered dashboard greets with the hour it actually is", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }

  const html = await (await fetch(`${BASE_URL}/dashboard`, { headers: { cookie } })).text();

  const shown = ["Good morning", "Good afternoon", "Good evening"].filter((value) =>
    html.includes(value),
  );
  assert.equal(shown.length, 1, `expected exactly one greeting, got ${shown.join(", ")}`);

  /*
   * The owner's stored zone defaults to Europe/London, and this asserts the
   * SERVER rendered the right one for it — which is the half a browser check
   * cannot see, because by the time devtools is open the client has re-rendered.
   */
  const expected = greetingAt(new Date(), "Europe/London");
  assert.equal(
    shown[0],
    expected,
    `server-rendered ${shown[0]} at ${new Date().toISOString()} (London expects ${expected})`,
  );
});

test("the placeholder identity has not come back with it", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  // The report's sixth item: signed out it read "Good morning, Preview". That
  // name came from the auth hole, which is closed — signed out there is no page
  // at all now, so the only thing to hold is that the placeholder is gone.
  const signedOut = await fetch(`${BASE_URL}/dashboard`, { redirect: "manual" });
  assert.equal((await signedOut.text()).length, 0);

  const cookie = await signIn();
  if (!cookie) {
    t.skip("the seeded owner could not sign in");
    return;
  }
  const html = await (await fetch(`${BASE_URL}/dashboard`, { headers: { cookie } })).text();
  assert.ok(!html.includes("Preview User"));
  assert.ok(!html.includes(", Preview"));
  assert.ok(html.includes(OWNER_EMAIL), "the real account is what is greeted");
});
