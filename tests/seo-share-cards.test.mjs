/**
 * QA 2026-10-01 against the live site: every subpage shared as the homepage
 * (og:url, og:title, twitter:* inherited from the root), the homepage had no
 * og:image, /login and the 404 page claimed the homepage canonical, four public
 * pages read "... | MAINTSUPP | MAINTSUPP", and the hero photograph stayed at
 * opacity 0 until the page hydrated.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every marketing page shares as itself, with an image", async () => {
  for (const [file, path] of [
    ["app/(marketing)/page.tsx", "/"],
    ["app/(marketing)/services/page.tsx", "/services"],
    ["app/(marketing)/how-it-works/page.tsx", "/how-it-works"],
    ["app/(marketing)/pricing/page.tsx", "/pricing"],
    ["app/(marketing)/case-study/page.tsx", "/case-study"],
    ["app/(marketing)/contact/page.tsx", "/contact"],
    ["app/(marketing)/contractors/page.tsx", "/contractors"],
    ["app/(marketing)/faqs/page.tsx", "/faqs"],
    ["app/(marketing)/privacy/page.tsx", "/privacy"],
    ["app/(marketing)/terms/page.tsx", "/terms"],
    ["app/(marketing)/cookies/page.tsx", "/cookies"],
  ]) {
    const source = await read(file);
    assert.match(source, new RegExp(`\\.\\.\\.pageSocial\\("${path.replace("/", "\\/")}",`), file);
  }
  const social = await read("app/lib/page-social.ts");
  assert.match(social, /images: \[SHARE_IMAGE\]/);
  assert.match(social, /card: "summary_large_image"/);
});

test("no root canonical, private screens are noindex, no doubled suffix", async () => {
  assert.doesNotMatch((await read("app/layout.tsx")).replace(/\/\*[\s\S]*?\*\//g, ""), /canonical: "\/"/);
  assert.match(await read("app/(app)/layout.tsx"), /robots: \{ index: false, follow: false \}/);
  for (const file of [
    "app/(public)/j/[token]/page.tsx",
    "app/(public)/r/[action]/[token]/page.tsx",
    "app/(public)/reset/[token]/page.tsx",
    "app/(public)/invite/[token]/page.tsx",
  ]) {
    assert.doesNotMatch((await read(file)).replace(/\/\/.*$/gm, ""), /title: "[^"]*\| MAINTSUPP"/, file);
  }
});

test("the hero photograph paints with the HTML", async () => {
  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, /\.hero \.ph__img\{opacity:1;transition:none\}/);
});
