/**
 * OPENING A SITE MUST NOT COST IT ITS COMPLIANCE SCORE.
 *
 * ── THE DEFECT THIS FILE EXISTS TO HOLD SHUT ──────────────────────────────
 *
 * `ensureComplianceProfile` writes one annotation row per requirement KIND, and
 * those kinds are `storeDocumentationKinds` — exactly the twelve labels a Store
 * Documentation board slot carries. Each is stamped `duty_holder =
 * "unconfirmed"` as it is created, which is correct and deliberate: the product
 * has invented a requirement and nobody has said whose it is.
 *
 * `readComplianceRegister` then looks an annotation up by `${siteId}::${kind}`.
 * The keys collide by construction. So once a site has been given a profile,
 * every BOARD slot of that site finds one of those rows and, read naively,
 * adopts its duty holder — including slots that carry a real, in-date
 * certificate. `countsTowardCompliance("unconfirmed")` is false, so those
 * requirements leave the numerator and the denominator together and a store
 * reading 100% starts reading nothing at all.
 *
 * The consequence is not a wrong label. It is a compliance figure that silently
 * stops existing, on the read path, for sites whose certificates are all in
 * order. That is the worst shape a reporting bug can take, because nothing
 * looks broken.
 *
 * `boardDutyHolder` is the fix, and it had NO test. It was added under
 * `62ec74d` in response to a review finding and shipped unpinned, which means
 * the single line standing between a correct score and an empty one could be
 * reverted by any future refactor without a red test anywhere. This file pins
 * it three ways: the rule itself, the ARITHMETIC the rule protects, and the
 * call sites in `compliance-register.ts` that have to keep using it.
 *
 * ── WHY THE ARITHMETIC IS TESTED AND NOT JUST THE PREDICATE ───────────────
 *
 * A test that only asserts `boardDutyHolder("unconfirmed") === null` documents
 * the function but not the reason for it. Somebody deleting the call site would
 * leave that test green. So the middle section here reconstructs the join the
 * way `readComplianceRegister` performs it, runs `complianceCompletion` over
 * both the defective and the fixed reading, and asserts the numbers that
 * actually reach a person's screen — 100% versus not-scored-at-all.
 *
 * ── WHY THIS COULD NOT BE PROVED ON STAGING ───────────────────────────────
 *
 * It was tried. `maintenance_group_items` on Staging holds rows for
 * `board_id='maintenance'` only — 12, 180 and 774 across the three
 * organisations — and ZERO for `store-documentation`. `readStoreDocumentationRows`
 * therefore returns empty for every tenant there, `storeDocumentationRegister`
 * yields nothing, and the `registerRowFor` join cannot fire at all. Every
 * compliance record on Staging is a register-only row taking the other branch.
 *
 * So the live check run against Demo Client Ltd proves the OTHER half of Part
 * 1A — that repair-on-read preserves a real estate, measured before and after
 * on 204 requirements with 12 attachments and 50 expiry dates, original rows
 * byte-identical by md5 — and this file proves the half Staging cannot reach.
 * Neither substitutes for the other, and a PASS claimed from the live run alone
 * would have been a PASS for a join that never executed.
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

/* A leaf with no imports, which is why it can be loaded straight from a
   `data:` URL — a relative specifier cannot resolve from one. */
const duty = await import(asModule(transpile(await read("app/lib/compliance-duty-holder.ts"))));

/* The two sources whose TEXT is pinned further down. Read once, here, beside
   everything else this file loads. */
const registerSource = await read("app/lib/compliance-register.ts");
const profileSource = await read("app/lib/compliance-profile.ts");

/*
 * `compliance-status.ts` has its specifiers rewritten by exact string, the same
 * way `tests/sites-compliance-link.test.mjs` and `tests/ops-rebuild-foundations.test.mjs`
 * do it. Kept in step with both: if this chain grows a link there, it grows one
 * here.
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

/* ── 1. The rule itself ───────────────────────────────────────────────────── */

test("the machine's placeholder does not survive a board row", () => {
  /*
   * A board row IS the answer the placeholder was waiting for. Somebody set the
   * store up on the compliance board and has been filing certificates against
   * it, which is positive evidence that the requirement is administered here.
   */
  assert.equal(duty.boardDutyHolder(duty.DUTY_HOLDER_UNCONFIRMED), null);
  assert.equal(duty.boardDutyHolder("unconfirmed"), null);
});

test("a human answer outranks the board, which is why this is not `?? null`", () => {
  /*
   * The cheap fix — drop every annotation for board-derived slots — would also
   * discard real decisions. If somebody has said a board-tracked fire alarm is
   * the landlord's, that is a decision and it has to survive the read.
   */
  for (const answer of duty.DUTY_HOLDERS) {
    assert.equal(duty.boardDutyHolder(answer), answer);
  }
});

test("no annotation at all still means nobody was asked", () => {
  /* NULL and "never had a row" are the same statement, and neither is an
     answer. Both must arrive at the register as null. */
  assert.equal(duty.boardDutyHolder(null), null);
  assert.equal(duty.boardDutyHolder(undefined), null);
});

test("the placeholder is written positively, or there is nothing to defend against", () => {
  /*
   * The whole defect depends on `ensureComplianceProfile` stamping a real
   * string rather than leaving NULL. If that ever changed to NULL the join
   * would become harmless — and the existing estate would become
   * indistinguishable from auto-created rows, which is a worse bug. Pinned here
   * so the two halves of the design cannot drift apart.
   */
  assert.equal(duty.DUTY_HOLDER_UNCONFIRMED, "unconfirmed");
  assert.ok(!duty.DUTY_HOLDERS.includes(duty.DUTY_HOLDER_UNCONFIRMED));
  assert.equal(duty.countsTowardCompliance(duty.DUTY_HOLDER_UNCONFIRMED), false);
  assert.equal(duty.countsTowardCompliance(null), true);
});

/* ── 2. The arithmetic the rule protects ──────────────────────────────────── */

/**
 * The join, reconstructed exactly as `readComplianceRegister` performs it.
 *
 * `registerByKey` is keyed `${siteId}::${kind}`; `registerRowFor` resolves a
 * board item to its site and looks the annotation up by that key. `reading` is
 * the one line under test: the fixed build passes it through `boardDutyHolder`,
 * the defective build read `registerRow?.dutyHolder` straight.
 */
const joinBoardSlots = (slots, annotations, reading) => {
  const registerByKey = new Map(
    annotations.map((row) => [`${row.siteId}::${row.kind}`, row]),
  );
  return slots.map((slot) => {
    const registerRow = registerByKey.get(`${slot.siteId}::${slot.kind}`) ?? null;
    return { state: slot.state, dutyHolder: reading(registerRow?.dutyHolder) };
  });
};

/** A store whose twelve certificates are all in date — the case that hurts. */
const TWELVE_IN_DATE = [
  "Drawing",
  "Electrical Wiring",
  "Emergency Lighting",
  "Fire Alarm",
  "Fire Door",
  "Fire Extinguisher",
  "Fire Risk Assessment",
  "PAT Test",
  "PLI",
  "RAMS",
  "Sprinkler",
  "Water Hygiene",
].map((kind) => ({ siteId: "site-cabot-circus", kind, state: "Compliant" }));

/** What `ensureComplianceProfile` leaves behind for that same site. */
const AUTO_CREATED_PROFILE = TWELVE_IN_DATE.map(({ siteId, kind }) => ({
  siteId,
  kind,
  dutyHolder: duty.DUTY_HOLDER_UNCONFIRMED,
}));

test("a fully compliant store still reads 100% after it has been given a profile", () => {
  const rows = joinBoardSlots(TWELVE_IN_DATE, AUTO_CREATED_PROFILE, duty.boardDutyHolder);
  const completion = status.complianceCompletion(rows);

  assert.equal(completion.total, 12);
  assert.equal(completion.applicable, 12, "all twelve are still in the denominator");
  assert.equal(completion.satisfied, 12, "all twelve are still in the numerator");
  assert.equal(completion.excluded, 0, "the placeholder excluded nothing");
  assert.equal(completion.percent, 100);
  assert.equal(completion.scored, true);
});

test("read naively, that same store's score does not merely fall — it disappears", () => {
  /*
   * This is the regression, stated in the numbers a person would see. It is
   * deliberately asserted rather than described: if somebody reverts the call
   * site, the test above goes red and this one documents exactly what they
   * turned it into.
   *
   * Note `scored: false` rather than a low percentage. `percent` is 0 when
   * nothing is applicable, so a screen reading the number alone would print
   * "0%" for a store with twelve valid certificates. That is why the register
   * has to read `scored`, and why "Not yet confirmed" is the required wording.
   */
  const naive = (stored) => stored ?? null;
  const rows = joinBoardSlots(TWELVE_IN_DATE, AUTO_CREATED_PROFILE, naive);
  const completion = status.complianceCompletion(rows);

  assert.equal(completion.total, 12);
  assert.equal(completion.applicable, 0, "the denominator emptied");
  assert.equal(completion.satisfied, 0, "the numerator emptied with it");
  assert.equal(completion.excluded, 12);
  assert.equal(completion.scored, false, "no score at all, for a store that is fully compliant");
});

test("a real answer still removes a requirement from the score, both readings alike", () => {
  /*
   * The fix must not become "board slots are never excluded". A fire alarm
   * confirmed as the landlord's is recorded and displayed, and not scored
   * against us — under the fixed reading exactly as under the naive one.
   */
  const annotations = AUTO_CREATED_PROFILE.map((row) =>
    row.kind === "Fire Alarm" ? { ...row, dutyHolder: "landlord" } : row,
  );
  const completion = status.complianceCompletion(
    joinBoardSlots(TWELVE_IN_DATE, annotations, duty.boardDutyHolder),
  );

  assert.equal(completion.excluded, 1);
  assert.equal(completion.applicable, 11);
  assert.equal(completion.satisfied, 11);
  assert.equal(completion.percent, 100, "eleven of eleven, not eleven of twelve");
});

test("a site with no annotations at all is arithmetically untouched", () => {
  /*
   * The pre-profile world. Every one of the rows that predates the column is
   * NULL, and the figure they produce is the one the estate has always
   * reported. Any change here restates a real client's compliance from a column
   * nobody filled in.
   */
  const before = status.complianceCompletion(
    joinBoardSlots(TWELVE_IN_DATE, [], duty.boardDutyHolder),
  );
  const after = status.complianceCompletion(
    joinBoardSlots(TWELVE_IN_DATE, AUTO_CREATED_PROFILE, duty.boardDutyHolder),
  );
  assert.deepEqual(after, before, "giving the site a profile changed no number");
});

test("register-only rows created by the repair stay out without dragging the estate with them", () => {
  /*
   * The other branch, and the one Staging DOES exercise. Demo Client Ltd was
   * measured through this path today: 60 pre-existing rows with NULL duty
   * holders, then 144 stamped "unconfirmed" created by repair-on-read. The
   * portfolio held at satisfied 11 / applicable 60 / 18% with 144 excluded,
   * before and after, and the original rows were byte-identical afterwards.
   *
   * Those exact numbers are reproduced here so the shape is pinned even though
   * the fixture estate cannot host it.
   */
  const original = [
    ...Array.from({ length: 11 }, () => ({ state: "Compliant", dutyHolder: null })),
    ...Array.from({ length: 24 }, () => ({ state: "Expiring soon", dutyHolder: null })),
    ...Array.from({ length: 15 }, () => ({ state: "Expired", dutyHolder: null })),
    ...Array.from({ length: 10 }, () => ({ state: "Missing", dutyHolder: null })),
  ];
  const created = Array.from({ length: 144 }, () => ({
    state: "Missing",
    dutyHolder: duty.DUTY_HOLDER_UNCONFIRMED,
  }));

  const before = status.complianceCompletion(original);
  const after = status.complianceCompletion([...original, ...created]);

  assert.equal(before.applicable, 60);
  assert.equal(before.satisfied, 11);
  assert.equal(before.percent, 18);

  assert.equal(after.applicable, 60, "the denominator did not grow");
  assert.equal(after.satisfied, 11, "the numerator did not move");
  assert.equal(after.percent, 18, "the headline figure survived 144 new requirements");
  assert.equal(after.excluded, 144);
  assert.equal(after.total, 204);
});

/* ── 3. The call sites, so the rule cannot be quietly bypassed ─────────────── */

test("every board-derived duty holder in the register goes through the rule", () => {
  /*
   * The predicate being correct is worthless if nothing calls it. Two call
   * sites produce a board-derived duty holder — the `RegisterEntry` the board
   * speaks for, and the `ComplianceItem` remembered against the linked site for
   * the per-site meter — and BOTH have to launder the value. Missing either one
   * gives a site whose register and whose percentage disagree.
   */
  const source = registerSource;
  const laundered = source.match(/dutyHolder: boardDutyHolder\(registerRow\?\.dutyHolder\)/g) ?? [];
  assert.equal(
    laundered.length,
    2,
    "expected both the entry and the remembered item to launder the annotation",
  );

  /* And nothing may read it raw into a duty holder again. */
  const raw = source.match(/dutyHolder: registerRow\?\.dutyHolder(?!\s*\))/g) ?? [];
  assert.deepEqual(raw, [], "a raw read of the annotation is the defect itself");
});

test("the rule is imported from the one module that owns it", () => {
  assert.match(
    registerSource,
    /import \{ boardDutyHolder \} from "\.\/compliance-duty-holder"/,
    "the register must not grow its own copy of this decision",
  );
});

test("the profile writer is what makes the placeholder reachable, and still stamps it", () => {
  /*
   * Pinned in the same file as the defence, because the two only make sense
   * together: `ensureComplianceProfile` creating the row is what puts an
   * "unconfirmed" annotation under a board slot's key in the first place.
   */
  assert.match(
    profileSource,
    /DUTY_HOLDER_UNCONFIRMED/,
    "auto-created requirements must be stamped, not left NULL",
  );
});
