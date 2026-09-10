/**
 * 2C's STORAGE AND 2D's BACKFILL — the two write paths the vocabulary needs.
 *
 * `tests/compliance-2c-vocabulary.test.mjs` pins the resolver, which is pure and
 * can be exercised outright. This file pins the two things around it that touch
 * a database and therefore cannot be: where a template is stored, and the batch
 * that acts on one.
 *
 * ── THE CONTRACT THIS SUITE EXISTS FOR ────────────────────────────────────
 *
 * The last unpreviewed backfill of this estate created 144 rows nobody had
 * approved, and there was no way to take them back. So:
 *
 *   • a preview is the DEFAULT, and it is the default by omission too — a
 *     client that mistypes `dryRun` must get a preview, not a write;
 *   • the preview and the apply are computed by ONE resolver, because a preview
 *     produced by a second implementation is a preview of something else;
 *   • an undo names specific rows and REFUSES any that have stopped being empty
 *     placeholders. Deleting somebody's uploaded certificate to undo a surplus
 *     row would be far worse than the surplus row.
 *
 * ── PINNED ON SOURCE, AND WHY THAT IS THE RIGHT INSTRUMENT HERE ───────────
 *
 * These are HTTP routes over a scoped drizzle handle; exercising them needs a
 * live server, and the register's board-derived half cannot be exercised on
 * Staging at all (`portal.maintenance_group_items` holds zero rows for
 * `board_id='store-documentation'` in every tenant, measured 2026-09-10). What
 * IS checkable without a server is that each safety property is present in the
 * statement that needs it — and every one of these was chosen because its
 * absence is silent: a missing organisation filter, a race window between a read
 * and a delete, an `IN` list that outgrows the variable cap.
 *
 * Reads normalise CRLF; line endings in this repository are per file.
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

/**
 * The same source with every comment removed.
 *
 * Needed for any assertion about an ABSENCE. Comment density in this repository
 * is high and deliberate, so "`complianceDocuments` must not appear in the
 * template route" matches the paragraph explaining that it must not appear, and
 * the pin passes or fails on the prose rather than on the code. Presence pins
 * keep reading the whole file: a comment naming the right thing is evidence too.
 */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const backfill = await read("app/api/compliance/backfill/route.ts");
const templateRoute = await read("app/api/compliance/template/route.ts");
const store = await read("app/lib/compliance-template-store.ts");
const profile = await read("app/lib/compliance-profile.ts");

/* ── 1. Where a template lives ────────────────────────────────────────────── */

test("a template round-trips through the settings blob without disturbing it", async () => {
  /*
   * The pure half of the store is importable — `readBlob`, `merge` and the
   * parser have no database between them — so this is exercised rather than
   * pinned. The property that matters is that saving a template leaves every
   * OTHER settings section exactly as it was: `reminders` shares this column,
   * and a compliance save that dropped quiet hours would silence the estate's
   * reminders as a side effect of editing a certificate name.
   */
  const spec = asModule(transpile(await read("db/monday-board-spec.ts")));
  const vocabulary = asModule(
    transpile(await read("app/lib/compliance-vocabulary.ts")).replace(
      /from ["']\.\.\/\.\.\/db\/monday-board-spec["']/g,
      `from "${spec}"`,
    ),
  );
  /* The schema import is the only database link and nothing under test calls
     it, so it is stubbed to an empty module rather than transpiled. */
  const stub = asModule("export const workspaceSettings = {};");
  const mod = await import(
    asModule(
      transpile(store)
        .replace(/from ["']\.\.\/\.\.\/db\/schema["']/g, `from "${stub}"`)
        .replace(/from ["']\.\/compliance-vocabulary["']/g, `from "${vocabulary}"`)
        .replace(/from ["']drizzle-orm["']/g, `from "${asModule("export const eq = () => {};")}"`),
    )
  );

  const before = JSON.stringify({
    reminders: { quietHours: { enabled: true, startTime: "07:00" } },
    something: 7,
  });
  const template = { kinds: [{ kind: "Gas safety certificate", aliases: ["Gas cert"], enabled: true }] };
  const after = JSON.parse(mod.mergeComplianceTemplate(before, template));

  assert.equal(after.reminders.quietHours.enabled, true, "quiet hours must survive");
  assert.equal(after.something, 7, "and so must anything else in the blob");
  assert.equal(after[mod.COMPLIANCE_TEMPLATE_KEY].kinds[0].kind, "Gas safety certificate");

  /* Read back through the same namespace, and the twelve board slots come with
     it — see the parser's reasoning about a board column the register cannot
     name. */
  const roundTrip = mod.complianceTemplateFromBlob(JSON.stringify(after));
  assert.equal(roundTrip.kinds.length, 13, "the operator's one plus the twelve");
  assert.ok(roundTrip.kinds.some((entry) => entry.kind === "Gas safety certificate"));
});

test("an organisation that has never saved anything reads the default template", async () => {
  const spec = asModule(transpile(await read("db/monday-board-spec.ts")));
  const vocabulary = asModule(
    transpile(await read("app/lib/compliance-vocabulary.ts")).replace(
      /from ["']\.\.\/\.\.\/db\/monday-board-spec["']/g,
      `from "${spec}"`,
    ),
  );
  const stub = asModule("export const workspaceSettings = {};");
  const mod = await import(
    asModule(
      transpile(store)
        .replace(/from ["']\.\.\/\.\.\/db\/schema["']/g, `from "${stub}"`)
        .replace(/from ["']\.\/compliance-vocabulary["']/g, `from "${vocabulary}"`)
        .replace(/from ["']drizzle-orm["']/g, `from "${asModule("export const eq = () => {};")}"`),
    )
  );
  /* Every tenant but the first has no `workspace_settings` row at all, so this
     is the ordinary case rather than the edge one. */
  for (const absent of [undefined, null, "", "{}", "not json at all"]) {
    assert.equal(mod.complianceTemplateFromBlob(absent).kinds.length, 12);
  }
});

test("the template is saved with an upsert, because most tenants have no settings row", () => {
  assert.match(store, /onConflictDoUpdate\(\{\s*target: workspaceSettings\.organisationId/);
  /* The primary key is the LEGACY client id column and every other writer of
     this table passes the organisation id for it; a different choice mints a
     second row the unique index then refuses. */
  assert.match(store, /legacyClientId: organisationId/);
});

/* ── 2. The template endpoint changes settings, never rows ────────────────── */

test("saving a template does not touch a single compliance row", () => {
  /*
   * The separation item 2D depends on. A settings save that silently rewrote
   * sixty rows of somebody's real register would be a migration disguised as a
   * preference — and it would be unpreviewed and irreversible, which is the
   * exact defect 2D exists to prevent.
   */
  assert.doesNotMatch(code(templateRoute), /complianceDocuments/);
  assert.doesNotMatch(code(templateRoute), /ensureComplianceProfile/);
});

test("reading the template is board.view and writing it is settings.edit", () => {
  assert.match(templateRoute, /scopedDbWithCapability\(request, "board\.view"\)/);
  assert.match(templateRoute, /scopedDbWithCapability\(request, "settings\.edit"\)/);
});

test("a payload cannot assert a template; it is parsed by the reader's own parser", () => {
  /* What is stored is by construction what will be read back. */
  assert.match(templateRoute, /const template = parseComplianceTemplate\(raw\)/);
  assert.match(templateRoute, /await writeComplianceTemplate\(db, orgId, template,/);
});

test("an alias claimed by two requirements is refused, and the word is named", () => {
  /*
   * The resolver breaks ties by specificity so it is never ambiguous at read
   * time — which means an ambiguous template would resolve silently and wrongly
   * forever. A 400 naming the word is something an operator can act on.
   */
  assert.match(templateRoute, /A name can only mean one requirement/);
  assert.match(templateRoute, /is listed under both/);
});

/* ── 3. The preview is the default ────────────────────────────────────────── */

test("a mistyped dryRun key gets a preview, not a write", () => {
  /*
   * `!== false`, never `=== true`. The failure mode of a client that forgets or
   * misspells the field must be "nothing happened".
   */
  assert.match(backfill, /const dryRun = payload\.dryRun !== false;/);
  assert.doesNotMatch(code(backfill), /dryRun === true/);
});

test("the preview and the apply share one resolver, or the preview is of something else", () => {
  assert.match(backfill, /const resolve = buildKindResolver\(template\)/);
  assert.match(
    backfill,
    /ensureComplianceProfile\(db, orgId, plan\.siteId, \{[\s\S]{0,400}?resolve,/,
    "the apply must be handed the resolver the preview used",
  );
});

test("the preview reports the aliased matches, which is the number that shows the work", () => {
  /*
   * "60 requirements already held under another name" is the line that would
   * have stopped the run that created 144 duplicates. Counting only `create`
   * and `held` would have shown that run as entirely reasonable.
   */
  assert.match(backfill, /aliased: Array<\{ kind: string; matchedAs: string \}>/);
  assert.match(backfill, /aliased: plans\.reduce\(/);
});

test("the preview is one read over the estate, not one query per site", () => {
  /* 500 queries to answer a question about one table, on a pool this app runs
     two connections of per instance. */
  const preview = backfill.slice(backfill.indexOf("THE PREVIEW IS ONE READ"));
  const perSiteReads = preview.slice(0, preview.indexOf("if (dryRun)")).match(/await db\s*\n?\s*\.select/g);
  assert.equal(perSiteReads?.length ?? 0, 1, "exactly one select builds the whole preview");
});

/* ── 4. The undo is exact, scoped and refuses real data ───────────────────── */

test("a batch is addressed by id, and the lookup is scoped to the organisation", () => {
  /*
   * A batch id is a guessable-looking string and it is NOT a capability.
   * Without the organisation filter one tenant could name another tenant's
   * batch and have its rows deleted.
   */
  const revert = backfill.slice(backfill.indexOf("async function revert"));
  assert.match(revert, /eq\(activityLog\.organisationId, orgId\)/);
  assert.match(revert, /eq\(activityLog\.entityId, batchId\)/);
  assert.match(revert, /eq\(complianceDocuments\.organisationId, orgId\)/);
});

test("undo refuses to delete a row that has become real data", () => {
  const revert = backfill.slice(backfill.indexOf("async function revert"));
  for (const [pattern, why] of [
    [/a certificate has been attached/, "an uploaded certificate"],
    [/an expiry date has been recorded/, "a recorded expiry"],
    [/it has been marked not required/, "a not-required decision"],
    [/somebody has confirmed whose obligation it is/, "a confirmed duty holder"],
  ]) {
    assert.match(revert, pattern, `${why} must keep the row and say so`);
  }
  /* Named, not just counted: "3 rows were kept" is not actionable; "Water
     Hygiene at Leeds Trinity, because a certificate has been attached" is. */
  assert.match(revert, /keptRows: kept/);
});

test("the guard is repeated in the DELETE, so the read-to-delete race loses safely", () => {
  /*
   * Between the read that classifies a row and the delete that removes it,
   * somebody can upload a certificate. Restating the predicate makes the delete
   * conditional on the row still being empty at the moment it runs — the row
   * survives and the count comes back one lower, which is the safe direction.
   */
  const del = backfill.slice(backfill.indexOf("for (const chunk of chunkIds(removable))"));
  assert.match(del, /isNull\(complianceDocuments\.attachmentId\)/);
  assert.match(del, /isNull\(complianceDocuments\.expiryDate\)/);
  assert.match(del, /eq\(complianceDocuments\.notRequired, false\)/);
  assert.match(del, /eq\(complianceDocuments\.dutyHolder, DUTY_HOLDER_UNCONFIRMED\)/);
});

test("every IN list is chunked, because a 12-site batch is already 144 ids", () => {
  /*
   * D1 binds one variable per COLUMN per row and refuses past roughly a
   * hundred. Twelve sites × twelve requirements is 144 before the estate is
   * anything but tiny.
   */
  assert.match(backfill, /import \{ chunkIds \} from "\.\.\/\.\.\/\.\.\/lib\/sql-batching"/);
  const inLists = backfill.match(/inArray\(/g) ?? [];
  const chunked = backfill.match(/for \(const chunk of chunkIds\(/g) ?? [];
  assert.ok(inLists.length >= 2, "there are IN lists to chunk");
  assert.equal(chunked.length, inLists.length, "and every one of them sits inside a chunk loop");
});

test("the batch id is minted before the writes, so a partial run is still reversible", () => {
  const apply = backfill.slice(backfill.indexOf("if (dryRun) {"));
  const mint = apply.indexOf("const batchId =");
  const write = apply.indexOf("ensureComplianceProfile");
  assert.ok(mint > 0 && write > mint, "the id must exist before the first row does");
  /* One site's failure does not abandon the batch — the alternative leaves an
     operator with no idea which sites were done. */
  assert.match(apply, /failures\.push\(\{/);
});

test("undo does not require data.delete, or a backfill could not be undone by its author", () => {
  /*
   * `data.delete` is the permanent purge of somebody's real data and is
   * withheld from `admin` deliberately. Undoing a batch of empty placeholders
   * this same endpoint created minutes ago is not that, and requiring it would
   * mean the only people who can run a backfill cannot reverse one.
   */
  /*
   * RE-POINTED from `board.edit` to `sites.edit`. The claim this test exists to
   * make — that the undo is NOT behind `data.delete` — is unchanged and still
   * asserted; only the capability it names has moved, and it moved because it
   * was the wrong one.
   *
   * `sites.edit` is defined in `app/lib/permissions.ts` as "Change the site
   * register, units and COMPLIANCE RECORDS", which is exactly what this
   * endpoint writes and, on a revert, deletes. `board.edit` is "create, update
   * and move rows, columns and groups on a BOARD". Every pre-existing writer of
   * `compliance_documents` — `WORKSPACE_CAPABILITY.compliance` and the three
   * site routes — already took `sites.edit`; this route and the responsibility
   * queue were the two that did not.
   *
   * Not an escalation under the built-in roles, which give `admin` both. It
   * mattered because `role_capabilities` is a per-organisation toggle: a
   * bespoke role granted `board.edit` alone would have been handed the
   * compliance register, and this endpoint's revert is a real delete.
   */
  assert.match(backfill, /scopedDbWithCapability\(request, "sites\.edit"\)/);
  assert.doesNotMatch(backfill, /scopedDbWithCapability\(request, "board\.edit"\)/);
  assert.doesNotMatch(backfill, /scopedDbWithCapability\(request, "data\.delete"\)/);
});

/* ── 5. The writer still holds the rules it held before ───────────────────── */

test("the profile writer reads every requirement a site holds, not just the twelve", () => {
  /*
   * The narrow read is the defect. The rows this function most needed to see
   * were precisely the ones whose names are NOT in `kinds` — a site's whole
   * register is a couple of dozen rows on an index built on
   * (organisation, site, kind), so the wider read is the cheaper mistake by a
   * very long way.
   */
  assert.doesNotMatch(code(profile), /inArray\(complianceDocuments\.kind/);
  assert.match(profile, /EVERY REQUIREMENT THIS SITE HOLDS/);
});

test("an existing row is never renamed to the machine's vocabulary", () => {
  /*
   * The operator's word for their own certificate is theirs. Rewriting sixty
   * rows on a read would be a data migration disguised as a repair — and it is
   * exactly the kind of thing 2D exists to make previewable and reversible.
   */
  assert.doesNotMatch(code(profile), /\.update\(complianceDocuments\)/);
  assert.match(profile, /deliberately NOT renamed/);
});
