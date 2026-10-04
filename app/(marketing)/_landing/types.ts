/**
 * THE LONDON PAGES, AS DATA.
 *
 * Seventeen pages under `/london` — the hub, nine services, three shopping
 * centres and four areas — share one renderer (`landing-page.tsx`) and differ
 * only in what they say. So what they say lives here, typed, and each route
 * file is a few lines: its own literal canonical (which
 * `tests/marketing-canonicals.test.mjs` requires to be a literal in the page
 * file) and one object from this folder.
 *
 * WHY THESE PAGES EXIST. The site was written for one buyer: a multi-site
 * operator with five or more locations. The owner widened the proposition in
 * October 2026 to take one-off jobs from a single shop or kiosk in London's
 * shopping centres as well, with emergency call-outs round the clock. Those
 * buyers search for a trade, a job or a place — "commercial electrician
 * London", "kiosk installation Westfield" — and none of those searches had a
 * page to land on. The keyword-to-page ownership is in
 * `docs/seo-keyword-map.md`.
 *
 * THE COPY RULES STILL APPLY HERE, because this folder is inside
 * `app/(marketing)` and the tests that walk that tree read it: no "our
 * engineers" (MAINTSUPP coordinates independent contractors and employs none),
 * no typed price (`_sections/rates.ts` is the only file that knows a number),
 * no VAT qualifier. Add to that the rules these pages set for themselves:
 * commercial premises only, no promised arrival time, and no claim to be any
 * centre's approved contractor — a centre keeps its own list.
 */

/** The public number. The only one the site may show. */
export const PHONE_DISPLAY = "07852 224644";
export const PHONE_HREF = "tel:+447852224644";
export const EMAIL = "info@maintsupp.com";

export type LandingKind = "hub" | "service" | "centre" | "area";

export type LandingCard = {
  title: string;
  body: string;
  /** Where the card leads, when it stands for another page. */
  href?: string;
  /** The link's own words. Defaults to the card title. */
  linkLabel?: string;
};

export type LandingBlock = {
  eyebrow: string;
  heading: string;
  lede?: string;
};

export type LandingFaq = { q: string; a: string };

export type LandingLink = { href: string; label: string };

export type LandingPlace = {
  /** The centre or street as people name it. */
  name: string;
  /** Where it is: "Hendon, NW4". */
  where: string;
  /** Its own page, where one exists. */
  href?: string;
};

export type LandingPage = {
  /** The address, from the site root: "/london/kiosk-installation". */
  path: string;
  kind: LandingKind;
  /** The breadcrumb's last word, and the name other pages link to it by. */
  crumb: string;
  /** The browser title, WITHOUT the brand — the root template adds it once. */
  title: string;
  /** At most 160 characters; `tests/seo-london-pages.test.mjs` measures it. */
  description: string;
  eyebrow: string;
  h1: string;
  lede: string;
  photo: { src: string; alt: string };

  /** The jobs or services the page is about. */
  cards: LandingBlock & { items: readonly LandingCard[] };
  /** The numbered steps, where the page explains how a job runs. */
  steps?: LandingBlock & { items: readonly LandingCard[] };
  /** A ticked list: what a centre asks for, why shops use this, what to send. */
  points?: LandingBlock & { items: readonly string[]; note?: string };
  /** Named centres and streets — the area pages and the hub. */
  places?: LandingBlock & { items: readonly LandingPlace[]; note?: string };

  faqs: readonly LandingFaq[];
  related: readonly LandingLink[];
  cta: { heading: string; lede: string };

  /** For the Service structured data. */
  serviceType: string;
  /** The place the service is offered in, when it is narrower than London. */
  place?: { name: string; streetAddress: string; postalCode: string };
  /** The subject line the "email us" button opens with. */
  emailSubject: string;
};
