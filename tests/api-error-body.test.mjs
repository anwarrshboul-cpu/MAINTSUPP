/**
 * AN ERROR MUST ARRIVE AS JSON, BECAUSE THE CLIENT IS GOING TO PARSE IT.
 *
 * The reported symptom was a sentence in the account menu:
 *
 *   Failed to execute 'json' on 'Response': Unexpected end of JSON input
 *
 * which is the PARSER complaining, not the server. What the server had
 * actually done was answer 500 with an empty body, and the menu called
 * `response.json()` before looking at `response.ok`, so the parse threw and
 * its message was reported as though the account were the problem. An operator
 * looking at that sentence goes hunting in the client. The real fault was the
 * database refusing connections.
 *
 * ── WHY THE BODY WAS EMPTY ────────────────────────────────────────────────
 *
 * Every one of these route handlers ends in a catch that answers with JSON, so
 * the shape is right. The bug was WHERE the boot call sat:
 *
 *     export async function GET(request: Request) {
 *       await ensureDatabase();          // <- outside
 *       try {
 *         …
 *       } catch (error) { return Response.json({ error }, { status: 503 }); }
 *     }
 *
 * `ensureDatabase()` runs the migration replay on the first request of every
 * instance, so it is the FIRST thing to fail when the database is unreachable —
 * and sitting outside the try, its throw escaped the handler entirely. The
 * platform then answered for it, with no body. Measured on the deployed
 * Preview: `GET /api/context` returned `500` and zero bytes, while every route
 * whose boot call was inside its try returned a readable
 * `503 {"error":"…temporarily unavailable."}` from the same broken database.
 *
 * Twenty-nine handlers had the boot call outside. This pins the thirteen that
 * were corrected by the safe one-line move, and lists the ones that were not,
 * so the remainder is a known quantity rather than a surprise.
 *
 * Reads normalise CRLF — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Every `route.ts` under app/api, as repo-relative POSIX paths. */
async function routeFiles(dir = "app/api", out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const next = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await routeFiles(next, out);
    else if (entry.name === "route.ts") out.push(next);
  }
  return out;
}

/**
 * Handlers whose boot call is still outside their try, with the reason each
 * was left alone. This list is the POINT of the test: it may shrink, and a
 * shrink means somebody did the work. It must not grow.
 *
 * The four auth routes and `files/[id]` are not one-line moves. `files/[id]`
 * wraps only its `scopedDb` call and deliberately re-throws anything else so a
 * genuine fault stays a fault, and it streams bytes rather than returning
 * JSON, so giving it an outer catch is a change of shape rather than of line
 * order. The auth family runs `getD1()` and `ensureOwnerAccount()` between the
 * boot call and the try. `updates` opens its try around `scopedDb` alone.
 */
const KNOWN_OUTSIDE = new Set([
  "app/api/auth/invitations/route.ts",
  "app/api/auth/invitations/[token]/route.ts",
  "app/api/auth/login/route.ts",
  "app/api/auth/logout/route.ts",
  "app/api/auth/logout-all/route.ts",
  "app/api/auth/password/route.ts",
  "app/api/auth/password-resets/[token]/route.ts",
  "app/api/files/[id]/route.ts",
  "app/api/updates/route.ts",
]);

/** Per handler: does `ensureDatabase()` come before the handler's first `try`? */
function bootOutsideTry(source) {
  const found = [];
  const starts = [...source.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\s*\(/g)];
  for (const [index, match] of starts.entries()) {
    const from = match.index;
    const to = starts[index + 1]?.index ?? source.length;
    const body = source.slice(from, to);
    const boot = body.indexOf("ensureDatabase()");
    if (boot < 0) continue;
    const tryAt = body.indexOf("try {");
    if (tryAt < 0 || boot < tryAt) found.push(match[1]);
  }
  return found;
}

test("a route that boots the database does it where its catch can see it", async () => {
  const offenders = [];
  for (const file of await routeFiles()) {
    if (KNOWN_OUTSIDE.has(file)) continue;
    const verbs = bootOutsideTry(await read(file));
    if (verbs.length) offenders.push(`${file} (${verbs.join(", ")})`);
  }
  assert.deepEqual(
    offenders,
    [],
    "these handlers would answer a database failure with an unparseable empty body:\n  " +
      offenders.join("\n  "),
  );
});

test("the exemption list only ever shrinks", async () => {
  /*
   * A name left in this set after the handler was fixed is a lie that hides
   * the next regression, so the set is checked against reality in both
   * directions.
   */
  const files = new Set(await routeFiles());
  for (const exempt of KNOWN_OUTSIDE) {
    assert.ok(files.has(exempt), `${exempt} is exempted and does not exist`);
    const verbs = bootOutsideTry(await read(exempt));
    assert.ok(
      verbs.length > 0,
      `${exempt} no longer needs its exemption — remove it from KNOWN_OUTSIDE`,
    );
  }
});

test("the routes behind the reported symptoms now answer inside their try", async () => {
  /*
   * Named individually because these are the four the incident was actually
   * about: `/api/context` is what the portal shell and the workspace menu
   * read — "Workspace unavailable", "Your workspace could not be read" —
   * `/api/account` is the account menu that showed the parser's message, and
   * `/api/trash` is the Recycle Bin.
   */
  for (const file of [
    "app/api/context/route.ts",
    "app/api/account/route.ts",
    "app/api/account/sessions/route.ts",
    "app/api/trash/route.ts",
  ]) {
    const source = await read(file);
    assert.deepEqual(bootOutsideTry(source), [], `${file} must boot inside its try`);
    assert.match(
      source,
      /  try \{\n    await ensureDatabase\(\);/,
      `${file}: the boot call belongs on the first line INSIDE the try`,
    );
  }
});

test("the account menu reports the server's failure, not the parser's", async () => {
  /*
   * Counted over CODE ONLY. The comment explaining this fix quotes the broken
   * line it replaced — as it should, that is the explanation — and a rule that
   * counts prose is a rule against writing the explanation down. Every source
   * check in this suite strips comments first, for the same reason.
   */
  const menu = (await read("app/(app)/portal/account-menu.tsx"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  /*
   * Two of the three call sites — a read and a write — parsed before checking
   * the status. Either `.catch()` form is accepted: what matters is that a
   * body-less answer becomes a missing payload rather than a thrown TypeError,
   * and `() => ({})` on the third site was already doing that.
   */
  const parses = menu.match(/await response\.json\(\)/g) ?? [];
  const guarded = menu.match(/await response\.json\(\)\.catch\(\(\) => (?:null|\(\{\}\))\)/g) ?? [];
  assert.equal(
    parses.length,
    guarded.length,
    `every response.json() in the account menu must be guarded (${parses.length} parses, ${guarded.length} guarded)`,
  );
  assert.ok(guarded.length >= 3, "the read, the write, and the workspace switch");

  /* And the status is carried, so a body-less failure still tells the reader
     something they can repeat to somebody else. */
  assert.match(menu, /\(HTTP \$\{response\.status\}\)/);
  assert.doesNotMatch(
    menu,
    /Unexpected end of JSON input/,
    "the parser's sentence must never be presented as the account's problem",
  );
});
