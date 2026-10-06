/**
 * The London pages: seventeen addresses, one renderer, and the rules that keep
 * them honest.
 *
 * WHY THIS FILE EXISTS. The pages are data (`app/(marketing)/_landing/`), and
 * data is where a claim slips in without a diff anybody reads as code. Each
 * assertion below is a rule the owner set or a limit a search engine imposes,
 * written down so that the next edit to a page's words is held to it:
 *
 *   - a title and a description that fit where they are shown;
 *   - one page per address, and one address per page;
 *   - the areas in the owner's order — North, East, West, South — behind the
 *     three centres he named first;
 *   - only the public telephone number, on any marketing page, ever;
 *   - no claim to be a shopping centre's approved contractor;
 *   - commercial premises only, said on every service page;
 *   - every link on these pages lands on a page that exists.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");

const { LANDING_PAGES, landingPage } = await import("../app/(marketing)/_landing/index.ts");
const { PHONE_DISPLAY, PHONE_HREF } = await import("../app/(marketing)/_landing/types.ts");
const { serviceData, faqPageData, ORGANIZATION_ID } = await import(
  "../app/(marketing)/_components/structured-data.ts"
);
const { SITE_ROUTES, FOOTER_DEFAULTS, cleanNavHref } = await import("../app/lib/site-navigation.ts");

const ORIGIN = "https://maintsupp.com";
/** What the root layout's template adds to every bare title. */
const SUFFIX = " | MAINTSUPP";

const MARKETING = "app/(marketing)";
const routeFile = (page) => `${MARKETING}${page.path}/page.tsx`;

test("there are seventeen, in the order the owner set", () => {
  assert.deepEqual(
    LANDING_PAGES.map((page) => page.path),
    [
      "/london",
      "/london/kiosk-installation",
      "/london/shop-strip-out",
      "/london/shop-fit-out",
      "/london/commercial-electrician",
      "/london/commercial-handyman",
      "/london/commercial-painters-decorators",
      "/london/commercial-carpentry",
      "/london/emergency-repairs",
      "/london/shop-maintenance",
      /* The three centres the owner named as most important, in his order. */
      "/london/westfield-stratford-city",
      "/london/westfield-london-white-city",
      "/london/brent-cross",
      /* Then the areas: north first, then east, then west, and south last. */
      "/london/north-london",
      "/london/east-london",
      "/london/west-london",
      "/london/south-london",
    ],
  );

  /* The hub shows them in that order too: centres, then areas. */
  const shown = landingPage("/london").places.items.map((place) => place.href);
  assert.deepEqual(shown, [
    "/london/westfield-stratford-city",
    "/london/westfield-london-white-city",
    "/london/brent-cross",
    "/london/north-london",
    "/london/east-london",
    "/london/west-london",
    "/london/south-london",
  ]);
});

test("every page has a route file that names its own address and shares as itself", () => {
  for (const page of LANDING_PAGES) {
    const file = routeFile(page);
    assert.ok(existsSync(path.join(root, file)), `${page.path} has no route file`);
    const source = read(file);
    assert.ok(source.includes(`landingPage("${page.path}")`), `${file} draws another page's words`);
    assert.ok(
      source.includes(`alternates: { canonical: "${ORIGIN}${page.path}" }`),
      `${file} does not declare its own canonical`,
    );
    assert.ok(source.includes(`...pageSocial("${page.path}",`), `${file} would share as another page`);
  }
  /* And nothing is under /london that the list does not know about. */
  const onDisk = readdirSync(path.join(root, MARKETING, "london"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/london/${entry.name}`);
  assert.deepEqual(
    [...onDisk].sort(),
    LANDING_PAGES.filter((page) => page.path !== "/london").map((page) => page.path).sort(),
  );
});

test("titles and descriptions fit where a search engine shows them", () => {
  for (const page of LANDING_PAGES) {
    const title = `${page.title}${SUFFIX}`;
    assert.ok(title.length <= 60, `${page.path}: "${title}" is ${title.length} characters, over 60`);
    assert.ok(page.title.length >= 25, `${page.path}: the title says too little`);
    assert.doesNotMatch(page.title, /maintsupp/i, `${page.path}: the template adds the brand once`);
    assert.ok(
      page.description.length >= 110 && page.description.length <= 160,
      `${page.path}: the description is ${page.description.length} characters; keep it between 110 and 160`,
    );
  }
  for (const field of ["title", "h1", "description", "path", "emailSubject"]) {
    const values = LANDING_PAGES.map((page) => page[field]);
    assert.equal(new Set(values).size, values.length, `two pages share a ${field}`);
  }
});

test("each page names London, or the place it is about, where it counts", () => {
  for (const page of LANDING_PAGES) {
    const place = page.place?.name.split(" ")[0] ?? "London";
    assert.ok(
      page.title.includes(place) || page.title.includes("London"),
      `${page.path}: the title does not say where`,
    );
    assert.ok(page.h1.includes(place) || page.h1.includes("London"), `${page.path}: the H1 does not say where`);
  }
});

test("only the public number is ever shown on a marketing page", () => {
  assert.equal(PHONE_DISPLAY, "07852 224644");
  assert.equal(PHONE_HREF, "tel:+447852224644");
  /* The owner's private mobile must never reach the site. Walked, not listed:
     a file added tomorrow is covered on the day it is added. */
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const target = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(target);
      else if (/\.(ts|tsx|css)$/.test(entry.name)) {
        const digits = read(target).replace(/[\s()-]/g, "");
        if (/7838504004/.test(digits)) offenders.push(target);
      }
    }
  };
  walk(MARKETING);
  assert.deepEqual(offenders, [], "a private number is in the marketing source");
});

test("no page claims to be a centre's approved contractor", () => {
  /*
   * A shopping centre keeps its own approved list, and MAINTSUPP is not on any
   * page of this site said to be on one. The centre pages answer the question
   * directly instead, and the answer has to keep saying "independent".
   */
  for (const page of LANDING_PAGES) {
    const said = [
      page.title, page.description, page.h1, page.lede,
      ...page.cards.items.map((card) => card.body),
      ...(page.points?.items ?? []),
      ...page.faqs.map((entry) => entry.a),
    ].join(" ");
    assert.doesNotMatch(
      said,
      /\b(approved|authorised|authorized|nominated|accredited|preferred)\s+(by|contractor|supplier|partner)\b/i,
      `${page.path} claims a status no centre has given`,
    );
  }
  const centres = LANDING_PAGES.filter((page) => page.kind === "centre");
  assert.equal(centres.length, 3);
  for (const page of centres) {
    const asked = page.faqs.find((entry) => /approved contractor/i.test(entry.q));
    assert.ok(asked, `${page.path} does not answer the question it will be asked`);
    assert.match(asked.a, /independent of/, `${page.path}: the answer must say MAINTSUPP is independent`);
    assert.match(asked.a, /works for the tenant/);
    /* The owner confirmed real jobs in all three on 4 October 2026. */
    assert.ok(
      page.faqs.some((entry) => /coordinated jobs inside the centre/.test(entry.a)),
      `${page.path} should say the work there is not hypothetical`,
    );
    assert.ok(page.place, `${page.path} has no address for its structured data`);
    assert.match(page.place.postalCode, /^[A-Z]{1,2}\d{1,2}[A-Z]? \d[A-Z]{2}$/);
  }
});

test("every page says who does the work, and that it is commercial only", () => {
  for (const page of LANDING_PAGES) {
    const answers = page.faqs.map((entry) => entry.a).join(" ");
    const everything = `${page.lede} ${answers} ${(page.points?.items ?? []).join(" ")}`;
    assert.match(
      everything,
      /independent (electrical )?contractors|does not employ tradespeople/,
      `${page.path} never says the work is done by independent contractors`,
    );
    /* A kiosk on a mall is commercial by its nature, so naming the shopping
       centre counts as saying who the page is for — and so does a centre page
       saying "a single shop or kiosk", which is its whole readership. */
    assert.match(
      everything,
      /commercial premises|commercial only|shops, kiosks|shopping centre|shop or kiosk/i,
      `${page.path} never says who it is for`,
    );
    assert.ok(page.faqs.length >= 6, `${page.path} answers too few questions`);
    const asked = page.faqs.map((entry) => entry.q);
    assert.equal(new Set(asked).size, asked.length, `${page.path} asks the same question twice`);
    for (const entry of page.faqs) {
      assert.ok(entry.a.length <= 900, `${page.path}: an answer runs past 900 characters`);
    }
  }
});

test("no arrival time is promised", () => {
  /* The emergency line is answered at any hour. What is NOT promised is how
     soon somebody arrives, on any page, in any form. */
  for (const page of LANDING_PAGES) {
    const said = JSON.stringify(page);
    assert.doesNotMatch(
      said,
      /within (an|one|two|\d+) ?(hour|hours|minutes|mins)\b|\b\d+[- ](minute|hour) response|guaranteed response/i,
      `${page.path} promises an arrival time`,
    );
  }
});

test("every link on a London page lands on a page that exists", () => {
  const known = new Set([
    ...LANDING_PAGES.map((page) => page.path),
    "/", "/services", "/how-it-works", "/pricing", "/case-study", "/contact", "/contractors", "/faqs",
  ]);
  for (const page of LANDING_PAGES) {
    const hrefs = [
      ...page.cards.items.map((card) => card.href),
      ...(page.places?.items.map((place) => place.href) ?? []),
      ...page.related.map((link) => link.href),
    ].filter(Boolean);
    for (const href of hrefs) {
      assert.ok(known.has(href), `${page.path} links to ${href}, which is not a page`);
      assert.notEqual(href, page.path, `${page.path} lists itself as related`);
    }
    /* Every page but the hub leads back to it, by breadcrumb and by link. */
    if (page.kind !== "hub") {
      assert.ok(
        hrefs.includes("/london") || page.kind === "service",
        `${page.path} has no link back to the hub`,
      );
    }
    assert.ok(page.related.length >= 4, `${page.path} offers too few ways onward`);
  }
  /* And the hub reaches every one of the sixteen. */
  const hub = landingPage("/london");
  const fromHub = new Set([
    ...hub.cards.items.map((card) => card.href),
    ...hub.places.items.map((place) => place.href),
  ]);
  for (const page of LANDING_PAGES.filter((entry) => entry.kind !== "hub")) {
    assert.ok(fromHub.has(page.path), `the hub does not link to ${page.path}`);
  }
});

test("the photographs are ones the site already ships, with their own alt text", async () => {
  const manifest = read(`${MARKETING}/_sections/asset-widths.ts`);
  for (const page of LANDING_PAGES) {
    assert.ok(manifest.includes(`"${page.photo.src}"`), `${page.path} draws a photograph the manifest does not know`);
    assert.ok(existsSync(path.join(root, "public", page.photo.src)), `${page.photo.src} is not on disk`);
    assert.ok(page.photo.alt.length >= 40, `${page.path}: the alt text does not describe the picture`);
    assert.doesNotMatch(page.photo.alt, /^(image|photo|picture) of/i);
    /* A stock scene is not the centre. The alt text must not say it is. */
    assert.doesNotMatch(page.photo.alt, /Westfield|Brent Cross/, `${page.path}: the picture is not of that centre`);
  }
});

test("the London pages' own pictures: every variant exists, none is shared, none is named after a centre", () => {
  /*
   * Twelve pages got pictures of their own in October 2026 (generated
   * illustrations supplied by the owner). Three things could quietly go wrong
   * with them, and each is checked here rather than trusted:
   *   - a variant the manifest advertises but the install never wrote, which a
   *     browser would fetch and get a 404 for instead of the picture;
   *   - two pages drifting back onto one shared picture;
   *   - a file NAMED after a centre. Image search reads file names, so a picture
   *     called after Westfield would claim to show it — the claim the alt text
   *     is already forbidden to make. The files are named for what they show.
   */
  const manifest = read(`${MARKETING}/_sections/asset-widths.ts`);
  const own = LANDING_PAGES.filter((page) => page.photo.src.startsWith("/assets/pages/london-"));
  assert.equal(own.length, 12, "the twelve service and area pages each have their own picture");
  assert.equal(new Set(own.map((page) => page.photo.src)).size, own.length, "no two pages share a picture");
  for (const page of own) {
    const src = page.photo.src;
    assert.doesNotMatch(src, /westfield|stratford|white-city|brent-cross/, `${src} is named after a centre`);
    const entry = manifest.match(new RegExp(`"${src.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}": \\{\\s*"widths": \\[([^\\]]*)\\]`));
    assert.ok(entry, `${src} has no widths in the manifest`);
    const widths = entry[1].split(",").map((n) => Number(n.trim())).filter(Boolean);
    assert.ok(widths.length > 0, `${src} advertises no variants`);
    const stem = src.replace(/\.jpg$/, "");
    for (const width of widths) {
      for (const ext of ["avif", "webp"]) {
        assert.ok(existsSync(path.join(root, "public", `${stem}-${width}.${ext}`)), `${stem}-${width}.${ext} is missing`);
      }
    }
  }
});

test("the sitemap, the navigation and the footer all know the pages", () => {
  const sitemap = read("public/sitemap.xml");
  const routes = new Set(SITE_ROUTES.map((route) => route.path));
  for (const page of LANDING_PAGES) {
    assert.ok(sitemap.includes(`<loc>${ORIGIN}${page.path}</loc>`), `${page.path} is not in the sitemap`);
    assert.ok(routes.has(page.path), `${page.path} is not a destination a menu may name`);
    assert.equal(cleanNavHref(page.path), page.path);
  }
  const services = FOOTER_DEFAULTS.find((group) => group.id === "services");
  const hrefs = services.links.map((link) => link.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "no two footer links go to the same place");
  assert.ok(hrefs.includes("/london"), "the footer reaches the hub from every page");
  for (const href of hrefs) assert.equal(cleanNavHref(href), href, `${href} is not a valid destination`);
  /* robots.txt must let a crawler reach them. */
  const robots = read("public/robots.txt");
  assert.doesNotMatch(robots, /Disallow: \/london/);
  assert.match(robots, /Sitemap: https:\/\/maintsupp\.com\/sitemap\.xml/);
});

test("the structured data describes one service by the one organisation", () => {
  const centre = landingPage("/london/brent-cross");
  const service = serviceData({
    path: centre.path,
    name: centre.h1,
    serviceType: centre.serviceType,
    description: centre.description,
    place: centre.place,
  });
  assert.equal(service["@type"], "Service");
  assert.equal(service["@id"], `${ORIGIN}/london/brent-cross#service`);
  assert.deepEqual(service.provider, { "@id": ORGANIZATION_ID }, "a reference, never a second organisation");
  assert.equal(service.areaServed["@type"], "Place");
  assert.equal(service.areaServed.address.postalCode, "NW4 3FP");
  /* The emergency line: every day, all day — and it is the public number. */
  const line = service.availableChannel.servicePhone;
  assert.equal(line.telephone, "+44 7852 224644");
  assert.equal(line.hoursAvailable.dayOfWeek.length, 7);
  assert.equal(line.hoursAvailable.opens, "00:00");

  const area = serviceData({ path: "/london/north-london", name: "x", serviceType: "y", description: "z", area: "North London" });
  assert.equal(area.areaServed.name, "North London");
  assert.equal(area.areaServed.containedInPlace.name, "London");
  const city = serviceData({ path: "/london", name: "x", serviceType: "y", description: "z" });
  assert.deepEqual(city.areaServed, { "@type": "City", name: "London" });

  const faq = faqPageData(centre.path, centre.faqs);
  assert.equal(faq["@type"], "FAQPage");
  assert.equal(faq.mainEntity.length, centre.faqs.length);
  assert.equal(faq.mainEntity[0].acceptedAnswer.text, centre.faqs[0].a);

  /* The renderer draws both, and draws the questions it marks up. */
  const renderer = read(`${MARKETING}/_landing/landing-page.tsx`);
  assert.match(renderer, /serviceData\(\{/);
  assert.match(renderer, /faqPageData\(page\.path, page\.faqs\)/);
  assert.match(renderer, /page\.faqs\.map\(/);
  assert.doesNotMatch(renderer, /["']use client["']/, "the pages are server-rendered, so a crawler reads them whole");
});

test("the homepage and the shared questions say what the London pages say", () => {
  const copy = read(`${MARKETING}/_sections/copy.ts`);
  /* The H1 names the three buyers; "one point of contact" is still the offer.
     Its length and word order were measured in a browser: four lines at every
     width from 360 to 1920, as the headline it replaced. */
  assert.match(copy, /titleLead: "Multi-site, shop and kiosk maintenance,"/);
  assert.match(copy, /titleAccent: "managed through one point of contact\."/);
  assert.match(copy, /title: "Shop & Commercial Maintenance, London & UK-Wide — MAINTSUPP"/);
  assert.match(copy, /We do not take domestic work\./);

  const content = read(`${MARKETING}/_sections/content.ts`);
  assert.match(content, /"q": "Do you take one-off jobs for a single shop or kiosk\?"/);
  assert.match(content, /"q": "Do you offer 24\/7 emergency call-outs\?"/);
  /* The line that used to contradict it is gone from the same list. */
  assert.doesNotMatch(content, /or a 24\/7 national team/);
  /* And the footer no longer reads as "closed at 5:30" to a shop with a fault. */
  const chrome = read(`${MARKETING}/_sections/chrome.tsx`);
  assert.match(chrome, /Mon – Fri: 8:30am – 5:30pm/);
  assert.match(chrome, /Emergencies in London: 24 hours/);
});
