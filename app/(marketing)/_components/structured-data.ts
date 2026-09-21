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
  description: "MAINTSUPP coordinates reactive repairs, planned maintenance and compliance administration for UK commercial portfolios of five or more sites through a vetted contractor network.",
  foundingDate: "2026-06-04",
  founder: { "@type": "Person", name: "Anwar Shboul" },
  telephone: "+44 7852 224644",
  email: "info@maintsupp.com",
  identifier: {
    "@type": "PropertyValue",
    propertyID: "GB-CRN",
    value: "17262302",
  },
  areaServed: { "@type": "Country", name: "United Kingdom" },
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
