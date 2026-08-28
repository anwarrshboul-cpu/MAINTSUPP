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

test('"What the system records" replaces the old label everywhere', async () => {
  /* The owner's wording. It used to read "What we record on your file", which
     described a filing cabinet rather than the thing the reader is being sold. */
  const workflow = await read("app/(marketing)/_sections/workflow.tsx");
  assert.match(workflow, /<dt>What the system records<\/dt>/);

  /* Nowhere on the site, not just in this file. */
  const offenders = [];
  const walk = async (folder) => {
    for (const entry of await readdir(path.join(root, folder), { withFileTypes: true })) {
      const next = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (/\.(tsx?|css)$/.test(entry.name)) {
        if ((await read(next)).includes("What we record on your file")) offenders.push(next);
      }
    }
  };
  await walk("app");
  assert.deepEqual(offenders, [], `old label still present in:\n  ${offenders.join("\n  ")}`);
});

test("the seven stage headings are the approved copy", async () => {
  const workflow = await read("app/(marketing)/_sections/workflow.tsx");
  /* The headings the owner signed off. The old ones described the mechanism
     ("Priority assigned (P1–P4) with a clear decision tree"); these describe
     what the client gets, which is what was approved. */
  for (const [step, heading] of [
    [1, "Logged with the detail that matters"],
    [2, "Priority set by someone accountable"],
    [7, "A portfolio view you can act on"],
  ]) {
    assert.match(
      workflow,
      new RegExp(`heading: "${heading}"`),
      `stage ${step} is not carrying its approved heading`,
    );
  }
  /* And none of the wording they replaced. */
  for (const gone of [
    "Fault logged with photos, urgency and access details.",
    "Priority assigned (P1–P4)",
    "Job closed into the portfolio record",
  ]) {
    assert.ok(!workflow.includes(gone), `superseded heading still present: ${gone}`);
  }
});

test("only the stage name carries the accent colour", async () => {
  const workflow = await read("app/(marketing)/_sections/workflow.tsx");
  /* The name is its own span; the em dash and the heading sit outside it, so
     the red stops at the keyword. */
  assert.match(
    workflow,
    /<span className="wf__stage-name">\{stage\.name\}<\/span> — \{stage\.heading\}/,
  );

  /* And `wf__stage-name` is the only workflow rule that reaches for the
     critical token — colouring `.wf__title` would paint the whole line. */
  const css = await read("app/(marketing)/marketing.css");
  const reddened = [...css.matchAll(/(^|\n)(\.wf[\w-]*)\{([^}]*)\}/g)]
    .filter(([, , , body]) => body.includes("var(--critical)"))
    .map(([, , selector]) => selector);
  assert.deepEqual(reddened, [".wf__stage-name"], "something else in the stepper is red");
});

test("all seven workflow stages survive, each with its own approved photograph", async () => {
  const workflow = await read("app/(marketing)/_sections/workflow.tsx");
  const photos = [...workflow.matchAll(/"\/assets\/workflow\/(how-it-works-[^"]+)"/g)].map((m) => m[1]);

  assert.deepEqual(photos, [
    "how-it-works-01-report-v3.jpg",
    "how-it-works-02-triage-v3.png",
    "how-it-works-03-approve-v3.png",
    "how-it-works-04-assign-v3.png",
    "how-it-works-05-attend-v3.png",
    "how-it-works-06-verify-v3.png",
    "how-it-works-07-reporting-v3.png",
  ], "step order, straight from the pack's README");

  /*
   * NOTHING MAY BE NAMED `-full` AGAIN, IN ANY EXTENSION. The re-shot pictures
   * were first published behind the filenames the rejected ones already had,
   * and static assets go out as `max-age=31536000, immutable` — so every
   * returning visitor was served the old blurred-edge bytes from disk cache
   * while the server answered correctly to everyone new. Those files are now
   * deleted, which makes any such reference a 404 as well as the wrong
   * picture. The guard covers every extension, not just .webp, and comments
   * too: naming a deleted file even in an explanation is how it finds its way
   * back into a path.
   */
  assert.ok(
    !/how-it-works-\d\d-[a-z]+-full/.test(workflow),
    "a superseded cache-poisoned filename is referenced again",
  );

  /*
   * And the version marker is the whole defence. Without it a later edit can
   * quietly reuse a stem that browsers already hold, and the symptom — correct
   * bytes on the server, stale bytes on the screen — looks like anything but a
   * naming mistake. Every runtime path must carry it.
   */
  for (const photo of photos) {
    assert.match(photo, /-v3\.(jpg|png)$/, `${photo} has no version marker`);
  }

  assert.equal(new Set(photos).size, 7, "no photograph is reused across two stages");
  assert.equal((workflow.match(/name: "/g) ?? []).length, 7, "seven stages");
  /* Stages 1 and 7 are both called "Report" and have different pictures, so the
     lookup must be positional. A name lookup would put step 1's photograph
     under step 7 and nothing on screen would look wrong. */
  assert.match(workflow, /WORKFLOW_PHOTOS\[active\]/);
});

test("the workflow photograph is a band, not a panorama", async () => {
  const css = await read("app/(marketing)/marketing.css");
  /*
   * `aspect-ratio:21/9` made the picture ~530px tall on a 1240px card, which
   * pushed the badge, the title and the explanation below the fold: the reader
   * saw a photograph and had to scroll to learn which stage it belonged to.
   */
  assert.ok(!/\.wf__photo\{[^}]*aspect-ratio:21\/9/.test(css), "the panorama ratio is gone");
  assert.ok(!/\.wf__photo\{[^}]*height:100%/.test(css), "and so is the height it had nothing to fill");

  const height = css.match(/\.wf__photo\{[^}]*height:(clamp\([^)]*\))/);
  assert.ok(height, ".wf__photo must set a fluid height of its own");
  /* Named bounds rather than an exact expression: the point is that a phone
     gets a low band and a wide desktop is capped, not which arithmetic gets
     there. */
  const [, min, max] = height[1].match(/clamp\((\d+)px,[^,]+,\s*(\d+)px\)/) ?? [];
  assert.ok(Number(min) >= 150 && Number(min) <= 230, `phone band out of range: ${min}px`);
  assert.ok(Number(max) >= 280 && Number(max) <= 380, `desktop cap out of range: ${max}px`);

  /* The height only lands if the <picture> is a block; inline, it collapses to
     a line box and the img's own height leaves a gap under it. */
  assert.match(css, /\.wf__stage picture\{display:block\}/);
  assert.match(css, /\.wf__photo\{[^}]*object-fit:cover/, "cover crops, it never stretches");

  /* Vertical crop means each stage needs its own focal point, carried on the
     stage data and passed through the shared photo component. */
  const workflow = await read("app/(marketing)/_sections/workflow.tsx");
  assert.match(workflow, /objectPosition=\{stage\.focus\}/);
  const photo = await read("app/(marketing)/_sections/approved-photo.tsx");
  assert.match(photo, /objectPosition\?: string/, "and it stays optional for every other caller");
  assert.match(photo, /style=\{objectPosition \? \{ objectPosition \} : undefined\}/);
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
  assert.equal((problem.match(/before: "/g) ?? []).length, 5, "the same five pairs");

  /*
   * A TABLE, ON EVERY WIDTH — this pin changed with the UI batch.
   *
   * It used to require `.comparepair` rows that were "side by side on desktop"
   * and "stacked on a phone". The stacked form was reviewed on a phone and
   * rejected: a column of alternating red and green cards, each with an icon
   * floating beside the text, is not a comparison. The approved shape is a
   * real <table> with two column headers and five rows, two columns at every
   * width down to 320px, and an icon track inside each cell so the icon can
   * never sit on the text.
   */
  assert.match(problem, /<table className="comparetable">/, "real table semantics");
  assert.equal((problem.match(/<th scope="col"/g) ?? []).length, 2, "two column headers");
  assert.match(problem, /Without Maintsupp/);
  assert.match(problem, /With Maintsupp/);
  assert.ok(!problem.includes("comparepair"), "the stacked pairs are gone");

  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, /\.comparetable\{[^}]*table-layout:fixed/, "the columns split 50/50 whatever the copy does");
  assert.match(css, /\.comparetable__inner\{display:grid;grid-template-columns:2[0-9]px minmax\(0,1fr\)/, "a fixed icon track inside each cell");
  assert.ok(!/\.comparetable[^{]*\{[^}]*grid-template-columns:1fr\}/.test(css), "never collapses to one column");
  /* The "with" column is the logo's cyan, the "without" column the critical red. */
  assert.match(css, /\.comparetable__th--gain\{background:var\(--steel-soft\);color:var\(--teal-deep\)\}/);
  assert.match(css, /\.comparetable__th--pain\{background:var\(--critical-bg\);color:var\(--critical\)\}/);
  assert.ok(!/\.comparetable[^{]*\{[^}]*--success/.test(css), "cyan, not green, for the Maintsupp column");
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

test("the founder section renders nothing in place of the photograph", async () => {
  const founder = await read("app/(marketing)/_sections/founder.tsx");
  assert.match(founder, /Who runs Maintsupp/);
  assert.match(founder, /Anwar Shboul — Founder &amp; Director/);
  assert.match(founder, /Maintsupp is founder-led\./);
  assert.match(founder, /\/assets\/photos\/founder-anwar\.jpg/, "the named slot is the only source");
  assert.match(founder, /const FOUNDER_PHOTO_SUPPLIED = false;/, "and it is not supplied yet");
  /*
   * CHANGED WITH THE UI BATCH. This used to require `.founder__frame` — an
   * empty dashed box with a picture icon where the photograph will go. On the
   * page it read as a broken image above the heading and was struck through
   * in review. Nothing renders until the file is supplied; the text takes the
   * width. The <img> path is kept behind the constant so the photograph is a
   * one-line change when it arrives.
   */
  assert.ok(!founder.includes("founder__frame"), "no placeholder frame, no picture icon");
  assert.match(founder, /\{FOUNDER_PHOTO_SUPPLIED && \(/, "the photograph renders only when supplied");
  assert.match(founder, /FOUNDER_PHOTO_SUPPLIED \? " founder--photo" : ""/, "and brings its two-column layout with it");
  const css = await read("app/(marketing)/marketing.css");
  assert.ok(!css.includes(".founder__frame"), "the frame's styles went with it");
  for (const chip of ["Founder-led", "One named coordinator per portfolio", "Mon–Fri, 8:30am–5:30pm"]) {
    assert.ok(founder.includes(chip), `missing chip: ${chip}`);
  }
  assert.ok(!/btn btn--primary|btn--lg/.test(founder), "no CTA in this section");
});

test("the contractor page asks the eleven questions, in order", async () => {
  const page = await read("app/(marketing)/contractors/page.tsx");
  /* `absolute`, because the root layout appends "| MAINTSUPP" to every title
     and the brief specifies this one exactly — a plain string rendered as
     "Join the Contractor Network — Maintsupp | MAINTSUPP". */
  assert.match(page, /title: \{ absolute: "Join the Contractor Network — Maintsupp" \}/);
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
