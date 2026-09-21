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
 * WHEN GIT CANNOT ANSWER. Two cases, one behaviour: no `.git` at all, and a
 * SHALLOW clone. The second is the one that nearly shipped. Vercel clones at
 * depth 1, and `git log -1 -- <file>` in a shallow repository does not fail —
 * it cheerfully returns the boundary commit, so every page that had not been
 * touched since the clone horizon reported the same recent date. Measured on
 * the first deploy of this script: /faqs, /terms and /cookies came back
 * 2026-09-17 when their real dates are 2026-08-14. Wrong dates that look
 * plausible are worse than the frozen ones they replaced.
 *
 * So both cases REUSE THE DATE ALREADY IN THE FILE rather than inventing one.
 * The committed sitemap is the record, written by a full clone; a shallow
 * build republishes it untouched and says so in the build log.
 * tests/sitemap-lastmod.test.mjs keeps that record honest by regenerating it
 * wherever full history IS available.
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
 * Shared structured data and breadcrumbs are included too: changing the public
 * identity or navigation changes the rendered page even when page.tsx is untouched.
 */
const ROUTES = [
  { path: "/",            changefreq: "weekly",  priority: "1.0", sources: ["app/(marketing)/page.tsx", "app/(marketing)/_sections", "app/(marketing)/_components/structured-data.ts"] },
  { path: "/contractors", changefreq: "monthly", priority: "0.8", sources: ["app/(marketing)/contractors/page.tsx", "app/(marketing)/_components"] },
  { path: "/faqs",        changefreq: "monthly", priority: "0.7", sources: ["app/(marketing)/faqs/page.tsx", "app/(marketing)/_components"] },
  { path: "/privacy",     changefreq: "yearly",  priority: "0.3", sources: ["app/(marketing)/privacy/page.tsx", "app/(marketing)/_components"] },
  { path: "/terms",       changefreq: "yearly",  priority: "0.3", sources: ["app/(marketing)/terms/page.tsx", "app/(marketing)/_components"] },
  { path: "/cookies",     changefreq: "yearly",  priority: "0.3", sources: ["app/(marketing)/cookies/page.tsx", "app/(marketing)/_components"] },
];

/**
 * Whether git's history here is too shallow to be asked about a file's age.
 *
 * `--is-shallow-repository` is the only reliable tell. A truncated history
 * answers `git log` without complaint and without saying the answer is a
 * horizon rather than a commit, which is precisely how the boundary date
 * reached six pages of a published sitemap.
 */
function historyIsTruncated() {
  try {
    return execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() !== "false";
  } catch {
    /* No git, no repository, no answer — same conclusion. */
    return true;
  }
}

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
const truncated = historyIsTruncated();
const unresolved = [];

const entries = ROUTES.map((route) => {
  const dated = truncated ? null : lastCommitDate(route.sources);
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

if (truncated) {
  console.warn(
    "generate-sitemap: history is shallow or absent, so every date was kept as published. " +
      "Expected on Vercel, which clones at depth 1. Run this in a full clone to refresh them.",
  );
} else if (unresolved.length) {
  console.warn(
    `generate-sitemap: git knows of no commit touching ${unresolved.join(", ")} — kept the published date.`,
  );
}
console.log(
  `generate-sitemap: ${entries.length} urls — ` +
    entries.map((e) => `${e.path} ${e.lastmod}`).join(", "),
);
