import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

/**
 * The v2 positioning edit, pinned.
 *
 * A targeted edit is the easy kind to undo by accident: nothing here changed
 * shape, so a later refactor that "tidies" a section list or restores a deleted
 * paragraph would put the page back without anybody noticing. These assertions
 * are the record of what was decided and why.
 */

test("Report a Job moved down, and its anchor moved with it", async () => {
  const page = await read("app/(marketing)/page.tsx");
  const body = page.slice(page.indexOf("HomePage"));
  const order = [...body.matchAll(/<([A-Z][A-Za-z]*)\s*\/>/g)].map((m) => m[1]);

  assert.ok(order.indexOf("ReportJob") === 3, `Report a Job is fourth, found at ${order.indexOf("ReportJob")}`);
  assert.ok(order.indexOf("WhoWeHelp") < order.indexOf("ReportJob"), "who it is for comes first");
  assert.ok(order.indexOf("Services") < order.indexOf("ReportJob"), "then what it covers");

  /* The anchor lives on the section, so moving the component moves the target —
     nothing in the nav or the hero needed editing, and nothing should have. */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(form, /id="report"/, "the #report anchor travels with the section");

  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  assert.match(chrome, /href="#report"/, "the nav still points at it");
  const hero = await read("app/(marketing)/_sections/hero.tsx");
  assert.match(hero, /href="#report"/, "and so does the hero's secondary button");
});

test("the hero chip is an example, not a response time", async () => {
  const hero = await read("app/(marketing)/_sections/hero.tsx");
  assert.match(hero, /contractor assigned same day/);
  /* Comments stripped first: the note explaining why the minute count went
     naturally quotes it, and a check that fails on its own rationale would
     force the reasoning out of the file to make the test pass. */
  const rendered = hero.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(rendered, /14 minutes/, "the minute count is gone");
  assert.match(hero, /className="feedline__tag">Example</, "and the chip says it is an illustration");
});

test("the portal section is trimmed to exactly what the brief keeps", async () => {
  const portal = await read("app/(marketing)/_sections/portal.tsx");

  /* Kept */
  assert.match(portal, /Total visibility\. Total control\./);
  for (const bullet of [
    "Open jobs by priority and site",
    "Assignment and attendance status in real time",
    "Compliance due in 90/60/30 days",
    "Spend by site and trade",
    "Contractor performance scores",
    "Quotes waiting for your approval",
  ]) {
    assert.ok(portal.includes(bullet), `kept bullet missing: ${bullet}`);
  }
  assert.match(portal, /Every client gets portfolio visibility/);

  /* Deleted — the eleven widget explainers and the hover hint */
  for (const gone of [
    "Active units",
    "Requiring attention",
    "Completed in 7 days",
    "Units requiring attention",
    "Jobs by status",
    "Spend trend",
    "Compliance score",
    "Jobs by trade",
    "Hover or tap any figure",
  ]) {
    assert.ok(!portal.includes(gone), `should have been deleted: ${gone}`);
  }

  /* Replaced */
  assert.match(
    portal,
    /Sample data shown\. Client data is only visible to authorised users after\s+secure login\./,
  );
  assert.ok(!portal.includes("never queries live portal records"), "old security sentence is gone");

  /* One text link, to /portal, and no button to /dashboard */
  assert.match(portal, /href="\/portal"[\s\S]{0,60}Portal Login/);
  assert.ok(!portal.includes("/dashboard"), "the /dashboard button is gone");
  assert.ok(!portal.includes("Open Client Portal"), "and so is its label");
});

test('"What we record on your file" replaces the old label everywhere', async () => {
  const workflow = await read("app/(marketing)/_sections/workflow.tsx");
  assert.match(workflow, /<dt>What we record on your file<\/dt>/);

  /* Nowhere on the site, not just in this file. */
  const offenders = [];
  const walk = async (folder) => {
    for (const entry of await readdir(path.join(root, folder), { withFileTypes: true })) {
      const next = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (/\.(tsx?|css)$/.test(entry.name)) {
        if ((await read(next)).includes("What the system records")) offenders.push(next);
      }
    }
  };
  await walk("app");
  assert.deepEqual(offenders, [], `old label still present in:\n  ${offenders.join("\n  ")}`);
});

test("all seven workflow stages survive, each with its own approved photograph", async () => {
  const workflow = await read("app/(marketing)/_sections/workflow.tsx");
  const photos = [...workflow.matchAll(/"\/assets\/workflow\/(how-it-works-[^"]+)"/g)].map((m) => m[1]);

  assert.deepEqual(photos, [
    "how-it-works-01-report-full.jpg",
    "how-it-works-02-triage-full.webp",
    "how-it-works-03-approve-full.webp",
    "how-it-works-04-assign-full.webp",
    "how-it-works-05-attend-full.webp",
    "how-it-works-06-verify-full.webp",
    "how-it-works-07-reporting-full.webp",
  ], "step order, straight from the pack's README");

  assert.equal(new Set(photos).size, 7, "no photograph is reused across two stages");
  assert.equal((workflow.match(/name: "/g) ?? []).length, 7, "seven stages");
  /* Stages 1 and 7 are both called "Report" and have different pictures, so the
     lookup must be positional. A name lookup would put step 1's photograph
     under step 7 and nothing on screen would look wrong. */
  assert.match(workflow, /WORKFLOW_PHOTOS\[active\]/);
});

test("each audience card carries the photograph the README gives it", async () => {
  const who = await read("app/(marketing)/_sections/who-we-help.tsx");
  const pairs = [...who.matchAll(/label: "([^"]+)",\s*\n\s*body: "[^"]*",\s*\n\s*photo: "([^"]+)"/g)].map(
    (m) => [m[1], m[2]],
  );
  assert.deepEqual(pairs, [
    ["Retail chains", "/assets/audience/who-we-help-retail-chains.png"],
    ["Shopping-centre kiosks", "/assets/audience/who-we-help-shopping-centre-kiosks.png"],
    ["Franchise groups", "/assets/audience/who-we-help-franchise-groups.png"],
    ["Clinics & wellness", "/assets/audience/who-we-help-clinics-wellness.png"],
    ["Gyms & studios", "/assets/audience/who-we-help-gyms-studios.png"],
    ["Small commercial offices", "/assets/audience/who-we-help-commercial-offices.png"],
  ], "card → file, exactly as the pack's README maps them");
  assert.equal(new Set(pairs.map(([, file]) => file)).size, 6, "no photograph is reused");
});

test("every approved asset the page asks for is actually in the repository", async () => {
  /* The one failure mode a mapping table cannot catch: a correct path to a file
     that was never copied in. */
  const manifest = await read("app/(marketing)/_sections/asset-widths.ts");
  const referenced = [
    ...(await read("app/(marketing)/_sections/who-we-help.tsx")).matchAll(/"(\/assets\/audience\/[^"]+)"/g),
    ...(await read("app/(marketing)/_sections/workflow.tsx")).matchAll(/"(\/assets\/workflow\/[^"]+)"/g),
  ].map((m) => m[1]);

  assert.equal(referenced.length, 13, "six audience cards and seven workflow stages");
  for (const src of referenced) {
    const file = path.join(root, "public", src);
    await readFile(file).catch(() => {
      throw new Error(`referenced but not in the repository: ${src}`);
    });
    assert.ok(manifest.includes(src), `${src} has no entry in asset-widths.ts, so it gets no variants`);
  }
});

test("the comparison shows both sides with nothing to press", async () => {
  const problem = await read("app/(marketing)/_sections/problem.tsx");
  assert.ok(!problem.includes("aria-pressed"), "the switcher is gone");
  assert.ok(!problem.includes("useState"), "and so is the state behind it");
  assert.match(problem, /className="comparepair"/, "paired rows instead");
  assert.equal((problem.match(/before: "/g) ?? []).length, 5, "the same five pairs");

  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, /\.comparepair\{[^}]*grid-template-columns:1fr auto 1fr/, "side by side on desktop");
  assert.match(css, /@media \(max-width:760px\)\{[\s\S]{0,200}\.comparepair\{grid-template-columns:1fr/, "stacked on a phone");
});

test("the review CTA has one name however the CSS behaves", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  const cta = chrome.slice(chrome.indexOf('className="btn btn--primary btn--sm hdr__cta"') - 200);
  assert.match(cta, /aria-label="Book a Portfolio Review"/, "one accessible name, fixed");
  assert.match(cta, /className="cta-long" aria-hidden="true"/);
  assert.match(cta, /className="cta-short" aria-hidden="true"/);
});

test("the SVG path leak is fixed where it was produced", async () => {
  /*
   * `toolArt` interpolated its `glyphPath` straight into a `<g>`, and its own
   * default is a bare `d` value — so "M20 6 9 17l-5-5" became a text node and
   * rendered in the case-study section. Callers pass both shapes, so the fix
   * normalises here rather than at one call site.
   */
  const photo = await read("app/(marketing)/_sections/photo.tsx");
  assert.match(photo, /const glyph = glyphPath\.trim\(\)\.startsWith\("<"\)/);
  assert.match(photo, /`<path d="\$\{glyphPath\}"\/>`/);
  assert.match(photo, /stroke-linejoin="round">\$\{glyph\}<\/g>/, "the <g> renders the normalised markup");
});

test("the footer renames the portal link and adds the contractor route, nav untouched", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  assert.match(chrome, /<li><a href="#portal">Client portal<\/a><\/li>/);
  assert.ok(!chrome.includes("The software"), "the old label is gone");
  assert.match(chrome, /<li><Link href="\/contractors">Join our contractor network<\/Link><\/li>/);
  assert.equal(
    (chrome.match(/\/contractors/g) ?? []).length,
    1,
    "exactly one link to it, and it is the footer's — not the top nav's",
  );
  /* The legal line is byte-for-byte what it was. */
  assert.match(chrome, /Maintsupp is a trading name of Maintauk Ltd\. Registered in England &amp; Wales,/);
});

test("the founder section renders a frame rather than somebody else's face", async () => {
  const founder = await read("app/(marketing)/_sections/founder.tsx");
  assert.match(founder, /Who runs Maintsupp/);
  assert.match(founder, /Anwar Shboul — Founder &amp; Director/);
  assert.match(founder, /Maintsupp is founder-led\./);
  assert.match(founder, /\/assets\/photos\/founder-anwar\.jpg/, "the named slot is the only source");
  assert.match(founder, /const FOUNDER_PHOTO_SUPPLIED = false;/, "and it is not supplied yet");
  assert.match(founder, /className="founder__frame"/, "so an empty frame stands in its place");
  for (const chip of ["Founder-led", "One named coordinator per portfolio", "Mon–Fri, 8:30am–5:30pm"]) {
    assert.ok(founder.includes(chip), `missing chip: ${chip}`);
  }
  assert.ok(!/btn btn--primary|btn--lg/.test(founder), "no CTA in this section");
});

test("the contractor page asks the eleven questions, in order", async () => {
  const page = await read("app/(marketing)/contractors/page.tsx");
  assert.match(page, /title: "Join the Contractor Network — Maintsupp"/);
  assert.match(page, /<h1 className="h1">Join the Maintsupp contractor network<\/h1>/);
  assert.match(page, /Maintsupp coordinates maintenance across multi-site commercial portfolios in/);
  assert.match(page, /Approval\s+requires document checks before any work is assigned\./);

  const form = await read("app/(marketing)/contractors/apply-form.tsx");
  const order = [...form.matchAll(/htmlFor="(company|contactName|email|phone|regions|yearsTrading|certifications|notes|consent)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    order.filter((id, i) => order.indexOf(id) === i),
    ["company", "contactName", "email", "phone", "regions", "yearsTrading", "certifications", "notes", "consent"],
    "the brief's field order, with trades and insurance as grouped controls between phone and regions",
  );
  assert.match(form, /Submit Application/);
  assert.equal((form.match(/"Other",/g) ?? []).length, 1);
  assert.equal([...form.matchAll(/^\s{2}"[^"]+",$/gm)].length >= 11, true, "eleven trades");
});

test("the contractor endpoint trusts nothing the browser sent", async () => {
  const route = await read("app/api/contractor-applications/route.ts");
  assert.match(route, /allowAnonymous: true/, "public by definition");
  assert.match(route, /const trades = TRADES\.filter\(\(trade\) => submitted\.includes\(trade\)\)/,
    "trades are intersected with the offered list, not merely filtered");
  assert.match(route, /if \(insured !== "Yes" && insured !== "No"\)/);
  assert.match(route, /if \(!consent\)/, "consent is required");
  assert.match(route, /EMAIL\.test\(email\)/);
  assert.doesNotMatch(route, /\.\.\.payload/, "nothing spreads the request body");
  assert.doesNotMatch(route, /export async function GET/, "no public read of the application register");
  assert.match(route, /clean\(payload\.company, 160\)/, "every field length-capped");
});
