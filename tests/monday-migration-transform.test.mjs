/**
 * The migration's decisions, pinned.
 *
 *   node --test tests/monday-migration-transform.test.mjs
 *
 * Every rule here was settled by evidence in the Phase 1 export rather than by
 * the original migration brief, and several of them contradict it. A test is
 * the only thing that stops the brief's wording quietly winning again later —
 * so each one says what the evidence was.
 *
 * No database and no network: `monday-transform.mjs` is pure by construction,
 * which is what lets the import path and this file share one copy of the rules.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SITE_REGISTER,
  NOT_A_SITE,
  buildAliasIndex,
  resolveSite,
  isSiteGroup,
  normalise,
  stripGroupSuffix,
  siteCode,
  jobTitle,
  tierNumber,
  blankToNull,
  engineerValue,
  costValue,
  timelineEnd,
  stageFor,
  complianceState,
  isVerifiableEvidence,
  SUSPICIOUS_ASSET_NAMES,
  ORGANISATION_LEVEL_SLOTS,
  NEVER_AUTO_ASSIGNED,
  UNDATED_SLOTS,
  STORE_DOC_FILE_COLUMNS,
  MAINTENANCE_FILE_COLUMNS,
} from "../db/monday-export/monday-transform.mjs";

const index = buildAliasIndex();
const resolve = (signals) => resolveSite(signals, index);

/* ── Cardiff: one shop, not two ──────────────────────────────────────────── */

test("both Cardiff namings resolve to one site", () => {
  // Phase 1 proved it by checksum: Invoice-1057752 and Certificate_1057752 are
  // byte-identical across both Store Documentation rows, and Grand Arcade's own
  // address reads "(FORMERLY KNOWN AS UNIT LG24)" — which is what the other row
  // is named after.
  assert.equal(resolve({ storeLocation: "Cardiff – Grand Arcade" }).canonical, "Cardiff – Grand Arcade");
  assert.equal(resolve({ locationRaw: "Cardiff St Davids" }).canonical, "Cardiff – Grand Arcade");
  assert.equal(resolve({ locationRaw: "Grand Arcade - Cardiff" }).canonical, "Cardiff – Grand Arcade");
  assert.equal(resolve({ group: "Cardiff completed" }).canonical, "Cardiff – Grand Arcade");
  assert.equal(resolve({ locationRaw: "UNIT LG24" }).canonical, "Cardiff – Grand Arcade");
});

test("the register holds exactly one Cardiff shopping-centre site", () => {
  const cardiff = SITE_REGISTER.filter((s) => /cardiff|grand arcade|st davids/i.test(s.canonical));
  assert.deepEqual(cardiff.map((s) => s.canonical), ["Cardiff – Grand Arcade"]);
  assert.equal(cardiff[0].status, "Active");
});

test("a merged Cardiff site keeps both source namings as aliases", () => {
  const entry = SITE_REGISTER.find((s) => s.canonical === "Cardiff – Grand Arcade");
  for (const alias of ["Grand Arcade - Cardiff", "Cardiff St Davids"]) {
    assert.ok(entry.aliases.includes(alias), `${alias} missing from the merged entry`);
  }
});

/* ── The four international sites ────────────────────────────────────────── */

test("the four Swedish locations are distinct International sites", () => {
  const swedish = ["Mall of Scandinavia", "Nacka", "Solna", "Täby"];
  for (const name of swedish) {
    const entry = SITE_REGISTER.find((s) => s.canonical === name);
    assert.ok(entry, `${name} is not in the register`);
    assert.equal(entry.status, "International");
    assert.equal(entry.region, "International");
  }
  assert.equal(new Set(swedish).size, 4);
});

test("a Swedish location never resolves to a UK site", () => {
  for (const raw of ["Mall of Scandinavia", "Nacka / Sweden", "Solna", "Taby/ Sweden"]) {
    const result = resolve({ locationRaw: raw });
    assert.ok(
      result.canonical === null || SITE_REGISTER.find((s) => s.canonical === result.canonical).status === "International",
      `${raw} resolved to ${result.canonical}`,
    );
  }
});

test("country is only set where the source states it", () => {
  // "Nacka / Sweden" and "Taby/ Sweden" say Sweden. The other two do not, and
  // no address or country is invented for them.
  assert.equal(SITE_REGISTER.find((s) => s.canonical === "Nacka").country, "Sweden");
  assert.equal(SITE_REGISTER.find((s) => s.canonical === "Täby").country, "Sweden");
  assert.equal(SITE_REGISTER.find((s) => s.canonical === "Solna").country, undefined);
  assert.equal(SITE_REGISTER.find((s) => s.canonical === "Mall of Scandinavia").country, undefined);
});

/* ── Site resolution is deterministic, and conflict is not a guess ───────── */

test("resolution prefers the Store Location label over the group", () => {
  const result = resolve({ storeLocation: "Watford – Atria", group: "Watford completed" });
  assert.equal(result.canonical, "Watford – Atria");
  assert.equal(result.method, "store-location-label");
});

test("the group resolves a job whose label is unset", () => {
  const result = resolve({ group: "Bullring completed" });
  assert.equal(result.canonical, "Birmingham – Bullring");
  assert.equal(result.method, "group");
});

test("monday's group typo resolves", () => {
  assert.equal(resolve({ group: "Nottingham complited" }).canonical, "Nottingham – Victoria Centre");
});

test("the double-spaced Westfield Stratford group resolves", () => {
  assert.equal(resolve({ group: "Westfield Stratford  completed" }).canonical, "Westfield – Stratford");
});

test("contradicting signals are held for review, never picked between", () => {
  const result = resolve({ storeLocation: "Watford – Atria", group: "Bullring completed" });
  assert.equal(result.canonical, null);
  assert.equal(result.method, "conflict");
  assert.equal(result.review, true);
  assert.match(result.detail, /disagree/);
});

test("an unrecognised location is unresolved and flagged, not guessed", () => {
  const result = resolve({ locationRaw: "Joseph" });
  assert.equal(result.canonical, null);
  assert.equal(result.method, "unresolved");
  assert.equal(result.review, true);
});

test("a job with no site signal at all is unresolved but not flagged for review", () => {
  const result = resolve({});
  assert.equal(result.canonical, null);
  assert.equal(result.review, false);
});

test("tokens two sites share never resolve", () => {
  // Cabot Circus and Cribbs Causeway both carry "bristol"; Stratford and White
  // City both carry "westfield". Guessing either attaches one shop's job
  // history to another.
  for (const raw of ["Bristol", "Westfiled"]) {
    assert.equal(resolve({ locationRaw: raw }).canonical, null, `${raw} should not resolve`);
  }
});

test("the four reviewed Phase 1 fuzzy candidates are now approved aliases", () => {
  assert.equal(resolve({ locationRaw: "Silverburn" }).canonical, "Glasgow – Silverburn");
  assert.equal(resolve({ locationRaw: "Stratford" }).canonical, "Westfield – Stratford");
  assert.equal(resolve({ locationRaw: "stratford" }).canonical, "Westfield – Stratford");
  assert.equal(resolve({ locationRaw: "Trafford" }).canonical, "Manchester – Trafford Centre");
});

test("Item 5 is not a site", () => {
  assert.ok(NOT_A_SITE.has("Item 5"));
  assert.equal(resolve({ locationRaw: "Item 5" }).canonical, null);
});

test("a stage group is never read as a place", () => {
  for (const title of ["Needs attention", "Jobs Booked", "On Hold", "International"]) {
    assert.equal(isSiteGroup(title), false, title);
  }
  // The monthly family is matched by shape: September appeared on the live
  // board after the repository's August capture.
  for (const title of ["September  2026 Recently completed", "August  2026 Recently completed", "January 2027 Recently completed"]) {
    assert.equal(isSiteGroup(title), false, title);
  }
  assert.equal(isSiteGroup("Bullring completed"), true);
  assert.equal(isSiteGroup("Nottingham complited"), true);
});

test("every register entry has a unique canonical name and site code", () => {
  const names = SITE_REGISTER.map((s) => s.canonical);
  assert.equal(new Set(names).size, names.length, "duplicate canonical name");
  const codes = SITE_REGISTER.map((s) => siteCode(s.canonical));
  assert.equal(new Set(codes).size, codes.length, "duplicate site code");
});

test("no alias maps to two different sites", () => {
  const seen = new Map();
  for (const entry of SITE_REGISTER) {
    for (const alias of [entry.canonical, ...entry.aliases]) {
      const key = normalise(alias);
      if (seen.has(key)) {
        assert.equal(seen.get(key), entry.canonical, `alias ${alias} claimed by two sites`);
      }
      seen.set(key, entry.canonical);
    }
  }
});

/* ── Job titles ──────────────────────────────────────────────────────────── */

test("rule 1 is site and label", () => {
  const result = jobTitle({ site: "Watford – Atria", label: "Lights" });
  assert.deepEqual(result, { title: "Watford – Atria — Lights", rule: 1 });
});

test("rule 2 is site and description, cut at 60 characters", () => {
  const result = jobTitle({ site: "Watford – Atria", description: "x".repeat(200) });
  assert.equal(result.rule, 2);
  assert.equal(result.title, `Watford – Atria — ${"x".repeat(60)}`);
});

test("rule 3 is the raw location when no site resolved", () => {
  const result = jobTitle({ locationRaw: "Unit 7, somewhere", description: "Shelf broken" });
  assert.deepEqual(result, { title: "Unit 7, somewhere — Shelf broken", rule: 3 });
});

test("rule 4 uses the description alone", () => {
  // The Phase 2 addition. Live item 3036314710 has description "Open the old
  // safe" and label "Other" but no site and no Location, so under the brief's
  // original rules nothing reached its description at all.
  const result = jobTitle({ description: "Open the old safe" });
  assert.deepEqual(result, { title: "Open the old safe", rule: 4 });
});

test("rule 5 needs a real source number", () => {
  assert.deepEqual(jobTitle({ sourceNumber: "418" }), { title: "Job 418", rule: 5 });
});

test("a blank source number falls through to the item id, never to 'Job '", () => {
  // Both items that reached the brief's last resort had no Number. "Job " is a
  // blank title on a NOT NULL column.
  const result = jobTitle({ sourceNumber: "   ", sourceItemId: "3083903723" });
  assert.deepEqual(result, { title: "Monday Job 3083903723", rule: 6 });
});

test("no combination of inputs produces a blank title", () => {
  const cases = [
    {}, { site: "" }, { description: "   " }, { label: "  ", description: "" },
    { sourceNumber: "", sourceItemId: "1" }, { locationRaw: "  ", description: "  " },
  ];
  for (const input of cases) {
    const { title } = jobTitle({ sourceItemId: "1", ...input });
    assert.ok(title.trim().length > 0, `blank title for ${JSON.stringify(input)}`);
  }
});

test("whitespace-only description is not content", () => {
  const result = jobTitle({ site: "Watford – Atria", description: "   \n  ", sourceItemId: "9" });
  assert.equal(result.rule, 6, "falls past rules 2, 3 and 4");
  assert.equal(result.title, "Monday Job 9");
});

/* ── Field rules ─────────────────────────────────────────────────────────── */

test("Plummer is stored as Plumber with the raw value preserved", () => {
  const result = engineerValue("Plummer");
  assert.equal(result.value, "Plumber");
  assert.equal(result.raw, "Plummer");
  assert.equal(result.corrected, true);
});

test("an engineer monday spells correctly is left alone", () => {
  const result = engineerValue("Electrician");
  assert.equal(result.value, "Electrician");
  assert.equal(result.corrected, false);
});

test("a blank label is null, never an empty category", () => {
  assert.equal(blankToNull(""), null);
  assert.equal(blankToNull("   "), null);
  assert.equal(blankToNull("Lights"), "Lights");
});

test("tier text becomes a number", () => {
  assert.equal(tierNumber("Tier 3"), 3);
  assert.equal(tierNumber(""), null);
  assert.equal(tierNumber("unknown"), null);
});

test("zero cost and no cost are different", () => {
  assert.equal(costValue("0"), 0);
  assert.equal(costValue(""), null);
  assert.equal(costValue("   "), null);
});

test("currency formatting does not break the cost sum", () => {
  assert.equal(costValue("£1,250.50"), 1250.5);
  assert.equal(costValue("1250.5"), 1250.5);
});

test("costs sum to the penny", () => {
  // The reconciliation is exact, so the parser has to be.
  const cells = ["£1,000.01", "0", "2.02", "", "  ", "£3.00"];
  const total = cells.map(costValue).filter((c) => c !== null).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(total * 100) / 100, 1005.03);
});

test("a timeline contributes its end date", () => {
  // An ISO date carries the same hyphen the range uses, so splitting on "-"
  // yields six fragments ending in "03" — which is what the first version of
  // timelineEnd wrote, and would have put into every due date.
  assert.equal(timelineEnd("2026-01-01 - 2026-02-03"), "2026-02-03");
  assert.equal(timelineEnd("2026-01-01 – 2026-02-03"), "2026-02-03");
  assert.equal(timelineEnd("2026-02-03"), "2026-02-03");
  assert.equal(timelineEnd(""), null);
});

test("stage comes from the group, then from a done status", () => {
  assert.equal(stageFor({ groupStageKey: "Booked", status: "Job Completed" }), "Booked");
  assert.equal(stageFor({ status: "Job Completed" }), "Completed");
  assert.equal(stageFor({ status: "Waiting for parts" }), "Incoming");
  assert.equal(stageFor({ status: "Waiting for parts", completedAt: "2026-01-01" }), "Completed");
});

/* ── Documents and compliance ────────────────────────────────────────────── */

test("the two suspicious documents may not stand as evidence", () => {
  assert.equal(isVerifiableEvidence("RAMS Watfrod Atria .docx"), false);
  assert.equal(isVerifiableEvidence("Water_Hygiene_and_Legionella_Risk_Assessment_Meadowhall.docx"), false);
  assert.equal(SUSPICIOUS_ASSET_NAMES.get("RAMS Watfrod Atria .docx").suggests, "Watford – Atria");
});

test("an ordinary certificate is verifiable evidence", () => {
  assert.equal(isVerifiableEvidence("PAT Aldgate 2026.pdf"), true);
});

test("certificate and expiry is confirmed evidence", () => {
  const state = complianceState({ slot: "pat", hasCertificate: true, expiry: "2027-01-01", today: "2026-09-09" });
  assert.equal(state.status, "Valid");
  assert.equal(state.confirmed, true);
  assert.equal(state.flag, null);
});

test("an expiry already past reads Expired, not Valid", () => {
  const state = complianceState({ slot: "fire-alarm", hasCertificate: true, expiry: "2026-06-24", today: "2026-09-09" });
  assert.equal(state.status, "Expired");
});

test("an expiry with no certificate keeps the due date and flags the gap", () => {
  const state = complianceState({ slot: "pat", hasCertificate: false, expiry: "2027-01-01", today: "2026-09-09" });
  assert.equal(state.flag, "certificate-missing");
  assert.equal(state.confirmed, false);
});

test("a certificate with no expiry flags a missing review date, unless the slot is undated", () => {
  assert.equal(complianceState({ slot: "pat", hasCertificate: true, expiry: null }).flag, "expiry-missing");
  // RAMS, Fire Risk Assessment and Drawing have no expiry column on the board.
  for (const slot of UNDATED_SLOTS) {
    assert.equal(complianceState({ slot, hasCertificate: true, expiry: null }).flag, null, slot);
  }
});

test("neither certificate nor expiry is responsibility not confirmed", () => {
  const state = complianceState({ slot: "fire-door", hasCertificate: false, expiry: null });
  assert.equal(state.flag, "responsibility-unconfirmed");
  assert.equal(state.confirmed, false);
});

test("sprinkler with no evidence is never auto-assigned", () => {
  assert.ok(NEVER_AUTO_ASSIGNED.has("sprinkler"));
  const state = complianceState({ slot: "sprinkler", hasCertificate: false, expiry: "2027-01-01" });
  assert.equal(state.flag, "responsibility-unconfirmed");
  assert.equal(state.confirmed, false);
});

test("PLI is organisation-level, so it is not a per-site gap", () => {
  assert.ok(ORGANISATION_LEVEL_SLOTS.has("pli"));
  assert.equal(ORGANISATION_LEVEL_SLOTS.has("pat"), false);
});

test("every Store Documentation file column maps to a compliance slot", () => {
  assert.equal(STORE_DOC_FILE_COLUMNS.size, 12);
  const slots = [...STORE_DOC_FILE_COLUMNS.values()].map((v) => v.slot);
  assert.equal(new Set(slots).size, 12, "two columns claim one slot");
  for (const slot of [...UNDATED_SLOTS, ...NEVER_AUTO_ASSIGNED, ...ORGANISATION_LEVEL_SLOTS]) {
    assert.ok(slots.includes(slot), `${slot} is not a known slot`);
  }
});

test("every Maintenance file column maps to an attachment kind", () => {
  assert.deepEqual(
    [...MAINTENANCE_FILE_COLUMNS.values()].map((v) => v.kind).sort(),
    ["completion", "general", "issue"],
  );
});

/* ── Normalisation ───────────────────────────────────────────────────────── */

test("an en dash and a hyphen are the same character", () => {
  assert.equal(normalise("Aldgate – Whitechapel Road"), normalise("Aldgate - Whitechapel Road"));
});

test("the group suffix strips monday's typo as well as the correct spelling", () => {
  assert.equal(stripGroupSuffix("Nottingham complited"), "Nottingham");
  assert.equal(stripGroupSuffix("Bullring completed"), "Bullring");
});

test("a site code is stable and derived, so a re-import finds the same site", () => {
  assert.equal(siteCode("Cardiff – Grand Arcade"), siteCode("Cardiff – Grand Arcade"));
  assert.equal(siteCode("Cardiff – Grand Arcade"), "mnd-cardiff-grand-arcade");
});
