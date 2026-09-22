/**
 * THE PUBLIC WEBSITE'S NAVIGATION — decision J. What it holds, what may be
 * stored, and what can never be taken out of it.
 *
 * Pure: no database and no React, so the API route, the marketing layout, the
 * editor and the tests all read the same rules from here. The database half is
 * `site-navigation-repository.ts`; the cached public read is
 * `site-navigation-public.ts`.
 *
 * WHAT IS EDITABLE, AND WHAT IS FRAME.
 *
 * Two lists are data: the HEADER MENU (the desktop bar and the phone drawer
 * render the same list — a phone menu that lists more destinations than the
 * desktop nav was never a decision anybody made) and the FOOTER's link columns
 * (Services, Company, Clients, and the Legal list under Contact). MAINTSUPP
 * platform staff may add links, rename them, reorder them, hide and unhide
 * them, and point them somewhere else — somewhere SAFE (`cleanNavHref`).
 *
 * The rest of the chrome stays code, because it is the site's frame rather than
 * its menu, and `FIXED_CHROME` says so on the editor screen:
 *   - the logo, which is the site's one structural link to "/" — the home page
 *     cannot be edited out of the navigation because it is not in the list;
 *   - the utility bar and the header's own buttons: Portal Login, Report a Job
 *     and Book a Portfolio Review, on every page at every width;
 *   - the footer's contact details and the registered-company line, which are
 *     legal particulars and never invented or edited here.
 *
 * THE LOCKS, AND WHY THESE FIVE AND NO MORE.
 *
 * A link is locked when taking it away would break a journey the site must
 * always offer or a notice it is obliged to keep reachable. Derived from what
 * the site depends on today, not from a wish list:
 *   - Report a Job (#report) — how a client with no account raises a job; the
 *     public intake at /api/report-job is behind it;
 *   - Portal Login (/portal) — the one sign-in door for clients, contractors and
 *     staff;
 *   - Privacy notice (/privacy) — the enquiry form's consent checkbox asks
 *     people to accept it, so it has to be reachable from every page;
 *   - Cookies (/cookies) — the cookie banner names it, and the choice it records
 *     is only informed if the notice can be read;
 *   - Terms (/terms) — the terms the site trades on.
 * A locked link keeps its destination and cannot be hidden or removed. Its
 * LABEL may change and it may move within its own list — neither takes the
 * destination away. Everything else (every section link, Contractors, FAQs,
 * Contact) is a marketing choice and is left free on purpose: "do not invent
 * unnecessary locks".
 */

import { claimViolation, cleanSlug } from "./cms-blocks.ts";

/*
 * THE HEADER MENU AS SHIPPED — also the fallback when nothing is stored or the
 * database cannot answer.
 *
 * Six links, and every one of them lands on a section that exists.
 *
 * FIVE OF THESE SIX ARE ANCHORS ON THE HOMEPAGE; "Contractors" is a ROUTE.
 * `/contractors` is a real page — the application form for the contractor
 * network — and until it joined this list the only way to it was a single line
 * in the footer, which is where links go to not be found. "Contact Us" sits
 * last so that contacting stays the last thing in the row, which is where the
 * footer and the utility bar also put it. "Contact Us" points at `#contact`, the
 * same section the footer's "Contact" link goes to — the page's only form that
 * asks who you are and how to reach you.
 *
 * MOVED HERE FROM `app/(marketing)/_sections/chrome.tsx` (decision J). That file
 * is a client component, and a server module importing a value from a
 * "use client" file gets a client reference rather than the value — so the one
 * list the server validates against, falls back to and seeds the editor with
 * has to live in a plain module. The chrome now renders what the layout hands
 * it. Kept FIRST in this file and in the same tuple shape, so the tests that
 * read this list read the same text they always did.
 */
export const NAV = [
  ["#services", "Services"],
  ["#how", "How It Works"],
  ["#pricing", "Pricing"],
  ["#case-study", "Case Study"],
  ["/contractors", "Contractors"],
  ["#contact", "Contact Us"],
] as const;

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export type FooterGroupId = "services" | "company" | "clients" | "legal";

/** One stored link. `hidden` keeps it in the editor and out of the page. */
export type NavLink = { id: string; label: string; href: string; hidden: boolean };

export type FooterGroup = { id: FooterGroupId; heading: string; links: NavLink[] };

/** The whole stored document: the header menu, and the footer's four lists. */
export type SiteNavigation = { primary: NavLink[]; footer: FooterGroup[] };

/** A link as a visitor's page draws it — hidden ones and unpublished pages already gone. */
export type PublicLink = { id: string; label: string; href: string; external: boolean };

export type PublicNavigation = {
  primary: PublicLink[];
  footer: Array<{ id: FooterGroupId; heading: string; links: PublicLink[] }>;
};

/* ------------------------------------------------------------------ */
/* The built-in navigation                                             */
/* ------------------------------------------------------------------ */

/**
 * The footer as shipped. Four lists, in the order the footer draws them: three
 * columns, then Legal under the Contact column.
 *
 * Two FAQ destinations, and they are not a duplicate: the anchor is the
 * accordion on the homepage, the route is the standalone page that renders
 * every answer open and carries the FAQPage markup — named so the difference is
 * visible before the click. The three V3 sections (What This Replaces, Your
 * Contractors or Ours, and the FAQ accordion) are reachable from here rather
 * than from the header, which has no room left; "Join our contractor network"
 * is footer-only by the same reasoning the header list gives for Contractors.
 */
export const FOOTER_DEFAULTS: ReadonlyArray<{
  id: FooterGroupId;
  heading: string;
  links: ReadonlyArray<{ id: string; href: string; label: string }>;
}> = [
  {
    id: "services",
    heading: "Services",
    links: [
      { id: "ftr-reactive", href: "#services", label: "Reactive Maintenance" },
      { id: "ftr-planned", href: "#services", label: "Planned Maintenance" },
      { id: "ftr-compliance", href: "#services", label: "Compliance Coordination" },
      { id: "ftr-projects", href: "#services", label: "Projects & Store Works" },
    ],
  },
  {
    id: "company",
    heading: "Company",
    links: [
      { id: "ftr-how", href: "#how", label: "How It Works" },
      { id: "ftr-pricing", href: "#pricing", label: "Pricing" },
      { id: "ftr-case-study", href: "#case-study", label: "Case Study" },
      { id: "ftr-sectors", href: "#sectors", label: "Who We Help" },
      { id: "ftr-replaces", href: "#replaces", label: "What This Replaces" },
      { id: "ftr-your-contractors", href: "#your-contractors", label: "Your Contractors or Ours" },
      { id: "ftr-join", href: "/contractors", label: "Join our contractor network" },
      { id: "ftr-contact", href: "#contact", label: "Contact" },
    ],
  },
  {
    id: "clients",
    heading: "Clients",
    links: [
      { id: "ftr-report", href: "#report", label: "Report a Job" },
      /* Same door, same name as the header and the utility bar. */
      { id: "ftr-portal", href: "/portal", label: "Portal Login" },
      { id: "ftr-faq", href: "#faq", label: "FAQs on this page" },
      { id: "ftr-faqs", href: "/faqs", label: "All FAQs" },
      { id: "ftr-client-portal", href: "#portal", label: "Client portal" },
    ],
  },
  {
    id: "legal",
    heading: "Legal",
    links: [
      { id: "ftr-privacy", href: "/privacy", label: "Privacy notice" },
      { id: "ftr-terms", href: "/terms", label: "Terms" },
      { id: "ftr-cookies", href: "/cookies", label: "Cookies" },
    ],
  },
];

export const FOOTER_GROUP_IDS: readonly FooterGroupId[] = ["services", "company", "clients", "legal"];

/** A stable id for a header default, from its destination: `nav-services`, `nav-contractors`. */
function primaryIdFor(href: string): string {
  return `nav-${href.replace(/^[#/]+/, "")}`;
}

/** The navigation exactly as the site shipped it — the fallback, and "reset". */
export function defaultNavigation(): SiteNavigation {
  return {
    primary: NAV.map(([href, label]) => ({ id: primaryIdFor(href), label, href, hidden: false })),
    footer: FOOTER_DEFAULTS.map((group) => ({
      id: group.id,
      heading: group.heading,
      links: group.links.map((link) => ({ ...link, hidden: false })),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Locks                                                               */
/* ------------------------------------------------------------------ */

export type LockedLink = { id: string; group: FooterGroupId; href: string; reason: string };

/** The five. See the header for why each one, and why no others. */
export const LOCKED_LINKS: readonly LockedLink[] = [
  { id: "ftr-report", group: "clients", href: "#report", reason: "How a client with no account reports a job — the public job intake." },
  { id: "ftr-portal", group: "clients", href: "/portal", reason: "The one sign-in door for clients, contractors and staff." },
  { id: "ftr-privacy", group: "legal", href: "/privacy", reason: "The enquiry form asks people to accept the privacy notice, so it must be reachable from every page." },
  { id: "ftr-terms", group: "legal", href: "/terms", reason: "The terms the site trades on." },
  { id: "ftr-cookies", group: "legal", href: "/cookies", reason: "The cookie banner names the cookie notice; a choice is only informed if it can be read." },
];

export function lockedLink(id: string): LockedLink | null {
  return LOCKED_LINKS.find((entry) => entry.id === id) ?? null;
}

/**
 * The parts of the chrome that are NOT in the editable lists, stated on the
 * editor screen so nobody hunts for a control that does not exist.
 */
export const FIXED_CHROME: readonly string[] = [
  "The MAINTSUPP logo always links to the home page, in the header, the phone menu and the footer.",
  "Portal Login, Report a Job and Book a Portfolio Review are always in the header, the phone menu and the bar above the header, at every screen width.",
  "The phone number, email address, opening hours and the registered-company line in the footer are fixed. They are legal and contact particulars, not links to edit here.",
];

/* ------------------------------------------------------------------ */
/* Destinations — what a link may point at                             */
/* ------------------------------------------------------------------ */

/**
 * The homepage sections a link may jump to — each an `id` the homepage renders.
 * An anchor with no target does not error; it silently does nothing, which is
 * the worst possible behaviour for navigation, so an anchor is accepted only
 * from this list. `#top` and `#hero` are left out: the logo is the way home.
 */
export const HOMEPAGE_ANCHORS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "sectors", label: "Who We Help" },
  { id: "services", label: "Services" },
  { id: "problem", label: "The problem" },
  { id: "replaces", label: "What This Replaces" },
  { id: "how", label: "How It Works" },
  { id: "your-contractors", label: "Your Contractors or Ours" },
  { id: "pricing", label: "Pricing" },
  { id: "case-study", label: "Case Study" },
  { id: "founder", label: "Who runs Maintsupp" },
  { id: "portal", label: "Client portal" },
  { id: "faq", label: "FAQs" },
  { id: "trust", label: "Trust strip" },
  { id: "review", label: "Book a portfolio review" },
  { id: "contact", label: "Contact form" },
  { id: "report", label: "Report a Job form" },
];

/** The site's own pages a link may name directly. */
export const SITE_ROUTES: ReadonlyArray<{ path: string; label: string }> = [
  { path: "/", label: "Home page" },
  { path: "/contractors", label: "Contractor network" },
  { path: "/faqs", label: "All FAQs" },
  { path: "/privacy", label: "Privacy notice" },
  { path: "/terms", label: "Terms" },
  { path: "/cookies", label: "Cookie notice" },
  { path: "/portal", label: "Portal sign-in" },
];

const SITE_HOSTS = new Set(["maintsupp.com", "www.maintsupp.com"]);

/**
 * A destination a browser may safely follow, normalised, or null.
 *
 * AN ALLOWLIST OF SHAPES, never a blocklist of schemes — so `javascript:`,
 * `data:`, `vbscript:` and whatever is invented next are refused because they
 * are not on the list, not because somebody remembered them:
 *   - a homepage section, `#services` (or `/#services`), from HOMEPAGE_ANCHORS;
 *   - one of the site's own pages, from SITE_ROUTES;
 *   - a website page written in the CMS, `/p/<slug>`;
 *   - another site, `https://` only, with no user name or password in it (the
 *     `https://maintsupp.com@evil.com` trick) and a real host name. A link to
 *     maintsupp.com itself is treated as the page it names, so it is checked
 *     against the two lists above rather than waved through as "external".
 * Protocol-relative `//host` is refused: it reads like a path and is another
 * site. So is plain `http://`, and anything with whitespace or a backslash.
 */
export function cleanNavHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300 || /[\s\\]/.test(trimmed)) return null;

  const anchor = /^\/?#([a-z0-9-]+)$/.exec(trimmed);
  if (anchor) return HOMEPAGE_ANCHORS.some((entry) => entry.id === anchor[1]) ? `#${anchor[1]}` : null;

  if (trimmed.startsWith("//")) return null;
  if (trimmed.startsWith("/")) return sameSitePath(trimmed);

  if (!/^https:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  if (SITE_HOSTS.has(host)) {
    /* The site's own address, typed in full: it must name a page this site has. */
    if (url.search) return null;
    const onSite = url.hash ? `${url.pathname === "/" ? "" : url.pathname}${url.hash}` : url.pathname;
    return cleanNavHref(onSite || "/");
  }
  return url.toString();
}

function sameSitePath(path: string): string | null {
  if (SITE_ROUTES.some((route) => route.path === path)) return path;
  const cms = /^\/p\/([^/?#]+)$/.exec(path);
  if (cms) {
    const slug = cleanSlug(cms[1]);
    return slug ? `/p/${slug}` : null;
  }
  return null;
}

/** Whether a stored destination leaves the site (it then opens in a new tab). */
export function isExternalHref(href: string): boolean {
  return href.startsWith("https://");
}

/** The CMS page a destination names, or null. */
export function cmsSlugOf(href: string): string | null {
  const match = /^\/p\/([a-z0-9-]+)$/.exec(href);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * THE HEADER HAS A WIDTH, AND IT IS MEASURED IN PIXELS, NOT CHARACTERS.
 *
 * The desktop bar appears at 1120px and carries a logo, the menu, Portal Login,
 * Report a Job and the booking button on one row. Measured on Production with
 * the shipped six links (2026-09-22): the row ran up to 82px past the screen
 * between 1120 and 1300, clipping the booking button, and `Report a Job` folded
 * onto two lines at every width from 1120 to 1300. marketing.css now packs the
 * 1120–1279 band a little tighter and keeps the booking button's short label up
 * to 1365 (see the rules after `.cta-long`). Measured after, in a browser:
 * nothing folds and nothing overruns at any width from 1120 to 1920, and
 *   - from 1280px up the menu has 553px at its tightest (1366 and wider, where
 *     the long label returns) and the six use 547.9 — the header is nearly FULL;
 *   - from 1120 to 1279 it has 472px at its tightest (1120) and the six use
 *     463.6.
 * A count of characters cannot guard that: "CONTACT US" is 33% wider than
 * "Contact Us", and six all-capital labels of the shipped length overflowed by
 * 93px where six longer lower-case ones fitted. So the check is the width the
 * browser will draw — each label's glyphs in the nav's own font (Inter 500,
 * `NAV_GLYPH_EM`, measured from the rendered page), plus the links' padding and
 * gaps — against the room in BOTH layouts (`HEADER_LAYOUTS`). Renaming a link
 * to something no wider, or hiding one to make room for another, always
 * passes; a menu that would not fit on a laptop is refused with the numbers.
 * Hidden links cost nothing, and the phone drawer lists links vertically, so
 * neither needs a budget.
 */
export const NAVIGATION_RULES = {
  primaryMaxVisible: 6,
  primaryMaxLinks: 12,
  primaryLabelMax: 24,
  footerLabelMax: 48,
  headingMax: 32,
  groupMaxLinks: 12,
} as const;

/**
 * The nav font's advance widths, in thousandths of an em, for the printable
 * ASCII characters 32 (space) to 126 (~), four digits each, in order. Measured
 * with the page's own font stack at the nav's own weight; a label measured this
 * way matched the rendered text to 0.1px. Any other character is costed as the
 * widest one (W), so an estimate is never low.
 */
const NAV_GLYPHS = "02670304049406390646099306530313036903690521066703030462030303700646041506160627065606030630057106290630030303150667066706670527098207090657073307220603058907480745027205750687056509130756076706420769064806460653074007091003070106960641036903700369047704630337056806180577061805870379062006020252025205590252088806020604061806180387053903400602057508290557057505590440034604400667";
const WIDEST_GLYPH_EM = 1.003;

/** A label's width in em, in the nav font. */
export function labelEm(label: string): number {
  let total = 0;
  for (const character of label) {
    const code = character.codePointAt(0) ?? 0;
    total += code >= 32 && code <= 126 ? Number(NAV_GLYPHS.slice((code - 32) * 4, (code - 32) * 4 + 4)) / 1000 : WIDEST_GLYPH_EM;
  }
  return total;
}

/**
 * The header's two desktop layouts and the room each leaves the menu. The font
 * sizes and paddings are marketing.css's (`.nav__link`, and the 1120–1279 band);
 * `tests/site-navigation.test.mjs` reads them out of that file, so the two
 * cannot drift apart.
 */
export const HEADER_LAYOUTS = {
  /* 1280px and up: `.nav__link{padding:10px 8px;font-size:.91rem}`. Room
     measured 553.9px at 1366 and wider (585.9 at 1280); a pixel is kept back
     for rounding in the glyph table. */
  wide: { fontPx: 14.56, padPx: 8, gapPx: 2, roomPx: 553 },
  /* 1120–1279px: the packed band. Room measured 472.5px at 1120 (and far more
     from 1150 up). */
  band: { fontPx: 13.76, padPx: 3, gapPx: 2, roomPx: 472 },
} as const;

/** How wide the menu draws in one layout, in px. */
export function headerWidth(labels: readonly string[], layout: keyof typeof HEADER_LAYOUTS): number {
  const spec = HEADER_LAYOUTS[layout];
  if (labels.length === 0) return 0;
  const text = labels.reduce((total, label) => total + labelEm(label) * spec.fontPx, 0);
  return text + labels.length * 2 * spec.padPx + (labels.length - 1) * spec.gapPx;
}

/** Whether a menu fits both layouts — and, when it does not, by how much. */
export function headerFit(labels: readonly string[]): { fits: boolean; usedPx: number; roomPx: number; layout: keyof typeof HEADER_LAYOUTS } {
  let worst: { fits: boolean; usedPx: number; roomPx: number; layout: keyof typeof HEADER_LAYOUTS } | null = null;
  for (const layout of Object.keys(HEADER_LAYOUTS) as Array<keyof typeof HEADER_LAYOUTS>) {
    const usedPx = Math.round(headerWidth(labels, layout) * 10) / 10;
    const roomPx = HEADER_LAYOUTS[layout].roomPx;
    const entry = { fits: usedPx <= roomPx, usedPx, roomPx, layout };
    if (!worst || usedPx - roomPx > worst.usedPx - worst.roomPx) worst = entry;
  }
  return worst as { fits: boolean; usedPx: number; roomPx: number; layout: keyof typeof HEADER_LAYOUTS };
}

/* ------------------------------------------------------------------ */
/* Validation (the write path) and normalisation (the read path)       */
/* ------------------------------------------------------------------ */

const LINK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

export type NavigationValidation = { ok: true; value: SiteNavigation } | { ok: false; reason: string };

/**
 * A submitted navigation, checked whole — or the first reason it cannot be
 * saved. Returns a NEW object built from the rules, never the caller's, so no
 * unknown key rides along into storage.
 *
 * A save is refused rather than repaired: an editor who removed a locked link
 * is told so, instead of finding it quietly put back after the save. (The READ
 * path does repair — see `normaliseNavigation` — because a visitor's page must
 * never be the thing that fails.)
 */
export function validateNavigation(input: unknown): NavigationValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "Send the navigation as { primary, footer }." };
  }
  const source = input as { primary?: unknown; footer?: unknown };
  if (!Array.isArray(source.primary)) return { ok: false, reason: "The header menu must be a list of links." };
  if (!Array.isArray(source.footer)) return { ok: false, reason: "The footer must be a list of its four link lists." };

  const seen = new Set<string>();
  const link = (raw: unknown, where: string, labelMax: number): NavLink | string => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${where}: each link needs a label and a destination.`;
    const entry = raw as { id?: unknown; label?: unknown; href?: unknown; hidden?: unknown };
    const id = typeof entry.id === "string" && LINK_ID.test(entry.id) ? entry.id : null;
    if (!id) return `${where}: a link has no valid id.`;
    if (seen.has(id)) return `${where}: two links share the id "${id}".`;
    seen.add(id);
    const label = text(entry.label, labelMax);
    if (!label) return `${where}: every link needs a label of 1–${labelMax} characters.`;
    const broken = claimViolation(label);
    if (broken) return `${where}, "${label}": ${broken}.`;
    const href = cleanNavHref(entry.href);
    if (!href) {
      return `${where}, "${label}": a link may point at a homepage section (#services), one of the site's own pages (/faqs), a website page (/p/<address>) or an https:// address — nothing else.`;
    }
    if (entry.hidden !== undefined && typeof entry.hidden !== "boolean") return `${where}, "${label}": hidden must be true or false.`;
    return { id, label, href, hidden: entry.hidden === true };
  };

  const primary: NavLink[] = [];
  if (source.primary.length > NAVIGATION_RULES.primaryMaxLinks) {
    return { ok: false, reason: `The header menu holds at most ${NAVIGATION_RULES.primaryMaxLinks} links, shown or hidden.` };
  }
  for (const raw of source.primary) {
    const checked = link(raw, "Header menu", NAVIGATION_RULES.primaryLabelMax);
    if (typeof checked === "string") return { ok: false, reason: checked };
    if (lockedLink(checked.id)) return { ok: false, reason: `Header menu: "${checked.id}" is the id of a locked footer link.` };
    primary.push(checked);
  }
  const shown = primary.filter((entry) => !entry.hidden);
  if (shown.length > NAVIGATION_RULES.primaryMaxVisible) {
    return {
      ok: false,
      reason: `The header shows at most ${NAVIGATION_RULES.primaryMaxVisible} links — beyond that the bar is wider than a laptop screen. Hide one, or move it to the footer.`,
    };
  }
  const fit = headerFit(shown.map((entry) => entry.label));
  if (!fit.fits) {
    return {
      ok: false,
      reason: `The header menu would be ${Math.ceil(fit.usedPx - fit.roomPx)}px wider than the bar has room for on a ${fit.layout === "band" ? "1120–1279px" : "1280px or wider"} screen (${fit.usedPx}px of ${fit.roomPx}px). Shorten a label, or hide a link.`,
    };
  }

  const footer: FooterGroup[] = [];
  const groups = new Map<string, unknown>();
  for (const raw of source.footer) {
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !FOOTER_GROUP_IDS.includes(id as FooterGroupId)) {
      return { ok: false, reason: `The footer has exactly four lists: ${FOOTER_GROUP_IDS.join(", ")}.` };
    }
    if (groups.has(id)) return { ok: false, reason: `The footer list "${id}" appears twice.` };
    groups.set(id, raw);
  }
  for (const id of FOOTER_GROUP_IDS) {
    const raw = groups.get(id) as { heading?: unknown; links?: unknown } | undefined;
    if (!raw) return { ok: false, reason: `The footer list "${id}" is missing.` };
    const heading = text(raw.heading, NAVIGATION_RULES.headingMax);
    if (!heading) return { ok: false, reason: `The footer list "${id}" needs a heading of 1–${NAVIGATION_RULES.headingMax} characters.` };
    const broken = claimViolation(heading);
    if (broken) return { ok: false, reason: `Footer heading "${heading}": ${broken}.` };
    if (!Array.isArray(raw.links)) return { ok: false, reason: `The footer list "${heading}" must be a list of links.` };
    if (raw.links.length > NAVIGATION_RULES.groupMaxLinks) {
      return { ok: false, reason: `The footer list "${heading}" holds at most ${NAVIGATION_RULES.groupMaxLinks} links.` };
    }
    const links: NavLink[] = [];
    for (const entry of raw.links) {
      const checked = link(entry, `Footer, ${heading}`, NAVIGATION_RULES.footerLabelMax);
      if (typeof checked === "string") return { ok: false, reason: checked };
      const lock = lockedLink(checked.id);
      if (lock) {
        if (lock.group !== id) return { ok: false, reason: `"${checked.label}" is locked to its own footer list.` };
        if (checked.href !== lock.href) {
          return { ok: false, reason: `"${checked.label}" is locked: it must keep pointing at ${lock.href}. ${lock.reason}` };
        }
        if (checked.hidden) return { ok: false, reason: `"${checked.label}" is locked and cannot be hidden. ${lock.reason}` };
      }
      links.push(checked);
    }
    footer.push({ id, heading, links });
  }
  for (const lock of LOCKED_LINKS) {
    if (!seen.has(lock.id)) {
      const name = defaultLabelOf(lock.id);
      return { ok: false, reason: `"${name}" is locked and cannot be removed. ${lock.reason}` };
    }
  }
  return { ok: true, value: { primary, footer } };
}

function defaultLabelOf(id: string): string {
  for (const group of FOOTER_DEFAULTS) {
    const found = group.links.find((entry) => entry.id === id);
    if (found) return found.label;
  }
  return id;
}

/**
 * A stored navigation, read back — ALWAYS a usable one.
 *
 * The read path repairs where the write path refuses. Storage is the past: a
 * row written by an older release, edited by hand, or cut short cannot be
 * allowed to take a visitor's menu away. So a link that no longer passes is
 * dropped, a footer list that is missing gets its built-in one, and every
 * locked link is put back — unhidden, at its fixed destination — if the row
 * somehow lost it. A document that is not a navigation at all reads as the
 * built-in one.
 */
export function normaliseNavigation(raw: unknown): SiteNavigation {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return defaultNavigation();
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultNavigation();
  const source = parsed as { primary?: unknown; footer?: unknown };
  const fallback = defaultNavigation();
  const seen = new Set<string>();

  const tidy = (entry: unknown, labelMax: number, allowLocked: boolean): NavLink | null => {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as { id?: unknown; label?: unknown; href?: unknown; hidden?: unknown };
    const id = typeof record.id === "string" && LINK_ID.test(record.id) ? record.id : null;
    const label = text(record.label, labelMax);
    const href = cleanNavHref(record.href);
    if (!id || !label || !href || seen.has(id) || claimViolation(label)) return null;
    /* A locked id belongs to the footer alone; in the header it is dropped
       without being counted as seen, so the footer's own copy survives. */
    if (!allowLocked && lockedLink(id)) return null;
    seen.add(id);
    return { id, label, href, hidden: record.hidden === true };
  };

  const primary = Array.isArray(source.primary)
    ? source.primary
        .slice(0, NAVIGATION_RULES.primaryMaxLinks)
        .map((entry) => tidy(entry, NAVIGATION_RULES.primaryLabelMax, false))
        .filter((entry): entry is NavLink => entry !== null)
    : fallback.primary;
  if (!Array.isArray(source.primary)) primary.forEach((entry) => seen.add(entry.id));
  /* The header's width is a property of the page, not of the row: past the
     limit, the extra links are hidden rather than allowed to break the bar. */
  const kept: string[] = [];
  for (const entry of primary) {
    if (entry.hidden) continue;
    if (kept.length + 1 > NAVIGATION_RULES.primaryMaxVisible || !headerFit([...kept, entry.label]).fits) {
      entry.hidden = true;
      continue;
    }
    kept.push(entry.label);
  }

  const stored = new Map<string, { heading?: unknown; links?: unknown }>();
  if (Array.isArray(source.footer)) {
    for (const group of source.footer) {
      const id = (group as { id?: unknown } | null)?.id;
      if (typeof id === "string" && FOOTER_GROUP_IDS.includes(id as FooterGroupId) && !stored.has(id)) {
        stored.set(id, group as { heading?: unknown; links?: unknown });
      }
    }
  }
  const footer: FooterGroup[] = FOOTER_GROUP_IDS.map((id) => {
    const builtIn = fallback.footer.find((group) => group.id === id) as FooterGroup;
    const raw = stored.get(id);
    if (!raw) {
      /* A list the row lost comes back as built — less any link the row
         already placed elsewhere, so no id appears twice. */
      const links = builtIn.links.filter((entry) => !seen.has(entry.id));
      links.forEach((entry) => seen.add(entry.id));
      return { ...builtIn, links };
    }
    const links = Array.isArray(raw.links)
      ? raw.links
          .slice(0, NAVIGATION_RULES.groupMaxLinks)
          .map((entry) => tidy(entry, NAVIGATION_RULES.footerLabelMax, true))
          .filter((entry): entry is NavLink => entry !== null)
      : [];
    return { id, heading: text(raw.heading, NAVIGATION_RULES.headingMax) ?? builtIn.heading, links };
  });

  /* Every lock, whatever the row says: in its own list, shown, at its destination. */
  for (const lock of LOCKED_LINKS) {
    const home = footer.find((group) => group.id === lock.group) as FooterGroup;
    for (const group of footer) {
      if (group !== home) group.links = group.links.filter((entry) => entry.id !== lock.id);
    }
    const present = home.links.find((entry) => entry.id === lock.id);
    if (present) {
      present.href = lock.href;
      present.hidden = false;
    } else {
      home.links.push({ id: lock.id, label: defaultLabelOf(lock.id), href: lock.href, hidden: false });
    }
  }
  return { primary, footer };
}

/**
 * What a visitor's page draws: hidden links gone, and a link to a website page
 * that is not LIVE right now gone too — so a link to a draft or a page still
 * waiting for its publishing window never shows a visitor the page's name or
 * address before the page itself would. `livePages` is the set of slugs live at
 * the moment of the render; null means "not known", and then every CMS link is
 * left out rather than risk pointing at a 404 or naming a draft.
 */
export function publicNavigation(navigation: SiteNavigation, livePages: ReadonlySet<string> | null): PublicNavigation {
  const keep = (entry: NavLink) => {
    if (entry.hidden) return false;
    const slug = cmsSlugOf(entry.href);
    return slug ? Boolean(livePages?.has(slug)) : true;
  };
  const shape = (entry: NavLink): PublicLink => ({
    id: entry.id,
    label: entry.label,
    href: entry.href,
    external: isExternalHref(entry.href),
  });
  return {
    primary: navigation.primary.filter(keep).map(shape),
    footer: navigation.footer.map((group) => ({ id: group.id, heading: group.heading, links: group.links.filter(keep).map(shape) })),
  };
}

/** Whether a navigation names any website page — only then does a render need their states. */
export function namesCmsPages(navigation: SiteNavigation): boolean {
  return [...navigation.primary, ...navigation.footer.flatMap((group) => group.links)].some((entry) => cmsSlugOf(entry.href) !== null);
}
