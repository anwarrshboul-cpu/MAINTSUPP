/**
 * The block catalogue — what a CMS page can be made of, and what may be stored.
 *
 * WHY THIS IS A NEW, SMALL SET AND NOT `app/(marketing)/_sections/`.
 *
 * The audit recommended reusing the twenty-four components in `_sections/` as the
 * block library. Read, they cannot be: `Hero()`, `Faq()`, `Services()` and their
 * siblings take **no props at all** — each reads module-level constants declared
 * beside it. They are not parameterisable blocks, they are one specific homepage,
 * expressed as components.
 *
 * Making them CMS-driven means adding a props interface to about twenty
 * components and changing what the live homepage renders through. Owner decision
 * **D5 forbids exactly that in this phase**: "prove the CMS on new pages; do not
 * convert the live homepage". So this is a small set of blocks written to be
 * parameterised, sharing the marketing stylesheet so a CMS page looks like the
 * site rather than like an orphan.
 *
 * That is a correction to the audit's premise, not a shortcut around it. Promoting
 * the homepage's sections into blocks is a real piece of work and it is the later
 * phase D5 reserves.
 *
 * WHAT VALIDATION IS FOR HERE, WHICH IS NOT ESCAPING.
 *
 * Nothing below is ever interpolated into HTML. Every field is rendered as a React
 * text child or a plain attribute, so React escapes it — there is no
 * `dangerouslySetInnerHTML` on the CMS path and a test asserts that. So this
 * module is not a sanitiser and must not be mistaken for one.
 *
 * What it does is guarantee SHAPE, for three reasons that are all about the
 * renderer rather than about safety:
 *
 *   1. a block whose `body` is missing a field its renderer indexes would throw
 *      during render, and a public page that 500s is worse than one with a typo;
 *   2. an unbounded string is a denial-of-service on the page's own readability
 *      and on the response size, so every field has a ceiling;
 *   3. a `href` is the one field that is NOT just text — it becomes an attribute a
 *      browser will follow, so it is restricted to a same-site path or an
 *      `https://` URL. `javascript:` and `data:` are refused by construction
 *      rather than by a blocklist.
 */

export type BlockKind = "heading" | "richText" | "bullets" | "cta" | "faq";

/** One field's rules. `lines` is a list of strings; `pairs` is a list of two. */
type FieldRule =
  | { kind: "text"; max: number; required?: boolean }
  | { kind: "href"; required?: boolean }
  | { kind: "lines"; max: number; maxItems: number; required?: boolean }
  | { kind: "pairs"; max: number; maxItems: number; required?: boolean };

export type BlockDefinition = {
  kind: BlockKind;
  label: string;
  /** One line for whoever is choosing a block, not for a developer. */
  description: string;
  fields: Readonly<Record<string, FieldRule>>;
};

/**
 * The five, chosen because each one earns a distinct renderer.
 *
 * A sixth that merely restyled one of these would be a template, not a block, and
 * a catalogue that grows by restyling is how a block library stops meaning
 * anything. `image` is deliberately absent from the first slice — see
 * `CMS_OMISSIONS`.
 */
export const BLOCK_CATALOGUE: readonly BlockDefinition[] = [
  {
    kind: "heading",
    label: "Heading",
    description: "A section heading, with an optional eyebrow above and lead below.",
    fields: {
      eyebrow: { kind: "text", max: 80 },
      title: { kind: "text", max: 180, required: true },
      lead: { kind: "text", max: 400 },
    },
  },
  {
    kind: "richText",
    label: "Paragraphs",
    description: "One or more paragraphs of plain text.",
    fields: {
      paragraphs: { kind: "lines", max: 1200, maxItems: 20, required: true },
    },
  },
  {
    kind: "bullets",
    label: "Bulleted list",
    description: "A short list, with an optional heading above it.",
    fields: {
      title: { kind: "text", max: 180 },
      items: { kind: "lines", max: 300, maxItems: 24, required: true },
    },
  },
  {
    kind: "cta",
    label: "Call to action",
    description: "A heading, a sentence and one button.",
    fields: {
      title: { kind: "text", max: 180, required: true },
      body: { kind: "text", max: 600 },
      buttonLabel: { kind: "text", max: 60, required: true },
      buttonHref: { kind: "href", required: true },
    },
  },
  {
    kind: "faq",
    label: "Questions and answers",
    description: "A list of question-and-answer pairs.",
    fields: {
      title: { kind: "text", max: 180 },
      pairs: { kind: "pairs", max: 900, maxItems: 30, required: true },
    },
  },
] as const;

export const BLOCK_KINDS: readonly string[] = BLOCK_CATALOGUE.map((b) => b.kind);

export function blockDefinition(kind: string): BlockDefinition | null {
  return BLOCK_CATALOGUE.find((b) => b.kind === kind) ?? null;
}

/**
 * What the first slice deliberately does NOT do, stated once so the admin screen
 * and the tests can both read it from here rather than each claiming their own.
 *
 * Every entry is a real gap. Naming them is the difference between a first slice
 * and a half-finished feature presented as a whole one.
 */
export const CMS_OMISSIONS: readonly string[] = [
  "A published page is not in sitemap.xml. That file is a committed artifact whose per-page lastmod comes from git history, so a database-driven URL has no date to put in it; a dynamic sitemap is its own change.",
  "There is no image block yet. Images need an upload path, and /api/files is portal-only — it brokers a private bucket behind a session, which a public page has none of.",
  "The existing marketing pages are untouched. The homepage and the five legal pages stay exactly as they are, by owner decision, until a later phase promotes their sections into blocks.",
  "There is no draft preview URL. A page is either published and public, or a draft only the console can see.",
  "A page cannot carry a price, a VAT qualifier, or any of the six phrases the brief forbids. Those rules are enforced on the site's source text by three test files, which cannot see a database row — so they are enforced here instead, on the way in. See CONTENT_RULES for each rule and its reason.",
];

/* ------------------------------------------------------------------ */
/* The claims rules — the one thing a CMS could quietly take away      */
/* ------------------------------------------------------------------ */

/**
 * Copy this product is not allowed to publish, refused on the write path.
 *
 * WHY THIS EXISTS AT ALL, WHICH IS THE INTERESTING PART.
 *
 * Three test files enforce the owner's copy rules today, and all three do it by
 * reading SOURCE TEXT: `stage-twentyeight-landing-rebuild` walks every `.ts`/`.tsx`
 * under `app/(marketing)` for six forbidden phrases, and `homepage-v3` walks the
 * same tree twice more — once for a VAT qualifier, once for a `£` followed by a
 * digit outside `pricing.tsx`.
 *
 * A CMS moves copy out of source and into rows. **The day the first CMS page is
 * published, all three of those rules go blind** — not relaxed, not reconsidered,
 * silently unenforced, on exactly the surface they were written to protect. That is
 * a feature quietly removing a guarantee, which is worse than a feature that never
 * had one.
 *
 * So the same rules are applied here instead, to stored content, on the way in.
 * The three are not equally motivated and it is worth being clear which is which:
 *
 *   - the six phrases are a LEGAL exposure. The reason in the test is that
 *     MAINTSUPP does not employ engineers, so "our engineers" is a statement a
 *     client could hold it to. That is the owner's own rule about the owner's own
 *     liability, and a database is not a reason to stop applying it;
 *   - the VAT sentence is a factual one. Maintauk Ltd is not currently VAT
 *     registered, so a price qualified "+ VAT" would be wrong rather than merely
 *     unwise;
 *   - the price is a SINGLE-SOURCE rule. `rates.ts` is the only file on the site
 *     that knows a number, and it self-checks its own invariant at module load. A
 *     price typed into a CMS page is a second source that cannot be checked
 *     against the first, and nothing would notice when the two disagreed.
 *
 * This is a restriction on the owner's own console, so it is stated plainly in
 * `CMS_OMISSIONS` rather than discovered as a mysterious refusal.
 */
export const CONTENT_RULES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  /* The six from the brief, byte-for-byte the patterns the source test uses. */
  { pattern: /\bour engineers\b/i, reason: 'the brief forbids "our engineers" — MAINTSUPP does not employ them' },
  { pattern: /\bour nationwide team\b/i, reason: 'the brief forbids "our nationwide team"' },
  { pattern: /24\/7 coverage/i, reason: 'the brief forbids "24/7 coverage"' },
  { pattern: /guaranteed same-day fix/i, reason: 'the brief forbids "guaranteed same-day fix"' },
  { pattern: /100% first-time fix/i, reason: 'the brief forbids "100% first-time fix"' },
  { pattern: /\bwe certify\b/i, reason: 'the brief forbids "we certify"' },
  /* The VAT qualifiers. Maintauk Ltd is not currently VAT registered, so every
     one of these would be factually wrong and not merely unwise. */
  { pattern: /\+\s*VAT/i, reason: "Maintauk Ltd is not currently VAT registered, so no price may be qualified with VAT" },
  { pattern: /ex\.?\s*VAT/i, reason: "Maintauk Ltd is not currently VAT registered" },
  { pattern: /exclud\w*\s+VAT/i, reason: "Maintauk Ltd is not currently VAT registered" },
  { pattern: /plus\s+VAT/i, reason: "Maintauk Ltd is not currently VAT registered" },
  { pattern: /VAT\s+extra/i, reason: "Maintauk Ltd is not currently VAT registered" },
  { pattern: /subject\s+to\s+VAT/i, reason: "Maintauk Ltd is not currently VAT registered" },
  /* A price. `rates.ts` is the site's single source for every number and checks
     its own invariant at module load; a figure typed here could not be checked
     against it, and nothing would notice when the two disagreed. */
  {
    pattern: /£\s*\d/,
    reason:
      "a price cannot be typed into a page — app/(marketing)/_sections/rates.ts is the single source for every figure on the site, and a second one could not be reconciled with it",
  },
];

/**
 * The first rule a piece of copy breaks, or null.
 *
 * Whitespace is collapsed first for the same reason the source test collapses it:
 * a phrase split across two lines is the same phrase, and a rule that a line break
 * defeats is not a rule.
 */
export function claimViolation(value: string): string | null {
  const flat = value.replace(/\s+/g, " ");
  for (const rule of CONTENT_RULES) {
    if (rule.pattern.test(flat)) return rule.reason;
  }
  /* The one permitted mention of VAT, checked sentence by sentence exactly as
     `homepage-v3` checks it — so "our prices are subject to VAT" cannot hide in a
     paragraph that also contains the permitted sentence. */
  for (const sentence of flat.match(/[^.]*\bVAT\b[^.]*\.?/gi) ?? []) {
    if (!/not currently VAT registered/i.test(sentence)) {
      return "VAT may only be mentioned to say that Maintauk Ltd is not currently VAT registered";
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type BlockBody = Record<string, unknown>;

export type BlockValidation =
  | { ok: true; kind: BlockKind; body: BlockBody }
  | { ok: false; reason: string };

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/**
 * A link a browser may follow, or null.
 *
 * ONLY a same-site path or an `https://` URL. That is an allowlist of two shapes
 * rather than a blocklist of dangerous schemes, which is the whole point:
 * `javascript:`, `data:`, `vbscript:` and everything anybody invents next are
 * refused because they are not on the list, not because somebody remembered them.
 *
 * A protocol-relative `//host` is refused too — it inherits the page's scheme and
 * reads like a path while pointing somewhere else entirely.
 */
export function cleanHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 400) return null;
  if (trimmed.startsWith("//")) return null;
  if (trimmed.startsWith("/")) return trimmed;
  if (/^https:\/\/[^\s/?#]+/i.test(trimmed)) return trimmed;
  return null;
}

function lines(value: unknown, max: number, maxItems: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value.slice(0, maxItems)) {
    const cleaned = text(entry, max);
    if (cleaned) out.push(cleaned);
  }
  return out.length ? out : null;
}

function pairs(
  value: unknown,
  max: number,
  maxItems: number,
): Array<{ question: string; answer: string }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ question: string; answer: string }> = [];
  for (const entry of value.slice(0, maxItems)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const question = text(record.question, 300);
    const answer = text(record.answer, max);
    /* Both halves or neither. A question with no answer is a worse page than no
       question, and it would render as a heading that promises something. */
    if (question && answer) out.push({ question, answer });
  }
  return out.length ? out : null;
}

/**
 * Coerce a submitted block into something the renderer can index safely.
 *
 * Returns a NEW object built field by field from the catalogue — never the
 * caller's, so an unknown extra key cannot ride along into storage. A field that
 * fails is dropped; a REQUIRED field that fails refuses the whole block, because a
 * block missing the thing it exists to show is not a block.
 */
export function validateBlock(kind: unknown, body: unknown): BlockValidation {
  if (typeof kind !== "string") return { ok: false, reason: "A block needs a kind." };
  const definition = blockDefinition(kind);
  if (!definition) {
    return { ok: false, reason: `Unknown block: ${kind}. Expected one of ${BLOCK_KINDS.join(", ")}.` };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: `${definition.label} needs a body object.` };
  }
  const source = body as Record<string, unknown>;
  const out: BlockBody = {};

  for (const [name, rule] of Object.entries(definition.fields)) {
    let value: unknown = null;
    if (rule.kind === "text") value = text(source[name], rule.max);
    else if (rule.kind === "href") value = cleanHref(source[name]);
    else if (rule.kind === "lines") value = lines(source[name], rule.max, rule.maxItems);
    else if (rule.kind === "pairs") value = pairs(source[name], rule.max, rule.maxItems);

    if (value === null) {
      if (rule.required) {
        return {
          ok: false,
          reason:
            rule.kind === "href"
              ? `${definition.label}: ${name} must be a path beginning "/" or an https:// address.`
              : `${definition.label}: ${name} is required.`,
        };
      }
      continue;
    }
    out[name] = value;
  }

  /*
   * The claims rules, applied to what was actually accepted rather than to what
   * was submitted — so a phrase in a field that was dropped for another reason
   * cannot refuse a block that would not have carried it anyway.
   *
   * Applied AFTER shape and to every string the block ends up holding, including
   * the ones nested inside a question-and-answer pair. See `CONTENT_RULES` for why
   * a CMS has to do this rather than leave it to the source-text tests.
   */
  const broken = claimViolation(stringsOf(out).join(" . "));
  if (broken) return { ok: false, reason: `${definition.label}: ${broken}.` };

  return { ok: true, kind: definition.kind, body: out };
}

/** Every string a validated body holds, at any depth the catalogue allows. */
function stringsOf(body: BlockBody): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(body);
  return out;
}

/**
 * Read a stored block body back, dropping anything the catalogue no longer knows.
 *
 * The mirror of validation, and it exists for the same reason the icon renderer
 * narrows a stored glyph: a row written before a field was retired must not reach
 * a renderer that has stopped expecting it. Storage is the past; the catalogue is
 * the present.
 */
export function readBlockBody(kind: string, raw: unknown): BlockBody | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const checked = validateBlock(kind, parsed);
  return checked.ok ? checked.body : null;
}

/* ------------------------------------------------------------------ */
/* Slugs                                                              */
/* ------------------------------------------------------------------ */

/**
 * The slugs a CMS page may NOT take, because something else already answers there.
 *
 * `p` itself, and the six static marketing routes. A CMS page at `/p/terms` would
 * not collide with `/terms` technically — the prefix keeps them apart — but a
 * second page called "terms" on one site is a support call, so the name is refused
 * at the door.
 */
export const RESERVED_SLUGS: readonly string[] = [
  "p",
  "contractors",
  "cookies",
  "faqs",
  "privacy",
  "terms",
  "admin",
  "dashboard",
  "login",
  "api",
];

/**
 * A URL segment, or null.
 *
 * Lowercase letters, digits and single hyphens. Deliberately narrow: a slug ends
 * up in a URL, in a canonical tag and in a sitemap one day, and every character
 * beyond this set is one that has to be encoded somewhere and read back
 * correctly everywhere.
 */
export function cleanSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) return null;
  if (trimmed.length > 80) return null;
  if (RESERVED_SLUGS.includes(trimmed)) return null;
  return trimmed;
}
