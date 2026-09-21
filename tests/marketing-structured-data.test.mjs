import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  organization, website, breadcrumbData, jsonLd, ORGANIZATION_ID, WEBSITE_ID,
} from "../app/(marketing)/_components/structured-data.ts";

// These are public claims, not implementation trivia: changes must not revive
// the former legal identity, invent social proof or create a preview entity.
test("the public graph identifies the confirmed business and one website", () => {
  assert.equal(organization.legalName, "MAINTSUPP LTD");
  assert.equal(organization.identifier.value, "17262302");
  assert.equal(organization.identifier.propertyID, "GB-CRN");
  assert.equal(organization["@id"], "https://maintsupp.com/#organization");
  assert.equal(website.publisher["@id"], ORGANIZATION_ID);
  assert.equal(website["@id"], WEBSITE_ID);
  assert.equal(website.inLanguage, "en-GB");
  assert.equal(organization["@type"], "Organization");
  assert.ok(!("sameAs" in organization));
  assert.ok(!("address" in organization));
  assert.equal(organization.contactPoint.hoursAvailable.opens, "08:30");
  assert.equal(organization.contactPoint.hoursAvailable.closes, "17:30");
  assert.equal(organization.contactPoint.hoursAvailable.dayOfWeek.length, 5);
});

test("the logo is a real square PNG large enough for the Organization", async () => {
  const png = await readFile(new URL("../public/apple-touch-icon.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), organization.logo.width);
  assert.equal(png.readUInt32BE(20), organization.logo.height);
  assert.ok(organization.logo.width >= 112);
  assert.equal(organization.logo.width, organization.logo.height);
});

test("nested breadcrumb positions and destinations follow the visible hierarchy", () => {
  const items = [
    { name: "Home", path: "/" },
    { name: "Services", path: "/services" },
    { name: "Reactive maintenance", path: "/services/reactive-maintenance" },
  ];
  const result = breadcrumbData(items);
  assert.equal(result["@type"], "BreadcrumbList");
  assert.deepEqual(result.itemListElement.map((item) => item.position), [1, 2, 3]);
  assert.deepEqual(result.itemListElement.map((item) => item.name), items.map((item) => item.name));
  assert.deepEqual(result.itemListElement.map((item) => item.item), [
    "https://maintsupp.com/", "https://maintsupp.com/services", "https://maintsupp.com/services/reactive-maintenance",
  ]);
});

test("JSON-LD labels cannot terminate their script element", () => {
  const input = { name: "Example </script><script>alert(1)</script>" };
  const encoded = jsonLd(input);
  assert.ok(!encoded.includes("<"));
  assert.deepEqual(JSON.parse(encoded), input);
});

test("every existing non-homepage marketing route has visible breadcrumbs", async () => {
  for (const route of ["contractors", "faqs", "privacy", "terms", "cookies"]) {
    const page = await readFile(new URL(`../app/(marketing)/${route}/page.tsx`, import.meta.url), "utf8");
    assert.match(page, /<Breadcrumbs items=/, route);
    assert.ok(page.includes(`path: "/${route}"`), route);
  }
  const cms = await readFile(new URL("../app/(marketing)/p/[slug]/page.tsx", import.meta.url), "utf8");
  assert.match(cms, /<Breadcrumbs items=/);
  assert.ok(cms.includes("path: `/p/${page.slug}`"));
  const component = await readFile(new URL("../app/(marketing)/_components/breadcrumbs.tsx", import.meta.url), "utf8");
  assert.match(component, /aria-label="Breadcrumb"/);
  assert.match(component, /aria-current="page"/);
  assert.doesNotMatch(component, /["']use client["']/);
});
