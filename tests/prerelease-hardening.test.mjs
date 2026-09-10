/**
 * THE FOUR PRE-RELEASE HARDENING CONTRACTS.
 *
 * Each of these was a finding, each was fixed, and each is the kind of thing
 * that comes back silently — a capability string edited to the neighbouring
 * one, an insert re-introduced into a read, a default that quietly stops
 * reading the organisation's own template. So they are pinned here together,
 * with what each one costs written down rather than left to be rediscovered.
 *
 * ── WHY SOURCE PINS AND NOT A RUNNING DATABASE ────────────────────────────
 *
 * `compliance-profile.ts` imports drizzle, the schema and the database module,
 * so it cannot be transpiled into a `data:` URL and called the way the pure
 * modules in this suite are. The BEHAVIOUR was measured instead, against the
 * running dev server, and the numbers are recorded in each test so a reader can
 * tell what these pins are standing in for:
 *
 *   · a read-only `client` reading a site three times moved its compliance rows
 *     12 → 12 and wrote no activity row;
 *   · that same caller was refused both write paths with
 *     403 "Your role (Client) does not have the \"sites.edit\" permission";
 *   · an authorised editor's explicit repair created 12 rows, a second identical
 *     repair created 0, and the batch's audit row carried
 *     `actor_email=owner@maintsupp.com` scoped to its organisation;
 *   · reverting that batch returned the site to 0 rows.
 *
 * Reads normalise CRLF — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const sitesRoute = await read("app/api/sites/route.ts");
const profile = await read("app/lib/compliance-profile.ts");
const backfill = await read("app/api/compliance/backfill/route.ts");
const responsibilities = await read("app/api/compliance/responsibilities/route.ts");
const templateRoute = await read("app/api/compliance/template/route.ts");

/** The body of one exported function, so a pin cannot match a neighbour. */
const bodyOf = (source, signature) => {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `could not find ${signature}`);
  const next = source.indexOf("\nexport ", start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
};

/* ── 1. A READ MUST NOT WRITE ─────────────────────────────────────────────── */

test("the sites GET performs no database write of any kind", () => {
  /*
   * THE DEFECT. This handler called `ensureComplianceProfile`, which inserts up
   * to twelve `compliance_documents` rows, and then `logChange`, which inserts
   * an `activity_log` row naming the caller as the author. It resolves
   * `scopedDb` with NO capability — reading a site needs none — so a `client`,
   * whose whole permission set is `board.view` and `data.export`, caused both
   * merely by opening a page, and the audit trail credited them with it.
   *
   * Asserted over the GET's own body rather than the file, because the POST and
   * PATCH in the same file write legitimately and a file-wide search would have
   * to be so narrow it proved nothing.
   */
  const get = bodyOf(sitesRoute, "export async function GET(");
  for (const forbidden of [
    "ensureComplianceProfile(",
    "logChange(",
    ".insert(",
    ".update(",
    ".delete(",
  ]) {
    assert.ok(
      !get.includes(forbidden),
      `the sites GET must not call ${forbidden} — a read that writes is what this pin exists to stop`,
    );
  }
});

test("the read reports the gap instead of repairing it", () => {
  const get = bodyOf(sitesRoute, "export async function GET(");
  assert.match(
    get,
    /complianceProfileGap\(db, orgId, id\)/,
    "the read must ask the read-only matcher",
  );
  assert.match(get, /complianceProfile,/, "and return the answer to the screen");
});

test("the read-only matcher has no insert on its call path", () => {
  /*
   * `complianceProfileGap` was split out of `ensureComplianceProfile` so a
   * reader could ask "is this profile complete" without a function that inserts
   * being anywhere it could reach. If the split ever collapses back, this is
   * what notices.
   */
  const gap = bodyOf(profile, "export async function complianceProfileGap(");
  assert.ok(!gap.includes(".insert("), "complianceProfileGap must never insert");
  assert.ok(!gap.includes("chunkRows("), "and must not reach the batched writer");
  assert.match(gap, /return \{ missing, matched, aliased \}/, "it returns the gap and nothing else");
});

test("the writer reuses the matcher rather than repeating it", () => {
  /*
   * Two copies of "does this site already hold this requirement, under any of
   * its names" would be two answers to the question a duplicate row depends on.
   */
  const writer = bodyOf(profile, "export async function ensureComplianceProfile(");
  assert.match(writer, /await complianceProfileGap\(/, "the writer calls the matcher");
  assert.ok(
    !writer.includes("const heldBy = new Map"),
    "and does not carry a second copy of the matching",
  );
});

/* ── 2. THE ORGANISATION'S OWN TEMPLATE ───────────────────────────────────── */

test("a profile is built from the organisation's template by default", () => {
  /*
   * THE DEFECT. `ensureComplianceProfile` defaulted to `buildKindResolver()`
   * with no argument — the built-in synonyms and nothing organisation-specific
   * — under a docstring claiming "the routes that create sites do" pass their
   * own. They did not: the sites route, the CSV importer and the workspace
   * route all called it with no options at all, so every site-create path
   * ignored that organisation's aliases and re-created the duplication the
   * whole vocabulary design exists to end.
   *
   * Fixing the call sites would have left the trap for the next one. The
   * DEFAULT is the fix, so a caller passes a resolver only to skip a read it
   * has already done.
   */
  const gap = bodyOf(profile, "export async function complianceProfileGap(");
  assert.match(
    gap,
    /options\.resolve \?\? buildKindResolver\(await readComplianceTemplate\(db, orgId\)\)/,
    "the default resolver must be the organisation's own template",
  );
  assert.ok(
    !/options\.resolve \?\? buildKindResolver\(\)/.test(profile),
    "the built-ins-only default is the defect and must not return",
  );
});

test("the backfill still passes its own resolver, because it loops", () => {
  /* It reads the template once and reuses it across many sites; re-reading per
     site is the only thing the default would cost it. */
  assert.match(backfill, /const template = await readComplianceTemplate\(db, orgId\)/);
  assert.match(backfill, /resolve,/);
});

/* ── 4. THE CAPABILITY THAT MATCHES THE RESOURCE ─────────────────────────── */

test("compliance writes require sites.edit, the capability defined for them", () => {
  /*
   * `sites.edit` is described in `app/lib/permissions.ts` as "Change the site
   * register, units and COMPLIANCE RECORDS". `board.edit` is "create, update
   * and move rows, columns and groups on a BOARD". A `compliance_documents` row
   * is the first and not the second, and every pre-existing writer of it —
   * `WORKSPACE_CAPABILITY.compliance` and the three site routes — already took
   * `sites.edit`. Two routes added later took `board.edit` and were the odd
   * ones out.
   *
   * Not an escalation under the built-in roles, which give `admin` both. It
   * mattered because `role_capabilities` is a per-organisation toggle: a
   * bespoke role granted `board.edit` alone would have received the compliance
   * register with it, silently.
   */
  for (const [name, source] of [
    ["backfill", backfill],
    ["responsibilities", responsibilities],
  ]) {
    assert.match(
      source,
      /scopedDbWithCapability\(request, "sites\.edit"\)/,
      `${name} must gate its write on sites.edit`,
    );
    assert.ok(
      !/scopedDbWithCapability\(request, "board\.edit"\)/.test(source),
      `${name} must not gate a compliance write on board.edit`,
    );
  }
});

test("reading compliance still needs only board.view", () => {
  /* The tightening is about writes. A reader must not have been locked out. */
  assert.match(responsibilities, /scopedDbWithCapability\(request, "board\.view"\)/);
  assert.match(templateRoute, /scopedDbWithCapability\(request, "board\.view"\)/);
});

test("the revert is deliberately not behind data.delete", () => {
  /* `data.delete` is the permanent purge of real data and is withheld from
     `admin` on purpose; undoing a batch of placeholder rows this endpoint
     created minutes ago is not that, and requiring it would mean the only
     people who can run a backfill cannot undo one. */
  assert.ok(
    !/scopedDbWithCapability\(request, "data\.delete"\)/.test(backfill),
    "the backfill must not require data.delete",
  );
});

/* ── 5. AN ALIAS MAY NOT SHADOW A CANONICAL NAME ──────────────────────────── */

test("every requirement's own name is claimed before aliases are checked", () => {
  /*
   * THE DEFECT. The conflict check compared aliases only with OTHER ALIASES, so
   * a template could hand one requirement's canonical name to another as an
   * alias — `{kind:"Fire Alarm", aliases:["Fire Door"]}` beside a real "Fire
   * Door" — and be answered 200. Nothing broke visibly, which is the problem:
   * the resolver breaks ties by specificity and a canonical name outranks an
   * alias, so the alias was stored and silently did nothing for ever. The
   * operator is told their rule saved and it never fires.
   */
  const put = bodyOf(templateRoute, "export async function PUT(");
  assert.match(
    put,
    /const canonical = new Set<string>\(\)/,
    "the canonical names must be tracked",
  );
  assert.match(
    put,
    /claimant\.set\(key, entry\.kind\);\n      canonical\.add\(key\)/,
    "and seeded into the same map the aliases are checked against",
  );
});

test("a name conflict answers 409, the code this API uses for a conflict", () => {
  /*
   * The payload is well formed; it conflicts with something already named in
   * it. `workspace-sections` answers 409 when a name is still held, and the
   * admin and invitation routes do the same. The pre-existing alias-versus-alias
   * case moved to 409 with the new one rather than leaving one route answering
   * two codes for one class of problem.
   *
   * Measured against the running route: an alias equal to a canonical name, and
   * one that only NORMALISES to it ("  fire   DOOR "), both answered 409; a
   * requirement listing its own name and a legitimate alias both answered 200.
   */
  const put = bodyOf(templateRoute, "export async function PUT(");
  assert.match(put, /status: 409/, "a name conflict is a 409");
  assert.ok(
    !/A name can only mean one requirement\.`,\s*\},\s*\{ status: 400 \}/.test(put),
    "the older 400 for the same class of problem is gone",
  );
});

test("a requirement may still list its own name", () => {
  /* `held === entry.kind` is a no-op, not a conflict, and refusing it would
     reject a template somebody typed carefully. */
  const put = bodyOf(templateRoute, "export async function PUT(");
  assert.match(
    put,
    /if \(held && held !== entry\.kind\)/,
    "the conflict is only with a DIFFERENT requirement",
  );
});
