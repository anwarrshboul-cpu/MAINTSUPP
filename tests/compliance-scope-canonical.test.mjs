/**
 * ONE CANONICAL COMPLIANCE SCOPE — THE SCREENS AND THE DIGEST ANSWER FROM THE
 * SAME PLACE.
 *
 * ── THE DIVERGENCE THIS FILE EXISTS TO PREVENT ────────────────────────────
 *
 * The product held two definitions of "compliance" at once:
 *
 *   · `/api/workspace` — which feeds /dashboard/compliance, the Overview
 *     compliance tile, the expiry calendar and the site drawer — called
 *     `readComplianceRegister(db, orgId)` and took its default: the CANONICAL
 *     Store Documentation register alone.
 *   · `/api/notifications/compliance` — the nightly digest and its 90/60/30/14/
 *     7/0 reminder cadence — called the same function with
 *     `boardIds: storeDocumentationBoards(...)`: EVERY Store Documentation
 *     register, custom workspace-section instances included.
 *
 * So a certificate held on a section instance was emailed about at 07:00 and
 * was invisible on the compliance page the reader then opened. An alert with
 * nowhere to go is the failure the register was rebuilt to end, arriving
 * through a scope instead of through the wrong table.
 *
 * ── THE OWNER'S DECISION: THE DIGEST FOLLOWS THE SCREENS ──────────────────
 *
 * The headline compliance experience is the CANONICAL Store Documentation
 * register for the selected organisation. Custom Store Documentation sections
 * are INDEPENDENT instances and are routinely sandboxes — this workspace holds
 * sections named `test`, `testt` and `testtt` — so they must not move the
 * primary client's score, totals, expiry timeline or notifications.
 *
 * `headlineComplianceBoardIds()` in app/lib/compliance-register.ts is the one
 * answer, and both paths read it: `readComplianceRegister`'s default IS that
 * function, and the digest resolves `headlineComplianceRegisters`, which is
 * built from it. This file fails if a future edit re-splits them.
 *
 * ── HOW THESE ARE WRITTEN ─────────────────────────────────────────────────
 *
 * EXECUTED first. `headlineComplianceBoardIds` and `headlineComplianceRegisters`
 * are imported and RUN — the second against a stub database holding a canonical
 * register and three section instances — so the central claim survives any
 * reformat and does not depend on a running server. Source pins cover the two
 * call sites, which have no reachable seam without a database. The live tests
 * SKIP when nothing answers, as ~32 files in this suite do.
 *
 * The scope is never asserted by NAME. `test`/`testt`/`testtt` are what people
 * happen to call a sandbox, not a rule — a name match would be a lie that
 * worked until somebody named an instance "Concession documents". The fixture
 * below uses those names precisely so that a name-matching implementation would
 * still pass the wrong way and the id-based assertion beside it would not.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * WHY THIS FILE RESOLVES ITS OWN IMPORTS. The product's modules import each
 * other without a file extension (`import … from "../../db/schema"`), which the
 * bundler resolves and Node's ESM resolver does not — so running the real
 * functions, rather than matching their source and hoping, needs twelve lines
 * of resolver. Same hook as tests/w2-store-documentation-instance.test.mjs, and
 * deliberately just as narrow: only a RELATIVE specifier with no extension, and
 * only when a `.ts`/`.tsx` file is actually sitting there.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const base = dirname(fileURLToPath(context.parentURL));
      for (const extension of [".ts", ".tsx", "/index.ts"]) {
        const candidate = resolvePath(base, specifier + extension);
        if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
      }
    }
    return next(specifier, context);
  },
});

const here = new URL("../", import.meta.url).href;
const {
  STORE_DOCUMENTATION_BOARD_ID,
  headlineComplianceBoardIds,
  headlineComplianceRegisters,
  storeDocumentationBoards,
} = await import(`${here}app/lib/compliance-register.ts`);

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* Comments are stripped before a pin is matched: several of these contracts are
   described at length in a comment beside the code that implements them, and a
   pin that matched the prose would go on passing after the code was deleted. */
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * A stub of the one query `storeDocumentationBoards` makes.
 *
 * `db.select({…}).from(boards).where(…).orderBy(…)` and nothing else, so the
 * whole surface is four chained calls ending in the rows. Deliberately a stub
 * rather than a live database: the point of these two tests is the SCOPE RULE,
 * and it has to be provable on an organisation that owns section instances —
 * which the local dev estate does not, and which no test may create on the
 * client's own workspace.
 */
function dbHolding(rows) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  };
}

/**
 * The fixture: one canonical register and three sandbox instances.
 *
 * Every row carries `kind = "store-documentation"`, because that is what makes
 * a board a document register — a section's key is GENERATED (`sec-<12hex>`),
 * so there is no string a reader could match on and none anybody should try to.
 * The three names are the owner's real ones.
 */
const REGISTERS_WITH_SANDBOXES = [
  { key: STORE_DOCUMENTATION_BOARD_ID, name: "Store Documentation UK" },
  { key: "sec-9f2c1a4b7e60", name: "test" },
  { key: "sec-0a1b2c3d4e5f", name: "testt" },
  { key: "sec-1122334455aa", name: "testtt" },
];

const ORG = "org_000000000000000000000001";

/* ── 1. A canonical expiry DOES affect headline compliance ────────────────── */

test("the canonical Store Documentation register is the headline compliance scope", async () => {
  /*
   * The positive half of the decision, and it has to be asserted or "nothing
   * affects the headline" would satisfy every other test in this file. The
   * canonical register is IN the scope, so a certificate expiring on it reaches
   * the score, the totals, the timeline and the digest.
   */
  const scope = headlineComplianceBoardIds();
  assert.deepEqual(
    [...scope],
    [STORE_DOCUMENTATION_BOARD_ID],
    "headline compliance is the canonical Store Documentation register, and only that",
  );

  /*
   * AND IT IS IN SCOPE WHETHER OR NOT ITS `boards` ROW EXISTS. `boards` is
   * materialised on demand while placements have carried
   * `board_id = 'store-documentation'` as a literal since before the table
   * existed — so an organisation can hold 31 stores, 42 expiry dates and no
   * `boards` row at all. A scope that trusted the query alone would cover
   * nothing and the digest would report that nothing had changed.
   */
  const bare = await headlineComplianceRegisters(dbHolding([]), ORG);
  assert.deepEqual(
    bare.map((board) => board.key),
    [STORE_DOCUMENTATION_BOARD_ID],
    "the canonical register is in scope even before its boards row is created",
  );
  assert.ok(bare[0].name, "and it always has a name to put in a digest");
});

test("the compliance screens take that scope without asking for it", async () => {
  const register = codeOnly(await source("app/lib/compliance-register.ts"));

  /*
   * THE COMPATIBILITY CONTRACT, RE-POINTED AT ITS NEW HOME. It used to read
   * `options.boardIds ?? [STORE_DOCUMENTATION_BOARD_ID]` — the same answer,
   * written as a second literal. It is a CALL now, so the default and the
   * digest cannot be edited apart; the contract it protects ("omitting them
   * selects the canonical board — never everything") is asserted by the
   * executed test above, which is a stronger statement than the literal was.
   */
  assert.match(
    register,
    /const boardIds = options\.boardIds \?\? headlineComplianceBoardIds\(\)/,
    "readComplianceRegister defaults to the shared headline scope",
  );

  /* And `/api/workspace` asks for no boards at all, so it gets that default. */
  const workspace = codeOnly(await source("app/api/workspace/route.ts"));
  assert.match(
    workspace,
    /readComplianceRegister\(db, orgId\)/,
    "the compliance page, the Overview tile, the calendar and the site drawer read the default scope",
  );
  assert.doesNotMatch(
    workspace,
    /storeDocumentationBoards/,
    "and never widen it to every register behind the screens' back",
  );
});

/* ── 2. A custom section instance does NOT affect headline compliance ─────── */

test("a Store Documentation section instance is outside the headline scope", async () => {
  const db = dbHolding(REGISTERS_WITH_SANDBOXES);

  /*
   * THE FIXTURE IS REAL FIRST. `storeDocumentationBoards` must SEE all four —
   * otherwise this test would pass because the stub was broken rather than
   * because the scope is narrow, which is the way a test of an exclusion lies.
   */
  const everyRegister = await storeDocumentationBoards(db, ORG);
  assert.deepEqual(
    everyRegister.map((board) => board.key).sort(),
    REGISTERS_WITH_SANDBOXES.map((board) => board.key).sort(),
    "the organisation really does own three section registers besides the canonical one",
  );

  const headline = await headlineComplianceRegisters(db, ORG);
  assert.deepEqual(
    headline.map((board) => board.key),
    [STORE_DOCUMENTATION_BOARD_ID],
    "headline compliance covers the canonical register and no section instance",
  );
  for (const board of headline) {
    assert.doesNotMatch(
      board.key,
      /^sec-/,
      "a generated section key must never reach the headline scope",
    );
  }
});

test("the scope is drawn on board identity, never on a section's name", async () => {
  /*
   * `test`, `testt` and `testtt` are what people happen to call a sandbox, not
   * a rule. A scope that matched those strings would work until somebody named
   * an instance "Concession documents" — and it would also exclude a real
   * register called "Latest tests". The exclusion is by KEY, and that is what
   * these two files must show.
   */
  for (const path of [
    "app/lib/compliance-register.ts",
    "app/api/notifications/compliance/route.ts",
  ]) {
    const text = codeOnly(await source(path));
    assert.doesNotMatch(
      text,
      /\bboard\.name\b\s*(===|!==|\.)|\.name\.(includes|startsWith|toLowerCase)\(/,
      `${path} must not decide compliance scope from a board's NAME`,
    );
    assert.doesNotMatch(
      text,
      /["'`]testt?t?["'`]/,
      `${path} must not name a sandbox section as a rule`,
    );
  }

  /*
   * And the exclusion is a property of the BOARD, in one function. Pinned by
   * its signature rather than by its prose so this fails if the helper is
   * deleted and the literal comes back in two places.
   */
  const register = codeOnly(await source("app/lib/compliance-register.ts"));
  assert.match(
    register,
    /export function headlineComplianceBoardIds\(\): readonly string\[\] \{\s*return \[STORE_DOCUMENTATION_BOARD_ID\];\s*\}/,
    "one function answers which boards headline compliance is computed over",
  );
});

/* ── 3. The digest scope IS the visible scope ─────────────────────────────── */

test("the digest resolves its scope from the same helper the screens do", async () => {
  const digest = codeOnly(await source("app/api/notifications/compliance/route.ts"));

  /*
   * RE-POINTED, WITH THE REASON. This assertion used to require
   * `storeDocumentationBoards(db, orgId)` — every register, by kind — which is
   * exactly the widening the owner has now reversed. It is not weakened: it
   * still demands that the scan name its scope out loud, and it now demands the
   * SHARED name, so the digest and the screens cannot be edited apart.
   */
  assert.match(
    digest,
    /headlineComplianceRegisters\(db, orgId\)/,
    "the scan asks which registers headline compliance covers",
  );
  assert.doesNotMatch(
    digest,
    /storeDocumentationBoards/,
    "and never re-widens itself to every Store Documentation register",
  );
  assert.match(
    digest,
    /boardIds: registers\.map\(\(board\) => board\.key\)/,
    "and derives the boards it scans from that answer, not from a literal",
  );

  /*
   * The two callers must reach the same function. Asserted as a RELATIONSHIP
   * between the two files rather than twice in isolation, because "both call
   * the helper" is the whole contract — a test that checked each side alone
   * would pass while one of them called a copy.
   */
  const register = codeOnly(await source("app/lib/compliance-register.ts"));
  assert.match(
    register,
    /export async function headlineComplianceRegisters\([\s\S]{0,400}?headlineComplianceBoardIds\(\)/,
    "the digest's helper is built from the same scope the screens default to",
  );
  assert.match(
    digest,
    /headlineComplianceRegisters,\n?\s*readComplianceRegister,/,
    "and both come from app/lib/compliance-register.ts, not from a local copy",
  );
});

/* ── Live ─────────────────────────────────────────────────────────────────── */

function call(path, options = {}, identity = ADMIN) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-maintsupp-identity": identity,
      ...(options.headers ?? {}),
    },
  });
}

async function serverIsUp() {
  try {
    return (await call("/api/workspace-sections")).ok;
  } catch {
    return false;
  }
}

test("live: nothing the digest reports is invisible on the compliance page", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }

  /*
   * THE DIVERGENCE, MEASURED FROM THE OUTSIDE. Both surfaces publish the same
   * `RegisterEntry.id` — `/api/workspace` maps `id: entry.id` and the digest
   * `id: row.id` — so the two scopes can be compared without either of them
   * having to publish a board key.
   *
   * A SUBSET, not an equality, and the direction is the point. The digest
   * filters further on top of the shared scope: `withinOperationalEstate`
   * (Europe, closed stores), "Not required", and the 90-day reminder ladder. So
   * the register legitimately holds rows the digest does not mention. What must
   * never happen is the reverse — a row somebody is emailed about that is not on
   * the page they open to act on it, which is precisely what a section instance
   * produced while the two scopes differed.
   */
  const [payload, digest] = await Promise.all([
    (await call("/api/workspace")).json(),
    (await call("/api/notifications/compliance")).json(),
  ]);

  /* `/api/workspace` wraps its payload; the register is `workspace.compliance`. */
  const visible = new Set((payload.workspace?.compliance ?? []).map((record) => record.id));
  assert.ok(visible.size > 0, "the compliance register must not be empty for this check to mean anything");

  const alerted = [...(digest.expired ?? []), ...(digest.expiring ?? [])];
  const orphans = alerted.filter((row) => !visible.has(row.id));
  assert.deepEqual(
    orphans.map((row) => `${row.id} (${row.board ?? "no board"})`),
    [],
    "every certificate the digest reports must be findable on /dashboard/compliance",
  );
});

test("live: the digest reports no register the compliance screens cannot show", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }

  /*
   * The same claim said in board keys, which is the form the defect took. A
   * digest row states its register; the only board key headline compliance
   * covers is the canonical one, and a register-only row states `null` rather
   * than claiming a register it is not on.
   */
  const digest = await (await call("/api/notifications/compliance")).json();
  const rows = [...(digest.expired ?? []), ...(digest.expiring ?? [])];
  const boards = new Set(rows.map((row) => row.board));
  for (const board of boards) {
    assert.ok(
      board === null || board === "store-documentation",
      `the digest alerted on register "${board}", which the compliance page does not show`,
    );
  }
});
