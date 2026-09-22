/**
 * THE BUILT-IN PAGES' COPY, AS A THING STAFF CAN EDIT — decision L (§77 item 9).
 *
 * D5 said the shipped marketing pages were code, and the CMS was for pages
 * written in it. This file is what lifts that: the homepage, `/contractors` and
 * `/faqs` keep their components, their stylesheet and their markup, and read
 * their WORDS from one resolver. Nothing renders twice and nothing renders
 * differently — `app/(marketing)/_sections/copy.ts` holds the page exactly as it
 * shipped, and a saved value is an OVERRIDE OF ONE FIELD on top of it.
 *
 * WHY THE SITE CANNOT GO EMPTY. There is no import step and no seed: with no row
 * at all, every field resolves to `copy.ts`, which is the live page today. That
 * is also the answer to the migration question the brief asks — the cutover
 * already happened, in the commit that moved the literals out of the components,
 * and it is verifiable by deleting the row. After it there is ONE content path:
 * the components take a `copy` prop and have no literals of their own to fall
 * back to.
 *
 * WHAT MAY BE EDITED, and why the list is short:
 *
 *   - headings, eyebrows, intro paragraphs, notes, the hero's kicker, its two
 *     title halves, its three trust chips and its two button labels;
 *   - the hero's photograph, from the media library (decision K);
 *   - the shared FAQ questions and answers — one list, still shared by the
 *     homepage section and `/faqs`, so the FAQPage structured data cannot
 *     disagree with the page;
 *   - each page's SEO title and description;
 *   - which homepage sections are shown, and the order of the movable ones.
 *
 * WHAT MAY NOT, deliberately:
 *
 *   - PRICES. `rates.ts` is the single source for every figure on the site and
 *     checks its own invariant at module load; `CONTENT_RULES` refuses a "£"
 *     followed by a digit in anything saved here, exactly as it does in a CMS
 *     page. A price is a commercial decision, made in code, with a test.
 *   - THE SIX FORBIDDEN CLAIMS and the VAT qualifiers — same rules, same
 *     function (`claimViolation`), so the console cannot write what a reviewer
 *     would refuse in a pull request.
 *   - canonical, robots, the OpenGraph url, siteName, locale and type, the
 *     sitemap, the structured-data graph, and every legal page. See `SEO_COPY`.
 *   - the cards, lists and statistics inside a section, and the section
 *     components' markup and classes. A heading is a string; a card is a layout.
 *     They can follow, one section at a time, with the design checked each time.
 *
 * THE ONE RULE THAT IS NOT OBVIOUS: a section cannot be hidden while a visible
 * navigation link points at its anchor, because that link would then scroll
 * nowhere. The refusal names the link, and decision J's editor is where it is
 * hidden or re-pointed first. This is why the "locked" set is not a list written
 * here: it is derived from the navigation actually in force (`requiredAnchors`),
 * plus the three sections that are fixed for reasons of their own — the hero
 * carries the page's H1, the contact panel is the only form that asks who you
 * are, and "Report a Job" is the door an existing client's store manager walks
 * through, whose `#report` anchor is a LOCKED link in `site-navigation.ts`.
 *
 * A PLAIN MODULE, not "use client": the editor, the save route and the public
 * render all read this, and a value exported from a "use client" file is a client
 * reference on the server (the trap `site-navigation.ts` records).
 */

import { faq as SHIPPED_QUESTIONS } from "../(marketing)/_sections/content.ts";
import { HOME_COPY, PAGE_COPY, SEO_COPY, type HomeCopy, type PageCopy } from "../(marketing)/_sections/copy.ts";
import { claimViolation, isMediaIdValue } from "./cms-blocks.ts";

/* ------------------------------------------------------------------ */
/* The document                                                        */
/* ------------------------------------------------------------------ */

export type ContentPageKey = "home" | "contractors" | "faqs";
export type HomeSectionKey = keyof HomeCopy | "reportJob";

/** One question and its answer — the shape `content.ts` already has. */
export type ContentQuestion = { q: string; a: string };

/** What one field may hold. A string, a list of lines, or a list of pairs. */
export type ContentValue = string | string[] | ContentQuestion[];

export type StoredSection = {
  /** Present and true only where the section is hideable. */
  hidden?: boolean;
  /** Only fields that DIFFER from the shipped copy; see `validateSiteContent`. */
  fields?: Record<string, ContentValue>;
};

export type StoredPage = {
  seo?: { title?: string; description?: string; socialDescription?: string };
  sections?: Record<string, StoredSection>;
  /** The movable sections, in the order they are drawn. Home only. */
  order?: string[];
};

export type SiteContent = { pages: Record<string, StoredPage> };

/** No overrides at all: every page is exactly what it shipped as. */
export const EMPTY_SITE_CONTENT: SiteContent = { pages: {} };

/* ------------------------------------------------------------------ */
/* What each field is                                                  */
/* ------------------------------------------------------------------ */

export type FieldKind = "line" | "paragraph" | "label" | "lines" | "pairs" | "media";

type FieldRule = {
  kind: FieldKind;
  label: string;
  /** The longest ONE string may be. A `lines`/`pairs` field applies it per entry. */
  max: number;
  /** For `lines` and `pairs`: how many entries there may be. */
  maxItems?: number;
  /** For `pairs`: the second half's own ceiling. */
  maxSecond?: number;
  help?: string;
};

/**
 * BY FIELD NAME, not by section, because the same name means the same thing
 * everywhere: an `eyebrow` is the small line above a heading in all thirteen
 * sections, and one rule for it is one rule to keep true.
 *
 * The ceilings are the shipped copy's own length with room to work in, measured
 * rather than guessed — the longest shipped `heading` is 78 characters and the
 * longest `lede` 396. They exist to stop a paragraph being typed into a heading,
 * which the design cannot draw; they are not an editorial opinion.
 */
const FIELD_RULES: Readonly<Record<string, FieldRule>> = {
  eyebrow: { kind: "line", label: "Eyebrow", max: 60, help: "The small line above the heading." },
  heading: { kind: "line", label: "Heading", max: 140 },
  lede: { kind: "paragraph", label: "Intro paragraph", max: 600 },
  note: { kind: "paragraph", label: "Note", max: 400 },
  promise: { kind: "paragraph", label: "Closing line", max: 400 },
  faultsHeading: { kind: "line", label: "Faults list heading", max: 140 },
  kicker: { kind: "line", label: "Kicker", max: 80, help: "Beside the pin icon, above the headline." },
  titleLead: { kind: "line", label: "Headline, first half", max: 140 },
  titleAccent: { kind: "line", label: "Headline, second half", max: 140, help: "Drawn in the accent colour." },
  pills: { kind: "lines", label: "Trust chips", max: 60, maxItems: 3, help: "Three, each beside its own icon. Leave one blank to keep the shipped chip." },
  bookLabel: { kind: "label", label: "Primary button", max: 40 },
  reportLabel: { kind: "label", label: "Secondary button", max: 40 },
  image: {
    kind: "media",
    label: "Photograph",
    max: 40,
    help: "From the media library. Leaving it empty keeps the art-directed pair of plates that ships with the site — see the note in hero.tsx.",
  },
  items: {
    kind: "pairs",
    label: "Questions and answers",
    max: 200,
    maxSecond: 900,
    maxItems: 14,
    help: "Shared by this page and the homepage's FAQ section, and by the FAQPage structured data. At least three.",
  },
};

/* ------------------------------------------------------------------ */
/* The pages, the sections and their defaults                          */
/* ------------------------------------------------------------------ */

type SectionDefinition = {
  key: HomeSectionKey | string;
  label: string;
  /** The `id` the section carries in the DOM — what a navigation link points at. */
  anchor: string | null;
  /** A section that cannot be hidden or moved, and the reason, which the editor prints. */
  fixed?: string;
  /** Fields beyond the copy object's own keys. */
  extraFields?: string[];
  /** Where the defaults come from when they are not a copy object's. */
  defaults?: Record<string, ContentValue>;
};

/**
 * THE HOMEPAGE'S FOURTEEN SECTIONS, IN THE ORDER THEY SHIP IN — the contract
 * that used to live as fourteen self-closing tags in `app/(marketing)/page.tsx`,
 * moved here because the page now draws what this says, in the order staff have
 * saved. Three tests read it here for that reason; the pins name this list.
 *
 * `TrustStrip` and `FinalCta` are ONE section in two components — a dark
 * full-bleed band and the form beneath it — which is why there are fourteen
 * sections and fifteen components.
 */
const HOME_SECTIONS: readonly SectionDefinition[] = [
  {
    key: "hero",
    label: "Hero",
    anchor: "hero",
    fixed: "The hero carries the page's H1 and the first thing a visitor sees; it stays first.",
    extraFields: ["image"],
    defaults: { image: "" },
  },
  { key: "whoWeHelp", label: "Who we help", anchor: "sectors" },
  { key: "services", label: "Services", anchor: "services" },
  { key: "problem", label: "The operating problem", anchor: "problem" },
  { key: "replaces", label: "What this replaces", anchor: "replaces" },
  { key: "how", label: "How it works", anchor: "how" },
  { key: "yourContractors", label: "Your contractors or ours", anchor: "your-contractors" },
  { key: "pricing", label: "Pricing", anchor: "pricing" },
  { key: "caseStudy", label: "Case study", anchor: "case-study" },
  { key: "founder", label: "Who runs Maintsupp", anchor: "founder" },
  { key: "portal", label: "Client portal", anchor: "portal" },
  { key: "faq", label: "Questions", anchor: "faq" },
  {
    key: "finalCta",
    label: "Contact and booking",
    anchor: "contact",
    fixed: "The only form on the page that asks who you are, and the destination of every \"Book a Portfolio Review\" button.",
  },
  {
    key: "reportJob",
    label: "Report a Job form",
    anchor: "report",
    fixed: "The door an existing client's store manager walks through. Its #report anchor is a locked navigation link.",
  },
];

/** The homepage sections in shipped order — the default `order`, and the whole set. */
export const HOME_SECTION_ORDER: readonly HomeSectionKey[] = HOME_SECTIONS.map(
  (section) => section.key as HomeSectionKey,
);

/** The sections staff may reorder: everything between the hero and the two fixed tails. */
export const MOVABLE_HOME_SECTIONS: readonly HomeSectionKey[] = HOME_SECTIONS.filter(
  (section) => !section.fixed,
).map((section) => section.key as HomeSectionKey);

const CONTRACTORS_SECTIONS: readonly SectionDefinition[] = [
  { key: "intro", label: "Introduction", anchor: null, fixed: "The page is one section: its heading and its introduction, above the application form." },
];

const FAQS_SECTIONS: readonly SectionDefinition[] = [
  { key: "intro", label: "Introduction", anchor: null, fixed: "The page's heading, above the questions." },
  {
    key: "questions",
    label: "The questions",
    anchor: null,
    fixed: "The list itself — shared with the homepage's FAQ section.",
    extraFields: ["items"],
    defaults: { items: SHIPPED_QUESTIONS.map((entry) => ({ q: entry.q, a: entry.a })) },
  },
];

/** Where a section's shipped copy lives, when it is a copy object. */
function shippedCopy(page: ContentPageKey, section: string): Record<string, ContentValue> | null {
  if (page === "home") {
    const copy = (HOME_COPY as Record<string, unknown>)[section];
    return (copy as Record<string, ContentValue> | undefined) ?? null;
  }
  if (page === "contractors" && section === "intro") return PAGE_COPY.contractors as unknown as Record<string, ContentValue>;
  if (page === "faqs" && section === "intro") return PAGE_COPY.faqs as unknown as Record<string, ContentValue>;
  return null;
}

/* ------------------------------------------------------------------ */
/* The registry the editor draws and the validator checks against      */
/* ------------------------------------------------------------------ */

export type ContentFieldSpec = {
  key: string;
  label: string;
  kind: FieldKind;
  max: number;
  maxItems: number | null;
  maxSecond: number | null;
  help: string | null;
  /** The shipped value — what the field resolves to when nothing is saved. */
  shipped: ContentValue;
};

export type ContentSectionSpec = {
  key: string;
  label: string;
  anchor: string | null;
  /** Null when the section may be hidden and moved; otherwise the reason it may not. */
  fixed: string | null;
  fields: ContentFieldSpec[];
};

export type ContentPageSpec = {
  key: ContentPageKey;
  label: string;
  path: string;
  /** The shipped SEO strings; `socialDescription` only where the page has one. */
  seo: { title: string; description: string; socialDescription?: string };
  /** True where the title opts out of the root layout's `%s | MAINTSUPP` template. */
  titleIsAbsolute: boolean;
  sections: ContentSectionSpec[];
};

function fieldSpec(name: string, shipped: ContentValue): ContentFieldSpec {
  const rule = FIELD_RULES[name];
  if (!rule) throw new Error(`site-content: no rule for the field "${name}"`);
  return {
    key: name,
    label: rule.label,
    kind: rule.kind,
    max: rule.max,
    maxItems: rule.maxItems ?? null,
    maxSecond: rule.maxSecond ?? null,
    help: rule.help ?? null,
    shipped,
  };
}

function sectionSpec(page: ContentPageKey, definition: SectionDefinition): ContentSectionSpec {
  const copy = shippedCopy(page, definition.key) ?? {};
  const fields: ContentFieldSpec[] = [];
  for (const [name, value] of Object.entries(copy)) fields.push(fieldSpec(name, value as ContentValue));
  for (const name of definition.extraFields ?? []) fields.push(fieldSpec(name, definition.defaults?.[name] ?? ""));
  return {
    key: definition.key,
    label: definition.label,
    anchor: definition.anchor,
    fixed: definition.fixed ?? null,
    fields,
  };
}

/**
 * EVERY PAGE AND FIELD THE CONSOLE OFFERS. Built from the shipped copy, so a
 * field added to a section in `copy.ts` appears here — with its rule — without a
 * second list to keep in step. A field with no rule throws at module load rather
 * than reaching the console unvalidated.
 */
export const CONTENT_PAGES: readonly ContentPageSpec[] = [
  {
    key: "home",
    label: "Home page",
    path: "/",
    seo: { ...SEO_COPY.home },
    titleIsAbsolute: false,
    sections: HOME_SECTIONS.map((definition) => sectionSpec("home", definition)),
  },
  {
    key: "contractors",
    label: "Contractor network",
    path: "/contractors",
    seo: { ...SEO_COPY.contractors },
    /* The brief specifies this title exactly, so it opts out of the template. */
    titleIsAbsolute: true,
    sections: CONTRACTORS_SECTIONS.map((definition) => sectionSpec("contractors", definition)),
  },
  {
    key: "faqs",
    label: "All FAQs",
    path: "/faqs",
    seo: { ...SEO_COPY.faqs },
    titleIsAbsolute: false,
    sections: FAQS_SECTIONS.map((definition) => sectionSpec("faqs", definition)),
  },
];

const pageSpec = (key: string): ContentPageSpec | null =>
  CONTENT_PAGES.find((page) => page.key === key) ?? null;

/** What the editor prints beside the fields, and what the tests read. */
export const CONTENT_OMISSIONS: readonly string[] = [
  "This is the copy on the pages that ship with the site. Clearing a box puts the shipped words back — it never leaves a blank space on the page.",
  "Prices cannot be typed here: every figure on the site comes from one file that checks its own totals. Nor can the six claims the brief forbids, or anything qualifying a price with VAT — the same rules a website page is held to.",
  "The cards, lists and numbers inside a section are still code, as are the three legal notices. Headings, introductions, notes, the hero and the questions are here.",
  "A section cannot be hidden while a link in the header or footer points at it — that link would scroll nowhere. Hide or re-point the link first, on the Navigation screen.",
  "Moving a section can put two sections with the same background next to each other. The page still works; it looks flatter at that seam.",
  "A change is live within half a minute for everyone, and at once for you. There is no draft state and no preview: what you save is what visitors read.",
];

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type ContentValidation = { ok: true; value: SiteContent } | { ok: false; reason: string };

const refuse = (reason: string): ContentValidation => ({ ok: false, reason });

/** One string, trimmed and whitespace-collapsed, or null when it is not one. */
function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? null : flat;
}

/** A paragraph: line breaks kept (the components render them as text), runs collapsed. */
function cleanParagraph(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const tidy = value.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return tidy.length > max ? null : tidy;
}

/**
 * A SAVE, CHECKED WHOLE. Returns the document to store — which is NOT what was
 * sent: every value equal to the shipped copy is dropped, so "no override" and
 * "the same words as the shipped page" are one state. That is what makes a revert
 * a revert, and what makes the fallback in `resolveSiteContent` the only path
 * when nothing has been edited.
 *
 * `requiredAnchors` maps an anchor to the navigation link that needs it (decision
 * J's menu, as it stands right now). Hiding a section named there is refused, and
 * the refusal says which link.
 */
export function validateSiteContent(
  value: unknown,
  options: { requiredAnchors?: ReadonlyMap<string, string> } = {},
): ContentValidation {
  if (!value || typeof value !== "object") return refuse("Send the content to save.");
  const submitted = (value as { pages?: unknown }).pages;
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
    return refuse("Send the content to save.");
  }
  const required = options.requiredAnchors ?? new Map<string, string>();
  const out: SiteContent = { pages: {} };

  for (const [pageKey, rawPage] of Object.entries(submitted as Record<string, unknown>)) {
    const spec = pageSpec(pageKey);
    if (!spec) return refuse(`There is no editable page called "${pageKey}".`);
    if (!rawPage || typeof rawPage !== "object" || Array.isArray(rawPage)) {
      return refuse(`${spec.label}: the page's content must be an object.`);
    }
    const page = rawPage as StoredPage;
    const stored: StoredPage = {};

    /* ── SEO ─────────────────────────────────────────────────────────── */
    if (page.seo !== undefined) {
      if (!page.seo || typeof page.seo !== "object") return refuse(`${spec.label}: the search-engine fields must be an object.`);
      const seo: NonNullable<StoredPage["seo"]> = {};
      for (const [name, max] of [["title", 70], ["description", 200], ["socialDescription", 200]] as const) {
        if (!(name in page.seo)) continue;
        if (name === "socialDescription" && spec.seo.socialDescription === undefined) {
          return refuse(`${spec.label} has no shared-link description.`);
        }
        const raw = (page.seo as Record<string, unknown>)[name];
        const cleaned = cleanLine(raw, max);
        if (cleaned === null) return refuse(`${spec.label}: the ${name === "title" ? "title" : "description"} must be text of at most ${max} characters.`);
        if (!cleaned) continue;
        /* The shipped value first, for `cleanField`'s reason: what the site ships
           with is not an override and is not re-checked. */
        if (cleaned === (spec.seo as Record<string, string | undefined>)[name]) continue;
        const claim = claimViolation(cleaned);
        if (claim) return refuse(`${spec.label}: ${claim}.`);
        if (name === "title" && /\|\s*MAINTSUPP/i.test(cleaned)) {
          return refuse(`${spec.label}: leave "| MAINTSUPP" out of the title — the site adds it once, and typing it gives "… | MAINTSUPP | MAINTSUPP".`);
        }
        seo[name] = cleaned;
      }
      if (Object.keys(seo).length) stored.seo = seo;
    }

    /* ── Sections ────────────────────────────────────────────────────── */
    if (page.sections !== undefined) {
      if (!page.sections || typeof page.sections !== "object") return refuse(`${spec.label}: the sections must be an object.`);
      const sections: Record<string, StoredSection> = {};
      for (const [sectionKey, rawSection] of Object.entries(page.sections as Record<string, unknown>)) {
        const section = spec.sections.find((entry) => entry.key === sectionKey);
        if (!section) return refuse(`${spec.label}: there is no section called "${sectionKey}".`);
        if (!rawSection || typeof rawSection !== "object") return refuse(`${spec.label} / ${section.label}: the section must be an object.`);
        const source = rawSection as StoredSection;
        const kept: StoredSection = {};

        if (source.hidden === true) {
          if (section.fixed) return refuse(`${section.label} cannot be hidden. ${section.fixed}`);
          const link = section.anchor ? required.get(section.anchor) : undefined;
          if (link) {
            return refuse(
              `${section.label} cannot be hidden while ${link} points at it — that link would scroll nowhere. Hide or re-point it on the Navigation screen first.`,
            );
          }
          kept.hidden = true;
        } else if (source.hidden !== undefined && source.hidden !== false) {
          return refuse(`${spec.label} / ${section.label}: "hidden" must be true or false.`);
        }

        if (source.fields !== undefined) {
          if (!source.fields || typeof source.fields !== "object") return refuse(`${spec.label} / ${section.label}: the fields must be an object.`);
          const fields: Record<string, ContentValue> = {};
          for (const [fieldKey, rawValue] of Object.entries(source.fields as Record<string, unknown>)) {
            const field = section.fields.find((entry) => entry.key === fieldKey);
            if (!field) return refuse(`${spec.label} / ${section.label}: there is no field called "${fieldKey}".`);
            const where = `${section.label} — ${field.label}`;
            const checked = cleanField(field, rawValue, where);
            if ("reason" in checked) return refuse(checked.reason);
            if (checked.value === null) continue;
            if (sameValue(checked.value, field.shipped)) continue;
            fields[fieldKey] = checked.value;
          }
          if (Object.keys(fields).length) kept.fields = fields;
        }

        if (Object.keys(kept).length) sections[sectionKey] = kept;
      }
      if (Object.keys(sections).length) stored.sections = sections;
    }

    /* ── Order (home only) ───────────────────────────────────────────── */
    if (page.order !== undefined) {
      if (pageKey !== "home") return refuse(`${spec.label}: only the home page's sections can be reordered.`);
      if (!Array.isArray(page.order)) return refuse("The order must be a list of section names.");
      const seen = new Set<string>();
      for (const key of page.order) {
        if (typeof key !== "string" || !(MOVABLE_HOME_SECTIONS as readonly string[]).includes(key)) {
          const fixed = HOME_SECTIONS.find((section) => section.key === key);
          return refuse(
            fixed?.fixed
              ? `${fixed.label} cannot be moved. ${fixed.fixed}`
              : `"${String(key)}" is not a section that can be moved.`,
          );
        }
        if (seen.has(key)) return refuse(`${key} is listed twice in the order.`);
        seen.add(key);
      }
      if (seen.size !== MOVABLE_HOME_SECTIONS.length) {
        const missing = MOVABLE_HOME_SECTIONS.filter((key) => !seen.has(key));
        return refuse(`The order must list every movable section; ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Hide a section rather than leaving it out.`);
      }
      if (page.order.join("\u0000") !== MOVABLE_HOME_SECTIONS.join("\u0000")) stored.order = [...page.order];
    }

    if (Object.keys(stored).length) out.pages[pageKey] = stored;
  }

  return { ok: true, value: out };
}

/**
 * One field's submitted value, cleaned — `null` means "no override", a reason
 * means refused.
 *
 * THE SHIPPED WORDS ARE NEVER RE-CHECKED, and that is deliberate rather than a
 * loophole. `CONTENT_RULES` forbids a price being TYPED into a page, because
 * `rates.ts` is the one source for every figure and a second one could not be
 * reconciled with it — and several shipped FAQ answers quote a rate, which they
 * get from `rates.ts` by interpolation. Checking the rules against a value that
 * is identical to the shipped one would therefore make the questions
 * un-editable: changing question three would be refused because answer seven
 * mentions £30. So the order is: clean it, and if it is what the site ships with
 * it is not an override at all; only what a person has actually written is held
 * to the rules. Every list is checked entry by entry for the same reason.
 */
function cleanField(
  field: ContentFieldSpec,
  raw: unknown,
  where: string,
): { value: ContentValue | null } | { reason: string } {
  const tooLong = (max: number) => ({ reason: `${where}: at most ${max} characters.` });

  if (field.kind === "media") {
    if (raw === "" || raw === null) return { value: null };
    if (!isMediaIdValue(raw)) return { reason: `${where}: choose an image from the media library.` };
    return { value: raw };
  }

  if (field.kind === "lines") {
    if (!Array.isArray(raw)) return { reason: `${where}: send a list of lines.` };
    if (raw.length > (field.maxItems ?? 0)) return { reason: `${where}: at most ${field.maxItems} of them.` };
    const shipped = Array.isArray(field.shipped) ? (field.shipped as string[]) : [];
    const lines: string[] = [];
    for (const [index, entry] of raw.entries()) {
      if (entry === "" || entry === null || entry === undefined) {
        lines.push(shipped[index] ?? "");
        continue;
      }
      const line = cleanLine(entry, field.max);
      if (line === null) return tooLong(field.max);
      if (!shipped.includes(line)) {
        const claim = claimViolation(line);
        if (claim) return { reason: `${where}: ${claim}.` };
      }
      lines.push(line);
    }
    /* A blank list is no override, not an empty hero. */
    return { value: lines.some((line) => line) ? lines : null };
  }

  if (field.kind === "pairs") {
    if (!Array.isArray(raw)) return { reason: `${where}: send a list of questions.` };
    if (raw.length > (field.maxItems ?? 0)) return { reason: `${where}: at most ${field.maxItems} questions.` };
    const pairs: ContentQuestion[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") return { reason: `${where}: every question needs a question and an answer.` };
      const question = cleanLine((entry as ContentQuestion).q, field.max);
      const answer = cleanParagraph((entry as ContentQuestion).a, field.maxSecond ?? field.max);
      if (question === null) return tooLong(field.max);
      if (answer === null) return tooLong(field.maxSecond ?? field.max);
      if (!question && !answer) continue;
      if (!question || !answer) return { reason: `${where}: "${question || answer}" needs both a question and an answer.` };
      /* Entry by entry against the shipped list, for the reason in the header:
         an answer nobody touched must not be refused for quoting a rate. */
      const asShipped = (field.shipped as ContentQuestion[]).some(
        (entry) => entry.q === question && entry.a === answer,
      );
      if (!asShipped) {
        for (const text of [question, answer]) {
          const claim = claimViolation(text);
          if (claim) return { reason: `${where}: ${claim}.` };
        }
      }
      pairs.push({ q: question, a: answer });
    }
    if (!pairs.length) return { value: null };
    if (pairs.length < 3) {
      return { reason: `${where}: keep at least three questions — the page and its structured data are built from this list.` };
    }
    const asked = new Set(pairs.map((pair) => pair.q.toLowerCase()));
    if (asked.size !== pairs.length) return { reason: `${where}: two questions are the same.` };
    return { value: pairs };
  }

  const cleaned = field.kind === "paragraph" ? cleanParagraph(raw, field.max) : cleanLine(raw, field.max);
  if (cleaned === null) return typeof raw === "string" ? tooLong(field.max) : { reason: `${where}: send text.` };
  if (!cleaned) return { value: null };
  /* The shipped words are not an override, and are not re-checked — see above. */
  if (cleaned === field.shipped) return { value: null };
  const claim = claimViolation(cleaned);
  if (claim) return { reason: `${where}: ${claim}.` };
  return { value: cleaned };
}

/** Whether a submitted value is the shipped one, so that it need not be stored. */
function sameValue(left: ContentValue, right: ContentValue): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return (left as Array<string | ContentQuestion>).every((entry, index) => {
    const other = (right as Array<string | ContentQuestion>)[index];
    if (typeof entry === "string" || typeof other === "string") return entry === other;
    return entry.q === other.q && entry.a === other.a;
  });
}

/**
 * A stored document, read back from the database and trusted no further than a
 * submitted one: every rule runs again, and anything that fails is DROPPED
 * rather than refused, because a page must draw. The navigation is not consulted
 * — a link added after a section was hidden is a dead link, which decision J's
 * own editor is where to notice, not a reason to un-hide a section behind
 * staff's backs.
 */
export function normaliseSiteContent(value: unknown): SiteContent {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return EMPTY_SITE_CONTENT;
    }
  }
  const checked = validateSiteContent(parsed);
  if (checked.ok) return checked.value;
  /* One bad field must not blank the whole document: try each page on its own. */
  const pages = (parsed as { pages?: Record<string, unknown> } | null)?.pages;
  if (!pages || typeof pages !== "object") return EMPTY_SITE_CONTENT;
  const out: SiteContent = { pages: {} };
  for (const [key, page] of Object.entries(pages)) {
    const one = validateSiteContent({ pages: { [key]: page } });
    if (one.ok && one.value.pages[key]) out.pages[key] = one.value.pages[key];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Resolution — defaults with the overrides on top                     */
/* ------------------------------------------------------------------ */

export type ResolvedSeo = { title: string; description: string; socialDescription: string };

export type ResolvedHome = {
  copy: HomeCopy;
  /** Every section to draw, in order, hidden ones removed. */
  sections: HomeSectionKey[];
  /** The hero's library image, when one is chosen. */
  heroImage: string | null;
  seo: ResolvedSeo;
};

export type ResolvedSiteContent = {
  home: ResolvedHome;
  contractors: { copy: PageCopy["contractors"]; seo: ResolvedSeo };
  faqs: { copy: PageCopy["faqs"]; questions: readonly ContentQuestion[]; seo: ResolvedSeo };
};

/**
 * THE SECTIONS TO DRAW, IN ORDER. Each fixed section keeps its own place in
 * `HOME_SECTION_ORDER` and the movable band is substituted, in the order staff
 * saved, where the first movable section sits. Written as a walk rather than as
 * "first, middle, last" so that marking another section fixed cannot silently
 * move it to an end.
 */
function renderOrder(order: readonly HomeSectionKey[], hidden: ReadonlySet<string>): HomeSectionKey[] {
  const movable = new Set<string>(MOVABLE_HOME_SECTIONS);
  const out: HomeSectionKey[] = [];
  let placed = false;
  for (const key of HOME_SECTION_ORDER) {
    if (!movable.has(key)) {
      out.push(key);
      continue;
    }
    if (placed) continue;
    placed = true;
    for (const moved of order) if (movable.has(moved) && !hidden.has(moved)) out.push(moved);
  }
  return out;
}

const overridesFor = (document: SiteContent | null, page: string, section: string): Record<string, ContentValue> =>
  document?.pages?.[page]?.sections?.[section]?.fields ?? {};

/**
 * One section's copy: the shipped object with any saved field on top. Typed
 * through the shipped object, which is the only thing that decides the shape —
 * an override can replace a value, never add a key (validation refuses an
 * unknown one) — so the cast is the shape the components already expect.
 */
function mergeSection<T>(shipped: T, overrides: Record<string, ContentValue>): T {
  if (!Object.keys(overrides).length) return shipped;
  const merged: Record<string, unknown> = { ...(shipped as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in merged)) continue;
    const base = merged[key];
    if (typeof base === "string" && typeof value === "string") merged[key] = value;
    else if (Array.isArray(base) && Array.isArray(value)) {
      /* Index for index, so a blank entry keeps the shipped one. */
      merged[key] = base.map((entry, index) => (value[index] === "" || value[index] === undefined ? entry : value[index]));
    }
  }
  return merged as T;
}

function mergeSeo(spec: ContentPageSpec, stored: StoredPage | undefined): ResolvedSeo {
  const shipped = spec.seo;
  const social = shipped.socialDescription ?? shipped.description;
  return {
    title: stored?.seo?.title || shipped.title,
    description: stored?.seo?.description || shipped.description,
    /* The shared-link line follows the description when it has been edited and
       nothing was written for the link itself: one edit, not two. */
    socialDescription: stored?.seo?.socialDescription || stored?.seo?.description || social,
  };
}

/**
 * EVERY BUILT-IN PAGE'S CONTENT FOR ONE RENDER. Pure: the same document always
 * resolves to the same pages, and `null` resolves to the site exactly as it
 * ships. Nothing here reads the database, so a page can call it on a value that
 * came from cache.
 */
export function resolveSiteContent(document: SiteContent | null): ResolvedSiteContent {
  const home = pageSpec("home") as ContentPageSpec;
  const contractors = pageSpec("contractors") as ContentPageSpec;
  const faqs = pageSpec("faqs") as ContentPageSpec;
  const homeStored = document?.pages?.home;

  const copy = Object.fromEntries(
    Object.keys(HOME_COPY).map((section) => [
      section,
      mergeSection((HOME_COPY as Record<string, unknown>)[section], overridesFor(document, "home", section)),
    ]),
  ) as HomeCopy;

  const order = homeStored?.order?.length ? (homeStored.order as HomeSectionKey[]) : MOVABLE_HOME_SECTIONS;
  const hidden = new Set(
    Object.entries(homeStored?.sections ?? {})
      .filter(([, section]) => section.hidden === true)
      .map(([key]) => key),
  );
  const heroImageValue = overridesFor(document, "home", "hero").image;

  const storedQuestions = overridesFor(document, "faqs", "questions").items;

  return {
    home: {
      copy,
      sections: renderOrder(order, hidden),
      heroImage: typeof heroImageValue === "string" && heroImageValue ? heroImageValue : null,
      seo: mergeSeo(home, homeStored),
    },
    contractors: {
      copy: mergeSection(PAGE_COPY.contractors, overridesFor(document, "contractors", "intro")),
      seo: mergeSeo(contractors, document?.pages?.contractors),
    },
    faqs: {
      copy: mergeSection(PAGE_COPY.faqs, overridesFor(document, "faqs", "intro")),
      questions: Array.isArray(storedQuestions) && storedQuestions.length
        ? (storedQuestions as ContentQuestion[])
        : SHIPPED_QUESTIONS,
      seo: mergeSeo(faqs, document?.pages?.faqs),
    },
  };
}

/** The site as it ships, with nothing saved — what every public page falls back to. */
export function defaultSiteContent(): ResolvedSiteContent {
  return resolveSiteContent(null);
}

/** Every media asset the content names, for the save route's library check and the render. */
export function contentMediaIds(document: SiteContent | null): string[] {
  const found = new Set<string>();
  for (const page of Object.values(document?.pages ?? {})) {
    for (const section of Object.values(page.sections ?? {})) {
      for (const [key, value] of Object.entries(section.fields ?? {})) {
        if (FIELD_RULES[key]?.kind === "media" && typeof value === "string" && value) found.add(value);
      }
    }
  }
  return [...found];
}

/** Whether the content names a section that is hidden — used by the editor's summary. */
export function hiddenSections(document: SiteContent | null): string[] {
  return Object.entries(document?.pages?.home?.sections ?? {})
    .filter(([, section]) => section.hidden === true)
    .map(([key]) => key);
}
