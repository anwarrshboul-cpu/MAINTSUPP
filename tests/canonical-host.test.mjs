/**
 * The site may declare exactly ONE canonical host, and these are all the files
 * that declare one.
 *
 * Measured on Production on 15 September 2026, it declared two at once. The
 * rendered page said `https://maintsupp.com` in its canonical link and its
 * `og:url`; the `robots.txt` it pointed crawlers at said `https://maintsupp.com`
 * in its self-reference AND in its `Sitemap:` line; all six `<loc>` entries in
 * that sitemap said the apex; and `metadataBase` — the base every relative
 * Open Graph URL is resolved against — said the apex too. So a crawler was told
 * the canonical host by the page and a different one by the sitemap the page
 * sent it to.
 *
 * None of that is visible in a browser and none of it fails a build. It is
 * exactly the kind of drift that arrives one file at a time, which is why the
 * rule is enforced over the whole set rather than pinned file by file: a new
 * file that names the wrong host fails here, and a deliberate change of host
 * fails here ONCE, in one place, with the list of everything that has to move
 * with it.
 *
 * `maintsupp-homepage-update-prompt.md` §10.3 names `https://maintsupp.com/`
 * and that is the host below. Changing it is a real decision — it must be made
 * together with the Vercel primary-domain setting, or the site will publish a
 * canonical URL that redirects.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const load = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** The one host. Everything below is measured against this and nothing else. */
const CANONICAL = "https://maintsupp.com";

/**
 * Every file that states an absolute public URL for this site.
 *
 * Kept as a list rather than a glob on purpose. A glob would silently stop
 * covering a file that moved, and the point of this test is to notice exactly
 * that kind of silence.
 */
const DECLARING = [
  "app/layout.tsx",
  "app/(marketing)/page.tsx",
  "app/(marketing)/contractors/page.tsx",
  /* The CMS route builds a canonical and an og:url from the page's slug. It has to
     declare one: `app/layout.tsx` sets a root `alternates: { canonical: "/" }`, so
     a page that declares none tells a crawler it is the homepage. Added here by
     hand because the header above says why this list is not a glob. */
  "app/(marketing)/p/[slug]/page.tsx",
  "public/robots.txt",
  "public/sitemap.xml",
  "worker/index.ts",
  "vercel/local-check.mjs",
];

/**
 * Absolute maintsupp.com URLs that are NOT claims about this site's canonical
 * host, and so are not this test's business:
 *
 *   · `*.test.maintsupp.com` — the seeded super-admin identities.
 *   · `portal.maintsupp.com` — quoted inside a comment that exists to record
 *     that this host has never served the product, which is the opposite of a
 *     declaration and must stay quotable.
 */
const NOT_A_DECLARATION = /(^|[@./])test\.maintsupp\.com|portal\.maintsupp\.com/;

/**
 * Every maintsupp.com origin a file states, deduplicated and normalised to an
 * origin.
 *
 * Two shapes count. A full URL is the obvious one. The other is a hostname in
 * quotes with no scheme — `const HOST = "maintsupp.com"` is how the
 * pre-deploy harness names the host it probes, and reading only full URLs made
 * that file look as though it declared nothing. A bare hostname in PROSE is
 * deliberately not matched: comments discuss both hosts by name, and they
 * should be able to.
 */
function originsIn(source) {
  const found = new Set();
  const consider = (origin, index, length) => {
    const around = source.slice(Math.max(0, index - 24), index + length + 4);
    if (NOT_A_DECLARATION.test(around)) return;
    found.add(origin);
  };
  for (const match of source.matchAll(/https?:\/\/[A-Za-z0-9.-]*maintsupp\.com/g)) {
    consider(match[0], match.index, match[0].length);
  }
  for (const match of source.matchAll(/["'`]([A-Za-z0-9.-]*maintsupp\.com)["'`]/g)) {
    consider(`https://${match[1]}`, match.index, match[0].length);
  }
  return [...found];
}

test("every file that names this site names the same host", async () => {
  const wrong = [];
  for (const file of DECLARING) {
    for (const origin of originsIn(await load(file))) {
      if (origin !== CANONICAL) wrong.push(`${file}: ${origin}`);
    }
  }
  assert.deepEqual(
    wrong,
    [],
    `these name a host that is not the canonical ${CANONICAL}:\n  ${wrong.join("\n  ")}`,
  );
});

test("every file in the list actually declares a host, so none has gone quiet", async () => {
  /* Half of this test's value is the list. A file that stops naming any host —
     renamed, emptied, refactored — would pass the check above by saying nothing
     at all, and the next drift would then go unnoticed in exactly the file that
     used to be watched. */
  const silent = [];
  for (const file of DECLARING) {
    if (originsIn(await load(file)).length === 0) silent.push(file);
  }
  assert.deepEqual(silent, [], `these no longer declare a host: ${silent.join(", ")}`);
});

test("the crawler entry points agree with the pages they point at", async () => {
  const robots = await load("public/robots.txt");
  const sitemap = await load("public/sitemap.xml");

  assert.match(
    robots,
    new RegExp(`^Sitemap: ${CANONICAL.replace(/[.]/g, "\\.")}/sitemap\\.xml$`, "m"),
    "robots.txt must point at the sitemap on the canonical host, not another one",
  );

  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= 5, `the sitemap should still list the public pages, found ${locs.length}`);
  for (const loc of locs) {
    assert.ok(
      loc.startsWith(`${CANONICAL}/`),
      `sitemap lists ${loc}, which is not on the canonical host`,
    );
  }

  /* A sitemap that lists the login wall would be asking a crawler to index a
     page robots.txt disallows in the same breath. */
  for (const disallowed of ["/dashboard", "/portal", "/login", "/admin", "/api/"]) {
    assert.match(robots, new RegExp(`^Disallow: ${disallowed}$`, "m"), `robots must keep ${disallowed}`);
    assert.ok(
      !locs.some((loc) => loc.startsWith(`${CANONICAL}${disallowed}`)),
      `the sitemap lists ${disallowed}, which robots.txt disallows`,
    );
  }
});

test("the redirect target and the pre-deploy harness use the canonical host too", async () => {
  /* These two are the pair that made the harness silently stop verifying once
     before: the worker began redirecting the host the harness was probing. They
     are checked here as well as in the homepage suite because they belong to
     the same one-host rule, and a reader changing the host needs to find them
     from this file. */
  const worker = await load("worker/index.ts");
  assert.match(
    worker,
    new RegExp(`const CANONICAL_ORIGIN = "${CANONICAL.replace(/[.]/g, "\\.")}";`),
    "the duplicate-host redirect must send visitors to the canonical host",
  );

  const check = await load("vercel/local-check.mjs");
  const host = /const HOST = "([^"]+)";/.exec(check);
  assert.ok(host, "local-check must declare the host it probes");
  assert.equal(
    `https://${host[1]}`,
    CANONICAL,
    "the harness must probe the canonical host, or it is checking a redirect",
  );
});

test("metadataBase resolves relative Open Graph URLs against the canonical host", async () => {
  /* `metadataBase` is not decoration: it is what turns the relative hero image
     path into the absolute URL a share card needs. Pointed at a host that
     redirects, every share card is built on a redirect. */
  const layout = await load("app/layout.tsx");
  assert.match(
    layout,
    new RegExp(`metadataBase: new URL\\("${CANONICAL.replace(/[.]/g, "\\.")}"\\)`),
  );
  assert.match(layout, new RegExp(`url: "${CANONICAL.replace(/[.]/g, "\\.")}"`), "og:url too");
});

test("the preview-alias guard accepts both of this project's production domains", async () => {
  /* `vercel project ls` reports the PRIMARY domain, so the value changes the
     day the primary is switched between the apex and www. Both belong to this
     project, so both are accepted and the guard still catches a third. Pinned
     here rather than in the alias suite because the reason lives with the
     one-host rule. */
  const script = await load("scripts/update-preview-alias.sh");
  assert.match(script, /EXPECTED_PRODUCTION="\$\{EXPECTED_PRODUCTION:-https:\/\/www\.maintsupp\.com\}"/);
  assert.match(script, /EXPECTED_PRODUCTION_ALT="\$\{EXPECTED_PRODUCTION_ALT:-https:\/\/maintsupp\.com\}"/);
  assert.match(
    script,
    /production_verdict "\$before" "\$after" "\$EXPECTED_PRODUCTION\|\$EXPECTED_PRODUCTION_ALT"/,
    "both must actually reach the verdict, not just be declared",
  );
});
