import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import ts from "typescript";

/**
 * W06-13 — THE CONTRACTOR SUMMARY: what a contractor drawer opens on.
 *
 * The drawer used to be one long scroll that began with a stat grid. Everything
 * the register HOLDS about a contractor — who to ring, whether they are on the
 * register, what they cover, whether their insurance is in date, what was
 * agreed — was reachable only through the edit form, and some of it through
 * nothing at all. The Summary is the read-only answer, and it is the first of
 * five tabbed views.
 *
 * ── The four things this suite actually protects ───────────────────────────
 *
 * 1. AGREED TERMS ARE NOT SPEND. The rate card and the spend figure now sit on
 *    one screen a few hundred pixels apart, which is the adjacency that invites
 *    somebody to total them. `day_rate_pence` and its three siblings are what
 *    was AGREED; without days worked, hours worked or call-outs used, a total
 *    of them is not a summary of cost, it is an invented number. So the tests
 *    below read the summary line by line and fail on any line that both names a
 *    rate and adds, reduces, totals or calls it spend.
 *
 * 2. WHATSAPP IS NEVER THE TELEPHONE. `wa.me` addresses people by full
 *    international number and answers a national one — `07812 224644`, the
 *    shape every number on a van is written in — with "the phone number shared
 *    via url is invalid". `whatsapp_number` is a separate column for that
 *    reason, `app/lib/contact-links.ts` refuses to guess a country code, and
 *    the summary reaches both only through `ContractorContact`.
 *
 * 3. `active` AND `availability` ARE TWO COLUMNS. A screenshot once proved what
 *    merging them costs: re-ticking "Active" writes only `active`, so an
 *    un-archived contractor keeps the `Inactive` availability the archive verb
 *    left behind, and the line read "Inactive" beside a ticked, saved box. Rows
 *    written before `contractorResurrectionRefusal` still carry that pair.
 *
 * 4. THE WORK FIGURES ARE THE PAGE'S ATTRIBUTION, CARRIED. The id-first rule in
 *    `app/lib/contractor-attribution.ts` is applied once, by the Contractors
 *    page; a panel with a second copy would be a second answer to "whose job
 *    was that", which is the exact failure W06-12 found in
 *    `ContractorScorecard`. A rename must not move a penny of it.
 *
 * ── How it is written ──────────────────────────────────────────────────────
 *
 * Three kinds of test, in three sections.
 *
 *   SOURCE      — the render contract. The summary is TSX and cannot be
 *                 mounted here, so what a section is GATED on is asserted
 *                 against the source, with comments excluded so that a
 *                 sentence explaining a rule cannot be mistaken for the rule.
 *   REPLAY      — `contractor-attribution.ts` is a pure module with no React
 *                 and no database in it, so the rename invariant is proved by
 *                 RUNNING it, transpiled to a data: URL exactly as
 *                 tests/workstream-six-reports-attribution.test.mjs does.
 *   SERVER      — what the summary's gates actually receive. A section that
 *                 renders "only when it has data" is only as good as the
 *                 payload, so a rich contractor and an empty one are created
 *                 through the real API and read back through /api/workspace.
 *                 Skips cleanly when no server answers.
 *
 * FIXTURES ARE REMOVED BY EXACT PRIMARY KEY, never by a name substring. This
 * repository's notes record a substring sweep repeatedly eating other agents'
 * rows, and the development database is shared with them; `ZZQA-W6-*` and
 * `w6contractor-*` rows belong to other suites and are not touched here.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(root + file, "utf8")).replace(/\r\n/g, "\n");

/** Comments are where the reasoning lives; assertions about CODE ignore them. */
function codeOnly(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*")
      );
    })
    .join("\n");
}

const SUMMARY = "app/(app)/portal/contractor-summary.tsx";
const PROFILE = "app/(app)/portal/contractor-profile.tsx";

/* ═══════════════════════════════════════════════════════════════════════════
   SOURCE — the render contract
   ═══════════════════════════════════════════════════════════════════════════ */

test("the drawer opens on the Summary, and it is the first of five views", async () => {
  const profile = await read(PROFILE);

  assert.match(
    profile,
    /const TABS = \["Summary", "Details", "Sites", "Documents", "Jobs"\] as const;/,
    "five views, Summary first",
  );
  assert.match(
    profile,
    /useState<\(typeof TABS\)\[number\]>\("Summary"\)/,
    "and the drawer opens on it",
  );

  /*
   * THE STRIP IS THE SHARED TAB COMPONENT, not a `<nav>` of plain buttons.
   *
   * `sites/section-tabs.tsx` is the WAI-ARIA tabs contract in full —
   * `aria-controls` on every tab, `role="tabpanel"` and `aria-labelledby` on
   * every panel, a roving tabindex so the whole strip is ONE tab stop, and
   * Arrow/Home/End moving selection with focus. The item drawer's own
   * `.detail-drawer__tabs` declares `role="tablist"` nowhere and implements
   * none of it; a third copy of that would have been a third strip that
   * announces itself as a tablist and behaves like separate buttons.
   */
  assert.match(
    profile,
    /import \{ SectionPanel, SectionTabs \} from "\.\/sites\/section-tabs";/,
    "the tab pattern is imported, not approximated",
  );
  for (const section of ["Summary", "Details", "Sites", "Documents", "Jobs"]) {
    assert.match(
      profile,
      new RegExp(`section="${section}"[\\s\\S]{0,120}?active=\\{tab === "${section}"\\}`),
      `${section} has a panel bound to the tab`,
    );
  }

  // And the summary is handed the two counts the drawer already fetched, not
  // left to fetch them again from a panel that may never be mounted.
  assert.match(profile, /documentsHeld=\{documentsHeld\}/);
  assert.match(profile, /sitesLinked=\{sitesLinked\}/);
});

test("every optional section is gated on having data", async () => {
  const summary = codeOnly(await read(SUMMARY));

  /*
   * FOUR GATES, ONE PER OPTIONAL GROUP. A card whose every row is null must not
   * render at all: a grid of em dashes is not a summary, it is the edit form
   * with the boxes taken away, and it reads as a screen that failed to load.
   */
  assert.match(summary, /\{hasContact && \(/, "Reach them is gated");
  assert.match(summary, /\{hasServices && \(/, "Services & coverage is gated");
  assert.match(summary, /\{hasCompliance && \(/, "Compliance is gated");
  assert.match(summary, /\{hasTerms && \(/, "Agreed commercial terms is gated");

  // Each gate is a presence test over the fields that group actually shows.
  assert.match(summary, /text\(contractor\.phone\) \|\|\s*\n?\s*text\(contractor\.whatsappNumber\)/);
  assert.match(summary, /const hasServices = trades\.length > 0 \|\| areas\.length > 0;/);
  assert.match(
    summary,
    /insuranceExpiry \|\| insurer \|\| certifications\.length \|\| certificationNames\.length/,
  );

  /*
   * AND THE ROW HELPER REFUSES AN EMPTY VALUE, so a group that renders cannot
   * carry a blank row inside it. This is the whole rule in one line.
   */
  assert.match(
    summary,
    /if \(!when \|\| children === null \|\| children === undefined \|\| children === ""\) return null;/,
    "an empty row is not drawn",
  );
  assert.match(summary, /if \(!agreed\(pence\)\) return null;/, "and neither is an unagreed rate");

  /*
   * STATUS AND PERFORMANCE ARE THE TWO THAT ALWAYS RENDER, deliberately:
   * `active` and `availability` are NOT NULL columns, and a contractor with no
   * work in the window has zeroes rather than an absence — "we use them and
   * they did nothing this quarter" is an answer.
   */
  assert.doesNotMatch(summary, /\{hasStatus && \(/);
  assert.doesNotMatch(summary, /\{hasPerformance && \(/);
});

test("what is not recorded is one quiet line, not four empty cards", async () => {
  const summary = await read(SUMMARY);

  assert.match(
    summary,
    /const missing = \[\s*\n\s*hasContact \? null : "contact details",/,
    "the gaps are collected rather than each drawn as a card",
  );
  assert.match(
    summary,
    /\{missing\.length > 0 && \(\s*\n\s*<p className="analytics-empty contractor-summary__missing">/,
    "and said once, as a paragraph",
  );
  // A paragraph, and never a section: the closing line must not become a sixth
  // card with a heading of its own.
  assert.doesNotMatch(
    codeOnly(summary),
    /<section[^>]*>\s*\n?\s*\{missing/,
    "the empty state is not a card",
  );

  /*
   * QUIET IN THE STYLESHEET TOO. `.analytics-empty` is the platform's own
   * "nothing here" paragraph; the summary adds nothing to it but a margin. A
   * border, a ground or a minimum height would make an absence look like a
   * warning, and this line is a fact about the register rather than a fault.
   */
  const css = (await read("app/brand-overrides.css"));
  const rule = css.slice(css.indexOf(".contractor-summary__missing {"));
  const block = rule.slice(0, rule.indexOf("}"));
  assert.match(block, /margin: 0;/);
  for (const property of ["border", "background", "min-height", "padding"]) {
    assert.doesNotMatch(block, new RegExp(`${property}:`), `${property} would make it a block`);
  }
});

test("WhatsApp is the WhatsApp column, and is never inferred from the telephone", async () => {
  const summary = codeOnly(await read(SUMMARY));

  /*
   * THE SUMMARY BUILDS NO CONTACT HREF OF ITS OWN. One component owns the rule,
   * over one helper, because the second copy is where a `wa.me` link gets built
   * out of a national number.
   */
  assert.match(summary, /<ContractorContact contractor=\{contractor\} \/>/);
  for (const forbidden of [/wa\.me/, /whatsappHref/, /telHref/, /mailto:/, /"tel:/]) {
    assert.doesNotMatch(summary, forbidden, "the summary must not build a contact link itself");
  }

  /*
   * AND THE COMPONENT IT DELEGATES TO STILL REFUSES TO GUESS. `whatsappHref`
   * returns null rather than inventing a country code, and null there means
   * PLAIN TEXT — the number stays readable and dialable by hand, it simply is
   * not dressed up as an action that would dead-end.
   */
  const contact = await read("app/(app)/portal/contractor-contact.tsx");
  assert.match(contact, /const chat = whatsappHref\(whatsapp\);/);
  assert.match(contact, /const whatsapp = \(contractor\.whatsappNumber \?\? ""\)\.trim\(\);/);
  assert.doesNotMatch(
    codeOnly(contact),
    /whatsappHref\(\s*(contractor\.)?phone/,
    "the phone number is never handed to the WhatsApp rule",
  );

  const links = await read("app/lib/contact-links.ts");
  assert.match(
    links,
    /if \(digits\.startsWith\("0"\)\) \{[\s\S]{0,400}?return null;/,
    "a national number resolves to no WhatsApp link at all",
  );
});

test("the register state and availability are two rows, and the screen says why", async () => {
  const summary = await read(SUMMARY);

  // Two rows, two labels — never one joined sentence.
  assert.match(summary, /<ContractorRow label="On the register">/);
  assert.match(summary, /<ContractorRow label="Availability" when=\{Boolean\(availability\)\}>/);
  assert.ok(
    summary.indexOf('label="On the register"') < summary.indexOf('label="Availability"'),
    "the record state leads; availability is the qualifier, not the headline",
  );

  // The canonical flag decides the first row, and nothing else may.
  assert.match(
    summary,
    /\{contractor\.active \? \(\s*\n\s*<span className="contractor-summary__state is-active">Active<\/span>/,
  );
  assert.match(summary, /<span className="contractor-archived-chip">\s*\n\s*Archived/);
  assert.match(
    summary,
    /— off the register; this is not their availability/,
    "and a screen reader is told the difference, not left to infer it from layout",
  );

  // Said out loud on the screen as well, because the two words look alike.
  assert.match(
    summary,
    /Two different facts\. The register state says whether/,
    "the summary states that these are two different claims",
  );

  /*
   * THE DRAWER HEADER NO LONGER JOINS THEM. It used to print
   * `{availability}{active ? "" : " · archived"}`, which is the exact merge the
   * register's own subtitle was rewritten to stop. The archived flag stays in
   * the header because it must be visible on every tab; the availability word
   * does not, because it belongs beside its label.
   */
  const profile = codeOnly(await read(PROFILE));
  assert.doesNotMatch(
    profile,
    /\{contractor\.availability \|\| "Availability not recorded"\}/,
    "the header must not print availability as the drawer's state line",
  );
  assert.match(profile, /Contractor\s*\n\s*\{contractor\.active \? "" : " · archived"\}/);
});

test("agreed terms are listed one by one, never totalled, and never called spend", async () => {
  const summary = await read(SUMMARY);
  const code = codeOnly(summary);

  // The heading itself carries the distinction, because the spend figure is a
  // few hundred pixels below it.
  assert.match(summary, /<h3>Agreed commercial terms<\/h3>/);
  assert.match(
    summary,
    /Agreed reference terms, not money spent\./,
    "and the sentence under it says so in words",
  );

  /*
   * NO ARITHMETIC OVER A RATE, ANYWHERE. Read line by line rather than as one
   * blob, so that a rate named in one paragraph and a total named in the next
   * cannot fail the test, and so that the failure message can name the line.
   */
  const RATES = ["dayRatePence", "hourlyRatePence", "callOutCostPence", "otherCostPence"];
  for (const line of code.split("\n")) {
    if (!RATES.some((field) => line.includes(field))) continue;
    assert.doesNotMatch(
      line,
      /\+|reduce\(|\btotal\b|\bsum\b/i,
      `an agreed rate is being combined: ${line.trim()}`,
    );
    assert.doesNotMatch(
      line,
      /spend/i,
      `an agreed rate is being presented as spend: ${line.trim()}`,
    );
  }

  /*
   * THE PRESENCE TEST IS A PRESENCE TEST. `agreed()` exists so that the only
   * expression in the file holding more than one rate at a time is a chain of
   * `||`, which cannot become a total by accident.
   */
  assert.match(
    code,
    /function agreed\(pence: number \| null \| undefined\): boolean \{\s*\n\s*return pence !== null && pence !== undefined;/,
  );

  /*
   * AND THE UNITS CANNOT BE CROSSED. Rates are integer pence; job cost is a
   * `real` in POUNDS — monday's "Cost of Works" column, the one place in this
   * product money is not an integer of pence. £450.00 of day rate through the
   * pounds formatter prints £45,000, and £585 of spend through the pence one
   * prints £5.85, so the two formatters are named for the unit they take.
   */
  assert.match(code, /import \{ formatMoney as formatAgreedRate \} from "\.\/sites\/site-types";/);
  assert.match(code, /<strong>\{formatAgreedRate\(pence\)\}<\/strong>/);
  assert.match(code, /function spendInPounds\(value: number\)/);
  assert.match(code, /<strong>\{spendInPounds\(performance\.spend\)\}<\/strong>/);

  /*
   * THE ATTRIBUTION MODULE IS STILL BLIND TO RATES, which is the structural
   * half of the same guarantee: every function there takes
   * `MaintenanceRequest[]`, which has no rate field to reach.
   */
  const attribution = await read("app/lib/contractor-attribution.ts");
  for (const field of RATES) {
    assert.doesNotMatch(
      codeOnly(attribution),
      new RegExp(field),
      "the attribution rule must never so much as name a rate column",
    );
  }
});

test("the performance figures are the page's attribution, carried and not recomputed", async () => {
  const summary = codeOnly(await read(SUMMARY));
  const profile = codeOnly(await read(PROFILE));
  const app = await read("app/(app)/portal/portal-app.tsx");

  // The rule is applied ONCE, on the page, by the shared helper.
  assert.match(app, /const attribution = attributeContractorWork\(scopedRequests, roster\);/);
  assert.match(
    app,
    /spend: theirs\.reduce\(\(sum, request\) => sum \+ \(request\.cost \?\? 0\), 0\),/,
    "spend is recorded job cost over the attributed rows, and nothing else",
  );

  // Handed down, unchanged, through the drawer to the summary.
  assert.match(profile, /performance=\{performance\}/);
  assert.match(summary, /performance: SummaryPerformance;/);

  // And neither surface re-derives it. Either copy would be a second answer to
  // "whose job was that" — the failure W06-12 found in ContractorScorecard.
  for (const source of [summary, profile]) {
    assert.doesNotMatch(source, /attributeContractorWork/);
    assert.doesNotMatch(source, /contractorId === /);
    assert.doesNotMatch(source, /request\.contractor ===/);
  }

  /*
   * THE BASIS SENTENCE IS THE SHARED ONE. It says the two things the figure
   * cannot: that this is recorded job cost rather than an invoiced or paid
   * amount, and which operational date decided the window. Typed into the panel
   * it would drift; imported, it cannot.
   */
  assert.match(summary, /contractorSpendBasisNote\(CONTRACTOR_SPEND_BASIS\.completed\)/);
  assert.match(summary, /<span className="drawer-label">Attributed spend<\/span>/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   REPLAY — the rename invariant, by running the rule
   ═══════════════════════════════════════════════════════════════════════════ */

const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const asModule = (js) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;

const { attributeContractorWork, contractorJobCost } = await import(
  asModule(transpile(await read("app/lib/contractor-attribution.ts")))
);

test("a renamed contractor keeps every penny of their attributed spend", () => {
  const contractorId = "contractor-zzqa-summary-replay";
  /*
   * The job records the name it was GIVEN, and that text is history: a rename
   * does not rewrite it, and must not need to. The reference is what says whose
   * job it was.
   */
  const jobs = [
    { contractorId, contractor: "ZZQA-SUMMARY Before", cost: 250, priority: "Urgent" },
    { contractorId, contractor: "ZZQA-SUMMARY Before", cost: 335, priority: "Normal" },
  ];

  const before = attributeContractorWork(jobs, [
    { id: contractorId, name: "ZZQA-SUMMARY Before" },
  ]);
  assert.equal(before.byRoster[0].jobs.length, 2);
  assert.equal(contractorJobCost(before.byRoster[0].jobs), 585);

  // The rename. Only the ROSTER row changes; the two jobs are untouched.
  const afterRename = attributeContractorWork(jobs, [
    { id: contractorId, name: "ZZQA-SUMMARY After" },
  ]);
  assert.equal(afterRename.byRoster[0].jobs.length, 2, "the jobs stay with the contractor");
  assert.equal(
    contractorJobCost(afterRename.byRoster[0].jobs),
    585,
    "and so does the money the summary prints beside them",
  );
  assert.deepEqual(afterRename.unattributed, [], "nothing is orphaned by a rename");

  /*
   * THE COUNTERFACTUAL, so this test fails if the rule ever goes back to
   * matching text. Keyed on the name, the rename loses both jobs and the whole
   * £585 — measured on the running product before W06-12, where the register
   * showed a renamed contractor holding £250 that the Reports scorecard printed
   * against a name appearing on no register row at all.
   */
  const byNameOnly = jobs.filter((job) => job.contractor === "ZZQA-SUMMARY After");
  assert.equal(byNameOnly.length, 0, "the old name-matching rule would have dropped them");
});

test("a job carrying no id still reaches its contractor, and an ambiguous name reaches nobody", () => {
  /*
   * The other half of the same rule, because the summary shows a number that
   * has to be able to say what it left out. A name TWO register rows answer to
   * is attributed to NEITHER: an under-count is visible and fixable, while a
   * double count silently inflates money somebody bills from.
   */
  const unlinked = [{ contractorId: null, contractor: "ZZQA-SUMMARY Solo", cost: 40 }];
  const solo = attributeContractorWork(unlinked, [{ id: "c-solo", name: "ZZQA-SUMMARY Solo" }]);
  assert.equal(contractorJobCost(solo.byRoster[0].jobs), 40, "a unique name still counts");

  const ambiguous = attributeContractorWork(unlinked, [
    { id: "c-one", name: "ZZQA-SUMMARY Solo" },
    { id: "c-two", name: "ZZQA-SUMMARY Solo" },
  ]);
  assert.equal(contractorJobCost(ambiguous.byRoster[0].jobs), 0);
  assert.equal(contractorJobCost(ambiguous.byRoster[1].jobs), 0);
  assert.equal(ambiguous.unattributed.length, 1, "and the job is surfaced, not discarded");
});

/* ═══════════════════════════════════════════════════════════════════════════
   SERVER — what the summary's gates actually receive
   ═══════════════════════════════════════════════════════════════════════════ */

const CANDIDATES = process.env.MAINTSUPP_BASE_URL
  ? [process.env.MAINTSUPP_BASE_URL]
  : [5173, 5174, 5175, 3000].map((port) => `http://localhost:${port}`);
let BASE_URL = CANDIDATES[0];
const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/**
 * The marker every fixture carries.
 *
 * Run-scoped, because the workspace API has no hard delete for a contractor —
 * `DELETE` archives the row — so a fixed prefix would leave a second row of the
 * same name behind on the next run, and two register rows sharing one name is
 * precisely the ambiguity `resolveContractorLink` refuses to guess between.
 * Cleanup is nevertheless BY PRIMARY KEY; the prefix is for a human reading the
 * register, not for the sweep.
 */
const RUN = `ZZQA-SUMMARY-${Date.now().toString(36)}`;

const createdContractors = [];
const createdRequests = [];

let cookie = null;
async function signIn() {
  if (cookie !== null) return cookie;
  cookie = "";
  for (const candidate of CANDIDATES) {
    try {
      const response = await fetch(`${candidate}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      BASE_URL = candidate;
      cookie = (response.headers.getSetCookie?.() ?? [])
        .map((raw) => raw.split(";")[0])
        .join("; ");
      if (cookie) return cookie;
    } catch {
      // Next candidate.
    }
  }
  return cookie;
}

async function call(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie: cookie ?? "",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

const contractorNamed = async (id) =>
  ((await call("GET", "/api/workspace")).body?.workspace?.contractors ?? []).find(
    (row) => row.id === id,
  );

async function makeContractor(data) {
  const created = await call("POST", "/api/workspace", { entity: "contractor", data });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  createdContractors.push(created.body.id);
  return created.body.id;
}

async function openDevDatabase() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const directory = new URL("../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/", import.meta.url);
  let file;
  try {
    file = (await readdir(directory)).find(
      (entry) => entry.endsWith(".sqlite") && entry !== "metadata.sqlite",
    );
  } catch {
    return null;
  }
  if (!file) return null;
  try {
    // `fileURLToPath`, not `URL.pathname`: this repository's path has a space
    // in it, and a percent-encoded path opens nothing.
    const db = new DatabaseSync(fileURLToPath(new URL(file, directory)));
    // The dev server holds this file open; an unqualified write loses the race.
    db.exec("PRAGMA busy_timeout = 15000");
    return db;
  } catch {
    return null;
  }
}

test("an empty contractor gives every optional section nothing to render", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }

  const id = await makeContractor({ name: `${RUN}-sparse` });
  const row = await contractorNamed(id);
  assert.ok(row, "the fixture is on the register");

  /*
   * EVERY GATE THE SUMMARY READS, ANSWERED "NOTHING" BY THE REAL API. The
   * source test above proves the sections are gated; this proves the gates are
   * gated on values the payload actually sends, so a field quietly dropped from
   * /api/workspace would fail here rather than emptying a card in silence.
   */
  for (const field of ["phone", "whatsappNumber", "email", "contactName"]) {
    assert.equal(row[field], null, `${field} is empty, so "Reach them" cannot render`);
  }
  assert.deepEqual(row.serviceCategories, []);
  assert.deepEqual(row.coverageAreas, []);
  assert.deepEqual(row.certificationEntries ?? [], []);
  assert.deepEqual(row.certifications, []);
  assert.equal(row.insuranceExpiry, null);
  assert.equal(row.insurerName, null);
  for (const field of [
    "dayRatePence",
    "hourlyRatePence",
    "callOutCostPence",
    "otherCostPence",
    "paymentTerms",
    "financeReference",
  ]) {
    assert.equal(row[field], null, `${field} is not agreed, so no rate row can render`);
  }

  /*
   * AND THE TWO THAT ALWAYS RENDER STILL HAVE SOMETHING TO SAY. `active` and
   * `availability` are NOT NULL columns with defaults, so the Status card is
   * never the empty one — which is why it is not behind a gate.
   */
  assert.equal(row.active, true);
  assert.equal(row.availability, "Available");
  assert.equal(typeof row.assignedJobs, "number");
  assert.equal(typeof row.spend, "number");

  /*
   * The insurance STATE is still sent, and it is `not-recorded` rather than
   * absent. The summary draws the chip only where there is a DATE behind it:
   * printing "Not recorded" as a status chip would dress an absence up as a
   * verdict somebody reached.
   */
  assert.equal(row.insuranceState, "not-recorded");
});

test("a filled contractor gives every section real data, derived where it should be", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }

  const id = await makeContractor({
    name: `${RUN}-rich`,
    contactName: "ZZQA Summary Contact",
    email: "zzqa-summary@example.com",
    phone: "+44 20 7946 0958",
    /* A SEPARATE number, and deliberately not the one above. */
    whatsappNumber: "+44 7700 900123",
    serviceCategories: ["Electrical"],
    coverageAreas: ["UK"],
    insurerName: "ZZQA Summary Mutual",
    policyNumber: "ZZQA-POL-1",
    insuranceExpiry: "2027-06-30",
    dayRatePence: 45000,
    hourlyRatePence: 6500,
    callOutCostPence: 9500,
    otherCostPence: 2000,
    otherCostLabel: "Congestion charge",
    paymentTerms: "30 days",
    financeReference: "ZZQA-SUP-1",
  });

  const row = await contractorNamed(id);
  assert.ok(row);
  assert.equal(row.phone, "+44 20 7946 0958");
  assert.equal(row.whatsappNumber, "+44 7700 900123");
  assert.notEqual(row.whatsappNumber, row.phone, "the two numbers are two columns");
  assert.deepEqual(row.serviceCategories, ["Electrical"]);
  assert.deepEqual(row.coverageAreas, ["UK"]);
  assert.equal(row.insurerName, "ZZQA Summary Mutual");
  assert.equal(row.dayRatePence, 45000);
  assert.equal(row.otherCostLabel, "Congestion charge");
  assert.equal(row.paymentTerms, "30 days");
  assert.equal(row.financeReference, "ZZQA-SUP-1");

  /*
   * THE STATUS IS DERIVED ON READ AND IS NOT A STORED WORD. 2027-06-30 is more
   * than the platform's 60 days away, so it is `valid` — and it is the server
   * that says so, using the one classifier, which is why the summary carries
   * the label rather than working one out for itself.
   */
  assert.equal(row.insuranceState, "valid");
  assert.equal(row.insuranceStatusLabel, "Valid");

  // The rate card is four separate figures. Nothing on the payload totals them,
  // and the spend beside them is its own field, unrelated and zero.
  assert.equal(row.spend, 0, "an agreed rate is not spend");
  assert.equal(
    row.dayRatePence + row.hourlyRatePence + row.callOutCostPence + row.otherCostPence,
    63000,
    "the arithmetic is possible, which is exactly why no screen may do it",
  );
});

test("a rename moves the name and nothing else the summary prints", async (t) => {
  if (!(await signIn())) {
    t.skip("no development server");
    return;
  }
  const stores = (await call("GET", "/api/workspace")).body?.workspace?.stores ?? [];
  if (!stores.length) {
    t.skip("no site to raise a job against");
    return;
  }

  const name = `${RUN}-rename`;
  const id = await makeContractor({ name });

  const raised = await call("POST", "/api/maintenance", {
    location: stores[0].name,
    requester: RUN,
    contact: "zzqa-summary@example.com",
    description: `${RUN} contractor summary fixture, safe to delete.`,
    category: "Electrical",
    priority: "Urgent",
  });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  const requestId = raised.body.request.id;
  createdRequests.push(requestId);

  // The one assignment surface. It has to write the reference, not only text.
  const assigned = await call("PATCH", "/api/maintenance", {
    id: requestId,
    fields: { contractor: name, cost: 250 },
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));

  const before = await contractorNamed(id);
  assert.equal(before.spend, 250, "the job's cost is attributed to them");
  assert.equal(before.assignedJobs, 1);
  assert.equal(before.urgentJobs, 1);

  const renamed = await call("PATCH", "/api/workspace", {
    entity: "contractor",
    id,
    data: { name: `${name}-RENAMED` },
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  const after = await contractorNamed(id);
  assert.equal(after.name, `${name}-RENAMED`, "the rename happened");
  assert.deepEqual(
    { spend: after.spend, assigned: after.assignedJobs, urgent: after.urgentJobs },
    { spend: 250, assigned: 1, urgent: 1 },
    "the summary's Performance card must survive a rename intact",
  );
});

/**
 * Cleanup, by exact primary key, with the result asserted.
 *
 * NEVER BY SUBSTRING. The development database is shared with the other
 * workstream-six suites and with whatever else is running; a `LIKE 'ZZQA%'`
 * sweep here has eaten other agents' fixtures before. Every id below was
 * returned by the API call that created the row.
 *
 * One transaction rather than a dozen statements: `node --test` runs files in
 * parallel and each separate delete takes its own write lock, which is a window
 * in which somebody else's request gets "database is locked".
 */
after(async () => {
  if (!createdContractors.length && !createdRequests.length) return;
  const db = await openDevDatabase();
  assert.ok(db, "fixture cleanup could not open the development database");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of createdRequests) {
        // The rows a job acquires on its way onto the board, by its own id.
        db.prepare("DELETE FROM maintenance_board_cells WHERE request_id = ?").run(id);
        db.prepare("DELETE FROM maintenance_group_items WHERE request_id = ?").run(id);
        db.prepare("DELETE FROM attachments WHERE request_id = ?").run(id);
        db.prepare("DELETE FROM maintenance_requests WHERE id = ?").run(id);
        db.prepare("DELETE FROM activity_log WHERE entity_id = ?").run(id);
        db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
      }
      for (const id of createdContractors) {
        db.prepare("DELETE FROM contractor_sites WHERE contractor_id = ?").run(id);
        db.prepare("DELETE FROM contractor_certifications WHERE contractor_id = ?").run(id);
        db.prepare("DELETE FROM contractors WHERE id = ?").run(id);
        db.prepare("DELETE FROM activity_log WHERE entity_id = ?").run(id);
        db.prepare("DELETE FROM audit_events WHERE entity_id = ?").run(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const residue = [];
    const check = (kind, table, ids) => {
      for (const id of ids) {
        if (db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)) {
          residue.push(`${kind} ${id}`);
        }
      }
    };
    check("contractor", "contractors", createdContractors);
    check("request", "maintenance_requests", createdRequests);
    assert.deepEqual(residue, [], `fixtures survived cleanup: ${residue.join(", ")}`);
  } finally {
    try {
      db.close();
    } catch {
      // The handle is going out of scope regardless.
    }
  }
});
