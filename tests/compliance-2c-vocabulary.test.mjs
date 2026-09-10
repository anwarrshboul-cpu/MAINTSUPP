/**
 * 2C — THE REQUIREMENT VOCABULARY.
 *
 * ── WHAT THIS SUITE IS DEFENDING ──────────────────────────────────────────
 *
 * `ensureComplianceProfile` matched an existing requirement on EXACT `kind`, so
 * a store that already held "Legionella risk assessment" was given "Water
 * Hygiene" beside it, and a store holding "Fire risk assessment" was given
 * "Fire Risk Assessment" — a duplicate created by a capital letter.
 *
 * The eight names in `DEMO_CLIENT_VOCABULARY` below are not invented. They were
 * read out of Staging's Demo Client tenant (`org_…0002`) on 2026-09-10 with
 *
 *   select kind, count(*), count(*) filter (where duty_holder is null)
 *   from portal.compliance_documents
 *   where organisation_id = 'org_000000000000000000000002' group by kind;
 *
 * which returned 60 rows under those eight names plus 144 rows under the
 * canonical twelve — 204 requirements across 12 sites, where about 66 is the
 * honest number. Every row count here is that measurement.
 *
 * ── HOW THE MODULE IS LOADED ──────────────────────────────────────────────
 *
 * The same `data:` URL chain the rest of this family uses. `compliance-vocabulary.ts`
 * imports exactly one thing — `db/monday-board-spec` — so the chain is one link
 * long, and it stays that way on purpose: this module is imported by a client
 * component and anything it grows would go to the browser with it.
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

const spec = asModule(transpile(await read("db/monday-board-spec.ts")));
const vocabulary = await import(
  asModule(
    transpile(await read("app/lib/compliance-vocabulary.ts")).replace(
      /from ["']\.\.\/\.\.\/db\/monday-board-spec["']/g,
      `from "${spec}"`,
    ),
  )
);
const boardSpec = await import(spec);

const {
  BUILT_IN_KIND_ALIASES,
  DEFAULT_COMPLIANCE_TEMPLATE,
  buildKindResolver,
  classifyKinds,
  normaliseKind,
  parseComplianceTemplate,
  templateKinds,
} = vocabulary;

/** The eight names Staging's Demo Client actually uses, and what each means. */
const DEMO_CLIENT_VOCABULARY = [
  { kind: "Fire risk assessment", rows: 11, canonical: "Fire Risk Assessment" },
  { kind: "Electrical installation condition report", rows: 13, canonical: "Electrical Wiring" },
  { kind: "Emergency lighting certificate", rows: 11, canonical: "Emergency Lighting" },
  { kind: "Fire alarm service certificate", rows: 3, canonical: "Fire Alarm" },
  { kind: "Legionella risk assessment", rows: 12, canonical: "Water Hygiene" },
  { kind: "PAT testing certificate", rows: 4, canonical: "PAT Test" },
  /* Not other names for a board slot — requirements the board does not track. */
  { kind: "Air conditioning inspection report", rows: 3, canonical: null },
  { kind: "Gas safety certificate", rows: 3, canonical: null },
];

/* ── 1. The measured estate ───────────────────────────────────────────────── */

test("every name the Demo Client actually uses resolves the way it was measured", () => {
  const resolve = buildKindResolver(DEFAULT_COMPLIANCE_TEMPLATE);
  for (const { kind, canonical, rows } of DEMO_CLIENT_VOCABULARY) {
    assert.equal(
      resolve(kind),
      canonical,
      canonical
        ? `${rows} rows named "${kind}" must resolve to "${canonical}" rather than be duplicated`
        : `"${kind}" is not another name for a board slot and must stay itself`,
    );
  }
});

test("the whole defect: a capital letter must not create a thirteenth requirement", () => {
  /*
   * The cheapest of the eight and the one that proves an editable list would
   * not have been enough. Nobody could have configured their way out of this:
   * the operator's data and the machine's vocabulary agree on every character
   * except one.
   */
  assert.equal(normaliseKind("Fire risk assessment"), normaliseKind("Fire Risk Assessment"));
  const resolve = buildKindResolver(DEFAULT_COMPLIANCE_TEMPLATE);
  assert.equal(resolve("Fire risk assessment"), "Fire Risk Assessment");
  assert.equal(resolve("FIRE RISK ASSESSMENT"), "Fire Risk Assessment");
  assert.equal(resolve("  fire-risk-assessment  "), "Fire Risk Assessment");
});

test("the six mergeable names account for 54 of the 60 original rows", () => {
  /* Arithmetic, so the claim in the module header cannot rot: 11+13+11+3+12+4. */
  const merged = DEMO_CLIENT_VOCABULARY.filter((entry) => entry.canonical);
  const kept = DEMO_CLIENT_VOCABULARY.filter((entry) => !entry.canonical);
  assert.equal(merged.reduce((sum, entry) => sum + entry.rows, 0), 54);
  assert.equal(kept.reduce((sum, entry) => sum + entry.rows, 0), 6);
  assert.equal(merged.length + kept.length, 8);
});

/* ── 2. The fold cannot merge two different certificates ──────────────────── */

test("no two of the twelve board slots fold to the same key", () => {
  /*
   * The one way this module could destroy data. "Fire Alarm" and "Fire Door"
   * must survive as different keys; a normaliser that got greedy — stripping
   * "door" as a noun, say — would silently merge two certificates and there
   * would be no row left to notice it by.
   */
  const seen = new Map();
  for (const kind of boardSpec.storeDocumentationKinds) {
    const key = normaliseKind(kind);
    assert.ok(!seen.has(key), `"${kind}" folds onto "${seen.get(key)}" — that is a lost certificate`);
    seen.set(key, kind);
  }
  assert.equal(seen.size, 12);
});

test("no alias is claimed by two different requirements", () => {
  const owner = new Map();
  for (const [kind, aliases] of Object.entries(BUILT_IN_KIND_ALIASES)) {
    for (const alias of aliases) {
      const key = normaliseKind(alias);
      const held = owner.get(key);
      assert.ok(
        held === undefined || held === kind,
        `"${alias}" is claimed by both "${held}" and "${kind}"`,
      );
      owner.set(key, kind);
    }
  }
});

test("an alias never folds onto a DIFFERENT requirement's own name", () => {
  /*
   * A wrong merge is worse than a duplicate: a duplicate is visible and a
   * merge silently moves a certificate to another slot. So an alias may fold
   * onto its own requirement's name — "Fire risk assessment" does — but never
   * onto another's.
   */
  const nameOwner = new Map(
    boardSpec.storeDocumentationKinds.map((kind) => [normaliseKind(kind), kind]),
  );
  for (const [kind, aliases] of Object.entries(BUILT_IN_KIND_ALIASES)) {
    for (const alias of aliases) {
      const collides = nameOwner.get(normaliseKind(alias));
      assert.ok(
        collides === undefined || collides === kind,
        `alias "${alias}" of "${kind}" folds onto the requirement "${collides}"`,
      );
    }
  }
});

/* ── 3. A template edit cannot reassign a name ────────────────────────────── */

test("a canonical name outranks any alias, so one typo cannot move eleven certificates", () => {
  /*
   * An operator who types "Fire Alarm" into the aliases box of "Sprinkler" is
   * making a mistake, not a decision. Without the specificity rule every real
   * Fire Alarm row would start resolving to Sprinkler.
   */
  const template = parseComplianceTemplate({
    kinds: [
      { kind: "Sprinkler", aliases: ["Fire Alarm"], enabled: true },
      { kind: "Fire Alarm", aliases: [], enabled: true },
    ],
  });
  const resolve = buildKindResolver(template);
  assert.equal(resolve("Fire Alarm"), "Fire Alarm");
});

test("a template teaches a new alias without un-teaching a shipped one", () => {
  const template = parseComplianceTemplate({
    kinds: [{ kind: "Water Hygiene", aliases: ["Tank clean record"], enabled: true }],
  });
  const resolve = buildKindResolver(template);
  assert.equal(resolve("Tank clean record"), "Water Hygiene", "the operator's own name");
  assert.equal(
    resolve("Legionella risk assessment"),
    "Water Hygiene",
    "and the shipped one, which the operator never listed and must not lose",
  );
});

test("a requirement outside the template keeps its own name", () => {
  const resolve = buildKindResolver(DEFAULT_COMPLIANCE_TEMPLATE);
  assert.equal(resolve("Gas safety certificate"), null);
  assert.equal(resolve("Something nobody has ever tracked"), null);
});

/* ── 4. What the template promises about the board ────────────────────────── */

test("the twelve board slots survive a save that dropped them", () => {
  /*
   * The board has a column for each of the twelve. A register with no name for
   * a column it can see would show a certificate it cannot label — so they come
   * back, DISABLED where the operator removed them, which honours the intent
   * without leaving the board unlabelled.
   */
  const template = parseComplianceTemplate({
    kinds: [{ kind: "Gas safety certificate", aliases: [], enabled: true }],
  });
  const names = template.kinds.map((entry) => entry.kind);
  for (const kind of boardSpec.storeDocumentationKinds) {
    assert.ok(names.includes(kind), `"${kind}" must survive`);
  }
  const restored = template.kinds.find((entry) => entry.kind === "Sprinkler");
  assert.equal(restored.enabled, false, "restored, not re-enabled");
  assert.equal(restored.board, true);
  assert.equal(templateKinds(template).join("|"), "Gas safety certificate");
});

test("a disabled requirement is still RESOLVED, or disabling would duplicate history", () => {
  /*
   * An estate that switches "Sprinkler" off still holds sprinkler certificates
   * on the sites that have them. Those rows must keep matching their own name;
   * if disabling removed the name from the resolver, the next repair would
   * create a second Sprinkler row beside every existing one — the exact defect
   * this work exists to end, re-entering through a settings toggle.
   */
  const template = parseComplianceTemplate({
    kinds: boardSpec.storeDocumentationKinds.map((kind) => ({
      kind,
      aliases: [],
      enabled: kind !== "Sprinkler",
    })),
  });
  assert.ok(!templateKinds(template).includes("Sprinkler"), "not created for new sites");
  assert.equal(
    buildKindResolver(template)("Sprinkler system certificate"),
    "Sprinkler",
    "but still recognised on the sites that already have one",
  );
});

test("two spellings of one requirement cannot both survive a save", () => {
  const template = parseComplianceTemplate({
    kinds: [
      { kind: "PAT Test", aliases: [], enabled: true },
      { kind: "PAT test", aliases: [], enabled: true },
    ],
  });
  const pat = template.kinds.filter((entry) => normaliseKind(entry.kind) === normaliseKind("PAT Test"));
  assert.equal(pat.length, 1, "one requirement, one row in the template");
});

test("an unreadable template is the default, because sites must still be creatable", () => {
  /*
   * Read on the create path of every site. A settings row somebody hand-edited
   * must not stop a site being created — the safe reading is the vocabulary the
   * product had before templates existed.
   */
  for (const junk of [null, undefined, "", 7, [], {}, { kinds: "twelve" }, { kinds: [] }]) {
    assert.equal(
      parseComplianceTemplate(junk).kinds.length,
      12,
      `${JSON.stringify(junk)} must fall back to the twelve`,
    );
  }
});

test("`board` is a fact about the spec, never a value the payload gets to assert", () => {
  const template = parseComplianceTemplate({
    kinds: [
      { kind: "Gas safety certificate", aliases: [], enabled: true, board: true },
      { kind: "Sprinkler", aliases: [], enabled: true, board: false },
    ],
  });
  const gas = template.kinds.find((entry) => entry.kind === "Gas safety certificate");
  const sprinkler = template.kinds.find((entry) => entry.kind === "Sprinkler");
  assert.equal(gas.board, false, "the board has no column for it, whatever the payload said");
  assert.equal(sprinkler.board, true, "and it does have one for this");
});

/* ── 5. The preview and the action are computed by one function ───────────── */

test("classifyKinds reports the merge a person is about to approve", () => {
  /*
   * The backfill preview and the Settings editor both render this. Pure and
   * shared, because a preview produced by a second implementation is a preview
   * of something else.
   */
  const resolve = buildKindResolver(DEFAULT_COMPLIANCE_TEMPLATE);
  const rows = classifyKinds(
    DEMO_CLIENT_VOCABULARY.map((entry) => entry.kind).concat(["Water Hygiene"]),
    resolve,
  );
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  assert.equal(byKind.get("Legionella risk assessment").canonical, "Water Hygiene");
  assert.equal(byKind.get("Legionella risk assessment").exact, false, "it would be merged");
  assert.equal(byKind.get("Water Hygiene").exact, true, "this one is already itself");
  assert.equal(byKind.get("Gas safety certificate").canonical, null);
  assert.equal(rows.length, 9, "each name reported once");
});

/* ── 6. The module stays importable from a client component ───────────────── */

test("the vocabulary imports no database, or the Settings editor drags the ORM", () => {
  /*
   * Pinned on the source rather than on behaviour, because the failure is a
   * bundle size and a server-only import in the browser — neither of which any
   * assertion about the resolver would catch.
   */
  return read("app/lib/compliance-vocabulary.ts").then((source) => {
    assert.doesNotMatch(source, /from "drizzle-orm"/);
    assert.doesNotMatch(source, /db\/schema/);
    assert.doesNotMatch(source, /from "\.\.\/\.\.\/db"/);
    assert.match(
      source,
      /import \{ storeDocumentationKinds \} from "\.\.\/\.\.\/db\/monday-board-spec"/,
      "one import, and it is the spec",
    );
  });
});
