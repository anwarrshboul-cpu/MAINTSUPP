/**
 * Public identity, shared by the homepage graph and each page's breadcrumbs.
 * These IDs always name production, including on a preview: a preview must not
 * create a second business entity. Social profiles are deliberately absent
 * until the owner supplies real URLs. The registered office is not a trading
 * location, so this describes an Organization, never a LocalBusiness.
 */
export const SITE_ORIGIN = "https://maintsupp.com";
export const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
export const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

export const organization = {
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: "MAINTSUPP",
  legalName: "MAINTSUPP LTD",
  url: `${SITE_ORIGIN}/`,
  logo: {
    "@type": "ImageObject",
    url: `${SITE_ORIGIN}/apple-touch-icon.png`,
    width: 180,
    height: 180,
  },
  image: `${SITE_ORIGIN}/assets/photos/hero-london-maintenance.jpg`,
  /* Widened in October 2026 with the proposition: one-off jobs for a single
     shop or kiosk in London sit beside the monthly plans for five sites and
     above. It still says "coordinates" and "vetted contractor network", because
     that is the model and the owner's copy rules hold it to that. */
  description: "MAINTSUPP coordinates repairs, planned maintenance, compliance administration and store works for commercial premises through a vetted contractor network: one-off jobs for shops and kiosks in London, and monthly coordination for UK portfolios of five or more sites.",
  foundingDate: "2026-06-04",
  founder: { "@type": "Person", name: "Anwar Shboul" },
  telephone: "+44 7852 224644",
  email: "info@maintsupp.com",
  identifier: {
    "@type": "PropertyValue",
    propertyID: "GB-CRN",
    value: "17262302",
  },
  areaServed: [
    { "@type": "Country", name: "United Kingdom" },
    { "@type": "City", name: "London" },
  ],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer service",
    telephone: "+44 7852 224644",
    email: "info@maintsupp.com",
    availableLanguage: "en",
    hoursAvailable: {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map(
        (day) => `https://schema.org/${day}`,
      ),
      opens: "08:30",
      closes: "17:30",
    },
  },
  knowsAbout: [
    "Multi-site commercial maintenance coordination",
    "Reactive maintenance coordination",
    "Planned preventive maintenance",
    "Compliance administration",
    "Contractor coordination",
    "Maintenance reporting",
    "Retail kiosk installation and removal",
    "Shop strip-out and fit-out works",
    "Commercial electrical, carpentry and decorating trades",
    "Emergency repairs for commercial premises in London",
  ],
};

export const website = {
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: "MAINTSUPP",
  url: `${SITE_ORIGIN}/`,
  publisher: { "@id": ORGANIZATION_ID },
  inLanguage: "en-GB",
};

export type BreadcrumbItem = { name: string; path: string };

/** One ordered input drives both navigation and JSON-LD, preventing drift. */
export function breadcrumbData(items: readonly BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": `${SITE_ORIGIN}${items.at(-1)?.path ?? "/"}#breadcrumb`,
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${SITE_ORIGIN}${item.path}`,
    })),
  };
}

/** A future label containing </script> must remain text, not close the tag. */
export function jsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/* ------------------------------------------------------------------ */
/* The London pages                                                    */
/* ------------------------------------------------------------------ */

/**
 * The emergency line, as a contact point of its own.
 *
 * NOT added to `organization.contactPoint`, which stays the office line with
 * office hours — `tests/marketing-structured-data.test.mjs` pins those hours,
 * and they are still true of the office. The round-the-clock line is for
 * emergencies at commercial premises in London, so it is declared on the
 * services it belongs to rather than on the company as a whole.
 */
const EMERGENCY_LINE = {
  "@type": "ContactPoint",
  contactType: "emergency",
  telephone: "+44 7852 224644",
  areaServed: { "@type": "City", name: "London" },
  availableLanguage: "en",
  hoursAvailable: {
    "@type": "OpeningHoursSpecification",
    dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map(
      (day) => `https://schema.org/${day}`,
    ),
    opens: "00:00",
    closes: "23:59",
  },
};

export type ServiceInput = {
  path: string;
  name: string;
  serviceType: string;
  description: string;
  /** A named area inside London ("North London"), when the page is about one. */
  area?: string;
  /** A named centre with its address, when the page is about one. */
  place?: { name: string; streetAddress: string; postalCode: string };
};

/**
 * One service, offered by the one organisation, in one place.
 *
 * `provider` is a reference to the homepage's Organization rather than a second
 * copy of it: a page that restated the company would be a second entity for a
 * crawler to reconcile, which is the mistake the `@id` scheme exists to prevent.
 */
export function serviceData(input: ServiceInput) {
  const areaServed = input.place
    ? {
        "@type": "Place",
        name: input.place.name,
        address: {
          "@type": "PostalAddress",
          streetAddress: input.place.streetAddress,
          addressLocality: "London",
          postalCode: input.place.postalCode,
          addressCountry: "GB",
        },
      }
    : input.area
      ? { "@type": "AdministrativeArea", name: input.area, containedInPlace: { "@type": "City", name: "London" } }
      : { "@type": "City", name: "London" };
  return {
    "@type": "Service",
    "@id": `${SITE_ORIGIN}${input.path}#service`,
    name: input.name,
    serviceType: input.serviceType,
    description: input.description,
    url: `${SITE_ORIGIN}${input.path}`,
    provider: { "@id": ORGANIZATION_ID },
    areaServed,
    audience: { "@type": "BusinessAudience", name: "Retailers and commercial operators" },
    availableChannel: {
      "@type": "ServiceChannel",
      serviceUrl: `${SITE_ORIGIN}${input.path}`,
      servicePhone: EMERGENCY_LINE,
    },
  };
}

/** The page's own questions. Only what the page visibly asks and answers. */
export function faqPageData(path: string, questions: readonly { q: string; a: string }[]) {
  return {
    "@type": "FAQPage",
    "@id": `${SITE_ORIGIN}${path}#faq`,
    mainEntity: questions.map((entry) => ({
      "@type": "Question",
      name: entry.q,
      acceptedAnswer: { "@type": "Answer", text: entry.a },
    })),
  };
}
