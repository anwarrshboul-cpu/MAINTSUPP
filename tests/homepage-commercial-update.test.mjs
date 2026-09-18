/**
 * The commercial update, as a test — §10 of the brief, executable.
 *
 * The brief that drove this change ends with an audit checklist: ten things a
 * person is told to confirm before publishing. Every one of them is a property
 * of the page rather than an opinion about it, so every one of them is here
 * instead of in somebody's memory.
 *
 * WHY A NEW FILE RATHER THAN MORE OF `homepage-v3`. That suite holds the
 * structural contracts of the page — one price table, no VAT qualifier, the
 * FAQ shared rather than copied, every anchor resolving. Those are rules about
 * the SHAPE of the site and they outlive any particular price list. This file
 * holds the COMMERCIAL facts: the rates, the bands, the allowances, the
 * destinations. They will change again, and when they do it should be obvious
 * which file to edit and which to leave alone.
 *
 * THE FIGURES ARE COMPUTED, NOT COPIED. Almost nothing below types a price.
 * The expectations are derived from `rates.ts` and checked against the page, so
 * this file cannot drift from the source the way a second list of numbers
 * would — which is the same argument `rates.ts` itself exists for. The four
 * exceptions are the approved rate table, the portfolio minimum, the three
 * destination addresses and the §1.7 forbidden list, which are quoted from the
 * brief on purpose: they are what a client is told, and a test that derived
 * them from the code could never catch the code being wrong.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const SECTIONS = "app/(marketing)/_sections";

/** Source with comments removed, so a note explaining a withdrawal is not the thing. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* `rates.ts` imports nothing, so it transpiles and loads on its own. */
const rates = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(await read(`${SECTIONS}/rates.ts`), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString("base64")}`
);

/**
 * React splits a static string from the interpolation beside it with an empty
 * comment, so "£300" arrives as "£<!-- -->300". Every check below reads the
 * text a person sees, not the markup that produced it.
 */
const asText = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

async function page(pathname = "/") {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    signal: AbortSignal.timeout(45_000),
  });
  assert.equal(response.status, 200, `${pathname} did not render`);
  return asText(await response.text());
}

async function serverIsUp() {
  try {
    return (await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(20_000) })).ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* §1 — the approved rate card                                         */
/* ------------------------------------------------------------------ */

test("the approved rates, exactly as they are quoted to clients", () => {
  /*
   * The one place in this file that types a price. Everything else derives
   * from `rates.ts`, and deriving these too would be a test asserting that a
   * number equals itself.
   */
  assert.deepEqual(
    rates.BANDS.map((band) => [band.label, band.essential, band.complete, band.compliance]),
    [
      ["5–10 stores", 60, 100, 55],
      ["11–25 stores", 56, 92, 51],
      ["26–50 stores", 52, 84, 47],
      ["51+ stores", null, null, null],
    ],
  );
});

test("Complete is £15 below buying the two parts, at every band", () => {
  /* The brief states it as a rule rather than as three coincidences, so it is
     held as one: any band that carries rates must satisfy it. */
  for (const band of rates.BANDS) {
    if (band.complete === null) continue;
    assert.equal(
      band.essential + band.compliance - band.complete,
      15,
      `${band.label} breaks the £15 rule`,
    );
  }
});

test("the minimum and the entry rate cannot contradict each other", () => {
  /*
   * §10.3. £300 must equal 5 × £60 — otherwise the calculator's readout at five
   * stores and the footnote beneath it say different things about the same
   * portfolio, and a reader doing the multiplication finds the page wrong.
   *
   * `rates.ts` throws on import if this is violated, so a bad pairing cannot
   * reach a build at all. This asserts the values as well, because a module
   * that guards itself can still be given two numbers that agree and are both
   * wrong.
   */
  assert.equal(rates.PORTFOLIO_MINIMUM, 300);
  assert.equal(rates.MINIMUM_SITES, 5);
  assert.equal(rates.ENTRY_BAND.essential * rates.MINIMUM_SITES, rates.PORTFOLIO_MINIMUM);
});

test("the selector cannot describe a portfolio the business will not take", () => {
  /* §10.2. Five is the floor, not a default — the minimum is five sites and the
     page says so in the footnotes, the FAQ and the enquiry form. */
  assert.equal(rates.SLIDER_MIN, rates.MINIMUM_SITES);
  assert.equal(rates.SLIDER_MAX, 60);
  assert.equal(rates.BANDS[0].min, 5, "and the bottom band starts there too");
  for (const band of rates.BANDS) {
    assert.ok(band.min >= 5, `${band.label} reaches below the minimum`);
  }
});

test("bandForCount puts every count in the brief's band", () => {
  const label = (count) => rates.bandForCount(count).label;
  assert.equal(label(5), "5–10 stores");
  assert.equal(label(10), "5–10 stores");
  assert.equal(label(11), "11–25 stores");
  assert.equal(label(25), "11–25 stores");
  assert.equal(label(26), "26–50 stores");
  assert.equal(label(50), "26–50 stores");
  assert.equal(label(51), "51+ stores");
  assert.equal(label(60), "51+ stores");
});

test("the monthly totals in the brief are what rate × count produces", () => {
  /*
   * §1.4's table, checked against the arithmetic the page does — which is the
   * point of quoting it: the brief and the component have to agree about what
   * a portfolio of eight stores costs, and neither one is allowed to be the
   * only source of that.
   */
  const expected = [
    [5, 300, 500],
    [8, 480, 800],
    [10, 600, 1000],
    [15, 840, 1380],
    [20, 1120, 1840],
    [30, 1560, 2520],
    [40, 2080, 3360],
  ];
  for (const [count, essential, complete] of expected) {
    const band = rates.bandForCount(count);
    assert.equal(band.essential * count, essential, `Essential at ${count} stores`);
    assert.equal(band.complete * count, complete, `Complete at ${count} stores`);
  }
});

/* ------------------------------------------------------------------ */
/* §1.7 — what must no longer be on the page                           */
/* ------------------------------------------------------------------ */

/**
 * The withdrawn strings, quoted from §1.7 of the brief.
 *
 * "£55" is excluded deliberately and the brief says why: it is forbidden "as a
 * headline tier price" and is now the compliance-only rate, where it is
 * correct. "21 stores" is excluded for the same reason — forbidden in the
 * pricing totals, kept in the hero chip and the case study, which is where the
 * portfolio actually is.
 */
const WITHDRAWN = [
  "£85",
  "£90",
  "£275",
  "£125",
  "£65",
  "2 coordinated jobs",
  "3 coordinated jobs",
  "1–5 stores",
  "1–4 stores",
  "save £20 per store",
  "waived on a 12-month term",
  "Waived on a 12-month term",
  "£375 at 5 stores",
];

test("none of the withdrawn pricing strings survives in the source", async () => {
  const pricing = code(await read(`${SECTIONS}/pricing.tsx`));
  const content = code(await read(`${SECTIONS}/content.ts`));
  for (const withdrawn of WITHDRAWN) {
    assert.ok(!pricing.includes(withdrawn), `pricing.tsx still says "${withdrawn}"`);
    assert.ok(!content.includes(withdrawn), `content.ts still says "${withdrawn}"`);
  }
});

/* ------------------------------------------------------------------ */
/* §1.2–1.6 — the shape of the section                                 */
/* ------------------------------------------------------------------ */

test("two cards, and compliance-only is small print beneath them", async () => {
  /* §10.5. The decision is between two plans. Compliance administration is
     still sold and still priced — as a sentence and a rate-card row. */
  const pricing = await read(`${SECTIONS}/pricing.tsx`);
  const body = code(pricing);
  const plans = [...body.matchAll(/^\s{4}key: "(\w+)",$/gm)].map((m) => m[1]);
  assert.deepEqual(plans, ["essential", "complete"], "exactly two plans, in this order");
  assert.ok(!body.includes("COMPLIANCE_PLAN"), "the third plan object is gone");
  assert.ok(!body.includes('className="pkgalt"'), "and so is its card");
  assert.match(pricing, /<p className="pkgfine">/, "the offer survives as small print");
});

test("§4.2's new question is in the source, not only on a running server", async () => {
  /* The live half of this file skips without a dev server, so a question pinned
     only there is a question nothing protects in CI. */
  const content = await read(`${SECTIONS}/content.ts`);
  assert.match(content, /"q": "What if we only have three or four sites\?"/);
  assert.match(content, /better served calling trades directly/);
  assert.match(content, /Our minimum is five sites/);
  const costAt = content.indexOf('"q": "What does it cost?"');
  const newAt = content.indexOf('"q": "What if we only have three or four sites?"');
  assert.ok(costAt > 0, "the cost answer is still there");
  assert.ok(newAt > costAt, "and the new one sits after it");
  /* Immediately after: nothing between the two entries but the closing brace
     and the opening of the next. */
  assert.ok(
    content.slice(costAt, newAt).split('"q": "').length === 2,
    "immediately after — no other question was inserted between them",
  );

  /* §4.1 quotes its answer word for word, and the brief writes both counts as
     WORDS. Interpolating the constants is what keeps the sentence from becoming
     a second typed copy; `inWords` is what keeps it reading as English. */
  assert.match(content, /\$\{inWords\(INCLUDED_JOBS\)\} coordinated jobs per store per month/);
  assert.match(content, /Our minimum portfolio is \$\{inWords\(MINIMUM_SITES\)\} sites/);
  assert.equal(rates.inWords(rates.INCLUDED_JOBS), "four");
  assert.equal(rates.inWords(rates.MINIMUM_SITES), "five");
});

test("the full rate card uses the page's own disclosure, and scrolls", async () => {
  /* §1.5 and §10.10. `<details>`/`<summary>` is what the FAQ uses — no new UI
     pattern — and the table scrolls inside its own box rather than widening
     the document. */
  const pricing = await read(`${SECTIONS}/pricing.tsx`);
  assert.match(pricing, /<details className="ratecard">/);
  assert.match(pricing, /<summary className="ratecard__toggle">See the full rate card<\/summary>/);
  assert.ok(!code(pricing).includes("useState(false)"), "a disclosure needs no state");

  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, /\.ratecard__scroll\{overflow-x:auto/, "the table scrolls, the page does not");
  const block = css.slice(css.indexOf(".ratecard{"), css.indexOf(".ratecard__note"));
  assert.doesNotMatch(block, /min-width:\s*\d+px/, "nothing in it may force the page wide");
});

test("every footnote the brief lists is on the page, and none of the old ones", async () => {
  const pricing = await read(`${SECTIONS}/pricing.tsx`);
  const notes = pricing.slice(pricing.indexOf('<ul className="pricing__notes">'));
  for (const fragment of [
    "Maintsupp coordinates portfolios of five sites and above",
    "Includes {INCLUDED_JOBS} coordinated jobs per store per month",
    "exceeds its allowance for two consecutive quarters",
    "Onboarding and asset capture",
    "Out-of-hours and P1 escalation",
    "Projects and kiosk works are scoped and quoted separately",
    "Sites added mid-term are charged pro-rata",
    "Service hours Mon–Fri, 8:30am–5:30pm",
    "Three-month initial term, then 30 days",
    "Contractor invoices are separate",
    "Prices shown are the total payable",
    "Final quote confirmed at your free portfolio review",
  ]) {
    assert.ok(notes.includes(fragment), `the footnotes lost "${fragment}"`);
  }
  /* The withdrawn ones, by their distinguishing clause. */
  for (const gone of [
    "Compliance pricing assumes a standard retail asset profile",
    "out-of-hours P1 incidents",
  ]) {
    assert.ok(!code(pricing).includes(gone), `"${gone}" was replaced, not kept`);
  }
});

/* ------------------------------------------------------------------ */
/* §2, §3, §9 — booking, the form, the nav                             */
/* ------------------------------------------------------------------ */

test("the booking link is one constant, and never a dead calendar", async () => {
  /* §10.7. Two typed copies of a booking URL is one that can be changed and one
     that cannot, and the one left behind sends people to a dead calendar.

     The constant was pinned to `https://cal.com/maintsupp/portfolio-review`,
     which 404s — the pin held the typo in place, because it asserted that the
     string had not changed and nothing about whether it could be booked. The
     slug on the account is `portfolio-review-30-minutes`; that is what is
     pinned now, and the deployment can override it without a release. */
  const content = await read(`${SECTIONS}/content.ts`);
  assert.match(
    content,
    /export const BOOKING_URL =\s*process\.env\.NEXT_PUBLIC_BOOKING_URL\?\.trim\(\) \|\|\s*"https:\/\/cal\.com\/maintsupp\/portfolio-review-30-minutes";/,
    "the verified event, overridable by the deployment",
  );
  assert.ok(
    !code(content).includes("cal.com/maintsupp/portfolio-review\""),
    "not the slug that 404s",
  );
  for (const file of ["hero.tsx", "final-cta.tsx"]) {
    const source = await read(`${SECTIONS}/${file}`);
    assert.match(
      source,
      /import \{ BOOKING_IS_EXTERNAL, BOOKING_URL \} from "\.\/content";/,
      `${file} imports it`,
    );
    assert.match(
      code(source),
      /href=\{BOOKING_URL\}[\s\S]{0,160}?target=\{BOOKING_IS_EXTERNAL \? "_blank" : undefined\}[\s\S]{0,120}?rel=\{BOOKING_IS_EXTERNAL \? "noopener noreferrer" : undefined\}/,
      `${file} opens an external calendar in a new tab, safely, and an anchor in this one`,
    );
    assert.ok(
      !code(source).includes("https://cal.com"),
      `${file} must not type the URL a second time`,
    );
  }
});

test("the enquiry form offers the pricing bands, plus the honest way to say no", async () => {
  /* §3 and §10.6. The options were invented for this form and matched nothing
     else on the page; a lead could arrive in a band the rate card cannot
     price. */
  const form = await read(`${SECTIONS}/final-cta.tsx`);
  /* Sliced to the END OF THE DECLARATION, not to a byte count — the same
     anti-pattern this release removes from three other suites. A comment or a
     longer label above it must not be able to truncate what is compared. */
  const from = form.indexOf("const SITE_RANGES = [");
  const ranges = form.slice(from, form.indexOf("] as const;", from));
  const offered = [...ranges.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(offered, ["5–10", "11–25", "26–50", "51+"]);
  assert.match(form, /const UNDER_MINIMUM = "Fewer than 5";/);
  assert.match(form, /SITE_RANGES = \["5–10", "11–25", "26–50", "51\+", UNDER_MINIMUM\]/);

  /* Every band the calculator can reach must be selectable in the form. */
  const labels = rates.BANDS.map((band) => band.label.replace(" stores", ""));
  assert.deepEqual(offered, labels, "the form's bands are the pricing bands");

  /* It says no and still takes the enquiry. */
  assert.match(form, /sites === UNDER_MINIMUM/);
  assert.match(form, /coordinates portfolios of five sites and above\. If you're opening more/);
  assert.match(form, /className="field__note" aria-live="polite"/, "and says so out loud");
  assert.doesNotMatch(
    code(form),
    /UNDER_MINIMUM[\s\S]{0,200}?(return|setError|disabled)/,
    "choosing it must not block the submit",
  );
});

test("the nav carries Contractors, and it is a route rather than an anchor", async () => {
  const chrome = await read(`${SECTIONS}/chrome.tsx`);
  assert.match(chrome, /\["\/contractors", "Contractors"\]/);
  assert.match(chrome, /const isAnchor = \(href: string\) => href\.startsWith\("#"\);/);
  /*
   * RE-POINTED: one component now decides `<a>` versus `<Link>`, and the rule
   * it applies is the one this test was asserting at each call site.
   *
   * These pinned the desktop nav rendering a route through `next/link` and the
   * drawer handing a route `setOpen(false)` rather than the deferred-hash
   * handler. Both were spelled out inline at nineteen call sites, and all
   * nineteen were also emitting section hashes that are dead on every page
   * except the homepage. `SectionLink` resolves the href for the current page
   * and then picks the element, so the claim is checked once, where it is now
   * made — and checked more strictly: the anchor handler must reach ONLY the
   * in-page branch, which the old per-site pins could not express.
   */
  assert.match(chrome, /<SectionLink className="nav__link" href=\{href\}>/, "the nav renders through it");
  const link = chrome.slice(chrome.indexOf("function SectionLink"));
  assert.match(link.slice(0, 1400), /const resolved = sectionHref\(href\);/);
  assert.match(
    link.slice(0, 1400),
    /if \(isAnchor\(resolved\)\) \{[\s\S]*?<a className=\{className\} href=\{resolved\} onClick=\{onAnchorClick\}/,
    "a hash on this page is a plain anchor and keeps the deferred-hash handler",
  );
  assert.match(
    link.slice(0, 1400),
    /<Link className=\{className\} href=\{resolved\} onClick=\{onNavigate\}/,
    "anything that is a route goes through next/link and never sees onAnchorClick",
  );
});

/* ------------------------------------------------------------------ */
/* §5, §6, §7, §8 — the strip, the destinations, the domain, the mock  */
/* ------------------------------------------------------------------ */

test("the trust strip makes no claim it cannot evidence", async () => {
  /* §5. Searched against the ICO's own public register by name on 15 September
     2026 for "Maintauk", "MAINTAUK LTD" and "Maintsupp": no entries. On a site
     selling compliance administration this is the worst place for an
     unverifiable claim. */
  const cta = await read(`${SECTIONS}/final-cta.tsx`);
  const claims = code(cta.slice(cta.indexOf("const CLAIMS = ["), cta.indexOf("export function TrustStrip")));
  assert.ok(!claims.includes("ICO registered"));
  assert.ok(!claims.includes("Data protection"));
  assert.equal((claims.match(/title: "/g) ?? []).length, 3);
});

test("each form goes where the brief sends it, with the subject it asks for", async () => {
  /* §6 and §10.8. The three addresses are typed here on purpose: they are what
     a client's mail lands in, and deriving them from the code would make this
     a test that the code equals itself. */
  const notifications = await read("app/lib/notifications.ts");
  assert.match(notifications, /source\.NOTIFY_OPS \?\? "operations@maintsupp\.com"/);
  assert.match(notifications, /source\.NOTIFY_SALES \?\? "anwar@maintsupp\.com"/);
  assert.match(notifications, /source\.NOTIFY_CONTRACTORS \?\? "admin@maintsupp\.com"/);
  /*
   * NO SHARED FALLBACK. `opsInbox` used to fall back to `salesInbox`, so a
   * broken shutter and a portfolio enquiry landed in the same place and the
   * urgent one waited behind the other. Each default is its own address.
   */
  assert.doesNotMatch(notifications, /NOTIFY_OPS \?\? salesInbox/);

  assert.match(notifications, /subject: `\[LEAD\] /, "the enquiry subject is filterable");
  assert.match(notifications, /\[JOB\] \$\{job\.site/, "so is the job subject");
  const contractor = await read("app/api/contractor-applications/route.ts");
  assert.match(contractor, /const \{ contractorInbox \} = notificationTargets\(\);/);
  assert.match(contractor, /subject: `\[CONTRACTOR\] \$\{company\}`/);
});

test("the duplicate Vercel hostname redirects, and Preview deployments do not", async () => {
  /*
   * §7. `maintsupp-portal.vercel.app` is an alias of the SAME production
   * deployment that serves maintsupp.com, so every page was reachable at two
   * addresses with no canonical between them.
   *
   * THE EXACT-MATCH RULE IS THE LOAD-BEARING PART. Preview deployments are
   * `maintsupp-portal-<hash>-maintsupp.vercel.app`; a suffix match would bounce
   * every one of them to production and make Preview QA — which is how this
   * project verifies every release — impossible.
   */
  const worker = await read("worker/index.ts");
  assert.match(worker, /const DUPLICATE_HOST = "maintsupp-portal\.vercel\.app";/);
  /*
   * AND THE PRE-DEPLOY HARNESS MUST NOT PROBE THAT HOST.
   *
   * `vercel/local-check.mjs` drives the BUILT function in-process against real
   * Postgres and sets `host:` on every probe. It was set to
   * `maintsupp-portal.vercel.app` — the very hostname this redirect now
   * catches — so every probe would have answered 301 with a zero-byte body
   * while the script, which exits 0 regardless, printed a tidy table and
   * reported success. A verification harness that silently stops verifying is
   * worse than none, so the two are pinned against each other here.
   */
  const check = await read("vercel/local-check.mjs");
  const host = /const HOST = "([^"]+)";/.exec(check);
  assert.ok(host, "local-check must declare the host it probes");
  assert.notEqual(host[1], "maintsupp-portal.vercel.app", "the harness must not probe the redirected host");
  assert.equal(host[1], "www.maintsupp.com", "it probes the canonical host");
  assert.match(worker, /const CANONICAL_ORIGIN = "https:\/\/www\.maintsupp\.com";/);
  assert.match(worker, /url\.hostname === DUPLICATE_HOST/, "an exact host match, never a suffix");
  /* Comments stripped: the note above the constant has to name the mistake it
     is warning against, and a check that fails on its own rationale pushes the
     reasoning out of the file to make the test pass. */
  assert.doesNotMatch(
    code(worker),
    /endsWith\("\.vercel\.app"\)/,
    "a suffix match would break Preview QA",
  );
  assert.match(worker, /status: 301/);
  assert.match(
    worker,
    /Location: `\$\{CANONICAL_ORIGIN\}\$\{url\.pathname\}\$\{url\.search\}`/,
    "the path is kept, so a deep link is not thrown away",
  );

  /* And a preview is not a second copy of the site for a crawler to index. */
  assert.match(worker, /function isUnindexableDeployment/);
  assert.match(worker, /target !== "" && target !== "production"/, "only a known non-production env");
  assert.match(worker, /headers\.set\("X-Robots-Tag", "noindex, nofollow"\)/);
});

test("the homepage canonical is the address the brief names", async () => {
  /* §7.3. Recorded with its caveat: `www.maintsupp.com` currently 307s to the
     apex, so this canonical names a host that redirects. That is a Vercel
     domain setting rather than a code change, and it is flagged in the release
     notes rather than guessed at here. */
  const homepage = await read("app/(marketing)/page.tsx");
  assert.match(homepage, /alternates: \{ canonical: "https:\/\/www\.maintsupp\.com\/" \}/);
});

test("the portal mock captions an address that exists", async () => {
  /* §8. `portal.maintsupp.com` is not a host this product has ever been served
     from, and Portal Login goes to `/portal` on this domain. Caption only —
     the screenshots and the section are untouched. */
  const portal = await read(`${SECTIONS}/portal.tsx`);
  assert.match(portal, /maintsupp\.com\/dashboard\/\{current\.url\}/);
  assert.ok(!code(portal).includes("portal.maintsupp.com"));
});

/* ------------------------------------------------------------------ */
/* Live — the page a reader actually gets                              */
/* ------------------------------------------------------------------ */

test("live: every figure agrees across the page", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const html = await page("/");
  const entry = rates.ENTRY_BAND;

  /* The cards, at the count the calculator opens on. */
  assert.ok(html.includes(`£${entry.essential}`), "the Essential rate");
  assert.ok(html.includes(`£${entry.complete}`), "the Complete rate");
  assert.ok(
    html.includes(`£${entry.essential * rates.SLIDER_MIN}`),
    "and the Essential portfolio total at five stores",
  );
  assert.ok(html.includes(`£${entry.complete * rates.SLIDER_MIN}`), "and Complete's");

  /* The badge, the compliance-only line, and the footnote figures. */
  assert.ok(html.includes(`save £${entry.essential + entry.compliance - entry.complete} per store`));
  assert.ok(html.includes(`from £${entry.compliance} per store / month`));
  assert.ok(html.includes(`Portfolio minimum £${rates.PORTFOLIO_MINIMUM} per month`));
  assert.ok(html.includes(`Includes ${rates.INCLUDED_JOBS} coordinated jobs`));
  assert.ok(html.includes(`Additional coordinated jobs £${rates.ADDITIONAL_JOB} each`));
  assert.ok(html.includes(`Out-of-hours and P1 escalation £${rates.OUT_OF_HOURS_P1} per incident`));
  assert.ok(html.includes(`${rates.PROJECT_PERCENT}% of third-party project spend`));
  assert.ok(html.includes(`minimum £${rates.PROJECT_MINIMUM}`));

  /* The rate card: every band's every rate, including "Bespoke". */
  for (const band of rates.BANDS) {
    assert.ok(html.includes(band.label), `${band.label} is a column`);
    for (const key of ["essential", "complete", "compliance"]) {
      const cell = band[key] === null ? "Bespoke" : `£${band[key]}`;
      assert.ok(html.includes(cell), `${band.label} / ${key} reads ${cell}`);
    }
  }
});

test("live: the cost FAQ quotes the same two rates the cards do", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  /* §10.4's hardest case: the FAQ is the one place a figure could drift
     unnoticed, because it is prose. It is derived, and this is the proof. */
  for (const where of ["/", "/faqs"]) {
    const html = await page(where);
    assert.ok(
      html.includes(`Essential from £${rates.ENTRY_BAND.essential} per store`),
      `${where}: the Essential entry rate`,
    );
    assert.ok(
      html.includes(`Complete from £${rates.ENTRY_BAND.complete} per store`),
      `${where}: the Complete entry rate`,
    );
    /* Spelled out, because §4.1 quotes the answer word for word and the brief
       writes both counts as words. `inWords` is how the derived constant still
       reads as English. */
    assert.ok(
      html.includes(`It includes ${rates.inWords(rates.INCLUDED_JOBS)} coordinated jobs per store`),
      `${where}: the coordinated-job allowance, in words`,
    );
    assert.ok(
      html.includes(`Our minimum portfolio is ${rates.inWords(rates.MINIMUM_SITES)} sites`),
      `${where}: the minimum, in words`,
    );
    assert.ok(
      html.includes("What if we only have three or four sites?"),
      `${where}: the new FAQ is there too`,
    );
  }
});

test("live: none of the withdrawn strings reaches a reader", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  /* §10.1, against the rendered page rather than the source — which is where a
     figure assembled from two interpolations would show up and a source scan
     would not. */
  const html = await page("/");
  for (const withdrawn of WITHDRAWN) {
    assert.ok(!html.includes(withdrawn), `the page still says "${withdrawn}"`);
  }
  assert.ok(!html.includes("ICO registered"), "and makes no ICO claim");
  assert.ok(!html.includes("portal.maintsupp.com"), "nor names a host that does not exist");
  assert.ok(!html.includes("Book My Portfolio Review"), "nor offers a submit that cannot book");
});

/*
 * The destination this page is SUPPOSED to offer, read from the one place that
 * decides it.
 *
 * This used to be a second typed copy of the slug, and it went stale the moment
 * the booking URL was corrected: the constant became
 * `portfolio-review-30-minutes` and this test still demanded the old
 * `portfolio-review`, so it failed while the product was right. A copy of a
 * value cannot check that value. It reads `BOOKING_URL` from `content.ts`
 * instead — including the deployment's override, which is how the URL is meant
 * to be changed — so it now asks the only question worth asking: does every
 * booking link on the page go where the configuration says?
 */
async function bookingDestination() {
  const override = process.env.NEXT_PUBLIC_BOOKING_URL?.trim();
  if (override) return override;
  const content = await read(`${SECTIONS}/content.ts`);
  const [, url] =
    content.match(/export const BOOKING_URL =[\s\S]*?\|\|\s*"([^"]+)";/) ?? [];
  assert.ok(url, "content.ts must still declare a default BOOKING_URL");
  return url;
}

test("live: the page offers the booking link and the enquiry form both", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const html = await page("/");
  const expected = await bookingDestination();

  /* Every calendar link on the page, whatever it points at — so a second,
     stale URL left behind somewhere fails this rather than hiding behind the
     one that is correct. */
  const calendarLinks = [...html.matchAll(/href="(https:\/\/cal\.com\/[^"]*)"[^>]*/g)];
  assert.ok(calendarLinks.length >= 2, "the hero and the final panel both book");
  for (const [tag, href] of calendarLinks) {
    assert.equal(href, expected, "every booking link is the configured destination");
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer"/);
  }
  assert.ok(html.includes("Send My Enquiry"), "the form is still there, honestly labelled");
  assert.ok(html.includes('href="/contractors"'), "and the nav carries Contractors");
});
