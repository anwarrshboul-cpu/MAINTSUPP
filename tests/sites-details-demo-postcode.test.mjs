/**
 * 2F, 2G, 2H — DEMO SITES, THE MISSING-DETAILS LIST, AND POSTCODES.
 *
 * Three small items that share one property: each of them was a NUMBER on a
 * screen with no way to act on it.
 *
 *   2G — "22 of 74 sites have incomplete details" and no way to see which. A
 *        count somebody cannot act on is a count that reads the same in a year.
 *   2F — no demo flag exists on `sites` at all, so a demonstration store and a
 *        real one were indistinguishable everywhere.
 *   2H — `siteCompleteness` chases a postcode and nothing anywhere said what a
 *        postcode looked like, so the field could be filled with anything and
 *        the count would go quiet. Measured on Staging's Demo Client: all twelve
 *        sites carry `postcode: null`.
 *
 * GEOCODING IS OUT OF SCOPE AND UNCONFIGURED. Swept `app/`, `db/`, `worker/`,
 * `docs/` and `package.json`: no provider of any kind. `uk-postcode.ts` says so
 * in its header and this suite pins that it does not quietly grow one.
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

/** Source with comments removed, for any assertion about an ABSENCE. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* Both modules import nothing, which is what lets them be handed straight to
   `import()` — and is itself the contract that keeps them usable from a client
   component. */
const postcodeSource = await read("app/lib/uk-postcode.ts");
const demoSource = await read("app/lib/demo-sites.ts");
const postcode = await import(asModule(transpile(postcodeSource)));
const demo = await import(asModule(transpile(demoSource)));

const sitesRoute = await read("app/api/sites/route.ts");
const sitesList = await read("app/(app)/portal/ops/sites-list.tsx");
const siteForm = await read("app/(app)/portal/sites/site-form.tsx");
const formField = await read("app/(app)/portal/sites/form-field.tsx");

/* ── 2H. Postcodes ────────────────────────────────────────────────────────── */

test("a real postcode is recognised however it was typed", () => {
  /* The five shapes a UK postcode comes in, one example of each, then the same
     five typed the way people actually type them. */
  for (const [typed, canonical] of [
    ["SW1A 1AA", "SW1A 1AA"],
    ["sw1a1aa", "SW1A 1AA"],
    ["  sw1a  1aa  ", "SW1A 1AA"],
    ["M1 1AE", "M1 1AE"],
    ["m11ae", "M1 1AE"],
    ["B33 8TH", "B33 8TH"],
    ["CR2 6XH", "CR2 6XH"],
    ["DN55 1PT", "DN55 1PT"],
    ["dn55-1pt", "DN55 1PT"],
  ]) {
    assert.ok(postcode.isValidUkPostcode(typed), `${typed} is a postcode`);
    assert.equal(postcode.formatUkPostcode(typed), canonical);
  }
});

test("the space goes back from the RIGHT, which is why no branch is needed", () => {
  /*
   * The inward code is exactly three characters in every UK postcode there has
   * ever been; the outward code is two to four. Splitting from the left needs
   * to know which, splitting from the right never does — so "M1 1AE" and
   * "DN55 1PT" take the identical path.
   */
  assert.equal(postcode.formatUkPostcode("m11ae").indexOf(" "), 2);
  assert.equal(postcode.formatUkPostcode("dn551pt").indexOf(" "), 4);
  assert.match(code(postcodeSource), /stripped\.slice\(0, -3\)/);
});

test("the excluded letters are what make a typo refusable", () => {
  /*
   * Royal Mail leaves C, I, K, M, O and V out of the final pair because those
   * are the ones that misread. It is the single most useful part of the
   * pattern: without it "SW1A 1AO" is indistinguishable from "SW1A 1AA".
   */
  for (const letter of ["C", "I", "K", "M", "O", "V"]) {
    assert.equal(
      postcode.isValidUkPostcode(`SW1A 1A${letter}`),
      false,
      `1A${letter} must be refused`,
    );
  }
  assert.ok(postcode.isValidUkPostcode("SW1A 1AA"));
});

test("nonsense is refused and the message says what to type", () => {
  for (const junk of ["", "   ", "12345", "NOTAPOSTCODE", "SW1A", "1AA", "ABCDEF"]) {
    assert.equal(postcode.isValidUkPostcode(junk), false, `${JSON.stringify(junk)}`);
  }
  const check = postcode.checkPostcode("NOTAPOSTCODE");
  /* Names the shape rather than saying "invalid". "Invalid" tells somebody they
     are wrong; an example tells them what to type. */
  assert.match(check.problem, /SW1A 1AA/);
});

test("an unrecognised postcode is kept exactly as typed, never mangled or emptied", () => {
  /*
   * This product has sites outside the UK — Staging holds a Europe reporting
   * group — and a normaliser that silently discarded an overseas postal code
   * would be a data loss dressed as a tidy-up.
   */
  assert.equal(postcode.formatUkPostcode("75008"), "75008", "a Paris code survives");
  assert.equal(postcode.formatUkPostcode("  1012 AB  "), "1012 AB", "trimmed, not changed");
  assert.equal(postcode.checkPostcode("75008").value, "75008");
});

test("an empty postcode is not an error, because it must not block a save", () => {
  /*
   * A postcode is a detail `siteCompleteness` chases, not a precondition for
   * recording that a store exists. Refusing the save would make this form
   * harder to finish than the spreadsheet it replaces, and the missing-details
   * list is the mechanism that already exists for chasing it.
   */
  const check = postcode.checkPostcode("   ");
  assert.equal(check.problem, null);
  assert.equal(check.value, "");
});

test("GIR 0AA is real and the general pattern cannot express it", () => {
  assert.ok(postcode.isValidUkPostcode("GIR 0AA"), "the Girobank code is still issued");
  assert.equal(postcode.formatUkPostcode("gir0aa"), "GIR 0AA");
});

test("the outward code is available, because it is all that grouping can use", () => {
  assert.equal(postcode.postcodeOutwardCode("SW1A 1AA"), "SW1A");
  assert.equal(postcode.postcodeOutwardCode("m11ae"), "M1");
  /* A guess would be worse than nothing here. */
  assert.equal(postcode.postcodeOutwardCode("75008"), null);
});

test("nothing in this module geocodes, and nothing in it grew a provider", () => {
  /*
   * BLOCKED, and stated rather than worked around. There is no geocoding
   * service configured anywhere in this product; inventing one — or adding a
   * credential for one — is not something a postcode helper gets to do.
   */
  for (const forbidden of [
    /mapbox/i,
    /nominatim/i,
    /opencage/i,
    /postcodes\.io/i,
    /googleapis/i,
    /geocod/i,
    /fetch\(/,
  ]) {
    assert.doesNotMatch(code(postcodeSource), forbidden, `${forbidden} must not appear`);
  }
});

test("the postcode is canonicalised on the ONE path both writes share", () => {
  /*
   * `sitePayload` serves POST and PATCH. Normalising in either handler instead
   * would let the column hold "m1 1ae" from one screen and "M1 1AE" from the
   * other, which is the same defect at half the size.
   */
  const payload = sitesRoute.slice(
    sitesRoute.indexOf("function sitePayload"),
    sitesRoute.indexOf("function sitePayload") + 2600,
  );
  assert.match(payload, /formatUkPostcode\(String\(data\.postcode\)\)/);
  /* Absent and blank must stay different — clearing a postcode still clears it. */
  assert.match(payload, /data\.postcode === undefined \|\| data\.postcode === null/);
});

test("the form advises and does not block, and says so before you get it wrong", () => {
  assert.match(siteForm, /import \{ checkPostcode \} from "\.\.\/\.\.\/\.\.\/lib\/uk-postcode"/);
  assert.match(siteForm, /problem=\{checkPostcode\(form\.postcode\)\.problem\}/);
  /* On blur, not on change: rewriting a value on every keystroke fights the
     person typing it. */
  assert.match(siteForm, /onBlur=\{\(\) => set\("postcode"\)\(checkPostcode\(form\.postcode\)\.value\)\}/);
  /* The rule is on screen before it is broken. */
  assert.match(siteForm, /hint="Tidied to the standard spelling/);
});

/* ── 2K. The message is reachable and announced ───────────────────────────── */

test("a field's problem is announced, not merely coloured", () => {
  /*
   * Colour alone carries no meaning to a screen reader and none to somebody who
   * cannot distinguish amber from grey. The message is wired into
   * `aria-describedby` ALONGSIDE the hint — not instead of it, so the rule and
   * the problem arrive in one pass — and the control is marked invalid.
   */
  assert.match(formField, /aria-invalid=\{problem \? true : undefined\}/);
  assert.match(formField, /const describedBy = \[hintId, problemId\]\.filter\(Boolean\)\.join\(" "\) \|\| undefined/);
  assert.match(formField, /role="status"/);
});

test("an empty aria-describedby is never emitted", () => {
  /* Some readers announce a description that points at nothing. */
  assert.match(formField, /\|\| undefined;/);
});

test("the problem style carries weight as well as colour", async () => {
  const css = await read("app/globals.css");
  const rule = css.slice(css.indexOf(".form-hint--problem"), css.indexOf(".form-hint--problem") + 160);
  assert.match(rule, /font-weight/, "colour must never be the only carrier");
  /* Amber, not red: this does not block the save, and red would say it did. */
  assert.match(rule, /--warn/);
});

/* ── 2F. Demo sites ───────────────────────────────────────────────────────── */

test("the fixtures already on Staging are recognised without any data entry", () => {
  /* Measured 2026-09-10: twelve sites named "ZZ-DEMO — <place>" with codes
     ZZD-S01..S12, in org_...0002. */
  assert.ok(demo.isDemoSite({ name: "ZZ-DEMO — Manchester Arndale", code: "ZZD-S01" }));
  assert.ok(demo.isDemoSite({ name: "zz-demo — leeds trinity" }), "case does not matter");
  assert.ok(demo.isDemoSite({ name: "Somewhere", code: "ZZD-S07" }), "the code alone is enough");
});

test("a real client site can never be promoted to demo by the convention", () => {
  /*
   * THE STANDING INSTRUCTION THIS IS BUILT AROUND. The fallback matches a
   * prefix no retailer puts on a store front, and it is READ-ONLY — nothing in
   * this module writes anything.
   */
  for (const real of [
    { name: "Westfield Stratford", code: "WS01" },
    { name: "Touchwood - Solihull", code: "TS02" },
    { name: "Demo Street Store", code: "DEM1" },
    { name: "Grand Arcade - Cardiff" },
    { name: "" },
    {},
  ]) {
    assert.equal(demo.isDemoSite(real), false, JSON.stringify(real));
  }
  assert.doesNotMatch(code(demoSource), /insert|update|delete/i, "this module writes nothing");
});

test("group membership is the authoritative mechanism, and it is deliberate", () => {
  /*
   * A reserved slug on a table that already exists, already has an API and
   * already renders. Somebody has to put a store in a group called Demo;
   * nothing does it silently, and removing it from the group undoes it.
   */
  assert.equal(demo.DEMO_GROUP_SLUG, "demo");
  assert.ok(demo.isDemoSite({ name: "Westfield Stratford", groupSlugs: ["demo"] }));
  assert.ok(demo.isDemoSite({ name: "Westfield Stratford", groupSlugs: ["DEMO", "north"] }));
  assert.equal(demo.isDemoSite({ name: "Westfield Stratford", groupSlugs: ["north"] }), false);
});

test("demo sites are SHOWN unless somebody asks otherwise", () => {
  /*
   * A list that silently omits rows while the meters above it still count them
   * is a page contradicting itself, and the contradiction is the part nobody
   * notices.
   */
  assert.equal(demo.parseDemoFilter(null), "all");
  assert.equal(demo.parseDemoFilter(""), "all");
  assert.equal(demo.parseDemoFilter("nonsense"), "all");
  assert.equal(demo.parseDemoFilter("hide"), "hide");
  assert.equal(demo.parseDemoFilter("only"), "only");

  const rows = [
    { name: "ZZ-DEMO — Leeds Trinity" },
    { name: "Westfield Stratford" },
  ];
  assert.equal(demo.applyDemoFilter(rows, "all").length, 2);
  assert.equal(demo.applyDemoFilter(rows, "hide")[0].name, "Westfield Stratford");
  assert.equal(demo.applyDemoFilter(rows, "only")[0].name, "ZZ-DEMO — Leeds Trinity");
});

test("the server decides which sites are demo, and the list never recomputes it", () => {
  /*
   * Two screens disagreeing about which stores are real is a worse failure than
   * either answer, because the disagreement is what nobody notices. The route
   * sends the field; the list reads it.
   */
  assert.match(sitesRoute, /demo: isDemoSite\(\{ name: row\.name, code: row\.code \}\)/);
  assert.match(sitesList, /import \{ parseDemoFilter \} from "\.\.\/\.\.\/\.\.\/lib\/demo-sites"/);
  assert.doesNotMatch(code(sitesList), /isDemoSite\(/, "the list must not have a second opinion");
});

test("a demo site is labelled rather than removed from the totals", () => {
  /* It has jobs and a compliance profile like any other site and contributes to
     every meter; what it must never do is be mistaken for a real one. */
  assert.match(sitesList, />\s*Demo\s*<\/StatusChip>/, "the chip prints the word");
  assert.match(sitesList, /A demonstration store, not a real one/);
});

/* ── 2G. The missing-details list ─────────────────────────────────────────── */

test("the incomplete count is a control now, not a sentence", () => {
  const band = sitesList.slice(sitesList.indexOf("coverage.incomplete > 0"));
  assert.match(band.slice(0, 2000), /aria-pressed=\{details === "incomplete"\}/);
  assert.match(band.slice(0, 2000), /setValue\("details", details === "incomplete" \? "" : "incomplete", ""\)/);
});

test("the filter is in the URL, so 'the seven with no postcode' is a link", () => {
  assert.match(sitesList, /"details",/);
  assert.match(sitesList, /const details = params\.get\("details"\)/);
  assert.match(sitesList, /if \(details === "incomplete" &&/);
});

test("a missing `completeness` is treated as COMPLETE, never as incomplete", () => {
  /*
   * A payload that does not carry the field is not evidence that anything is
   * missing. Guessing the other way would fill this list with every site the
   * moment the field was dropped, which is a very loud way to be wrong.
   */
  assert.match(sitesList, /\(site\.completeness\?\.missing\.length \?\? 0\) === 0/);
});

test("both new filters can be seen and removed like every other one", () => {
  /* A filter with no chip is a list that is lying about what it contains, and
     the only cure is reloading the page. */
  assert.match(sitesList, /key: "details",\s*\n\s*label: "Details"/);
  assert.match(sitesList, /key: "demo",\s*\n\s*label: "Demo sites"/);
  /* And `Clear all` must clear them, which means being in FILTER_KEYS. */
  const keys = sitesList.slice(sitesList.indexOf("const FILTER_KEYS"), sitesList.indexOf("] as const;"));
  assert.match(keys, /"details"/);
  assert.match(keys, /"demo"/);
});

/* ── 2I. The capability split, verified rather than changed ───────────────── */

test("a site is archived, never purged, and the reason is on the function", () => {
  /*
   * Jobs, compliance documents and assets all reference the site; deleting the
   * row would orphan legally significant records. So there is no purge path for
   * a site at all — which is how this product honours the `data.delete` split:
   * not by gating a destructive endpoint, but by not having one.
   *
   * Pinned so that if a purge is ever added, this test is what makes somebody
   * decide which capability it belongs behind.
   */
  assert.match(sitesRoute, /Sites are archived, never deleted/);
  const del = sitesRoute.slice(sitesRoute.indexOf("export async function DELETE"));
  assert.match(del, /scopedDbWithCapability\(request, "sites\.edit"\)/);
  assert.match(del, /lifecycle: "Closed"/);
  assert.doesNotMatch(code(del), /\.delete\(sites\)/, "DELETE must not delete a site row");
  assert.doesNotMatch(code(sitesRoute), /"data\.delete"/, "no purge path exists to gate");
});
