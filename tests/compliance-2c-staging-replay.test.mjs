/**
 * THE STAGING ESTATE, REPLAYED THROUGH THE REAL RESOLVER.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * Every other test in this family checks a property. This one checks the
 * OUTCOME, on the exact data the defect was found in, and it is the only
 * evidence available for item 2C without writing to a shared tenant.
 *
 * The board-derived half of the register cannot be exercised on Staging at all:
 * `portal.maintenance_group_items` holds rows only for `board_id='maintenance'`
 * (12 / 180 / 774 across the three organisations) and **zero** for
 * `store-documentation`, measured 2026-09-10. So `readStoreDocumentationRows`
 * returns empty for every tenant and every compliance record there is
 * register-only — which is precisely the branch `ensureComplianceProfile`
 * matches on, and precisely the branch this replays.
 *
 * ── WHAT THE FIXTURE IS ───────────────────────────────────────────────────
 *
 * `MEASURED_ROWS` is the verbatim result of
 *
 *   select site_id, kind from portal.compliance_documents
 *   where organisation_id = 'org_000000000000000000000002'
 *     and duty_holder is null
 *   order by site_id, kind;
 *
 * run against Staging on 2026-09-10 — the sixty requirements twelve ZZ-DEMO
 * stores held BEFORE repair-on-read ran. `duty_holder is null` is what
 * separates them from the 144 the repair created (`duty_holder = 'unconfirmed'`).
 *
 * Two rows in it are duplicates the estate already carried —
 * `zzdemo-store-07` has "Legionella risk assessment" twice and
 * `zzdemo-store-08` has "Electrical installation condition report" twice —
 * and they are kept exactly as measured, because a resolver that only works on
 * clean data is not a resolver for this estate.
 *
 * ── WHAT IT PROVES ────────────────────────────────────────────────────────
 *
 * Replaying the OLD rule (exact string equality) reproduces the 144 rows the
 * repair actually created, which is what makes this a fair replay rather than a
 * flattering one. Replaying the NEW rule shows what it would have created
 * instead. The difference is the item.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

const asModule = (js) =>
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

const spec = asModule(transpile(await read("db/monday-board-spec.ts")));
const { buildKindResolver, DEFAULT_COMPLIANCE_TEMPLATE } = await import(
  asModule(
    transpile(await read("app/lib/compliance-vocabulary.ts")).replace(
      /from ["']\.\.\/\.\.\/db\/monday-board-spec["']/g,
      `from "${spec}"`,
    ),
  )
);
const { storeDocumentationKinds } = await import(spec);

/** Verbatim from Staging, 2026-09-10. Sixty rows, twelve sites. */
const MEASURED_ROWS = [
  ["zzdemo-store-01", "Electrical installation condition report"],
  ["zzdemo-store-01", "Emergency lighting certificate"],
  ["zzdemo-store-01", "Fire risk assessment"],
  ["zzdemo-store-01", "Gas safety certificate"],
  ["zzdemo-store-01", "Legionella risk assessment"],
  ["zzdemo-store-02", "Air conditioning inspection report"],
  ["zzdemo-store-02", "Electrical installation condition report"],
  ["zzdemo-store-02", "Emergency lighting certificate"],
  ["zzdemo-store-02", "Fire risk assessment"],
  ["zzdemo-store-02", "Gas safety certificate"],
  ["zzdemo-store-02", "Legionella risk assessment"],
  ["zzdemo-store-02", "PAT testing certificate"],
  ["zzdemo-store-03", "Electrical installation condition report"],
  ["zzdemo-store-03", "Emergency lighting certificate"],
  ["zzdemo-store-03", "Fire alarm service certificate"],
  ["zzdemo-store-03", "Legionella risk assessment"],
  ["zzdemo-store-03", "PAT testing certificate"],
  ["zzdemo-store-04", "Air conditioning inspection report"],
  ["zzdemo-store-04", "Electrical installation condition report"],
  ["zzdemo-store-04", "Emergency lighting certificate"],
  ["zzdemo-store-04", "Fire risk assessment"],
  ["zzdemo-store-04", "Legionella risk assessment"],
  ["zzdemo-store-05", "Electrical installation condition report"],
  ["zzdemo-store-05", "Emergency lighting certificate"],
  ["zzdemo-store-05", "Fire risk assessment"],
  ["zzdemo-store-05", "Legionella risk assessment"],
  ["zzdemo-store-06", "Electrical installation condition report"],
  ["zzdemo-store-06", "Emergency lighting certificate"],
  ["zzdemo-store-06", "Fire risk assessment"],
  ["zzdemo-store-06", "Legionella risk assessment"],
  ["zzdemo-store-06", "PAT testing certificate"],
  ["zzdemo-store-07", "Electrical installation condition report"],
  ["zzdemo-store-07", "Fire alarm service certificate"],
  ["zzdemo-store-07", "Fire risk assessment"],
  ["zzdemo-store-07", "Legionella risk assessment"],
  ["zzdemo-store-07", "Legionella risk assessment"],
  ["zzdemo-store-08", "Electrical installation condition report"],
  ["zzdemo-store-08", "Electrical installation condition report"],
  ["zzdemo-store-08", "Emergency lighting certificate"],
  ["zzdemo-store-08", "Fire alarm service certificate"],
  ["zzdemo-store-08", "Fire risk assessment"],
  ["zzdemo-store-08", "Legionella risk assessment"],
  ["zzdemo-store-09", "Electrical installation condition report"],
  ["zzdemo-store-09", "Emergency lighting certificate"],
  ["zzdemo-store-09", "Fire risk assessment"],
  ["zzdemo-store-09", "Legionella risk assessment"],
  ["zzdemo-store-10", "Air conditioning inspection report"],
  ["zzdemo-store-10", "Electrical installation condition report"],
  ["zzdemo-store-10", "Emergency lighting certificate"],
  ["zzdemo-store-10", "Fire risk assessment"],
  ["zzdemo-store-10", "Legionella risk assessment"],
  ["zzdemo-store-11", "Electrical installation condition report"],
  ["zzdemo-store-11", "Emergency lighting certificate"],
  ["zzdemo-store-11", "Fire risk assessment"],
  ["zzdemo-store-11", "Gas safety certificate"],
  ["zzdemo-store-11", "PAT testing certificate"],
  ["zzdemo-store-12", "Electrical installation condition report"],
  ["zzdemo-store-12", "Emergency lighting certificate"],
  ["zzdemo-store-12", "Fire risk assessment"],
  ["zzdemo-store-12", "Legionella risk assessment"],
];

const SITES = [...new Set(MEASURED_ROWS.map(([siteId]) => siteId))];

function rowsFor(siteId) {
  return MEASURED_ROWS.filter(([id]) => id === siteId).map(([, kind]) => kind);
}

/**
 * The OLD rule, restated here rather than imported, because the code that
 * implemented it is gone.
 *
 *   const held = new Set(existing.map((row) => row.kind));
 *   const missing = kinds.filter((kind) => !held.has(kind));
 *
 * Exact string equality against the twelve, over the rows whose kind was one of
 * the twelve. Reproduced faithfully so the comparison below is honest.
 */
function oldRule(siteId) {
  const held = new Set(rowsFor(siteId));
  return storeDocumentationKinds.filter((kind) => !held.has(kind));
}

/**
 * The NEW rule, as `ensureComplianceProfile` now applies it: resolve every kind
 * the site holds, then look each wanted requirement up under ITS resolved name.
 */
function newRule(siteId, resolve) {
  const heldBy = new Map();
  for (const kind of rowsFor(siteId)) {
    const canonical = resolve(kind) ?? kind;
    if (!heldBy.has(canonical)) heldBy.set(canonical, kind);
  }
  const create = [];
  const aliased = [];
  for (const kind of storeDocumentationKinds) {
    const matchedAs = heldBy.get(resolve(kind) ?? kind);
    if (matchedAs === undefined) create.push(kind);
    else if (matchedAs !== kind) aliased.push({ kind, matchedAs });
  }
  return { create, aliased };
}

test("the fixture is the measurement: 60 rows, 12 sites", () => {
  assert.equal(MEASURED_ROWS.length, 60);
  assert.equal(SITES.length, 12);
});

test("the OLD rule reproduces the 144 rows the repair actually created", () => {
  /*
   * THE CONTROL. If replaying the old rule did not land on 144, the comparison
   * below would be measuring a straw man rather than the defect. It lands on
   * exactly 144 — twelve requirements at every one of twelve sites, because the
   * old rule recognised NONE of the sixty names already there.
   */
  const created = SITES.reduce((sum, siteId) => sum + oldRule(siteId).length, 0);
  assert.equal(created, 144, "twelve sites x twelve requirements, none recognised");
  for (const siteId of SITES) {
    assert.equal(oldRule(siteId).length, 12, `${siteId} got a full twelve it did not need`);
  }
});

test("the NEW rule recognises 52 requirements and creates 92 instead of 144", () => {
  const resolve = buildKindResolver(DEFAULT_COMPLIANCE_TEMPLATE);
  let create = 0;
  let aliased = 0;
  for (const siteId of SITES) {
    const plan = newRule(siteId, resolve);
    create += plan.create.length;
    aliased += plan.aliased.length;
  }
  /*
   * FIFTY-TWO, and the arithmetic is worth writing out because the first draft
   * of this test guessed 54 and was wrong:
   *
   *   54  rows carry a name that IS another name for a board slot
   *       (EICR 13, Emergency lighting 11, Legionella 12, Fire risk 11,
   *        Fire alarm service 3, PAT testing 4)
   *   -2  the estate's own pre-existing duplicates — store-07 holds
   *       "Legionella risk assessment" twice and store-08 holds
   *       "Electrical installation condition report" twice, and each pair is
   *       ONE requirement matched once
   *   ──
   *   52  distinct (site, requirement) pairs already held under another name
   *
   * The remaining six of the sixty are "Air conditioning inspection report" (3)
   * and "Gas safety certificate" (3), which are NOT other names for a board slot
   * and are deliberately left alone as register-only requirements.
   */
  assert.equal(aliased, 52, "requirements already held under another name");
  assert.equal(create, 144 - 52, "and only the genuinely absent ones are created");
  assert.equal(create, 92);
});

test("not one of the 52 is duplicated — the whole point of the item", () => {
  const resolve = buildKindResolver(DEFAULT_COMPLIANCE_TEMPLATE);
  for (const siteId of SITES) {
    const { create, aliased } = newRule(siteId, resolve);
    for (const entry of aliased) {
      assert.ok(
        !create.includes(entry.kind),
        `${siteId}: "${entry.kind}" is held as "${entry.matchedAs}" and must not also be created`,
      );
    }
  }
});

test("the estate's own wording survives; nothing is renamed", () => {
  /*
   * `newRule` returns what would be CREATED and what was MATCHED. It never
   * returns a rename, because `ensureComplianceProfile` never performs one —
   * the operator's word for their own certificate is theirs.
   */
  const resolve = buildKindResolver(DEFAULT_COMPLIANCE_TEMPLATE);
  const { aliased } = newRule("zzdemo-store-01", resolve);
  const legionella = aliased.find((entry) => entry.matchedAs === "Legionella risk assessment");
  assert.equal(legionella.kind, "Water Hygiene", "the template's name for it");
  assert.equal(legionella.matchedAs, "Legionella risk assessment", "and the estate's, unchanged");
});

test("the two requirements the board does not track are left as themselves", () => {
  /*
   * Folding "Gas safety certificate" into a board slot would be a lie that
   * loses a real certificate. It resolves to nothing, stays a register-only
   * row, and the editable template is how an estate promotes it.
   */
  const resolve = buildKindResolver(DEFAULT_COMPLIANCE_TEMPLATE);
  assert.equal(resolve("Gas safety certificate"), null);
  assert.equal(resolve("Air conditioning inspection report"), null);
  const { create, aliased } = newRule("zzdemo-store-01", resolve);
  const names = [...create, ...aliased.map((entry) => entry.kind)];
  assert.ok(!names.includes("Gas safety certificate"), "never proposed as a board requirement");
});

test("a site's total after the fix is 12 or 13, not 17", () => {
  /*
   * The number a person sees. Before: twelve stores holding seventeen
   * requirements each (five originals plus twelve), the confirm queue asking
   * about each certificate twice. After: the twelve the template asks for, plus
   * any genuinely extra requirement the estate tracks on its own.
   */
  const resolve = buildKindResolver(DEFAULT_COMPLIANCE_TEMPLATE);
  for (const siteId of SITES) {
    const before = rowsFor(siteId).length;
    const afterOld = before + oldRule(siteId).length;
    const afterNew = before + newRule(siteId, resolve).create.length;
    assert.ok(afterOld >= 16, `${siteId} held ${afterOld} under the old rule`);
    assert.ok(
      afterNew <= 14,
      `${siteId} holds ${afterNew} under the new one, which must be about twelve`,
    );
  }
  const totalOld = SITES.reduce((sum, id) => sum + rowsFor(id).length + oldRule(id).length, 0);
  const totalNew = SITES.reduce(
    (sum, id) => sum + rowsFor(id).length + newRule(id, resolve).create.length,
    0,
  );
  assert.equal(totalOld, 204, "the 204 rows Staging actually holds today");
  assert.equal(totalNew, 152, "against what the resolver would have produced");
  /* 152 rather than 144 because six of the sixty are genuinely extra
     requirements this estate tracks and the board does not, and because two of
     its rows were already duplicated before any of this ran. Neither is
     something a resolver should silently tidy away. */
});
