/**
 * THE OVERVIEW'S THREE WRITE TOOLS — §2.5, §3.6 and §6.4.
 *
 * `/api/dashboard/*` reads and `/api/overview/*` writes. Everything asserted
 * here is a property of that second namespace that a compiler cannot see and a
 * live request would not reliably expose:
 *
 *   1. the similarity function is ARITHMETIC, so the two examples §3.6 names by
 *      hand can be pinned rather than eyeballed — and so can a non-match, which
 *      is the case that actually matters: a threshold tuned by guesswork is how
 *      a linking tool merges two contractors nobody meant to merge;
 *   2. `other` is a permanent catch-all, enforced by the SERVER and not only by
 *      the screen;
 *   3. the D1 variable cap is arithmetic too, and the chunk sizes are chosen
 *      rather than inherited;
 *   4. a mapping change writes no job record — §2.5 and §8 — which is provable
 *      by the absence of a write in the file, and by nothing else short of a
 *      live database.
 *
 * ── HOW THE SIMILARITY FUNCTION IS LOADED ─────────────────────────────────
 *
 * It lives inside the route, between two marker comments, and is written to
 * import nothing. The block is sliced out, transpiled and imported as a `data:`
 * URL — the pattern `tests/ops-rebuild-foundations.test.mjs` and a dozen others
 * already use — because importing the route itself would drag drizzle, the
 * database and the router into a unit test of four pure functions.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const METER_ROUTE = "app/api/overview/meter-settings/route.ts";
const ALIAS_ROUTE = "app/api/overview/contractor-aliases/route.ts";
const SITE_ROUTE = "app/api/overview/site-assign/route.ts";
const TOOLS_CSS = "app/(app)/portal/ops/overview-tools.css";

const ts = (await import("typescript")).default;

/** Slice a marked, import-free region out of a TypeScript file and load it. */
async function loadRegion(file, marker) {
  const source = await read(file);
  const start = source.indexOf(`/* ovt:${marker}:start`);
  const end = source.indexOf(`/* ovt:${marker}:end */`);
  assert.ok(start >= 0 && end > start, `the ${marker} markers are in ${file}`);
  const region = source.slice(start, end);
  assert.ok(
    !/^\s*import\s/m.test(region),
    `the ${marker} region must import nothing — that is what makes it testable in isolation`,
  );
  const js = ts.transpileModule(region, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

const similarity = await loadRegion(ALIAS_ROUTE, "similarity");
const meters = await import("../app/lib/overview-meters.ts");
const batching = await import("../app/lib/sql-batching.ts");

/* ── 1. The similarity function ───────────────────────────────────────────── */

test('§3.6\'s first example: "UK safety" proposes "UK Safety Ltd"', () => {
  const score = similarity.nameSimilarity("UK safety", "UK Safety Ltd");
  assert.ok(
    score >= similarity.SIMILARITY_THRESHOLD,
    `"UK safety" -> "UK Safety Ltd" scored ${score}, under the ${similarity.SIMILARITY_THRESHOLD} threshold`,
  );
  // The legal suffix is the only difference, so this is the identical case.
  assert.equal(score, 1);
});

test('§3.6\'s second example: "Taskrabbit" proposes "TaskRabbit"', () => {
  const score = similarity.nameSimilarity("Taskrabbit", "TaskRabbit");
  assert.ok(
    score >= similarity.SIMILARITY_THRESHOLD,
    `"Taskrabbit" -> "TaskRabbit" scored ${score}`,
  );
  assert.equal(score, 1);
});

test("two different contractors do not propose each other", () => {
  const score = similarity.nameSimilarity("Saed Electrical", "Omega Fire and Security");
  assert.ok(
    score < similarity.SIMILARITY_THRESHOLD,
    `unrelated names scored ${score}, at or over the ${similarity.SIMILARITY_THRESHOLD} threshold — that is a merge nobody asked for`,
  );
});

test("a shared first word is not a match", () => {
  /*
   * The case the threshold was set from. Token overlap alone rates this 0.5 and
   * would propose it; the trigram half pulls it to 0.45, and the threshold sits
   * above that on purpose — "John" is not "John Smith Plumbing", and linking
   * them would credit one man's invoices to a company. This test is what caught
   * the first threshold sitting exactly ON the score.
   */
  const score = similarity.nameSimilarity("John", "John Smith Plumbing");
  assert.equal(score, 0.45);
  assert.ok(score < similarity.SIMILARITY_THRESHOLD, `"John" scored ${score} against a longer name`);
});

test("a real near-miss is still proposed", () => {
  // The threshold must refuse the case above without refusing this one.
  const score = similarity.nameSimilarity("Omega Fire", "Omega Fire and Security");
  assert.ok(
    score >= similarity.SIMILARITY_THRESHOLD,
    `"Omega Fire" scored ${score} against "Omega Fire and Security"`,
  );
});

test("punctuation, case and ampersands are all invisible to the match", () => {
  assert.equal(similarity.normaliseForMatch("  M & S  Facilities Ltd. "), "m and s facilities");
  assert.equal(similarity.normaliseForMatch("uk-safety"), "uk safety");
  assert.equal(similarity.nameSimilarity("M&S Facilities", "M and S Facilities Limited"), 1);
});

test("a blank name matches nothing, and never itself", () => {
  assert.equal(similarity.nameSimilarity("", "UK Safety"), 0);
  assert.equal(similarity.nameSimilarity("   ", "  "), 0);
  assert.equal(similarity.nameSimilarity("!!!", "UK Safety"), 0);
});

test("the Dice coefficient is symmetric and bounded", () => {
  const left = similarity.trigrams("uk safety");
  const right = similarity.trigrams("uk safety ltd");
  const forward = similarity.diceCoefficient(left, right);
  assert.equal(forward, similarity.diceCoefficient(right, left));
  assert.ok(forward > 0 && forward <= 1);
  assert.equal(similarity.diceCoefficient(new Set(), new Set()), 1);
  assert.equal(similarity.diceCoefficient(new Set(["abc"]), new Set()), 0);
});

/* ── 2. The catch-all invariants ──────────────────────────────────────────── */

test("`other` is the catch-all, and an unknown status resolves to it", () => {
  assert.equal(meters.CATCH_ALL_METER, "other");
  const assignments = new Map([["job completed", "completed"]]);
  assert.equal(meters.meterForStatus(assignments, "Job Completed"), "completed");
  // A status invented tomorrow, and one whose row carries no meter_key.
  assert.equal(meters.meterForStatus(assignments, "Invented Yesterday"), "other");
  assert.equal(meters.meterForStatus(new Map([["x", "not_a_meter"]]), "x"), "other");
  assert.equal(meters.meterForStatus(assignments, null), "other");
});

test("the server refuses to hide, delete or replace the catch-all", async () => {
  const source = await read(METER_ROUTE);
  assert.match(
    source,
    /cannot be hidden/,
    "PUT must refuse a save that hides `other` — the UI is not the enforcement layer",
  );
  assert.match(source, /cannot be deleted/, "PUT must refuse a save that omits `other`");
  assert.match(
    source,
    /isCatchAll:\s*meter\.key === CATCH_ALL_METER/,
    "`is_catch_all` is written from the key, so it cannot be handed to another meter",
  );
  assert.match(
    source,
    /isMeterKey\(key\)/,
    "a meter key outside the eight is refused rather than created",
  );
  assert.match(
    source,
    /isMeterKey\(meter\) \? meter : CATCH_ALL_METER/,
    "an unknown or absent meter_key resolves to the catch-all rather than dangling",
  );
});

test("a meter save writes no job record — §2.5 and §8", async () => {
  const source = await read(METER_ROUTE);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const write of [
    /\.update\(maintenanceRequests\)/,
    /\.insert\(maintenanceRequests\)/,
    /\.delete\(maintenanceRequests\)/,
    /update\s+maintenance_requests/i,
  ]) {
    assert.ok(
      !write.test(code),
      `${METER_ROUTE} must not write maintenance_requests — it matched ${write}`,
    );
  }
  // It still READS them, for the live preview counts.
  assert.match(code, /\.from\(maintenanceRequests\)/);
});

test("Reset restores a recorded baseline, never an empty mapping", async () => {
  const source = await read(METER_ROUTE);
  /*
   * The trap this pins. `JOB_STATUS_METER_SEED` lives in `db/init.ts` and is not
   * exported, and `ensureDatabase()` is memoised per process — so a reset that
   * cleared every `meter_key` and waited for the boot path to refill them would
   * leave the whole workspace reading `Other` until the server restarted. The
   * first save records what it found instead, and that is what Reset replays.
   */
  assert.match(source, /const BASELINE_ACTION = "meters\.baseline";/);
  assert.match(source, /if \(!reset\) await ensureBaseline\(/, "the baseline is recorded before the first change");
  assert.match(source, /readBaseline\(scope\)/, "Reset reads it back");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
    !/SET meter_key = NULL/i.test(code),
    "nothing may null a whole workspace's mapping — that is not a reset, it is a wipe",
  );
});

/* ── 3. The chunking arithmetic ───────────────────────────────────────────── */

test("chunkIds never exceeds the size it is given", () => {
  const ids = Array.from({ length: 245 }, (_, index) => `MN-${index}`);
  const chunks = batching.chunkIds(ids, 80);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [80, 80, 80, 5],
  );
  assert.equal(chunks.flat().length, ids.length);
  assert.deepEqual(new Set(chunks.flat()).size, ids.length);
  // A list inside the size is one chunk, and an empty list is no statements.
  assert.equal(batching.chunkIds(ids.slice(0, 80), 80).length, 1);
  assert.deepEqual(batching.chunkIds([], 80), []);
});

test("chunkRows divides the variable budget by the row width", () => {
  // The cap is counted PER COLUMN PER ROW, which is the whole point.
  const rows = Array.from({ length: 20 }, (_, index) => index);
  assert.deepEqual(
    batching.chunkRows(rows, 12).map((chunk) => chunk.length),
    [7, 7, 6],
  );
  for (const width of [1, 2, 5, 12, 90, 200]) {
    for (const chunk of batching.chunkRows(rows, width)) {
      assert.ok(
        chunk.length * width <= batching.SQL_VARIABLE_CHUNK || chunk.length === 1,
        `${chunk.length} rows of ${width} columns exceeds ${batching.SQL_VARIABLE_CHUNK} variables`,
      );
    }
  }
});

test("both write routes chunk below the bare-IN budget, because their statements are not bare", async () => {
  const site = await read(SITE_ROUTE);
  const alias = await read(ALIAS_ROUTE);

  const assign = /const ASSIGN_CHUNK = (\d+);/.exec(site);
  assert.ok(assign, "site-assign declares its own chunk size");
  const backfill = /const BACKFILL_CHUNK = (\d+);/.exec(alias);
  assert.ok(backfill, "contractor-aliases declares its own chunk size");

  for (const [name, match] of [["ASSIGN_CHUNK", assign], ["BACKFILL_CHUNK", backfill]]) {
    const size = Number(match[1]);
    assert.ok(
      size < batching.SQL_VARIABLE_CHUNK,
      `${name} is ${size}; it must be under ${batching.SQL_VARIABLE_CHUNK}, which is sized for a BARE \`IN\` list`,
    );
    // Room for the SET clause and the organisation filter, with margin.
    assert.ok(size + 5 <= batching.SQL_VARIABLE_CHUNK, `${name} leaves too little margin`);
  }

  assert.match(site, /chunkIds\(/, "the UPDATE is chunked");
  assert.match(site, /SQL_VARIABLE_CHUNK/, "the verification SELECT uses the bare-IN size");
  assert.match(alias, /chunkIds\(ids, BACKFILL_CHUNK\)/, "the backfill is chunked");
});

test("the batch cap is a refusal, never a silent truncation", async () => {
  const source = await read(SITE_ROUTE);
  assert.match(source, /const MAX_BATCH = (\d+);/);
  assert.match(
    source,
    /requestIds\.length > MAX_BATCH/,
    "an over-large batch is refused before anything is written",
  );
  assert.ok(
    !/requestIds\.slice\(0, MAX_BATCH\)/.test(source.replace(/\/\*[\s\S]*?\*\//g, "")),
    "the caller's list must not be silently truncated to the cap",
  );
});

/* ── 4. The namespace's shared contract ───────────────────────────────────── */

const ROUTES = [
  [METER_ROUTE, ["board.view", "settings.edit"]],
  [ALIAS_ROUTE, ["board.view", "settings.edit"]],
  [SITE_ROUTE, ["board.edit"]],
];

for (const [file, capabilities] of ROUTES) {
  test(`${file} is dynamic, boots the database and is capability-gated`, async () => {
    const source = await read(file);
    assert.match(source, /export const dynamic = "force-dynamic";/);
    assert.match(source, /await ensureDatabase\(\)/);
    for (const capability of capabilities) {
      assert.match(
        source,
        new RegExp(`scopedDbWithCapability\\(request, "${capability.replace(".", "\\.")}"\\)`),
        `${file} must gate on ${capability}`,
      );
    }
  });

  test(`${file} refuses in the right order and never leaks a message`, async () => {
    const source = await read(file);
    const anonymous = source.indexOf("anonymousRefusal(error)");
    const busy = source.indexOf("busyRefusal(error");
    assert.ok(anonymous > 0, "a dead session is a 401, not an outage");
    assert.ok(busy > anonymous, "the pooler arm comes after the session arm");
    assert.match(
      source,
      /process\.env\.NODE_ENV === "development"/,
      "the driver's message is development-only — it carries the failing statement",
    );
    assert.match(source, /status: 503/);
  });

  test(`${file} says it is the Overview's write namespace, not a dashboard read`, async () => {
    const source = await read(file);
    assert.match(
      source,
      /\/api\/dashboard/,
      "the header must state why this is a separate namespace from the read-only aggregates",
    );
  });
}

test("every write action previews unless told to apply", async () => {
  for (const file of [ALIAS_ROUTE, SITE_ROUTE]) {
    const source = await read(file);
    assert.match(
      source,
      /body\.mode === "apply"/,
      `${file} must default to preview — §3.6 and §8 both forbid an unconfirmed write`,
    );
  }
});

test("both write routes re-check the caller's ids against the organisation", async () => {
  const site = await read(SITE_ROUTE);
  assert.match(site, /eq\(sites\.organisationId, scope\.orgId\)/, "the site is re-read in this tenant");
  assert.match(
    site,
    /liveWorkOrderCondition\(scope\.orgId\)/,
    "every job id is re-read in this tenant before it is written",
  );
  const alias = await read(ALIAS_ROUTE);
  assert.match(
    alias,
    /eq\(contractors\.organisationId, scope\.orgId\)/,
    "the contractor is re-read in this tenant",
  );
  assert.match(alias, /A FOREIGN KEY IS NOT A TENANT CHECK/);
});

test("every action writes both logs", async () => {
  for (const file of [METER_ROUTE, ALIAS_ROUTE, SITE_ROUTE]) {
    const source = await read(file);
    assert.match(source, /\.insert\(activityLog\)/, `${file} writes activity_log`);
    assert.match(source, /recordAudit\(/, `${file} writes audit_events`);
  }
  assert.match(await read(METER_ROUTE), /changeDetail\(/, "a meter save logs a real diff");
});

test("the dialect rules hold — no julianday, strftime, json_extract, printf, GLOB or window functions", async () => {
  for (const file of [METER_ROUTE, ALIAS_ROUTE, SITE_ROUTE]) {
    /* Comments stripped first. `meter-settings` explains at length why it
       matches status keys in JavaScript rather than reaching for `GLOB`, and a
       prose ban on a construct is not a use of it. */
    const source = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of [/julianday/i, /strftime/i, /json_extract/i, /printf\s*\(/i, /\bGLOB\b/, /\browid\b/, /\bover\s*\(\s*partition\b/i]) {
      assert.ok(!banned.test(source), `${file} must not use ${banned}`);
    }
  }
});

/* ── 5. The stylesheet ────────────────────────────────────────────────────── */

test("overview-tools.css uses tokens only — not one hex literal", async () => {
  const css = await read(TOOLS_CSS);
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hex = code.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.equal(hex, null, `hex literals in ${TOOLS_CSS}: ${hex?.join(", ")}`);
});

test("overview-tools.css only uses the agreed breakpoints", async () => {
  const css = await read(TOOLS_CSS);
  const allowed = new Set(["640", "767", "768", "1024", "1280"]);
  const widths = [...css.matchAll(/@media[^{]*?(\d+)px/g)].map((match) => match[1]);
  assert.ok(widths.length > 0, "the stylesheet has at least one width query");
  for (const width of widths) {
    assert.ok(allowed.has(width), `${width}px is not one of 640 / 767 / 768 / 1024 / 1280`);
  }
});

test("every tap target in the three tools clears 44px", async () => {
  const css = await read(TOOLS_CSS);
  for (const selector of [
    ".ovt-btn",
    ".ovt-toggle",
    ".ovt-status__grip",
    ".ovt-suggestion",
    ".ovt-job__check",
  ]) {
    const block = css.slice(css.indexOf(`${selector} {`));
    assert.ok(block.startsWith(`${selector} {`), `${selector} is declared`);
    const body = block.slice(0, block.indexOf("}"));
    assert.match(
      body,
      /(min-height|height):\s*44px/,
      `${selector} must be at least 44px on its short edge — §1.8`,
    );
  }
});

/* ── 6. The two ways to move a status ─────────────────────────────────────── */

test("§2.5 and §1.8: a status moves by drag AND by a menu, and the menu is keyboard-usable", async () => {
  const source = await read("app/(app)/portal/ops/meter-settings.tsx");
  // Drag, on Pointer Events so that touch works at all.
  assert.match(source, /onPointerDown=/, "the grip starts a pointer drag");
  assert.match(source, /onPointerMove=/);
  assert.match(source, /onPointerUp=/);
  assert.match(source, /setTimeout\(/, "touch arms on a long press, so a scroll is still a scroll");
  assert.match(source, /elementFromPoint\(/, "the drop target is whatever is under the pointer");
  // The tap and keyboard path, on every row.
  assert.match(source, /<select/, "every status row carries a Move to… menu");
  assert.match(source, /`Move to \$\{option\.label\}`/);
  /* The grip must opt out of touch scrolling or the long-press drag is fought
     by the browser's own gesture the whole way down the list. */
  const css = await read(TOOLS_CSS);
  const grip = css.slice(css.indexOf(".ovt-status__grip {"));
  assert.match(grip.slice(0, grip.indexOf("}")), /touch-action:\s*none/);
});

test("nothing applies until Save", async () => {
  const source = await read("app/(app)/portal/ops/meter-settings.tsx");
  assert.match(source, /nothing applies until you save/i);
  assert.match(source, /disabled=\{!dirty \|\| saving\}/, "Save is inert until something changed");
  assert.match(source, /confirmingReset/, "Reset to defaults asks first");
});
