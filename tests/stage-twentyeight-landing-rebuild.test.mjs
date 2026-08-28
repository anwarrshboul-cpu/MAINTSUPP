/**
 * Stage 28 — the landing page rebuild, checked against the brief's own audit.
 *
 * The brief ends with a six-point audit to run before finishing. This file is
 * that audit, written down so it runs on every commit rather than once. Its
 * source assertions read the components; its live assertions drive a real
 * browser and skip when nothing is listening on the dev server.
 *
 * WHY A SEPARATE FILE. `stage-eleven-marketing` covers the porting rules that
 * predate the rebuild — no iframe, copy ported not rewritten, legal pages
 * reachable. Those are still true and still worth holding. What is here is the
 * new contract: ten sections, four validated behaviours and the anchors that
 * tie them together.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/* ── 1. Ten sections, each exactly once ──────────────────────────────────── */

/** The ten, by the anchor each one owns. Section 10 is a band plus a panel. */
const ANCHORS = [
  "hero",
  "report",
  "sectors",
  "services",
  "problem",
  "how",
  "pricing",
  "case-study",
  "portal",
  "trust",
  "review",
];

test("the page is eleven sections, in the v2 order, each exactly once", async () => {
  /*
   * Was ten. The v2 positioning edit moved Report a Job from second to fourth
   * and added "Who runs Maintsupp" between the case study and the portal.
   *
   * The order is asserted, not just the count: the whole point of the edit was
   * the sequence — who it is for, what it covers, then the form — and a count
   * alone would pass just as happily with the form back at the top.
   */
  const page = await read("app/(marketing)/page.tsx");
  const rendered = [...page.slice(page.indexOf("HomePage")).matchAll(/<([A-Z][A-Za-z]*)\s*\/>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(rendered, [
    "Hero",
    "WhoWeHelp",
    "Services",
    "ReportJob",
    "Problem",
    "HowItWorks",
    "Pricing",
    "CaseStudy",
    "Founder",
    "Portal",
    "TrustStrip",
    "FinalCta",
  ], "eleven sections; the last is two components — a dark band and the form beneath it");
  assert.equal(new Set(rendered).size, rendered.length, "each exactly once");
});

/* ── 2. Copy rules ───────────────────────────────────────────────────────── */

test("the forbidden claims appear nowhere on the marketing site", async () => {
  /*
   * The brief lists six phrases that must never be used, and the reason is not
   * squeamishness: Maintsupp does not employ engineers, so "our engineers" is a
   * statement a client could hold them to. Checked across every section, the
   * legal pages and the shared copy — a rule enforced in one file is a rule
   * that moves to another file.
   */
  const forbidden = [
    /\bour engineers\b/i,
    /\bour nationwide team\b/i,
    /24\/7 coverage/i,
    /guaranteed same-day fix/i,
    /100% first-time fix/i,
    /\bwe certify\b/i,
  ];
  const dir = path.join(root, "app/(marketing)");
  const offenders = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|ts)$/.test(entry.name)) {
        const source = readFileSync(full);
        for (const pattern of forbidden) {
          if (pattern.test(source)) {
            offenders.push(`${path.relative(root, full)} — ${pattern}`);
          }
        }
      }
    }
  };
  const { readFileSync } = await import("node:fs");
  walk(dir);
  assert.deepEqual(offenders, [], "the brief forbids these phrases");
});

test("every price is shown + VAT", async () => {
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  // Each of the four money figures outside the tier cards carries it inline;
  // the per-store figures carry it in the shared price line.
  assert.match(pricing, /\+ VAT/, "the price line must say + VAT");
  for (const figure of ["£295/month", "£65 each", "£125 per incident", "£25/store"]) {
    const at = pricing.indexOf(figure);
    assert.ok(at > 0, `${figure} is missing`);
    assert.match(
      pricing.slice(at, at + 60),
      /\+ VAT/,
      `${figure} must be followed by "+ VAT"`,
    );
  }
});

test("the Total Care saving is derived from the prices above it", async () => {
  /*
   * "Most popular — save £20 per store" is true at both numbered bands, and it
   * is computed rather than typed so it cannot come to contradict the cards.
   * The arithmetic is checked here against the same table the component uses.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  const bands = [...pricing.matchAll(
    /coordination: (\d+), compliance: (\d+), total: (\d+)/g,
  )].map(([, coordination, compliance, total]) => ({
    coordination: Number(coordination),
    compliance: Number(compliance),
    total: Number(total),
  }));

  /*
   * Three numbered bands now, not two: 26+ used to be a "Custom" card with a
   * button and carries a published rate. The approved figures, pinned here so
   * a price cannot drift silently — they are quoted to clients.
   */
  assert.deepEqual(bands, [
    { coordination: 65, compliance: 55, total: 100 },
    { coordination: 58, compliance: 48, total: 88 },
    { coordination: 52, compliance: 42, total: 78 },
  ]);

  /* The badge claims a saving per band; each band's cards must produce it. */
  assert.deepEqual(
    bands.map((band) => band.coordination + band.compliance - band.total),
    [20, 18, 16],
  );
  assert.match(pricing, /save £\{saving\} per store/, "the badge must read the computed figure");
  assert.match(
    pricing,
    /const saving = band\.coordination \+ band\.compliance - band\.total/,
    "and must derive it from the band on screen rather than a typed number",
  );
});

test("the store count drives the band, the rate and the monthly total", async () => {
  /*
   * The calculator is the section's one input. If any of these stops being
   * derived, the page can show a reader a rate their own store count does not
   * qualify for — which is worse than showing no calculator at all.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  assert.match(pricing, /type="range"/, "there is a real slider, not a band picker alone");
  assert.match(pricing, /function bandForCount/, "the band is computed from the count");
  assert.match(
    pricing,
    /amount \* storeCount/,
    "the monthly total is rate x count, not a typed figure",
  );
  /* The struck-through price is the entry band's, so it cannot contradict it. */
  assert.match(pricing, /was=\{entryBand\[plan\.key\]\}/);
  assert.match(pricing, /was > amount/, "and only shows once the reader is past that band");
});

/*
 * The phone presentation of the same section.
 *
 * Three plan cards stacked ran to 2294px at 390 and 2510px at 320 — more than
 * the whole desktop section — and answered no comparison question, because a
 * reader had to hold one card's feature list in their head while scrolling to
 * the next. Below 768px the section renders a comparison matrix instead.
 *
 * The danger in a second presentation is a second copy of the facts, so these
 * tests hold the opposite: one data table, two renderings, and nothing that
 * only one of them knows.
 */

/** Every feature the cards listed before the matrix existed, in order. */
const CARD_FEATURES = {
  coordination: [
    "Intake & triage",
    "Contractor assignment",
    "Quote control",
    "Attendance chasing",
    "Photo-verified close-out",
    "Monthly report",
  ],
  compliance: [
    "Certificate register",
    "90/60/30-day reminders",
    "Provider booking",
    "Certificate chasing",
    "Remedial tracking",
    "Traffic-light compliance dashboard",
  ],
  total: ["Quarterly portfolio review"],
};

test("every feature the cards listed still exists, once, in the shared table", async () => {
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  const table = pricing.slice(pricing.indexOf("const FEATURES"), pricing.indexOf("/** Whether `plan`"));
  const rows = [...table.matchAll(/\{ label: "([^"]+)", plan: "(\w+)" \}/g)].map(
    ([, label, plan]) => ({ label, plan }),
  );

  for (const [plan, labels] of Object.entries(CARD_FEATURES)) {
    assert.deepEqual(
      rows.filter((row) => row.plan === plan).map((row) => row.label),
      labels,
      `${plan} lost or reordered a feature`,
    );
  }
  assert.equal(rows.length, 13, "a feature was added or dropped without this test moving");

  /* No label may be typed twice — that is the defect a second presentation
     invites, and it is what would let the card and the matrix disagree. */
  assert.equal(new Set(rows.map((r) => r.label)).size, rows.length);
});

test("both presentations render from that table, not from copies of it", async () => {
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");

  /* The card's bullets are derived, including Total Care's summary lines. */
  assert.match(pricing, /cardPoints\(plan\)\.map\(/, "the card must render derived points");
  assert.match(
    pricing,
    /`Everything in \$\{titleOf\(key\)\}`/,
    "Total Care's roll-up wording must be built from the plan titles, not typed",
  );
  /* The matrix enumerates the same table. */
  assert.match(pricing, /FEATURES\.map\(\(feature\)/, "the matrix must render every feature row");
  assert.match(pricing, /planHas\(plan, feature\)/, "and decide each tick from the same data");
  /* Prices in both come from the band on screen. */
  assert.match(pricing, /const amount = band\[plan\.key\]/);

  /* One price table. Outside BANDS and the footnote list, no £ figure may be
     typed into the markup — a second one is how a matrix comes to quote a
     price the cards no longer charge. */
  const body = pricing
    .slice(pricing.indexOf("export function Pricing"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const literals = [...body.matchAll(/£(\d[\d,]*)/g)].map((m) => m[0]);
  assert.deepEqual(
    literals,
    ["£295", "£65", "£125"],
    `only the three footnote figures may be typed; found ${literals.join(", ")}`,
  );
});

test("the matrix says what is included in words, never in colour alone", async () => {
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  assert.match(pricing, /<span className="vh">Included<\/span>/, "a tick needs a name");
  assert.match(
    pricing,
    /function NotIncluded\(\{ label = "Not included" \}/,
    "an excluded cell needs a name too",
  );
  assert.match(pricing, /<span className="pmx__no" aria-hidden="true">/, "and a glyph, not a tint");

  /* It is a real table: a row header and a column header per cell. */
  assert.match(pricing, /<th\s+scope="col"/);
  assert.match(pricing, /<th scope="row">/);
  assert.match(pricing, /<caption className="vh">/, "the table must name itself");
});

test("the matrix scrolls inside its own box, and the page never does", async () => {
  const css = await read("app/(marketing)/marketing.css");
  const block = css.slice(css.indexOf(".pmx{display:none}"));
  assert.ok(block.length > 0, "the matrix styles have been removed");

  const scroll = block.slice(block.indexOf(".pmx__scroll{"), block.indexOf(".pmx__table{"));
  assert.match(scroll, /overflow-x:auto/);
  assert.match(
    scroll,
    /contain:paint/,
    "without it the table's width reaches the document and the whole page slides sideways at 320",
  );

  /* Sized so 375, 390 and 430 need no sideways scroll at all. */
  assert.match(block, /\.pmx__table\{[^}]*min-width:340px/);
  /* The feature column stays named while the plans pass under it. */
  assert.match(block, /th\[scope=row\]\{width:29%;position:sticky;left:0/);

  /* The two presentations swap; neither is hidden to shorten the page. */
  assert.match(block, /@media \(max-width:767px\)\{\s*\.pkgs\{display:none\}\s*\.pmx\{display:block\}/);
});

test("the matrix cells do not hyphenate", async () => {
  /*
   * `hyphens:auto` was tried here and removed after QA on the deployed
   * preview: the cells that carry a sentence rather than a label rendered
   * "Reactive re-pairs, run end to end" and "Certificates tracked be-fore
   * they expire" at 430 and below, which reads as a typo in a pricing table.
   *
   * `overflow-wrap:break-word` stays and covers the only thing hyphenation
   * was needed for — stopping a long word overflowing its column. Verified in
   * Chromium at 430/390/375/360/320: no cell overflows its box, and the only
   * breaks that are not at a space are two compound labels at 375 breaking at
   * their OWN hyphen ("Photo-" / "verified", "90/60/30-" / "day"), which is
   * correct typography rather than an inserted hyphen.
   *
   * Widening the feature column to make even those fit was measured and
   * rejected: at 30% the plan names stop fitting, which trades a correct
   * hyphen break for an incorrect mid-word one ("Administratio/n").
   */
  const css = await read("app/(marketing)/marketing.css");
  const block = css.slice(css.indexOf(".pmx{display:none}"));
  const cellRule = block.slice(block.indexOf(".pmx__table th,.pmx__table td{"));

  assert.doesNotMatch(
    cellRule.slice(0, cellRule.indexOf("}") + 1),
    /hyphens/,
    "the matrix cells must not hyphenate — see the note above this rule",
  );
  assert.match(cellRule.slice(0, cellRule.indexOf("}") + 1), /overflow-wrap:break-word/);
  assert.match(
    block,
    /No `hyphens:auto` here, deliberately/,
    "the reason must stay recorded, or the next person reads it as an accidental deletion",
  );
  /* The row header's `hyphens:manual` is a different rule and still correct:
     it wraps on spaces and on its own punctuation, never on an inserted
     hyphen. */
  assert.match(block, /th\[scope=row\]\{[^}]*hyphens:manual/);
});

test("the page's vertical rhythm is a scale, not thirty typed numbers", async () => {
  const css = await read("app/(marketing)/marketing.css");
  /* Both ends of the scale, pinned. The desktop values are the ones that
     took 615px off 1440 and 489px off 1024: the section band came down from
     7.2vw/108px to 5vw/76px, and the block and step gaps from 30/26 to 26/22.
     They are held here because the next person to "just nudge one section"
     should have to change the scale instead. */
  assert.match(css, /--section-y:clamp\(50px,5vw,76px\)/, "the desktop section band");
  assert.match(css, /--gap-block:26px;--gap-step:22px;--gap-card:14px;--gap-pad:22px/);
  assert.match(
    css,
    /--section-y:clamp\(40px,8vw,56px\);--gap-block:20px;--gap-step:18px;--gap-card:10px;--gap-pad:16px/,
    "the phone step sizes must narrow together, in one place",
  );
  /* Dead space, not a gap: a trailing paragraph's bottom margin sat against
     the section's own padding at every width. */
  assert.match(css, /\.section > \.wrap > \*:last-child\{margin-bottom:0\}/);
  /* The blocks that used to carry their own 26/30px must read the scale. */
  for (const rule of [
    /\.whogrid\{[^}]*margin-top:var\(--gap-block\)/,
    /* Was `.offergrid`. The five services are one ruled register now, not a
       card grid, but the block it sits in still has to read the scale. */
    /\.svclist\{[^}]*margin-top:var\(--gap-block\)/,
    /\.pricing__plans\{margin-top:var\(--gap-step\)\}/,
    /\.pkgfoot\{[^}]*margin-top:var\(--gap-step\)/,
    /\.whocard__body\{padding:calc\(var\(--gap-pad\) - 2px\)/,
  ]) {
    assert.match(css, rule, `${rule} no longer reads the spacing scale`);
  }
});

test("What we offer still carries all five services, word for word", async () => {
  /*
   * THE RISK THIS CLOSES. "What we offer" was five cards in an auto-fit grid;
   * it is now one ruled register, because five cards laid out four-plus-one and
   * padded the four short ones out to the height of the long one. A layout edit
   * like that is exactly the kind of change under which a sentence quietly goes
   * missing — the Compliance body is the longest on the page, and shortening it
   * is the easiest way to make any grid look tidier.
   *
   * So the copy is pinned here in full, not by title and not by prefix. These
   * are claims about who does the inspections; they may be re-laid-out freely
   * and may not be trimmed, summarised or reworded without editing this list.
   */
  const source = await read("app/(marketing)/_sections/services.tsx");
  const services = [
    [
      "Reactive Maintenance Coordination",
      "Intake, triage, contractor assignment, quote control, attendance chasing and verified close-out.",
    ],
    [
      "Planned Maintenance (PPM)",
      "Recurring service schedules, work orders, attendance monitoring and follow-up actions.",
    ],
    [
      "Compliance Administration",
      "Certificate register, due-date reminders, provider booking, document chasing and remedial tracking. Inspections and certificates are carried out by competent certified providers.",
    ],
    [
      "Projects & Store Works",
      "Kiosk moves, refreshes, signage and multi-trade works, each separately scoped and quoted.",
    ],
    [
      "Reporting & Visibility",
      "Monthly KPI, spend, ageing and compliance reporting across the portfolio.",
    ],
  ];
  for (const [title, body] of services) {
    assert.ok(source.includes(`title: "${title}"`), `the ${title} service is gone`);
    assert.ok(source.includes(`body: "${body}"`), `the ${title} body has been altered or trimmed`);
  }
  assert.equal(
    [...source.matchAll(/^\s{4}title: "/gm)].length,
    services.length,
    "five services, no more and no fewer — a sixth would need a row here too",
  );

  /*
   * And the semantics the register is built on. `list-style:none` costs a <ul>
   * its list role in Safari, so the explicit role is what keeps "list, 5 items"
   * being announced; the headings are what keep the five services reachable by
   * heading navigation, which the cards' <h3>s used to provide.
   */
  assert.match(source, /<ul className="svclist reveal" role="list">/);
  assert.match(source, /<h3 className="svclist__term">/);
  assert.match(source, /<p className="svclist__def">\{service\.body\}<\/p>/);
});

/* ── 3. The Report a Job form ────────────────────────────────────────────── */

test("the form asks the brief's eleven questions, in order", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  const order = [
    "rjSite",
    "rjName",
    "rjPhone",
    "rjEmail",
    "rjAddress",
    "rjPostcode",
    "rjCategory",
    "rjUrgency",
    "rjDesc",
    "rjUpload",
    "rjAccess",
  ];
  const positions = order.map((id) => ({ id, at: form.indexOf(`id="${id}"`) }));
  for (const { id, at } of positions) assert.ok(at > 0, `${id} is missing from the form`);
  const sorted = [...positions].sort((a, b) => a.at - b.at).map((entry) => entry.id);
  assert.deepEqual(sorted, order, "the fields must appear in the brief's order");
});

test("the required fields are validated, and the access window stays optional", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  const checks = form.slice(form.indexOf("const CHECKS"), form.indexOf("type FieldValue"));
  for (const id of [
    "rjSite",
    "rjName",
    "rjPhone",
    "rjEmail",
    "rjAddress",
    "rjPostcode",
    "rjCategory",
    "rjUrgency",
    /*
     * The description joined them: the approved reference marks it required,
     * because a coordinator triaging "P1, Electrical, Oxford Street" with no
     * sentence has to ring the store back before choosing a trade.
     */
    "rjDesc",
  ]) {
    assert.match(checks, new RegExp(`"${id}"`), `${id} must be required`);
  }
  /* The access window is the one field a reporter may genuinely not know. */
  assert.doesNotMatch(checks, /"rjAccess"/, "the access window stays optional");
});

test("evidence is required, and checked outside CHECKS because it is not a field", async () => {
  /*
   * The files live in component state, not in a form control, so the rule
   * cannot sit in CHECKS with the others — but it must run in the same pass,
   * or somebody missing both a description and a photograph is told about one,
   * fixes it, and is then told about the other.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(form, /if \(picked\.length === 0\) \{\s*found\.rjUpload =/);
  assert.match(form, /Add at least one photo or video/);
  assert.match(form, /\{filesError \|\| errors\.rjUpload\}/, "and it is shown in the upload block");
});

test("the urgency chips promise no response time", async () => {
  /*
   * THIS ASSERTION IS THE REVERSE OF THE ONE IT REPLACES.
   *
   * The chips used to print "Within 4 hrs", "Next working day" and so on,
   * added under an earlier brief. The v2 positioning brief withdraws them: no
   * response-time or SLA commitment may appear anywhere on the page, and its
   * audit tests for absence rather than merely forbidding new ones.
   *
   * The P-codes stay. A code classifies how bad the fault is — something the
   * reporter can answer and triage needs. A response time is a promise about
   * what happens next, and that is the part that was withdrawn.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");

  for (const code of ["P1", "P2", "P3", "P4"]) {
    assert.match(form, new RegExp(`code: "${code}"`), `${code} is still offered`);
  }
  assert.match(form, /P1 — Critical, site unsafe or cannot trade/);

  assert.ok(!form.includes("chip__sla"), "the SLA line is no longer rendered");
  assert.ok(!/sla:/.test(form), "and the field is gone, so it cannot be rendered again");

  /* Comments stripped: the note recording why the promises went quotes them,
     and a check that fails on its own rationale would push the reasoning out
     of the file to make the test pass. */
  const rendered = form.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const promise of ["Within 4 hrs", "Next working day", "5 working days"]) {
    assert.ok(!rendered.includes(promise), `response time still present: ${promise}`);
  }
});

test("every invalid field is reported at once, not one at a time", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(
    form,
    /const \[errors, setErrors\] = useState<Record<string, string>>\(\{\}\)/,
    "a map, not a single field — the brief asks for an error on every one",
  );
  assert.match(form, /const found: Record<string, string> = \{\};/);
  assert.match(form, /if \(message\) found\[name\] = message;/, "collect, do not return early");
  assert.match(form, /scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.match(form, /focus\(\{ preventScroll: true \}\)/, "scroll first, then focus");
});

test("the form posts to a route a logged-out visitor may actually use", async () => {
  /*
   * THE BUG THIS REPLACES. The form posted to `/api/maintenance`, which
   * requires the `board.edit` capability. Every visitor to a marketing page is
   * logged out by definition, so every submission came back
   * `401 Your session has ended. Sign in to continue.` — the form has never
   * once worked, and the failure looked like a session problem rather than a
   * missing endpoint.
   *
   * The fix is NOT to loosen `/api/maintenance`: that would make every board in
   * every tenant writable by anyone who could guess a payload. It is a separate
   * public route with its tenant pinned.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(form, /fetch\("\/api\/report-job"/, "the public route, not the operator one");
  assert.doesNotMatch(
    form,
    /fetch\("\/api\/maintenance"/,
    "/api/maintenance requires board.edit and a visitor has none",
  );

  const route = await read("app/api/report-job/route.ts");
  assert.match(route, /allowAnonymous: true/, "a visitor has no session");
  assert.match(
    route,
    /const orgId = PRIMARY_ORGANISATION_ID/,
    "the tenant is pinned, never taken from the payload or a cookie",
  );
  assert.doesNotMatch(
    route,
    /payload\.(organisationId|orgId|tenant)/,
    "no request may steer a job into another workspace",
  );
  assert.match(route, /configuredValue\(db, orgId, "priority"/, "canonicalise, do not trust");
  assert.match(route, /source: "Website form"/, "a coordinator must see where this came from");
  assert.match(route, /uploadToken/, "and the reporter must be able to attach the photographs");
});

test("the description reports its own error like every other field", async () => {
  /*
   * Making the description required without giving it an error slot is worse
   * than leaving it optional: the submit is blocked, nine other fields light up
   * red, and the one actually stopping the form says nothing.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(form, /id="rjDesc-err"/, "the description needs somewhere to put its message");
  assert.match(
    form,
    /className=\{fieldClass\("rjDesc"\)\}/,
    "and the red outline every other field gets",
  );
});

test("the priority and engineer values the form sends exist on the board", async () => {
  /*
   * THE BUG THIS REPLACES. The old form sent `"High"` for a trading-impaired
   * fault and `"HVAC"` / `"Plumber"` / `"Specialist"` for three of its five
   * categories. None of those four are in the board's option sets, and
   * `configuredValue` silently substitutes the default rather than refusing —
   * so the second-most-urgent report a store can make arrived at the bottom of
   * the pile, and nobody could see why.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  const spec = await read("db/monday-board-spec.ts");

  const priorities = new Set(
    [...spec.slice(spec.indexOf("priority: [")).slice(0, 200).matchAll(/opt\("([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );
  const engineers = new Set(
    [
      ...spec
        .slice(spec.indexOf("engineer_required: ["))
        .slice(0, 260)
        .matchAll(/opt\("([^"]+)"/g),
    ].map((match) => match[1]),
  );
  assert.ok(priorities.size >= 3 && engineers.size >= 4, "board spec moved; fix this test");

  for (const [, value] of form.matchAll(/priority: "([^"]+)"/g)) {
    assert.ok(priorities.has(value), `priority "${value}" is not on the board`);
  }
  for (const [, value] of form.matchAll(/engineer: "([^"]+)"/g)) {
    assert.ok(engineers.has(value), `engineer "${value}" is not on the board`);
  }
});

/* ── 4. Chrome ───────────────────────────────────────────────────────────── */

test("Portal Login is the name everywhere, and it points at the portal", async () => {
  /*
   * Read with the explanations stripped. The comment beside the header link
   * says why it is not called "Client Login", so a raw search finds the phrase
   * being ruled out and fails on the sentence that rules it out.
   */
  const chrome = (await read("app/(marketing)/_sections/chrome.tsx"))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const hits = [...chrome.matchAll(/Portal Login/g)];
  assert.ok(hits.length >= 3, `expected it in the utility bar, header and footer; found ${hits.length}`);
  assert.match(chrome, /href="\/portal"/);
  assert.doesNotMatch(chrome, /Client Login/, "the brief names it Portal Login for a reason");
});

test("every nav anchor names a section that exists", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  const nav = chrome.slice(chrome.indexOf("const NAV = ["), chrome.indexOf("] as const;"));
  const targets = [...nav.matchAll(/\["#([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length >= 5, "four in-page destinations from the brief, plus Contact Us");
  assert.ok(targets.includes("review"), "Contact Us points at the section the footer calls Contact");
  for (const target of targets) {
    assert.ok(ANCHORS.includes(target), `#${target} has no section`);
  }
});

test("the footer carries the legal line verbatim", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  for (const fragment of [
    "Maintsupp is a trading name of Maintauk Ltd",
    "company no. 17262302",
    "C/O MJR Accounting & Tax Services",
    "One Canada Square, London, E14 5AA",
  ]) {
    assert.ok(
      chrome.replace(/&amp;/g, "&").includes(fragment),
      `the legal line is missing: ${fragment}`,
    );
  }
});

/* ── 5. Live, in a real browser ──────────────────────────────────────────── */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function openBrowser(width, height) {
  const profile = mkdtempSync(path.join(tmpdir(), "maintsupp-stage28-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=9343",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
  ]);
  chrome.on("error", () => undefined);

  let socketUrl = null;
  for (let attempt = 0; attempt < 60 && !socketUrl; attempt += 1) {
    try {
      socketUrl = (await (await fetch("http://127.0.0.1:9343/json/version")).json())
        .webSocketDebuggerUrl;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!socketUrl) {
    chrome.kill();
    return null;
  }

  const socket = new WebSocket(socketUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")));
  });
  const consoleErrors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(String(message.params.args?.[0]?.value ?? "error"));
    }
    if (message.method === "Runtime.exceptionThrown") consoleErrors.push("uncaught exception");
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: width < 768 },
    sessionId,
  );

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  };

  await send("Page.navigate", { url: `${BASE_URL}/` }, sessionId);
  for (let attempt = 0; attempt < 140; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await evaluate(`Boolean(document.querySelector("#rjForm"))`)) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 900));

  return {
    evaluate,
    consoleErrors,
    close() {
      socket.close();
      chrome.kill();
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* the profile is a temp dir; a locked file is not worth failing over */
      }
    },
  };
}

test("live: the ten sections are on the page, once each, with no duplicate heading", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const browser = await openBrowser(1440, 900);
  if (!browser) {
    t.skip("Chrome is not available");
    return;
  }
  try {
    const found = await browser.evaluate(`(() => {
      const main = document.querySelector("main#top");
      const ids = [...main.querySelectorAll(":scope > section")].map(s => s.id);
      const h2 = [...main.querySelectorAll("h2")].map(h => h.textContent.trim());
      return { ids, h1: main.querySelectorAll("h1").length, dupes: h2.filter((h,i) => h2.indexOf(h) !== i) };
    })()`);
    assert.deepEqual(found.ids, ANCHORS, "the sections, in the brief's order");
    assert.equal(found.h1, 1, "one h1 on the page");
    assert.deepEqual(found.dupes, [], "a repeated heading means a section is drawn twice");
    assert.deepEqual(browser.consoleErrors, []);
  } finally {
    browser.close();
  }
});

test("live: an empty Report a Job cannot be submitted", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const browser = await openBrowser(1440, 900);
  if (!browser) {
    t.skip("Chrome is not available");
    return;
  }
  try {
    await browser.evaluate(
      `document.querySelector("#rjForm button[type=submit]").click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const state = await browser.evaluate(`(() => {
      const form = document.querySelector("#rjForm");
      const shown = [...form.querySelectorAll(".field__err")].filter(p => !p.hidden && p.textContent.trim());
      const invalid = [...form.querySelectorAll(".is-invalid")];
      const red = invalid.map(el => {
        const control = el.tagName === "FIELDSET"
          ? el.querySelector(".chipgroup label")
          : el.querySelector("input,select,textarea");
        return control ? getComputedStyle(control).borderColor : null;
      });
      return { shown: shown.length, invalid: invalid.length, red: [...new Set(red)] };
    })()`);

    assert.equal(state.shown, 8, "an inline message on every one of the eight");
    assert.equal(state.invalid, 8, "and a red outline on every one");
    assert.equal(state.red.length, 1, `every invalid control takes the same red; got ${state.red}`);
    assert.match(state.red[0], /^rgb\(/, "the outline must be a real computed colour");
    assert.deepEqual(browser.consoleErrors, []);
  } finally {
    browser.close();
  }
});

test("live: every in-page anchor lands on something, at both widths", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const browser = await openBrowser(width, height);
    if (!browser) {
      t.skip("Chrome is not available");
      return;
    }
    try {
      const result = await browser.evaluate(`(() => {
        const hrefs = [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute("href"));
        return {
          missing: [...new Set(hrefs)].filter(h => h !== "#" && !document.querySelector(h)),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
        };
      })()`);
      assert.deepEqual(result.missing, [], `dead anchors at ${width}px`);
      assert.equal(result.overflow, 0, `${width}px scrolls sideways by ${result.overflow}px`);
      assert.equal(result.brokenImages, 0, `broken images at ${width}px`);
    } finally {
      browser.close();
    }
  }
});
