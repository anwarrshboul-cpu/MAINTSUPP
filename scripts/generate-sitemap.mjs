/**
 * Generates public/sitemap.xml with a REAL lastmod per page.
 *
 * WHY THIS EXISTS. The file used to be hand-written, and every one of its six
 * entries claimed 2026-09-09 for months while the pages underneath them kept
 * changing — the homepage alone was rewritten three times after that date. A
 * lastmod that never moves is worse than no lastmod at all: Google learns the
 * field is noise on this host and stops using it to schedule recrawls, which
 * is the one job the field has.
 *
 * WHERE THE DATE COMES FROM. `git log -1` on the files that actually render
 * the page. Not the build clock — stamping today onto all six pages on every
 * deploy is the same lie told faster, and Google distrusts that shape too.
 *
 * WHEN GIT IS NOT THERE. A build container without `.git` cannot answer the
 * question, so this REUSES THE DATE ALREADY IN THE FILE rather than inventing
 * one. The sitemap then ages instead of lying, and the warning below says so
 * in the build log. It never writes a date it cannot justify.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const OUT = "public/sitemap.xml";

/*
 * Kept equal to CANONICAL_ORIGIN in worker/index.ts, which is the host every
 * other signal on the site names. tests/sitemap-lastmod.test.mjs fails if the
 * two ever drift, because a sitemap advertising a different host than the
 * canonical tag is the exact contradiction this project just finished fixing.
 */
const ORIGIN = "https://maintsupp.com";

/*
 * `sources` is what the page is MADE of, not merely the file named after it.
 * The homepage is assembled from `_sections/`, so a rewrite of the hero lives
 * there and nowhere near `page.tsx`; crediting only `page.tsx` would report
 * the homepage as untouched through exactly the changes that matter most.
 * The legal pages own their whole selves and list only themselves.
 */
const ROUTES = [
  { path: "/",            changefreq: "weekly",  priority: "1.0", sources: ["app/(marketing)/page.tsx", "app/(marketing)/_sections"] },
  { path: "/contractors", changefreq: "monthly", priority: "0.8", sources: ["app/(marketing)/contractors/page.tsx"] },
  { path: "/faqs",        changefreq: "monthly", priority: "0.7", sources: ["app/(marketing)/faqs/page.tsx"] },
  { path: "/privacy",     changefreq: "yearly",  priority: "0.3", sources: ["app/(marketing)/privacy/page.tsx"] },
  { path: "/terms",       changefreq: "yearly",  priority: "0.3", sources: ["app/(marketing)/terms/page.tsx"] },
  { path: "/cookies",     changefreq: "yearly",  priority: "0.3", sources: ["app/(marketing)/cookies/page.tsx"] },
];

/** The last commit date touching any of `paths`, as YYYY-MM-DD, or null. */
function lastCommitDate(paths) {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cs", "--", ...paths],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    /* An empty answer is a real answer: git ran and knows of no such commit.
       A shallow clone deep enough to run but too shallow to reach the file
       lands here too, which is why an empty string is treated as "unknown"
       and falls through to the previous value rather than to today. */
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** The lastmod values already published, keyed by path. */
async function previousDates() {
  const map = new Map();
  try {
    const xml = await readFile(OUT, "utf8");
    for (const block of xml.split("<url>").slice(1)) {
      const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
      const mod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
      if (loc && mod) map.set(new URL(loc).pathname, mod);
    }
  } catch {
    /* No file yet — first run. */
  }
  return map;
}

const previous = await previousDates();
const unresolved = [];

const entries = ROUTES.map((route) => {
  const dated = lastCommitDate(route.sources);
  if (!dated) unresolved.push(route.path);
  return { ...route, lastmod: dated ?? previous.get(route.path) ?? null };
});

const missing = entries.filter((e) => !e.lastmod);
if (missing.length) {
  console.error(
    `generate-sitemap: no date, from git or from the existing file, for ${missing
      .map((e) => e.path)
      .join(", ")}.`,
  );
  process.exit(1);
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) => `  <url>
    <loc>${ORIGIN}${e.path}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`,
  )
  .join("\n")}
</urlset>
`;

await writeFile(OUT, xml);

if (unresolved.length) {
  console.warn(
    `generate-sitemap: git could not date ${unresolved.join(", ")} — kept the published date. ` +
      `Expected in a build container without .git; not expected locally.`,
  );
}
console.log(
  `generate-sitemap: ${entries.length} urls — ` +
    entries.map((e) => `${e.path} ${e.lastmod}`).join(", "),
);
