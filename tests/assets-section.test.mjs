/**
 * THE ASSETS SECTION — the contracts that do not need a server.
 *
 * Two halves, and they are different kinds of assertion on purpose.
 *
 * The first half CALLS `app/lib/asset-model.ts`. That module is pure — no
 * hooks, no JSX, no clock, and its only import is a type — precisely so the
 * rules it owns can be executed here rather than pattern-matched. A cycle check
 * asserted by grepping for the word "cycle" proves nothing; one that builds a
 * three-deep chain and asks does.
 *
 * The second half PINS SOURCE, which is this suite's style for the rules that
 * live in a route or a screen and cannot be loaded without a Worker runtime
 * around them. Those pins are contracts, not spelling: each one names the
 * defect it would catch.
 *
 * The live half — tenancy, site scope, CSV, the bin — is
 * `tests/assets-security.test.mjs`, which skips when no dev server answers.
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

/*
 * Source with its comments removed.
 *
 * Every "this file must not contain X" assertion below reads THIS, never the
 * raw text — because the prose in these files explains why X is forbidden and
 * therefore quotes it. Three of these checks failed on their own subject's
 * comment before the helper existed, which is a test failing for the opposite
 * of its reason.
 */
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/*
 * The model is TypeScript with NO runtime imports, so it transpiles to a
 * `data:` URL with nothing to rewrite and loads directly — the pattern ten
 * other suites in this directory use.
 *
 * This is also why `asset-model.ts` has to stay a leaf. Its only import is an
 * `import type`, which the transpiler erases; a value import of anything
 * relative would not resolve from a `data:` URL and these assertions would have
 * to fall back to matching source text, which proves spelling rather than
 * behaviour.
 */
const model = await (async () => {
  const source = await read("app/lib/asset-model.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
})();

/* ── 1. The rules, executed ───────────────────────────────────────────────── */

test("the model module loads and is callable", () => {
  assert.ok(model, "asset-model.ts must stay importable — it is a pure leaf by design");
  assert.equal(typeof model.wouldCycle, "function");
  assert.equal(typeof model.parseSpecs, "function");
  assert.equal(typeof model.costPence, "function");
  assert.equal(typeof model.safeUrl, "function");
});

test("an asset cannot be its own parent, however far round the loop", () => {
  /* Self. The zero-length case, which a plain walk never reaches. */
  assert.equal(model.wouldCycle("a", "a", () => null), true);

  /* a -> b -> a. The two-step loop, which is the one people actually make. */
  const twoStep = { b: "a" };
  assert.equal(model.wouldCycle("a", "b", (id) => twoStep[id] ?? null), true);

  /* a -> b -> c -> a, three deep. */
  const threeStep = { c: "b", b: "a" };
  assert.equal(model.wouldCycle("a", "c", (id) => threeStep[id] ?? null), true);

  /* A legitimate chain: cabinet holds a light, the light is not the cabinet. */
  const legitimate = { cabinet: null };
  assert.equal(
    model.wouldCycle("light", "cabinet", (id) => legitimate[id] ?? null),
    false,
    "a real parent must not be refused — the rule has to be usable as well as safe",
  );

  /*
   * A chain longer than the walk is REFUSED, not allowed.
   *
   * An unresolvable chain is not a proven cycle, but it is not something to
   * write either. Failing closed is the direction that cannot produce a page
   * which never finishes rendering.
   */
  const endless = (id) => `${id}x`;
  assert.equal(model.wouldCycle("a", "b", endless), true);
});

test("a specification without a name is not a fact about the asset", () => {
  const parsed = model.parseSpecs([
    { key: "Voltage", value: "24", unit: "V" },
    { key: "  ", value: "abandoned", unit: "" },
    { value: "no name at all" },
  ]);
  assert.deepEqual(parsed, [{ key: "Voltage", value: "24", unit: "V" }]);
});

test("specifications survive a round trip through the column", () => {
  const written = model.serialiseSpecs([{ key: "IP rating", value: "65", unit: "" }]);
  assert.deepEqual(model.parseSpecs(written), [
    { key: "IP rating", value: "65", unit: "" },
  ]);
  /* A column that has never been written reads as an empty list, not a crash. */
  assert.deepEqual(model.parseSpecs(null), []);
  assert.deepEqual(model.parseSpecs("not json at all"), []);
  assert.deepEqual(model.parseSpecs("{}"), []);
});

test("a duplicate specification keeps the later value, not both", () => {
  const parsed = model.parseSpecs([
    { key: "Width", value: "10", unit: "mm" },
    { key: "width", value: "12", unit: "mm" },
  ]);
  assert.equal(parsed.length, 1, "one name, one value — a register cannot show two widths");
  assert.equal(parsed[0].value, "12");
});

test("the specification list is bounded", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({
    key: `Spec ${index}`,
    value: String(index),
    unit: "",
  }));
  assert.equal(model.parseSpecs(many).length, model.MAX_SPECS);
});

test("money is pence, and a negative cost is refused", () => {
  assert.equal(model.costPence("42.50"), 4250);
  assert.equal(model.costPence(42.5), 4250);
  assert.equal(model.costPence(""), null);
  assert.equal(model.costPence(null), null);
  /*
   * A replacement cannot cost minus four hundred pounds, and the column is an
   * integer a report sums. Refusing beats storing a negative that later
   * silently reduces a total.
   */
  assert.equal(model.costPence("-400"), null);
  assert.equal(model.costPence("not a number"), null);
  /* No float creeps in: 0.1 + 0.2 arithmetic must not reach the column. */
  assert.equal(Number.isInteger(model.costPence("0.30")), true);
});

test("a supplier link is http(s) or it is not stored", () => {
  assert.equal(model.safeUrl("https://parts.example.com/x"), "https://parts.example.com/x");
  assert.equal(model.safeUrl("http://parts.example.com/x"), "http://parts.example.com/x");
  /*
   * THE ONE THAT MATTERS. A `javascript:` supplier link rendered as an anchor
   * by the detail screen is stored XSS against everybody who can see the asset.
   */
  assert.equal(model.safeUrl("javascript:alert(1)"), null);
  assert.equal(model.safeUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(model.safeUrl("  "), null);
  assert.equal(model.safeUrl("not a url"), null);
});

test("the asset number is a reference somebody can quote", () => {
  assert.equal(model.formatAssetNumber(1), "AST-000001");
  assert.equal(model.formatAssetNumber(123), "AST-000123");
  assert.match(model.formatAssetNumber(99), model.ASSET_NUMBER_PATTERN);
  /* Never an index: 0 and a negative both land on the first real number. */
  assert.equal(model.formatAssetNumber(0), "AST-000001");
});

test("kind is a closed vocabulary and an unknown value falls back rather than throwing", () => {
  assert.deepEqual([...model.ASSET_KINDS], [
    "equipment",
    "component",
    "replacement_part",
    "reference",
  ]);
  assert.equal(model.assetKind("component"), "component");
  assert.equal(model.assetKind("whatever a caller invented"), "equipment");
  assert.equal(model.assetKindLabel("replacement_part"), "Replacement part");
});

test("the search reaches the specification JSON, which is why it is in the browser", () => {
  const haystack = model.assetHaystack({
    name: "LED strip",
    partNumber: "LF-STRIP-3000-IP20-5M",
    specs: [{ key: "Colour temperature", value: "3000", unit: "K" }],
    siteName: "Kingsway Central",
  });
  assert.ok(haystack.includes("3000"), "the measured value is searchable");
  assert.ok(haystack.includes("lf-strip-3000"), "and so is the part number");
  assert.ok(haystack.includes("kingsway"), "and the site the asset is at");
});

test("needs-replacement is decided by the stored value, not a label", () => {
  assert.equal(model.needsReplacement("Needs replacement"), true);
  assert.equal(model.needsReplacement("needs replacement"), true);
  assert.equal(model.needsReplacement("Active"), false);
  assert.equal(model.needsReplacement(null), false);
});

/* ── 2. The schema ────────────────────────────────────────────────────────── */

test("the asset is the units table, extended and never replaced", async () => {
  const schema = await read("db/schema.ts");
  /*
   * A SECOND `assets` table is the thing this section was built not to create.
   * `units` has been the asset register since W5, `attachments.unit_id` is an
   * upload anchor the file routes already validate against the tenant, and the
   * Sites screen already draws a tab called Assets from these rows. Two tables
   * would be two answers to "what equipment is at Kingsway".
   */
  assert.doesNotMatch(
    schema,
    /sqliteTable\(\s*"assets"/,
    "a parallel assets table would give the product two asset registers",
  );
  for (const column of [
    'assetNumber: text("asset_number")',
    'kind: text("kind")',
    'partNumber: text("part_number")',
    'paintReference: text("paint_reference")',
    'specs: text("specs")',
    'parentUnitId: text("parent_unit_id")',
    'supplierContractorId: text("supplier_contractor_id")',
    'replacementPartNumber: text("replacement_part_number")',
    'replacementCostPence: integer("replacement_cost_pence")',
    'primaryImageId: text("primary_image_id")',
    'deletedAt: text("deleted_at")',
  ]) {
    assert.ok(schema.includes(column), `units must carry ${column}`);
  }
  /* The history is a lifecycle now, and `service_type` kept its old meaning. */
  assert.match(schema, /eventType: text\("event_type"\)/);
  assert.match(schema, /previousDetail: text\("previous_detail"\)/);
  assert.match(schema, /serviceType: text\("service_type"\)/);
});

test("the asset number is unique per workspace, which is what makes it a reference", async () => {
  const schema = await read("db/schema.ts");
  assert.match(
    schema,
    /uniqueIndex\("units_asset_number_idx"\)\.on\(table\.organisationId, table\.assetNumber\)/,
    "a duplicate AST- number is one somebody quotes on an order",
  );
});

test("the migration is additive and its cost on the boot path is guarded", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /async function ensureAssetsFoundation\(/);
  assert.match(init, /await ensureAssetsFoundation\(d1\);/, "and it is actually called");

  /*
   * The stage this section adds must not make the known cold-start problem
   * worse. No destructive statement, and the vocabulary seed is guarded by one
   * query that returns nothing on a warm database rather than a loop of
   * `INSERT OR IGNORE`s over every tenant on every boot.
   */
  const stage = init.slice(
    init.indexOf("async function ensureAssetsFoundation("),
    init.indexOf("async function seedOptionValues("),
  );
  assert.doesNotMatch(stage, /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
  assert.doesNotMatch(stage, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(stage, /\bALTER TABLE \w+ RENAME\b/i);
  assert.match(
    stage,
    /AND NOT EXISTS \(/,
    "the vocabulary seed must ask which workspaces need it, not write to all of them",
  );
  assert.match(stage, /if \(organisations\.length === 0\) return;/);
  for (const statement of stage.match(/INSERT(\s+OR\s+IGNORE)?\s+INTO/gi) ?? []) {
    assert.match(statement, /INSERT\s+OR\s+IGNORE\s+INTO/i, `a bare INSERT: ${statement}`);
  }
});

test("no asset number is back-filled on the boot path", async () => {
  const init = await read("db/init.ts");
  const stage = init.slice(
    init.indexOf("async function ensureAssetsFoundation("),
    init.indexOf("async function seedOptionValues("),
  );
  /*
   * A write per asset at every cold start is fine at five rows and an outage at
   * five thousand. Rows that predate the column are numbered when somebody
   * opens them — see `readOne`.
   */
  assert.doesNotMatch(stage, /UPDATE units/i, "numbering every asset on boot is the trap here");
  const route = await read("app/api/assets/route.ts");
  assert.match(route, /if \(!assetNumber\) \{/, "the lazy mint is on the single-record read");
});

/* ── 3. The route ─────────────────────────────────────────────────────────── */

test("there is exactly one writer of the asset register", async () => {
  /*
   * `/api/units` is gone rather than kept alongside. Two routes writing one
   * table is how the contractor scorecard came to print four disagreeing
   * figures, and the old route additionally answered 200 for an id belonging to
   * another tenant.
   */
  await assert.rejects(
    () => read("app/api/units/route.ts"),
    "the superseded route must not be kept beside its replacement",
  );
  const route = await read("app/api/assets/route.ts");
  assert.match(route, /export const dynamic = "force-dynamic";/);
  for (const verb of ["GET", "POST", "PATCH", "DELETE"]) {
    assert.match(route, new RegExp(`export async function ${verb}\\(`));
  }
});

test("every write verb demands the capability, and every read is tenant-scoped", async () => {
  const route = await read("app/api/assets/route.ts");
  const writes = route.split(/export async function (?:POST|PATCH|DELETE)\(/).slice(1);
  assert.equal(writes.length, 3);
  for (const body of writes) {
    const head = body.slice(0, 400);
    assert.match(
      head,
      /scopedDbWithCapability\(request, "sites\.edit"\)/,
      "a write route that resolves a scope and then writes is not authorisation",
    );
    assert.match(head, /if \(guard\.denied\) return guard\.denied;/, "the refusal is returned");
  }
  /* `sites.edit` is reused rather than invented: the capability is already
     described as "Edit sites and assets", and a new one would be held by
     nobody until somebody edited the roles matrix. */
  const permissions = await read("app/lib/permissions.ts");
  assert.match(permissions, /key: "sites\.edit"[\s\S]{0,120}Edit sites and assets/);
});

test("an UPDATE that matches nothing is not reported as a success", async () => {
  const route = await read("app/api/assets/route.ts");
  for (const verb of ["PATCH", "DELETE"]) {
    const body = route.slice(route.indexOf(`export async function ${verb}(`));
    const upTo = body.slice(0, body.indexOf("} catch"));
    assert.match(
      upTo,
      /if \(!current\) return Response\.json\(\{ error: "Asset not found\." \}, \{ status: 404 \}\);/,
      `${verb} must look the row up before writing — a WHERE that matches nothing answers 200`,
    );
  }
});

test("the activity id cannot collide under concurrency", async () => {
  const route = await read("app/api/assets/route.ts");
  /*
   * The route this replaced built `activity-unit-<id>-<Date.now base36>` with
   * no random suffix. Measured on `sites`: 113 of 144 concurrent PATCHes failed
   * on the primary key, and because the row UPDATE ran first the caller was
   * told "failed" for a write that had already landed.
   */
  assert.match(
    route,
    /activity-asset-\$\{assetId\}-\$\{Date\.now\(\)\.toString\(36\)\}-\$\{Math\.random\(\)/,
    "an activity id built from a clock alone collides",
  );
});

test("the asset number is minted atomically", async () => {
  const route = await read("app/api/assets/route.ts");
  const mint = route.slice(
    route.indexOf("async function nextAssetNumber("),
    route.indexOf("/* ── Payload"),
  );
  /*
   * Increment and read in ONE statement. The two-statement version has already
   * been measured wrong in this codebase on job references: ten concurrent
   * creates were handed three distinct numbers, one of them shared by five.
   */
  assert.match(mint, /\.update\(organisations\)/);
  assert.match(mint, /\.returning\(\{ sequence: organisations\.assetSequence \}\)/);
  assert.doesNotMatch(mint, /\.select\(/, "a separate read after the increment is the race");
});

test("every relation is proved to belong to the caller's workspace", async () => {
  const route = await read("app/api/assets/route.ts");
  for (const [helper, table] of [
    ["assertSite", "sites"],
    ["assertSupplier", "contractors"],
    ["assertParent", "units"],
    ["assertPrimaryImage", "attachments"],
  ]) {
    const at = route.indexOf(`async function ${helper}(`);
    assert.ok(at > 0, `${helper} must exist`);
    const body = route.slice(at, route.indexOf("\n}", at));
    assert.match(body, new RegExp(`\\.from\\(${table}\\)`), `${helper} reads ${table}`);
    assert.match(
      body,
      /organisationId, orgId\)/,
      `${helper} must scope to the tenant — a foreign id that exists globally is still foreign`,
    );
  }
  /* The parent rule is three rules, and all three are here. */
  const parent = route.slice(
    route.indexOf("async function assertParent("),
    route.indexOf("async function validateOption("),
  );
  assert.match(parent, /An asset cannot be part of itself/);
  assert.match(parent, /same site as the asset it holds/);
  assert.match(parent, /wouldCycle\(childId, parentId/);
});

test("the membership's site restriction is applied to every read and every write", async () => {
  const route = await read("app/api/assets/route.ts");
  /*
   * `/api/units` ignored `siteScope` entirely, which meant a member confined to
   * three stores read the whole estate's asset register. Every query that
   * selects or writes an asset folds it in.
   */
  assert.match(route, /function siteFilter\(siteScope: string\[\] \| null\)/);
  const uses = route.match(/siteFilter\(siteScope\)/g) ?? [];
  assert.ok(uses.length >= 4, `expected the scope on every asset query, saw ${uses.length}`);
  assert.match(
    route,
    /siteScope && siteScope\.length \? inArray\(sites\.id, siteScope\) : undefined/,
    "and the site a write names must be one the member may touch",
  );
  /* Asking for a store outside the scope returns nothing rather than widening. */
  assert.match(route, /!siteScope\.includes\(siteId\)/);
});

test("the export is formula-safe and scoped", async () => {
  const csv = await read("app/api/assets/csv/route.ts");
  /*
   * An asset register is operator-typed free text end to end, which is exactly
   * the input a formula-injection defence exists for. `app/lib/csv.ts` does no
   * neutralisation; the finance writer does, and leaves a plain number alone so
   * a negative figure stays a number.
   */
  assert.match(csv, /from "\.\.\/\.\.\/\.\.\/lib\/finance\/exports"/);
  assert.match(csv, /csvDocument\(/);
  assert.doesNotMatch(csv, /from "\.\.\/\.\.\/\.\.\/lib\/csv"/, "the unprotected writer is not used here");
  assert.match(csv, /scopedDbWithCapability\(request, "data\.export"\)/);
  assert.match(csv, /inArray\(units\.siteId, siteScope\)/, "an export must not widen the scope");
  assert.match(csv, /isNull\(units\.deletedAt\)/, "a binned asset is not exported");

  const exports = await read("app/lib/finance/exports.ts");
  assert.match(exports, /FORMULA_STARTERS/);
});

test("the export joins rather than looking up per row", async () => {
  const csv = await read("app/api/assets/csv/route.ts");
  /* One query for several hundred assets. An export making a lookup per row is
     the N+1 this product has already paid for once. */
  assert.match(csv, /\.leftJoin\(sites,/);
  assert.match(csv, /\.leftJoin\(contractors,/);
});

/* ── 4. The recycle bin ───────────────────────────────────────────────────── */

test("an asset is binned, not destroyed, and nothing it owns is cascaded", async () => {
  const bin = await read("app/lib/recycle-bin.ts");
  assert.match(bin, /export const ASSET_ENTITY_TYPE = "asset";/);
  assert.match(bin, /export async function sendAssetToBin\(/);
  assert.match(bin, /if \(entry\.entityType === ASSET_ENTITY_TYPE\) return restoreAsset\(/);

  const sender = bin.slice(
    bin.indexOf("export async function sendAssetToBin("),
    bin.indexOf("async function restoreAsset("),
  );
  /* The row is flagged; its history, its files and its children are untouched. */
  assert.match(sender, /\.set\(\{ deletedAt, deletedBy: actor\.email \?\? null \}\)/);
  assert.doesNotMatch(sender, /\.delete\(unitServiceRecords\)/);
  assert.doesNotMatch(sender, /\.delete\(attachments\)/);
  assert.doesNotMatch(sender, /parentUnitId: null/, "binning a parent must not orphan its children");

  const trash = await read("app/api/trash/route.ts");
  assert.match(trash, /if \(entityType === ASSET_ENTITY_TYPE\) \{/);
  assert.match(trash, /async function purgeAsset\(/);
  const purge = trash.slice(
    trash.indexOf("async function purgeAsset("),
    trash.indexOf("\n}", trash.indexOf("async function purgeAsset(")),
  );
  /* Objects first, then the rows that name them: rows deleted first would
     leave bytes in the bucket nothing in the database can find. */
  assert.ok(
    purge.indexOf("purgeAttachmentsOf") < purge.indexOf("delete(unitServiceRecords)"),
    "the bucket is emptied before the rows that point at it",
  );
  assert.match(trash, /asset: "unit",/, "the audit vocabulary knows the kind");
});

test("the destructive verb stays behind data.delete", async () => {
  const route = await read("app/api/assets/route.ts");
  const del = route.slice(route.indexOf("export async function DELETE("));
  /*
   * DELETE on the asset is the REVERSIBLE verb and takes `sites.edit`. The
   * irreversible one is `DELETE /api/trash`, which takes `data.delete` — a
   * capability an `admin` does not hold by default.
   */
  assert.match(del, /scopedDbWithCapability\(request, "sites\.edit"\)/);
  assert.match(del, /sendAssetToBin\(/);
  const trash = await read("app/api/trash/route.ts");
  assert.match(trash, /scopedDbWithCapability\(request, "data\.delete"\)/);
});

/* ── 5. The screens ───────────────────────────────────────────────────────── */

test("the portfolio and the site tab are one implementation", async () => {
  const manager = await read("app/(app)/portal/assets/assets-manager.tsx");
  const detail = await read("app/(app)/portal/sites/site-detail.tsx");
  assert.match(detail, /<AssetsManager siteId=\{site\.id\} embedded onNotify=\{onNotify\} \/>/);
  assert.match(manager, /siteId\?: string \| null;/);
  /* The site view narrows the same component; it does not reimplement it. */
  assert.doesNotMatch(
    codeOnly(detail),
    /analytics-table[\s\S]{0,400}Next service/,
    "the old static copy is gone",
  );
});

test("the register is usable on a phone rather than gated behind a wider screen", async () => {
  const list = await read("app/(app)/portal/assets/assets-list.tsx");
  /*
   * `--mobile-cards` reflows each row into a labelled card at 767px, which is
   * why every cell carries `data-label`. The ops convention — a desktop-only
   * table with "switch to a wider screen" — is the wrong answer for a register
   * somebody reads standing in front of the broken cabinet.
   */
  assert.match(list, /analytics-table analytics-table--mobile-cards/);
  const cells = list.match(/<td data-label="/g) ?? [];
  const headers = list.match(/<th scope="col">/g) ?? [];
  assert.ok(
    cells.length >= headers.length,
    `every cell needs a data-label for the card view: ${cells.length} cells, ${headers.length} headers`,
  );
  assert.doesNotMatch(
    codeOnly(list),
    /ops-hide-desktop/,
    "the table is not withheld from phones",
  );
});

test("filters and sort live in the URL, never in storage", async () => {
  const list = await read("app/(app)/portal/assets/assets-list.tsx");
  assert.match(list, /useQueryState\(\)/);
  assert.doesNotMatch(codeOnly(list), /localStorage|sessionStorage/);
  for (const key of ["q", "site", "kind", "category", "status", "sort"]) {
    assert.ok(list.includes(`"${key}"`), `the ${key} filter is addressable`);
  }
});

test("the section stylesheet uses tokens and the agreed breakpoints only", async () => {
  const css = await read("app/(app)/portal/assets/assets.css");
  /*
   * A hex literal is correct in one theme and wrong in the other; the palette
   * is defined on bare `:root` and redefined in the dark block precisely so a
   * rule written against `var(--line)` is right in both.
   */
  const hexes = codeOnly(css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexes, [], `a raw colour cannot be theme-correct: ${hexes.join(", ")}`);

  const widths = [...codeOnly(css).matchAll(/\((?:max|min)-width:\s*(\d+)px\)/g)].map(
    (m) => m[1],
  );
  for (const width of widths) {
    assert.ok(
      ["640", "767", "768", "1024", "1280"].includes(width),
      `${width}px is not one of the agreed breakpoints`,
    );
  }
});

test("the primary image is a thumbnail, and it must belong to the asset", async () => {
  const list = await read("app/(app)/portal/assets/assets-list.tsx");
  /* The register would otherwise pull several hundred full-size photographs to
     draw 40px squares. */
  assert.match(list, /\/api\/files\/\$\{row\.primaryImageId\}\?thumb=1/);

  const route = await read("app/api/assets/route.ts");
  /*
   * Without the check the column is an arbitrary attachment id, and a caller
   * could point a row's thumbnail at any document in the workspace — which the
   * register would then render inline to everyone who can see the asset.
   */
  assert.match(route, /eq\(attachments\.unitId, assetId\)/);
});

test("uploads go through the one helper that knows the ceilings", async () => {
  const files = await read("app/(app)/portal/assets/asset-files.tsx");
  /*
   * A hand-rolled fetch loses three things at once: the ~1 MiB form-parser
   * ceiling that answers a bare-text 413, the multipart fallback above it, and
   * the thumbnail. A photograph from a phone is over the direct limit every
   * time, so the hand-rolled version works in testing and fails for every user.
   */
  assert.match(files, /import \{ uploadEvidenceFile \} from "\.\.\/\.\.\/\.\.\/lib\/client-upload";/);
  assert.doesNotMatch(codeOnly(files), /fetch\("\/api\/files"/);
  assert.match(files, /unitId: assetId/, "the asset is the anchor the file routes already validate");
});

test("removing a file archives it rather than destroying the bytes", async () => {
  const files = await read("app/(app)/portal/assets/asset-files.tsx");
  assert.match(files, /body: \{ archived: true \}/);
  assert.doesNotMatch(
    codeOnly(files),
    /method: "DELETE"/,
    "permanent removal lives behind data.delete",
  );
});

/* ── 6. The demonstration data ────────────────────────────────────────────── */

test("the demo assets are confined to the demonstration workspace", async () => {
  const seed = await read("db/demo-workspace.ts");
  const block = seed.slice(seed.indexOf("export async function seedDemoWorkspaceAssets("));
  assert.ok(block.length > 0, "the asset seed is still exported");

  for (const statement of block.split(/INSERT\s+OR\s+IGNORE\s+INTO/i).slice(1)) {
    const upTo = statement.slice(0, statement.indexOf(".run()") + 1 || statement.length);
    assert.match(upTo, /DEMO_WORKSPACE_ID/, `an asset insert naming no workspace: ${upTo.slice(0, 120)}`);
  }
  assert.doesNotMatch(block, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(block, /\bUPDATE\s+\w+\s+SET\b/i);
  assert.match(seed, /const assetId = \(site: string, key: string\) => `demo-asset-\$\{site\}-\$\{key\}`;/);
});

test("the demo asset seed has its own guard, because the workspace already exists", async () => {
  const seed = await read("db/demo-workspace.ts");
  /*
   * `seedDemoWorkspaceData` returns early once the workspace has sites — which
   * it does on every database that has booted since the workspace shipped,
   * Production included. Assets appended inside it would have reached a fresh
   * database and no existing one.
   */
  assert.match(seed, /async function assetsAlreadySeeded\(/);
  assert.match(seed, /SELECT id FROM units WHERE id = \? LIMIT 1/);
  const body = seed.slice(seed.indexOf("export async function seedDemoWorkspaceAssets("));
  assert.match(body, /if \(await assetsAlreadySeeded\(d1\)\) return;/);

  const init = await read("db/init.ts");
  assert.match(init, /await seedDemoWorkspaceAssets\(d1, new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\);/);
});

test("the demonstration data demonstrates the whole model", async () => {
  const seed = await read("db/demo-workspace.ts");
  const catalogue = seed.slice(
    seed.indexOf("const DEMO_ASSETS: readonly DemoAsset[] = ["),
    seed.indexOf("const assetId = ("),
  );
  for (const kind of ["equipment", "component", "replacement_part", "reference"]) {
    assert.ok(catalogue.includes(`kind: "${kind}"`), `no demo asset of kind ${kind}`);
  }
  /* A four-child parent, which is what the relationship model is for. */
  const children = catalogue.match(/parent: "cabinet"/g) ?? [];
  assert.ok(children.length >= 4, `the display cabinet needs its parts: ${children.length}`);
  assert.ok(catalogue.includes('parent: "ac"'), "and the AC unit needs its controller");
  /* Something must be on borrowed time, or the KPI tile demonstrates nothing. */
  assert.match(catalogue, /needsReplacementAt: \[/);
  /* And something must carry the specifications the section exists for. */
  assert.match(catalogue, /\["Colour temperature", "3000", "K"\]/);
  assert.match(catalogue, /paintReference:/);

  /* History, including the replacement that names what came out. */
  const body = seed.slice(seed.indexOf("export async function seedDemoWorkspaceAssets("));
  assert.match(body, /'Replaced'/);
  assert.match(body, /VT-LPV-40-24 \(40W\)/, "the part that came out is named in previous_detail");
});

test("no demo asset carries a real address, a real brand or a fixed date", async () => {
  const seed = await read("db/demo-workspace.ts");
  const block = seed.slice(seed.indexOf("/* ── The asset register"));
  const addresses = block.match(/[\w.+-]*@[\w.-]+/g) ?? [];
  assert.deepEqual(
    addresses.filter((address) => !address.endsWith("@example.com")),
    [],
    "a demo row carrying a deliverable address",
  );
  /* Links must go to the reserved domain, which resolves nowhere. */
  for (const url of block.match(/https?:\/\/[^\s"`]+/g) ?? []) {
    assert.match(url, /example\.com/, `a demo link that leaves the building: ${url}`);
  }
  assert.doesNotMatch(block, /"20\d\d-\d\d-\d\d"/, "a hardcoded date goes stale and then reads as broken");
  assert.match(block, /day\(today, -/, "every date is an offset from the boot date");
});
