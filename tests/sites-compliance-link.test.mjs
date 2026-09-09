/**
 * A SITE AND ITS COMPLIANCE PROFILE ARE ONE THING.
 *
 * The reported fault: a site created on the Sites page got no compliance
 * profile. "Anwar test" read "No requirements set", and the header reported the
 * same across the register — 11 of 11 sites with incomplete details, portfolio
 * compliance 15%.
 *
 * Traced through every write path — `POST /api/sites`, `POST /api/sites/csv`,
 * `POST /api/workspace {entity:"site"}` — and not one of them inserted a single
 * `compliance_documents` row. There was also no shared function for them to
 * call, so the fix had to be a function before it could be a behaviour.
 *
 * ── THE TRAP THIS FILE EXISTS TO HOLD SHUT ────────────────────────────────
 *
 * Giving a new site twelve requirements is the easy half. The dangerous half is
 * what those requirements do to the numbers: created as ordinary records they
 * are all "Missing", they all land in the denominator, and a brand-new site
 * reads 0% compliant while dragging the portfolio down with it. Most of these
 * items are landlord- or centre-controlled in a mall unit and several do not
 * apply at all, so scoring them against the client is not a smaller lie than
 * showing nothing — it is a bigger one.
 *
 * Hence `duty_holder`, and hence the distinction these tests spend most of
 * their time on: NULL means nobody has ever been asked and counts exactly as it
 * always did, while the stored string "unconfirmed" means this product created
 * the row and is waiting. Collapse those two and you either exclude the whole
 * existing estate from its own compliance figure, or you include every
 * unclaimed requirement in it. Both were reachable from one line.
 *
 * Reads normalise CRLF — this is a Windows checkout.
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

/*
 * `compliance-duty-holder.ts` imports nothing, which is why it can be loaded
 * this way at all — a relative specifier cannot resolve from a `data:` URL. It
 * was given its own file for exactly that reason: the rule is asked by the
 * register, by the completion function and by a route handler, and a leaf with
 * no imports can be read by any of them without a cycle.
 */
const duty = await import(asModule(transpile(await read("app/lib/compliance-duty-holder.ts"))));

/*
 * `compliance-status.ts` has to have its specifiers rewritten by exact string,
 * the same way `tests/ops-rebuild-foundations.test.mjs` does it. Kept in step
 * with that file: if this chain grows a link there, it grows one here.
 */
const status = await (async () => {
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
  return import(
    asModule(
      transpile(await read("app/lib/compliance-status.ts"))
        .replace(/from ["']\.\/expiry-status["']/g, `from "${expiry}"`)
        .replace(/from ["']\.\/store-documentation-register["']/g, `from "${register}"`)
        .replace(/from ["']\.\/compliance-duty-holder["']/g, `from "${dutyHolder}"`),
    )
  );
})();

/* ── The distinction the whole design rests on ────────────────────────────── */

test("a requirement nobody has been asked about still counts, exactly as it did", () => {
  /*
   * THE 748-ROW QUESTION. Every `compliance_documents` row that predates the
   * `duty_holder` column is NULL. If NULL were read as "unconfirmed" the
   * portfolio figure would restate itself overnight from a column nobody has
   * filled in, and every screen would report an estate nobody had changed.
   */
  assert.equal(duty.countsTowardCompliance(null), true);
  assert.equal(duty.countsTowardCompliance(undefined), true);
});

test("a requirement confirmed as the client's counts", () => {
  assert.equal(duty.countsTowardCompliance("client"), true);
});

test("a requirement that is not ours, or not yet answered for, does not", () => {
  // Maintsupp administers a schedule; it does not assume responsibility for
  // assets it was never given.
  assert.equal(duty.countsTowardCompliance("unconfirmed"), false);
  assert.equal(duty.countsTowardCompliance("landlord"), false);
  assert.equal(duty.countsTowardCompliance("centre"), false);
  assert.equal(duty.countsTowardCompliance("not_applicable"), false);
});

test("a value the column should not hold is left out rather than asserted", () => {
  /* The safe direction for a defect is to omit a requirement from a compliance
     CLAIM, never to invent one. */
  assert.equal(duty.countsTowardCompliance("Client"), false, "case matters");
  assert.equal(duty.countsTowardCompliance("whoever"), false);
  assert.equal(duty.countsTowardCompliance(""), false);
});

test('"unconfirmed" is not one of the answers a person may give', () => {
  assert.equal(duty.isDutyHolder("unconfirmed"), false);
  assert.deepEqual([...duty.DUTY_HOLDERS], ["client", "landlord", "centre", "not_applicable"]);
  for (const value of duty.DUTY_HOLDERS) assert.equal(duty.isDutyHolder(value), true);
});

test("the words a person reads say Responsibility, whatever the column is called", () => {
  assert.equal(duty.dutyHolderLabel("unconfirmed"), "Responsibility not confirmed");
  assert.equal(duty.dutyHolderLabel("centre"), "Shopping centre");
  assert.equal(duty.dutyHolderLabel("not_applicable"), "Not applicable");
  /* NULL is a different sentence from "unconfirmed" on screen too, because they
     are different facts: never asked, versus asked and waiting. */
  assert.notEqual(duty.dutyHolderLabel(null), duty.dutyHolderLabel("unconfirmed"));
});

/* ── What that does to the score ──────────────────────────────────────────── */

const record = (state, dutyHolder) =>
  dutyHolder === undefined ? { state } : { state, dutyHolder };

test("records with no duty holder score precisely as they did before", () => {
  /*
   * BACKWARD COMPATIBILITY, ASSERTED RATHER THAN HOPED FOR. A caller that
   * assembles records for a score without touching the register — and several
   * do — must get the old arithmetic to the digit.
   */
  const rows = [
    record("Compliant"),
    record("Compliant"),
    record("Missing"),
    record("Expired"),
    record("Not required"),
  ];
  const out = status.complianceCompletion(rows);
  assert.equal(out.total, 5);
  assert.equal(out.notRequired, 1);
  assert.equal(out.applicable, 4, "total minus not-required, as it always was");
  assert.equal(out.satisfied, 2);
  assert.equal(out.percent, 50);
  assert.equal(out.scored, true);
  assert.equal(out.excluded, 0, "nothing is excluded when nothing was asked");
});

test("a brand-new site reads 'not yet confirmed', never 0%", () => {
  /*
   * THE FAULT IN ONE ASSERTION. Twelve unclaimed requirements used to come back
   * `applicable: 12, percent: 0, scored: true`, which every screen renders as a
   * failing store. Measured on the running server before the fix, and this is
   * the shape that replaced it.
   */
  const rows = Array.from({ length: 12 }, () => record("Missing", "unconfirmed"));
  const out = status.complianceCompletion(rows);
  assert.equal(out.total, 12, "the requirements exist");
  assert.equal(out.excluded, 12);
  assert.equal(out.applicable, 0);
  assert.equal(out.scored, false, "so a caller prints a dash, not a zero");
});

test("confirming one as the client's brings exactly that one into the score", () => {
  const rows = [
    record("Compliant", "client"),
    record("Missing", "unconfirmed"),
    record("Missing", "landlord"),
    record("Missing", "centre"),
  ];
  const out = status.complianceCompletion(rows);
  assert.equal(out.applicable, 1);
  assert.equal(out.satisfied, 1);
  assert.equal(out.percent, 100);
  assert.equal(out.scored, true);
  assert.equal(out.excluded, 3, "unanswered, landlord and centre alike");
});

test("a certificate held for somebody else's obligation is not scored as ours", () => {
  /* The inverse of the trap above, and just as wrong: a landlord's in-date
     certificate must not flatter the client's percentage either. */
  const out = status.complianceCompletion([
    record("Compliant", "landlord"),
    record("Missing", "client"),
  ]);
  assert.equal(out.satisfied, 0, "the landlord's Compliant row is not ours to count");
  assert.equal(out.applicable, 1);
  assert.equal(out.percent, 0);
});

test("the three groups partition the total and never overlap", () => {
  /*
   * `total - notRequired - excluded === applicable`, which is what stops a
   * record marked Not applicable being subtracted twice — once for its state
   * and once for its duty holder. That double subtraction would make
   * `applicable` negative and the percentage nonsense.
   */
  const rows = [
    record("Compliant", "client"),
    record("Missing", "unconfirmed"),
    record("Not required", "not_applicable"),
    record("Not required", "unconfirmed"),
    record("Expired"),
  ];
  const out = status.complianceCompletion(rows);
  assert.equal(out.total - out.notRequired - out.excluded, out.applicable);
  assert.ok(out.applicable >= 0);
  assert.equal(out.notRequired, 2, "both Not required rows, whatever their duty holder");
  assert.equal(out.excluded, 1, "only the applicable-but-unclaimed one");
});

/* ── One function, every create path ─────────────────────────────────────── */

test("all three site-create paths call the one profile function", async () => {
  const paths = {
    "app/api/sites/route.ts": "the Add site form",
    "app/api/sites/csv/route.ts": "the CSV importer",
    "app/api/workspace/route.ts": "the Manage data drawer",
  };
  for (const [file, description] of Object.entries(paths)) {
    const source = await read(file);
    assert.match(
      source,
      /ensureComplianceProfile\(db, orgId, id\)/,
      `${description} (${file}) must create the profile through the shared function`,
    );
    assert.match(
      source,
      /from "(\.\.\/)+lib\/compliance-profile"/,
      `${description} must import it rather than restate it`,
    );
  }
});

test("the Add site form creates neither the site nor nothing", async () => {
  const source = await read("app/api/sites/route.ts");
  /*
   * The brief asks for one transaction. This route is a sequence of awaits, so
   * the guarantee is met by compensating instead: the site row is removed again
   * if its profile cannot be written. Proven live — the first probe run failed
   * on a 144-variable insert and left no site behind.
   */
  const create = source.slice(source.indexOf("export async function POST"));
  const call = create.indexOf("ensureComplianceProfile");
  /*
   * Matched WITHOUT the receiver, deliberately. This read `db.delete(sites)`
   * and broke the moment the statement gained a `registerScopeFilter` and had
   * to be wrapped across lines — a pin that fails on reformatting rather than
   * on the contract is a pin that gets deleted the next time it fires. What
   * matters is that a delete of `sites` happens AFTER the profile call, which
   * is the ordering that makes it a rollback rather than a race.
   */
  const rollback = create.search(/\.delete\(sites\)/);
  assert.ok(call > 0, "the create path must ask for a profile");
  assert.ok(rollback > call, "a failed profile must roll the site back");
  assert.match(create, /Nothing was saved/, "and must say so");
  /* The rollback is a `sites` write like any other and carries the register
     scope — w2-scope-model enforces that on the statement, and caught this one
     when it did not. */
  assert.match(
    create.slice(rollback, rollback + 400),
    /registerScopeFilter\(sites\.boardId, scope\)/,
    "including the rollback",
  );
});

test("the profile insert is chunked, because twelve rows is 144 variables", async () => {
  const source = await read("app/lib/compliance-profile.ts");
  assert.match(source, /import \{ chunkRows \} from "\.\/sql-batching"/);
  assert.match(source, /chunkRows\(rows, COMPLIANCE_INSERT_COLUMNS\)/);
  /* Not a hardcoded row count. D1 binds one variable per COLUMN per row, so the
     safe row count depends on the table's width — and this change added a
     column to that table. */
  assert.doesNotMatch(source, /chunkRows\(rows, \d+\)/);
});

test("the profile matches on requirement kind and never duplicates", async () => {
  const source = await read("app/lib/compliance-profile.ts");
  assert.match(source, /const missing = kinds\.filter\(\(kind\) => !held\.has\(kind\)\)/);
  /* There is no unique index on (organisation, site, kind) — `db/init.ts` is
     additive only — so a deterministic primary key is what makes a racing
     second writer collide instead of quietly minting a thirteenth requirement. */
  assert.match(source, /export function complianceProfileId\(/);
  assert.match(source, /id: complianceProfileId\(siteId, kind\)/);
});

test("the reader still does not write; the repair lives on the site's own read", async () => {
  const register = await read("app/lib/compliance-register.ts");
  /*
   * `readComplianceRegister`'s docstring ends "Nothing here writes, and nothing
   * here drops a row", and it must stay true. A repair placed there would fire
   * on the PORTFOLIO read — every site at once, on every page load — which is
   * a far worse thing than a missing profile.
   */
  assert.doesNotMatch(register, /ensureComplianceProfile/);
  assert.match(register, /Nothing here writes, and nothing here drops a row/);

  const sites = await read("app/api/sites/route.ts");
  const detail = sites.slice(sites.indexOf('const id = url.searchParams.get("id")'));
  assert.match(detail, /ensureComplianceProfile\(db, orgId, id\)/, "one site, on the request that opened it");
  assert.match(detail, /compliance_profile_created/, "and the repair is logged");
});

/* ── The write half, and the naming it must not collide with ─────────────── */

test("a duty holder can actually be confirmed, or the state is a one-way door", async () => {
  const source = await read("app/api/workspace/route.ts");
  assert.match(source, /isDutyHolder\(dutyHolder\)/, "validated against the vocabulary");
  assert.match(source, /A responsibility must be one of/);
  assert.match(source, /dutyHolder: dutyHolder \|\| null/, "and written");
});

test("omitting the duty holder leaves it alone, while the other four keys may not be", async () => {
  const source = await read("app/api/workspace/route.ts");
  /*
   * This branch's UPDATE is a full replace and the calendar's drag sends site,
   * kind, state and expiry together — so an omitted key THERE is an erasure and
   * is refused. `dutyHolder` is not in that payload, so if absence were treated
   * the same way, dragging a certificate to a new date would silently
   * un-confirm a responsibility and take the requirement back out of the score.
   */
  assert.match(source, /const dutyHolderSent = "dutyHolder" in data;/);
  assert.match(source, /\.\.\.\(dutyHolderSent \? \{ dutyHolder: dutyHolder \|\| null \} : \{\}\)/);
  // The other four stay required. If these refusals go, the asymmetry above
  // stops being a decision and becomes an inconsistency.
  assert.match(source, /A status is required\. Send the document's current status/);
  assert.match(source, /An expiry date is required\. Send null to clear it\./);
});

test('"Not applicable" reaches the state the product already has a word for', async () => {
  const source = await read("app/api/workspace/route.ts");
  assert.match(source, /notRequired: state === "Not required" \|\| isNotApplicable\(dutyHolder\)/);
  /* A sixth ComplianceState would have to be learned by eleven test suites, the
     digest email and the CSV export. The reason is kept on the row instead. */
  const dutyHolder = await read("app/lib/compliance-duty-holder.ts");
  assert.match(dutyHolder, /sixth state/);
});

test("duty holder and responsibility stay two names for two questions", async () => {
  /*
   * `StoreDocumentSlot.responsibility` already means WHO CHASES THE
   * CERTIFICATE — Contractor, Fire safety partner, Insurance broker — and is
   * already the register's `?who=` filter. The new axis is WHOSE OBLIGATION IT
   * IS. A fire alarm service can be chased by the fire safety partner and still
   * be the landlord's liability, so one name for both is how a filter starts
   * answering the wrong question.
   */
  const view = await read("app/lib/compliance-view.ts");
  assert.match(view, /responsibility: string;/, "who chases it");
  assert.match(view, /dutyHolder: string \| null;/, "whose obligation it is");

  const spec = await read("db/monday-board-spec.ts");
  assert.match(spec, /responsibility: "Fire safety partner"/, "the older axis is untouched");
  assert.doesNotMatch(spec, /dutyHolder/, "and knows nothing about the new one");
});

test("the score depends on ComplianceRow carrying it, so both routes populate it", async () => {
  /*
   * `groupCompliance` and `portfolioCounts` both score `ComplianceRow[]`, not
   * `RegisterEntry[]`. Carrying the field on the entry alone is what made a
   * new site read 0% while the register knew perfectly well the requirements
   * were unclaimed — caught by querying the summary, not by reading the diff.
   */
  for (const file of [
    "app/api/compliance/summary/route.ts",
    "app/api/compliance/records/route.ts",
  ]) {
    const source = await read(file);
    assert.match(source, /dutyHolder: entry\.dutyHolder,/, `${file} must pass it through`);
  }
});

test("bySite carries it too, or every percentage on the Sites page is wrong", async () => {
  const register = await read("app/lib/compliance-register.ts");
  /* `entries` feeds the list; `bySite` feeds the meters. Both loops that call
     `remember` have to send it — the register-only one was missed first time
     round and that alone was enough to keep the old, wrong number. */
  const remembers = register.match(/remember\([^)]*\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(remembers.length >= 2, "board-derived and register-only rows both remember");
  for (const [index, block] of remembers.entries()) {
    assert.match(block, /dutyHolder/, `remember() call ${index + 1} must carry the duty holder`);
  }
});

test("the column is nullable text, and nothing defaults it", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /\["duty_holder", "TEXT"\]/);
  /* A DEFAULT would erase the difference between "never asked" and
     "unconfirmed" for every existing row, which is the one thing this design
     cannot survive. TEXT also keeps it clear of `BOOLEAN_COLUMNS` and the
     bare-name rewrite in `db/sqlite-to-postgres.ts`. */
  assert.doesNotMatch(init, /"duty_holder", "TEXT NOT NULL/);
  assert.doesNotMatch(init, /duty_holder.*DEFAULT/);
});
