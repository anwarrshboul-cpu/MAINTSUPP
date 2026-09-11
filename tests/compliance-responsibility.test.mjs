/**
 * THE RESPONSIBILITY / DUTY-HOLDER UI.
 *
 * `tests/sites-compliance-link.test.mjs` pins the MODEL — that NULL and
 * "unconfirmed" are different facts, and what each does to the compliance
 * percentage. This file pins the half a person can actually reach: the control
 * that answers the question, the queue that lists what is still waiting, the
 * bulk write behind it, and the sentence printed beside the score.
 *
 * ── THE ONE THING THIS SUITE EXISTS FOR ───────────────────────────────────
 *
 * A brand-new site must never read 0% compliant. `complianceCompletion` already
 * makes that arithmetically true — `scored: false` — but a screen can still
 * print "0%" from a false `scored`, or print "No requirements set" about a
 * store holding twelve of them, and both were live in the register before this
 * work. So the coverage SENTENCE is a value with its own function, and the two
 * headers that print it are pinned to it rather than to a number.
 *
 * ── HOW THE MODULES ARE LOADED ────────────────────────────────────────────
 *
 * The same `data:` URL chain `tests/ops-rebuild-foundations.test.mjs` and
 * `tests/sites-compliance-link.test.mjs` use, with the specifiers rewritten by
 * exact string. Kept in step with those two: if the chain grows a link there,
 * it grows one here. A VALUE import left un-rewritten does not fail loudly — it
 * takes the whole file out on load.
 *
 * Reads normalise CRLF — this is a Windows checkout, and line endings in this
 * repository are per file.
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

/* `compliance-duty-holder.ts` imports nothing, which is why it can be handed
   straight to `import()`. That is the whole reason it is a file of its own. */
const duty = await import(
  asModule(transpile(await read("app/lib/compliance-duty-holder.ts")))
);

/** The register's view layer, with its four-deep specifier chain rewritten. */
const view = await (async () => {
  const formatDate = asModule(transpile(await read("app/lib/format-date.ts")));
  const spec = asModule(transpile(await read("db/monday-board-spec.ts")));
  const dutyHolder = asModule(transpile(await read("app/lib/compliance-duty-holder.ts")));
  const expiry = asModule(
    transpile(await read("app/lib/expiry-status.ts")).replace(
      /from ["']\.\/format-date["']/g,
      `from "${formatDate}"`,
    ),
  );
  const register = asModule(
    transpile(await read("app/lib/store-documentation-register.ts"))
      .replace(/from ["']\.\.\/\.\.\/db\/monday-board-spec["']/g, `from "${spec}"`)
      .replace(/from ["']\.\/expiry-status["']/g, `from "${expiry}"`),
  );
  const status = asModule(
    transpile(await read("app/lib/compliance-status.ts"))
      .replace(/from ["']\.\/expiry-status["']/g, `from "${expiry}"`)
      .replace(/from ["']\.\/store-documentation-register["']/g, `from "${register}"`)
      .replace(/from ["']\.\/compliance-duty-holder["']/g, `from "${dutyHolder}"`),
  );
  return import(
    asModule(
      transpile(await read("app/lib/compliance-view.ts"))
        .replace(/from ["']\.\.\/\.\.\/db\/monday-board-spec["']/g, `from "${spec}"`)
        .replace(/from ["']\.\/compliance-status["']/g, `from "${status}"`)
        .replace(/from ["']\.\/compliance-duty-holder["']/g, `from "${dutyHolder}"`)
        /* The due-date filters (`due=`, `from`/`to`) compare date-only values
           through `dateOnlyValue`, so the view now reads the same expiry module
           the status layer does; the chain gains one link, not a new rule. */
        .replace(/from ["']\.\/expiry-status["']/g, `from "${expiry}"`),
    )
  );
})();

/* ── 1. The vocabulary a control offers ───────────────────────────────────── */

test("the control's options are built from the vocabulary, never retyped", () => {
  /*
   * A hand-typed option list is how a fifth spelling of "centre" reaches the
   * database. `DUTY_HOLDER_CHOICES` is derived from `DUTY_HOLDERS` and
   * `dutyHolderLabel`, so a value the control can post is by construction one
   * `isDutyHolder` accepts.
   */
  assert.deepEqual(
    duty.DUTY_HOLDER_CHOICES.map((choice) => choice.value),
    [...duty.DUTY_HOLDERS],
  );
  for (const choice of duty.DUTY_HOLDER_CHOICES) {
    assert.equal(duty.isDutyHolder(choice.value), true);
    assert.equal(choice.label, duty.dutyHolderLabel(choice.value));
  }
});

test("the machine placeholder is not offered as an answer a person may give", () => {
  /* "unconfirmed" is the statement that nobody has answered. Offering it in a
     menu invites somebody to "set" a requirement back into the state it is
     already waiting in. */
  assert.equal(
    duty.DUTY_HOLDER_CHOICES.some((choice) => choice.value === duty.DUTY_HOLDER_UNCONFIRMED),
    false,
  );
});

test("every answer says what it commits the product to", () => {
  /* A reader picking Landlord is deciding this requirement leaves the
     compliance percentage. A menu that does not say so is asking them to
     guess. */
  for (const choice of duty.DUTY_HOLDER_CHOICES) {
    assert.ok(duty.dutyHolderMeaning(choice.value).length > 20, choice.value);
  }
  assert.match(duty.dutyHolderMeaning("client"), /score/i, "the client's is scored");
  assert.match(duty.dutyHolderMeaning("landlord"), /not scored/i);
  assert.match(duty.dutyHolderMeaning(null), /Nobody has been asked/);
  assert.notEqual(
    duty.dutyHolderMeaning(null),
    duty.dutyHolderMeaning(duty.DUTY_HOLDER_UNCONFIRMED),
    "never asked and asked-and-waiting are different sentences here too",
  );
});

/* ── 2. Coverage: the sentence that must never be a percentage ────────────── */

const held = (dutyHolder) => ({ state: "Missing", dutyHolder });

test("a brand-new site's coverage reads 'Not yet confirmed', never 0%", () => {
  /*
   * THE DEFECT THIS WHOLE DESIGN EXISTS TO PREVENT, as one assertion. Twelve
   * requirements, none answered for. "0%" beside the word compliance is read
   * as "this store is failing" by everyone who has ever seen a dashboard.
   */
  const coverage = duty.responsibilityCoverage(
    Array.from({ length: 12 }, () => held("unconfirmed")),
  );
  assert.equal(coverage.label, "Not yet confirmed");
  assert.equal(coverage.label, duty.RESPONSIBILITY_NOT_CONFIRMED);
  assert.doesNotMatch(coverage.label, /%/, "a coverage sentence is a count, never a percentage");
  assert.equal(coverage.confirmed, 0);
  assert.equal(coverage.unconfirmed, 12);
  assert.equal(coverage.total, 12);
  assert.equal(coverage.complete, false);
});

test("the sentence is '3 of 12 requirements confirmed' once anything is answered", () => {
  const rows = [
    held("client"),
    held("landlord"),
    held("not_applicable"),
    ...Array.from({ length: 9 }, () => held("unconfirmed")),
  ];
  const coverage = duty.responsibilityCoverage(rows);
  assert.equal(coverage.label, "3 of 12 requirements confirmed");
  assert.equal(coverage.confirmed, 3);
  assert.equal(coverage.unconfirmed, 9);
  assert.doesNotMatch(coverage.label, /%/);
});

test("one requirement reads 'requirement', not 'requirements'", () => {
  assert.equal(
    duty.responsibilityCoverage([held("client")]).label,
    "1 of 1 requirement confirmed",
  );
});

test("the NULL estate is counted apart from the queue's placeholder", () => {
  /*
   * Every row that predates the `duty_holder` column is NULL, and NULL is not
   * "unconfirmed". Collapsing them would either sweep 748 rows into a queue
   * that says they are waiting on somebody, or hide the ones that really are.
   */
  const coverage = duty.responsibilityCoverage([
    held(null),
    held(undefined),
    held("unconfirmed"),
    held("client"),
  ]);
  assert.equal(coverage.neverAsked, 2);
  assert.equal(coverage.unconfirmed, 1);
  assert.equal(coverage.confirmed, 1);
  assert.equal(coverage.total, 4);
});

test("a site with nothing to confirm says so, rather than 'not yet'", () => {
  const coverage = duty.responsibilityCoverage([]);
  assert.equal(coverage.label, "No requirements set");
  assert.equal(coverage.label, duty.RESPONSIBILITY_NOTHING_TO_CONFIRM);
  assert.equal(coverage.complete, false, "nothing is not complete");
});

test("complete is only true when every requirement has a real answer", () => {
  assert.equal(
    duty.responsibilityCoverage([held("client"), held("landlord")]).complete,
    true,
  );
  assert.equal(
    duty.responsibilityCoverage([held("client"), held(null)]).complete,
    false,
    "never asked is not an answer",
  );
});

test("an unrecognised string counts as unanswered, never as confirmed", () => {
  /* The safe direction for a defect is to leave a requirement out of a claim
     rather than to assert one — the same rule `countsTowardCompliance` follows. */
  const coverage = duty.responsibilityCoverage([held("Client"), held("whoever")]);
  assert.equal(coverage.confirmed, 0, "case matters, and so does the vocabulary");
  assert.equal(coverage.neverAsked, 2);
  assert.equal(coverage.label, "Not yet confirmed");
});

/* ── 3. Coverage reaches the screens through the view layer ───────────────── */

const row = (siteId, kind, dutyHolder, state = "Missing") => ({
  id: `${siteId}-${kind}`,
  siteId,
  siteName: siteId === "s1" ? "Cabot Circus" : "Aldgate",
  kind,
  responsibility: "Contractor",
  dutyHolder,
  state,
  expiry: null,
  fileCount: 0,
  editable: true,
});

test("every group header carries its own coverage sentence", () => {
  /*
   * ON THE HEADER, not on the records. The header is drawn from the summary
   * while the group is still COLLAPSED, and the store nobody has answered for
   * is exactly the store nobody expands — so a sentence computed from the
   * records would be invisible precisely where it matters.
   */
  const groups = view.groupCompliance(
    [
      row("s1", "Fire Alarm", "client", "Compliant"),
      row("s1", "PAT", "unconfirmed"),
      row("s2", "Fire Alarm", "unconfirmed"),
      row("s2", "PAT", "unconfirmed"),
    ],
    new Date("2026-09-10T00:00:00Z"),
  );
  const bySite = new Map(groups.map((group) => [group.siteId, group]));
  assert.equal(bySite.get("s1").coverage.label, "1 of 2 requirements confirmed");
  assert.equal(bySite.get("s2").coverage.label, "Not yet confirmed");
  for (const group of groups) assert.doesNotMatch(group.coverage.label, /%/);
});

test("the portfolio band carries it too, from the same function", () => {
  const portfolio = view.portfolioCounts([
    row("s1", "Fire Alarm", "client", "Compliant"),
    row("s2", "PAT", "unconfirmed"),
  ]);
  assert.equal(portfolio.coverage.label, "1 of 2 requirements confirmed");
  /* One function, two callers, one sentence — the same discipline
     `complianceCompletion` is under, so the band and the store beneath it
     cannot disagree about how much of the register has been answered for. */
  assert.deepEqual(
    portfolio.coverage,
    duty.responsibilityCoverage([
      row("s1", "Fire Alarm", "client", "Compliant"),
      row("s2", "PAT", "unconfirmed"),
    ]),
  );
});

test("a wholly unconfirmed group is unscored AND says why", () => {
  /*
   * The two halves together. `scored: false` is what stops a percentage being
   * printed; the coverage sentence is what replaces it. Either alone leaves a
   * store either lying or silent.
   */
  const [group] = view.groupCompliance(
    Array.from({ length: 12 }, (_, index) => row("s1", `Requirement ${index}`, "unconfirmed")),
    new Date("2026-09-10T00:00:00Z"),
  );
  assert.equal(group.completion.scored, false);
  assert.equal(group.completion.applicable, 0);
  assert.equal(group.completion.excluded, 12);
  assert.equal(group.total, 12, "the requirements exist");
  assert.equal(group.coverage.label, "Not yet confirmed");
});

/* ── 4. What "Not required" does when an answer is withdrawn ──────────────── */

test('"Not applicable" sets the flag, and taking it back clears it', () => {
  /*
   * A ONE-WAY DOOR OTHERWISE. Mark a kiosk's gas certificate Not applicable,
   * realise it was the wrong store, change it to Landlord — and without this
   * the row stays flagged not-required for ever, outside the applicable count,
   * with nothing on screen explaining why.
   */
  assert.equal(duty.notRequiredAfterDutyHolder("unconfirmed", "not_applicable", false), true);
  assert.equal(duty.notRequiredAfterDutyHolder("not_applicable", "landlord", true), false);
  assert.equal(duty.notRequiredAfterDutyHolder("not_applicable", null, true), false);
});

test("a Not required somebody ticked by hand survives a responsibility edit", () => {
  /* The flag follows the ANSWER that set it, and only that one. Somebody ticked
     "Not required" in Manage register for their own reasons; changing who is
     responsible is not the place to silently undo it. */
  assert.equal(duty.notRequiredAfterDutyHolder("client", "landlord", true), true);
  assert.equal(duty.notRequiredAfterDutyHolder(null, "client", true), true);
  assert.equal(duty.notRequiredAfterDutyHolder(null, "client", false), false);
});

/* ── 5. The write endpoint ────────────────────────────────────────────────── */

const ROUTE = "app/api/compliance/responsibilities/route.ts";

test("the bulk write is guarded by sites.edit and the queue by board.view", async () => {
  const source = await read(ROUTE);
  assert.match(
    source,
    /scopedDbWithCapability\(request, "board\.view"\)/,
    "reading which responsibilities are outstanding is not a wider permission than reading the register",
  );
  /*
   * RE-POINTED from `board.edit`, and the title moved with it.
   *
   * The reasoning behind the original — that confirming a responsibility moves
   * a requirement into or out of the compliance percentage, so it needs a WRITE
   * capability rather than a new one of its own — was right about the first
   * half and wrong about which. `sites.edit` is defined as "Change the site
   * register, units and COMPLIANCE RECORDS"; `board.edit` is about rows,
   * columns and groups on a board, which a `compliance_documents` row is not.
   * Every sibling writer of that table already took `sites.edit`.
   *
   * Measured after the change: a `client` calling this route is refused with
   * 403 "Your role (Client) does not have the \"sites.edit\" permission in this
   * workspace", and the read side still answers 200.
   */
  assert.match(
    source,
    /scopedDbWithCapability\(request, "sites\.edit"\)/,
    "confirming one changes a compliance record, which is what sites.edit names",
  );
  assert.doesNotMatch(
    source,
    /scopedDbWithCapability\(request, "board\.edit"\)/,
    "and must not drift back to the board's capability",
  );
});

test("the value written is validated against the vocabulary, and null clears", async () => {
  const source = await read(ROUTE);
  assert.match(source, /if \(dutyHolder !== null && !isDutyHolder\(dutyHolder\)\)/);
  assert.match(source, /A responsibility must be one of/);
  /* Clearing back to "never asked" is a legitimate thing to do on purpose, and
     is why the key is "one of the four, or explicitly null" rather than "a
     non-empty string". */
  assert.match(source, /raw === null \|\| raw === "" \? null : raw/);
});

test("the placeholder cannot be written by a caller", async () => {
  /* `isDutyHolder` returns false for it, so the validation above already
     refuses it — asserted here because it is a PROPERTY of this endpoint and
     not an accident of which helper it happened to call. */
  assert.equal(duty.isDutyHolder(duty.DUTY_HOLDER_UNCONFIRMED), false);
  const source = await read(ROUTE);
  assert.doesNotMatch(
    source,
    /dutyHolder = DUTY_HOLDER_UNCONFIRMED/,
    "nothing here writes the machine placeholder",
  );
});

test("a requirement is addressed by site and name, not by a register id", async () => {
  const source = await read(ROUTE);
  /*
   * A board-derived entry's id is `registerDocumentId(itemId, slotKey)` — a
   * synthesised string with no row behind it — so addressing by id would leave
   * half the register unreachable. `${siteId}::${kind}` is what
   * `registerByKey` in compliance-register.ts is built on.
   */
  assert.match(source, /const pairKey = \(siteId: string, kind: string\) => `\$\{siteId\}::\$\{kind\}`/);
});

test("only requirements already on this register may be set", async () => {
  const source = await read(ROUTE);
  /* The allow-list is the register itself, which is what stops this endpoint
     being a way to mint arbitrary `compliance_documents` rows — a `kind` of
     three zero-width spaces has done exactly that through another route. */
  assert.match(source, /const known = new Map\(rows\.map\(\(row\) => \[pairKey\(row\.siteId, row\.kind\), row\]\)\)/);
  assert.match(source, /None of those requirements are on this register/);
});

test("the bulk write chunks its statements, because D1 counts variables per row", async () => {
  const source = await read(ROUTE);
  /*
   * D1 binds one variable per COLUMN per row and refuses past roughly a
   * hundred. A 12-row × 14-column insert is 168 and fails; so does an `IN` list
   * of 200 ids. Both go through the shared helpers rather than being restated.
   */
  assert.match(source, /import \{ chunkIds \} from "\.\.\/\.\.\/\.\.\/lib\/sql-batching"/);
  assert.match(source, /for \(const chunk of chunkIds\(ids\)\)/);
  /* The inserts are not rebuilt here at all: `ensureComplianceProfile` owns the
     row-width arithmetic and the deterministic id that makes a racing writer
     collide instead of minting a thirteenth requirement. */
  assert.match(source, /ensureComplianceProfile\(db, orgId, siteId, \{ kinds \}\)/);
  assert.doesNotMatch(source, /db\.insert\(complianceDocuments\)/, "inserts go through the shared function");
});

test("the not-required flag is set from the shared rule, not restated inline", async () => {
  const source = await read(ROUTE);
  assert.match(
    source,
    /notRequiredAfterDutyHolder\(row\.dutyHolder, dutyHolder, row\.notRequired\)/,
  );
  /* There are two write paths now — this one and the workspace PATCH — and they
     must not disagree about what "Not applicable" does to the flag. */
  const workspace = await read("app/api/workspace/route.ts");
  assert.match(workspace, /isNotApplicable\(dutyHolder\)/, "the older path still maps it too");
});

test("a bulk request has a blast radius, and the client knows the same number", async () => {
  const source = await read(ROUTE);
  assert.match(source, /const MAX_RECORDS = 500;/);
  assert.match(source, /Set at most \$\{MAX_RECORDS\} requirements at once/);
  const ui = await read("app/(app)/portal/ops/compliance-responsibility.tsx");
  assert.match(
    ui,
    /const MAX_PER_REQUEST = 500;/,
    "Select all must not compose a request the server will refuse",
  );
});

test("the stored value is re-read before it is written, not taken from the register", async () => {
  const source = await read(ROUTE);
  /*
   * `readComplianceRegister` runs a board-derived row's annotation through
   * `boardDutyHolder`, which HIDES the "unconfirmed" placeholder — correctly,
   * for reading. The reversal rule needs to know whether the answer being
   * withdrawn was "not applicable", so the write reads the column itself.
   */
  assert.match(source, /\.from\(complianceDocuments\)\s*\n\s*\.where\(eq\(complianceDocuments\.organisationId, orgId\)\)/);
  assert.match(source, /storedByKey/);
});

test("a bulk confirm writes one audit line per site, not one per requirement", async () => {
  const source = await read(ROUTE);
  assert.match(source, /action: "compliance_responsibility_set"/);
  assert.match(source, /for \(const \[siteId, count\] of touchedSites\)/);
  /* A twelve-site bulk confirm writing 144 activity rows would bury every other
     event on those sites. */
  assert.match(source, /activity-compliance-\$\{siteId\}/);
});

test("a row already carrying the requested answer costs no statement", async () => {
  const source = await read(ROUTE);
  /* Re-pointed when the loop learned about duplicate rows: the comparison moved
     from once per requirement to once per ROW, and the `continue` became a skip
     inside the inner loop rather than a skip of the whole requirement. The
     contract it protects is unchanged — pressing Apply twice costs one round
     trip and no rows. */
  assert.match(source, /if \(row\.dutyHolder === dutyHolder && row\.notRequired === flag\) continue;/);
  assert.match(source, /unchanged \+= 1;/);
});

test("every duplicate of a requirement gets the same answer", async () => {
  const source = await read(ROUTE);
  /*
   * There is no unique index on (organisation, site, kind) — `db/init.ts` is
   * additive only and the monday import already left duplicates — and
   * `readComplianceRegister`'s second loop emits EVERY uncovered register row,
   * so a duplicated pair is in the register twice and counted twice. Writing to
   * one would leave the other at "unconfirmed", still in this queue, still out
   * of the percentage, and the change would look as though it had not taken.
   *
   * `new Map(rows.map(...))` is what a first cut writes, and it silently keeps
   * only the last row for a key. Pinning the absence of that shape is the
   * assertion that catches it coming back.
   */
  assert.match(source, /const storedByKey = new Map<string, typeof stored>\(\);/);
  assert.doesNotMatch(
    source,
    /storedByKey = new Map\(stored\.map/,
    "a plain Map keeps only the last duplicate",
  );
  assert.match(source, /const rowsForPair = storedByKey\.get\(pairKey\(pair\.siteId, pair\.kind\)\) \?\? \[\];/);
  /* And the reply counts REQUIREMENTS, so a reader who selected twelve is told
     twelve whether or not the table holds thirteen rows for them. */
  assert.match(source, /const updated = updatedPairs;/);
});

/* ── 6. The queue ─────────────────────────────────────────────────────────── */

const UI = "app/(app)/portal/ops/compliance-responsibility.tsx";

test("the queue holds the placeholder rows, and deliberately not the NULL estate", async () => {
  const source = await read(ROUTE);
  assert.match(
    source,
    /\.filter\(\(row\) => row\.dutyHolder === DUTY_HOLDER_UNCONFIRMED\)/,
    "only the requirements this system created and is waiting on",
  );
  /* Sweeping the NULL estate in would invite one afternoon of clicking to
     restate the compliance figure for an estate nobody had changed. The reason
     is written where somebody would go to change it. */
  assert.match(source, /A NULL\s*\n?\s*\* duty holder is a DIFFERENT fact/);
});

test("the queue is grouped by site, worst first", async () => {
  const source = await read(ROUTE);
  /* A mall unit's landlord owns the same five certificates at every one of its
     stores, so the site is the unit somebody actually knows the answer for. */
  assert.match(source, /siteName: siteRows\[0\]\?\.siteName \?\? siteId/);
  assert.match(
    source,
    /right\.records\.length - left\.records\.length \|\|\s*\n?\s*left\.siteName\.localeCompare\(right\.siteName, "en-GB"\)/,
  );
  const ui = await read(UI);
  assert.match(ui, /data\.groups\.map\(\(group\) =>/, "and the screen draws those groups");
  assert.match(ui, /toggleSite/, "with a select-all per store");
});

test("a site with nothing outstanding is not in the queue, but still counts in coverage", async () => {
  const source = await read(ROUTE);
  assert.match(source, /coverage: responsibilityCoverage\(siteRows\)/, "over the site's WHOLE set");
  assert.match(source, /\.filter\(\(group\) => group\.records\.length > 0\)/);
});

test("bulk actions post one request for the whole selection", async () => {
  const ui = await read(UI);
  assert.match(ui, /const ENDPOINT = "\/api\/compliance\/responsibilities"/);
  assert.match(ui, /method: "POST"/);
  assert.match(ui, /records: records\.map\(\(record\) => \(\{ siteId: record\.siteId, kind: record\.kind \}\)\)/);
  assert.match(ui, /DUTY_HOLDER_CHOICES\.map\(\(choice\) => \(/, "one button per answer");
});

test("a failed Apply keeps the selection", async () => {
  const ui = await read(UI);
  /* Emptying the boxes on a refusal would make the reader re-tick twelve rows
     before they could find out whether a second attempt works. */
  const apply = ui.slice(ui.indexOf("const apply = useCallback"));
  const failure = apply.indexOf("setError(result.error)");
  const clear = apply.indexOf("setSelected(new Set<string>())");
  assert.ok(failure > 0 && clear > failure, "the selection is only cleared after a success");
  assert.match(apply.slice(failure, failure + 60), /return;/, "and the failure path returns");
});

test("the queue and the register are the same page, sharing one URL state", async () => {
  const page = await read("app/(app)/portal/ops/compliance-page.tsx");
  assert.match(page, /\["confirm", "Confirm responsibilities"\]/);
  assert.match(page, /view === "confirm" \? \(/);
  /* RE-POINTED: a save now broadcasts `announceDataChanged`, which re-reads
     every figure on the page — this summary as before, and the Compliance
     dashboard block above it, which scores the same register and was left
     stale by a summary-only reload. */
  assert.match(
    page,
    /<ConfirmResponsibilitiesQueue search=\{search\} onSaved=\{announceDataChanged\} \/>/,
  );
  /* Filter state stays in the URL — a filtered page is a link — which is the
     rule every operations page is already held to. */
  assert.doesNotMatch(await read(UI), /localStorage|sessionStorage/);
});

test("the confirm view survives a filter that empties the record list", async () => {
  const page = await read("app/(app)/portal/ops/compliance-page.tsx");
  /*
   * The two empty-state guards describe the RECORD list. If they came first,
   * narrowing to one store and then going to confirm its responsibilities would
   * land on "No records match these filters" — which is the exact state
   * somebody is in when they want the queue.
   */
  const confirm = page.indexOf('view === "confirm" ?');
  const emptyRegister = page.indexOf("summary.data.registerTotal === 0 ?");
  assert.ok(confirm > 0 && emptyRegister > confirm, "the queue branch comes first");
});

/* ── 7. The per-requirement control ───────────────────────────────────────── */

test("a requirement can be answered from the register row it is on", async () => {
  const page = await read("app/(app)/portal/ops/compliance-page.tsx");
  assert.match(page, /dutyHolder: string \| null;/, "the row declares it at last");
  assert.match(page, /<ResponsibilityControl record=\{record\} onSaved=\{onSaved\} compact \/>/);
});

test("the control is a sibling of the row button, never a child of it", async () => {
  const page = await read("app/(app)/portal/ops/compliance-page.tsx");
  /*
   * `.ops-record` is a `<button>`, and a `<select>` inside a button is invalid
   * — a button takes phrasing content — and browsers that render it anyway
   * swallow the select's own clicks into the button's.
   */
  const rowStart = page.indexOf("function RecordRow(");
  const block = page.slice(rowStart, page.indexOf("/* ── By requirement", rowStart));
  const closeButton = block.indexOf("</button>");
  const control = block.indexOf("<ResponsibilityControl");
  assert.ok(closeButton > 0 && control > closeButton, "the control follows the button, outside it");
  assert.match(block, /<div className="resp-record">/);
});

test("the current value is always representable, so the select cannot lie", async () => {
  const ui = await read(UI);
  /*
   * A `<select>` whose value is not among its options silently displays the
   * FIRST option, so a requirement at the placeholder would read "Client" — a
   * lie about state, and one that invites somebody to "change" it to the thing
   * it already appears to say.
   */
  assert.match(ui, /\{!known && current \? \(\s*\n\s*<option value=\{current\} disabled>/);
  assert.match(ui, /\{dutyHolderLabel\(current\)\}/, "carrying the words for that state");
  assert.match(ui, /<option value="">\{dutyHolderLabel\(null\)\}<\/option>/, "and clearing is offered");
});

test("the control never retypes either vocabulary", async () => {
  const ui = await read(UI);
  assert.match(ui, /from "\.\.\/\.\.\/\.\.\/lib\/compliance-duty-holder"/);
  /* The four words a person reads exist in exactly one function. A literal here
     is how "Shopping centre" becomes "Shopping Centre" on one screen. */
  for (const word of ["Landlord", "Shopping centre", "Not applicable"]) {
    assert.doesNotMatch(
      ui.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
      new RegExp(`"${word}"`),
      `${word} must come from dutyHolderLabel, not from a literal`,
    );
  }
});

test("the two Responsibility axes are still two things", async () => {
  /*
   * `responsibilityFor()` answers WHO CHASES THE CERTIFICATE and is already the
   * `?who=` filter. This work adds WHOSE OBLIGATION IT IS. One name for both is
   * how a filter starts quietly answering the wrong question.
   */
  const ui = await read(UI);
  assert.match(ui, /WHO CHASES THIS\s*\n?\s*\* CERTIFICATE/, "the trap is written down where the new UI lives");
  assert.equal(typeof view.responsibilityFor, "function", "the older axis is untouched");
  assert.equal(view.responsibilityFor("Fire Alarm", "Someone"), "Fire safety partner");
});

/* ── 8. A phone is the design width ──────────────────────────────────────── */

test("the controls are stacked at 375px and only become rows at 768", async () => {
  const css = await read("app/(app)/portal/ops/compliance-responsibility.css");
  /* Mobile is the base case and every rule widens from it, never the other way
     round — the same discipline ops.css is written under. */
  assert.match(css, /\.resp-row \{\s*\n\s*display: flex;\s*\n\s*flex-direction: column;/);
  assert.match(css, /\.resp-bulk \{[\s\S]*?flex-direction: column;/);
  assert.match(css, /\.resp-bulk__actions \{[\s\S]*?flex-wrap: wrap;/);
});

test("only the agreed breakpoints", async () => {
  const css = await read("app/(app)/portal/ops/compliance-responsibility.css");
  const queries = css.match(/@media \([^)]*width: (\d+)px\)/g) ?? [];
  assert.ok(queries.length > 0, "there is at least one, or the desktop layout is missing");
  for (const query of queries) {
    const width = Number(query.match(/(\d+)px/)[1]);
    assert.ok(
      [640, 767, 768, 1024, 1280].includes(width),
      `${query} is outside the agreed breakpoints`,
    );
  }
});

test("every control a backlog is cleared with is a 44px target", async () => {
  const css = await read("app/(app)/portal/ops/compliance-responsibility.css");
  /* These are the controls somebody uses forty times in a row, which is exactly
     where a missed tap costs a wrong answer written to a compliance record. */
  assert.match(css, /\.resp-control__select \{[\s\S]*?min-height: 44px;/);
  assert.match(css, /\.resp-bulk__action \{\s*\n\s*min-height: 44px;/);
  assert.match(
    css,
    /\.resp-bulk__all,\s*\n\.resp-group__select,\s*\n\.resp-row__pick \{[\s\S]*?min-height: 44px;/,
  );
  /* A browser checkbox is 13px. */
  assert.match(css, /input\[type="checkbox"\] \{[\s\S]*?width: 20px;\s*\n\s*height: 20px;/);
});

test("the select is 16px on a phone, or iOS zooms and does not zoom back", async () => {
  const css = await read("app/(app)/portal/ops/compliance-responsibility.css");
  const base = css.slice(0, css.indexOf("@media"));
  assert.match(base, /\.resp-control__select \{[\s\S]*?font-size: 16px;/);
});

test("nothing in the new UI can scroll the page sideways", async () => {
  const css = await read("app/(app)/portal/ops/compliance-responsibility.css");
  /* `min-width: 0` on every flex and grid child is what lets a long requirement
     name wrap instead of forcing its track wider than the screen. */
  assert.match(css, /\.resp-row__name \{[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(css, /\.resp-group__name \{[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere;/);
  /* The media queries themselves are `min-width: 768px` and are not
     declarations; strip them before asking whether any BOX has a minimum
     wider than a phone. */
  const declarations = css.replace(/@media \([^)]*\)/g, "");
  assert.doesNotMatch(
    declarations,
    /min-width: [3-9]\d\dpx/,
    "no element may be wider than a 375px screen at its narrowest",
  );
});

/* ── 9. The header sentences the score is printed beside ─────────────────── */

test("a store with twelve unconfirmed requirements is never called empty", async () => {
  const page = await read("app/(app)/portal/ops/compliance-page.tsx");
  /*
   * The header used to read "0 of 0" and "No requirements set" for a store
   * holding a full register, because both were derived from the compliance
   * score's denominator — which is only the requirements confirmed as ours.
   * Two sentences saying the store is empty, about a store that is not.
   */
  assert.match(page, /: plural\(group\.total, "requirement"\)/);
  assert.match(page, /group\.total === 0\s*\n?\s*\? "No requirements set"\s*\n?\s*: group\.coverage\.label/);
});

test("no screen prints a percentage it has been told is unscored", async () => {
  const page = await read("app/(app)/portal/ops/compliance-page.tsx");
  /* `scored` exists because 0% and "nothing to score" are different claims, and
     a meter drawn at 0 of 1 is the same lie as "0%" in a different shape. */
  assert.match(page, /\{group\.completion\.scored \? \(\s*\n\s*<ProgressMeter/);
  assert.match(page, /portfolio\.completion\.scored \? `\$\{portfolio\.completion\.percent\}%` : "—"/);
});

test("the coverage sentence reaches the portfolio band and the group header", async () => {
  const page = await read("app/(app)/portal/ops/compliance-page.tsx");
  assert.match(page, /<ResponsibilityCoverageLine coverage=\{portfolio\.coverage\} tone="strong" \/>/);
  assert.match(page, /<ResponsibilityCoverageLine coverage=\{group\.coverage\} \/>/);
  /* And the excluded count is stated, so "8%" cannot be read as "3 of 12 held"
     when it is "3 of 12 confirmed". */
  assert.match(page, /portfolio\.completion\.excluded > 0/);
});
