/**
 * THE ORPHAN-NUMBER VALIDATOR — the last thing between a model and a client.
 *
 * Module 4 §4.3 states the rule the whole narrative feature is built around:
 * the model writes sentences AROUND figures it is given and never produces one.
 * The prompt says so, but a prompt is a request. This file is the enforcement:
 * every number, currency amount, percentage and date in a generated paragraph
 * is extracted and checked against the locked set that was computed BEFORE the
 * model ran. One token that is not in that set refuses the whole draft with
 * "The draft contains a figure not present in the data."
 *
 * ── WHY IT FAILS CLOSED, EVERY TIME ────────────────────────────────────────
 *
 * A false positive here costs an operator one click on Regenerate. A false
 * negative puts an invented figure in a document a client is invoiced against.
 * Those are not comparable, so every judgement call below is resolved towards
 * refusing. That is also why nothing in this file "helpfully" widens the locked
 * set — no rounding tolerance, no ±1, no "close enough". `£1.75k` passes only
 * if £1,750.00 is genuinely in the data; against a real figure of £1,758.00 it
 * is a rounded number the model produced, which is exactly what §4.3 forbids.
 *
 * ── WHAT COUNTS AS A FIGURE ────────────────────────────────────────────────
 *
 *   money        £1,758.00 · £1,758 · -£12.00 · £1.75k · £5 million
 *                Checked against the LOCKED AMOUNTS in pounds and in pence, so
 *                the same figure passes whether the sentence writes 1758 or
 *                175800. Magnitude only — see "sign" below.
 *   percentage   62% · 62.0% · 62 per cent      Checked against the locked
 *                PERCENTAGES only, so a job count of 62 does not license "62%".
 *   number       47 · 1,758 · 17.5              Counts and bare amounts.
 *   date         2026-03-31 · 31 March 2026 · 31/03/2026
 *   month        March 2026 · 2026-03           Checked against the months the
 *                locked dates fall in, so a report for March cannot say April.
 *   year         2026                           Checked against the YEARS of
 *                the locked dates rather than against the counts — see below.
 *   identifier   MS-2026-003 · P1 · JOB-1042    A token mixing letters and
 *                digits. Checked against the references the payload carries, so
 *                an invented invoice number or job reference is caught too.
 *
 * ── SPELLED-OUT NUMBERS COUNT. THE DECISION, AND WHY ───────────────────────
 *
 * "four sites were past target" is a figure. It is a claim about a quantity, a
 * reader treats it exactly as they would treat "4", and a model that has been
 * told not to write digits it was not given will reach for words if words are
 * unchecked. Ignoring them would leave the single most obvious way around this
 * file wide open, so a bounded lexicon of CARDINALS — zero through twenty, the
 * tens with their hyphenated compounds, and hundred/thousand/million — is
 * extracted and validated like any digit.
 *
 * The cost is admitted rather than hidden: "one" is a common English word and
 * some sentences will be refused for using it where 1 is not in the data. Two
 * things keep that tolerable. The hyphen guard skips `one-off`, `one-to-one`
 * and the like, which is where most of the noise was. And the prompt asks for
 * digits, so a compliant draft rarely reaches this rule at all. Where it does,
 * the operator edits the word out — a cheap outcome next to the alternative.
 *
 * ORDINALS ARE NOT CARDINALS and are not extracted: "the first site" and "the
 * 21st" name a position in a list, not a quantity, and there is nothing in a
 * figure set for them to match.
 *
 * ── WHAT IS DELIBERATELY NOT A FIGURE, AND THE HOLE EACH ONE LEAVES ────────
 *
 * Every exclusion is somewhere a wrong number could be driven through, so each
 * is named with its hole rather than left implicit.
 *
 *  1. ORDINALS — `1st`, `21st`, `first`, `third`. A position, not a quantity.
 *     HOLE: "the third quarter" can name the wrong quarter. Mitigated only by
 *     the period label and dates, which ARE validated.
 *  2. QUARTER TOKENS — `Q1`…`Q4`. A period label, and §4.3 names it as a
 *     non-figure explicitly. HOLE: the same as (1).
 *  3. SIGN — `-£12.00` and `£12.00` canonicalise to the same magnitude, and the
 *     locked set carries both signed and absolute forms. HOLE: "spend was
 *     £12.00 higher" when it was lower. Nothing textual can settle direction;
 *     the locked block hands the model the direction as a WORD so it does not
 *     have to infer one.
 *  4. BARE FOUR-DIGIT YEARS (1900-2199) — validated against the years of the
 *     locked DATES, never against the counts. Otherwise a report whose data
 *     happens to contain the count 2026 would license the year 2026 and vice
 *     versa. HOLE: a genuine count in that range must be written with a
 *     separator (`2,026`) or it reads as a year and is refused.
 *  5. CLOCK TIMES — `09:00`. Nothing in the payload is a time of day, and
 *     splitting one into 9 and 0 would manufacture two orphans out of a
 *     harmless string. HOLE: an invented time is not caught. The narrative
 *     blocks have no reason to state one.
 *  6. VAGUE QUANTIFIERS — "approximately", "several", "a handful". These are
 *     unsourced quantities, but they are not tokens with a value, so they
 *     cannot be matched against anything. They are reported as `hedges` and do
 *     NOT block: refusing a draft for the word "nearly" would train operators
 *     to work around the validator, which is the one outcome worse than the
 *     hedge itself. The panel shows them so a human removes them.
 *  7. TOKENS INSIDE AN IDENTIFIER — the `1042` of `JOB-1042` is never read as
 *     the number 1042. It is a label. Reading it as a quantity would mean
 *     every reference in the payload had to be added to the numeric set, and
 *     that set would then license those digits as quantities anywhere in the
 *     prose — a far bigger hole than the one it closed.
 *  8. CLASSIFICATION LABELS — `Tier 1`, `Priority 2`, `Band 3`. The same kind
 *     of token as `Q1` and excluded for the same reason the owner excluded
 *     that one: the digit names a service level, not a quantity. This is not
 *     hypothetical tidying — `narrative.ts` has written "urgent or Tier 1" as
 *     a fixed phrase since long before this file existed, and treating its 1
 *     as a count made the computed summary fail its own validator against real
 *     data. HOLE: prose could name the wrong tier. The tier of any individual
 *     job is rendered from the payload in the SLA and job-log tables, not from
 *     a sentence, so a reader has the authoritative value beside the prose.
 *     `P1`-style labels are NOT covered here: they are identifier-shaped, so
 *     they go through the identifier rule and ARE checked against the
 *     classifications the payload carries.
 *
 * ── PURE, AND IMPORTING NOTHING ────────────────────────────────────────────
 *
 * No database handle, no payload type, no provider. It takes prose and a set of
 * strings. That is what lets it be loaded on its own in a test, and what makes
 * it impossible for a code path to reach the model without passing through it.
 */

/* ------------------------------------------------------- the locked set -- */

/**
 * The figures a draft is allowed to use, canonicalised.
 *
 * Built by `lockedFigureSet()` in `narrative-blocks.ts` from the computed
 * payload — never from anything a model returned. The sets are kept apart
 * rather than merged into one because the separation is where the strictness
 * lives: a percentage may only match a percentage, and money may only match
 * money, so a job count of 62 does not quietly authorise "62%".
 */
export interface LockedFigureSet {
  /** Counts and money magnitudes. A bare `47` or `1,758` is checked here. */
  numbers: ReadonlySet<string>;
  /** Money magnitudes only, in pounds AND in pence. `£…` is checked here. */
  amounts: ReadonlySet<string>;
  /** Percentages only. `…%` is checked here. */
  percentages: ReadonlySet<string>;
  /** ISO calendar dates, `YYYY-MM-DD`. */
  dates: ReadonlySet<string>;
  /** `YYYY-MM`, derived from the dates. */
  months: ReadonlySet<string>;
  /** `YYYY`, derived from the dates. */
  years: ReadonlySet<string>;
  /** Upper-cased references, classifications and codes the payload carries. */
  identifiers: ReadonlySet<string>;
}

export function emptyLockedFigureSet(): LockedFigureSet {
  return {
    numbers: new Set(),
    amounts: new Set(),
    percentages: new Set(),
    dates: new Set(),
    months: new Set(),
    years: new Set(),
    identifiers: new Set(),
  };
}

/* --------------------------------------------------------- canonical form -- */

/**
 * One numeric value, one string, whatever notation wrote it.
 *
 * `1758`, `1,758`, `1758.00` and `£1,758.00` all arrive here as 1758 and leave
 * as "1758", which is the whole reason "the same figure in a different format"
 * is recognised rather than being a second orphan. Six decimal places, because
 * the payload is integer pence and a hundredth is the smallest thing a report
 * ever states — the rounding is there to absorb binary representation, not to
 * grant a tolerance.
 */
export function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  const settled = Number(value.toFixed(6));
  /* `-0` and `0` are the same figure; only one of them should be a key. */
  return String(settled === 0 ? 0 : settled);
}

/** `YYYY-MM-DD` from parts, with no timezone anywhere near it. */
function isoDate(year: number, month: number, day: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/* --------------------------------------------------------- word cardinals -- */

/**
 * The bounded lexicon. Deliberately small: everything in it is unambiguously a
 * quantity when it stands alone, and nothing outside it is guessed at.
 */
const WORD_UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const WORD_TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const WORD_SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1000000,
};

/** Longest first, or `four` would win inside `fourteen`. */
function alternation(words: readonly string[]): string {
  return [...words].sort((a, b) => b.length - a.length).join("|");
}

const TENS_COMPOUND = `(?:${alternation(Object.keys(WORD_TENS))})(?:[-\\s](?:${alternation(
  Object.keys(WORD_UNITS).filter((word) => word !== "zero"),
)}))?`;

/*
 * The hyphen guard. `one-off`, `one-to-one` and `three-quarters` are idioms,
 * not quantities, and they were the bulk of the false positives when this was
 * first measured. A compound like `twenty-four` is matched by TENS_COMPOUND
 * above BEFORE this alternative is reached, so the guard costs nothing real.
 */
const WORD_NUMBER = `\\b(?:${TENS_COMPOUND}|(?:${alternation([
  ...Object.keys(WORD_UNITS),
  ...Object.keys(WORD_SCALES),
])})(?![-\\w]))\\b`;

function wordNumberValue(token: string): number | null {
  const normalised = token.toLowerCase().replace(/\s+/g, "-");
  if (normalised in WORD_UNITS) return WORD_UNITS[normalised];
  if (normalised in WORD_SCALES) return WORD_SCALES[normalised];
  const [tens, unit] = normalised.split("-");
  if (tens in WORD_TENS) {
    if (!unit) return WORD_TENS[tens];
    if (unit in WORD_UNITS) return WORD_TENS[tens] + WORD_UNITS[unit];
  }
  return null;
}

/* ------------------------------------------------------------ extraction -- */

export type FigureKind =
  | "money"
  | "percent"
  | "number"
  | "date"
  | "month"
  | "year"
  | "identifier";

export interface ExtractedFigure {
  kind: FigureKind;
  /** Exactly as the prose wrote it, for the message an operator reads. */
  token: string;
  /** The form checked against the locked set. */
  canonical: string;
  /** Character offset, so the panel can point at it. */
  index: number;
}

type TokenKind =
  | FigureKind
  /* Matched so that it is CONSUMED and cannot be re-read as something else. */
  | "excluded";

interface Pattern {
  name: string;
  kind: TokenKind;
  source: string;
}

const MONTH_ALTERNATION = alternation(MONTH_NAMES);

/*
 * ORDER IS THE DESIGN. The engine tries these alternatives left to right at
 * each position, so a longer, more specific reading always gets first refusal:
 * `2026-03-31` is a date before it is a year, `£1,758.00` is money before it is
 * the number 1758, `1st` is an ordinal before it is the number 1, and `four` is
 * a cardinal before the identifier rule can swallow it as an ordinary word.
 *
 * The identifier alternative matches every English word and most of them are
 * discarded a line later for having no digit in them. That is deliberate: it is
 * how `JOB-1042` gets consumed WHOLE, so its digits never reach the numeric
 * rule and never have to be added to the numeric set to keep the peace.
 */
const PATTERNS: Pattern[] = [
  { name: "time", kind: "excluded", source: String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\b` },
  { name: "isoDate", kind: "date", source: String.raw`\b\d{4}-\d{2}-\d{2}\b` },
  { name: "isoMonth", kind: "month", source: String.raw`\b\d{4}-\d{2}\b` },
  { name: "slashDate", kind: "date", source: String.raw`\b\d{1,2}\/\d{1,2}\/\d{4}\b` },
  {
    name: "longDate",
    kind: "date",
    source: String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTH_ALTERNATION})\s+\d{4}\b`,
  },
  {
    name: "monthYear",
    kind: "month",
    source: String.raw`\b(?:${MONTH_ALTERNATION})\s+\d{4}\b`,
  },
  { name: "quarter", kind: "excluded", source: String.raw`\bQ[1-4]\b` },
  {
    name: "classLabel",
    kind: "excluded",
    source: String.raw`\b(?:tier|priority|band|level|phase|category|class)\s+\d{1,2}\b`,
  },
  {
    name: "money",
    kind: "money",
    source: String.raw`[-−]?\s?£\s?[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:thousand|million|billion|bn|k|m)\b)?`,
  },
  {
    name: "percent",
    kind: "percent",
    source: String.raw`\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?%|\s+per\s+cent)`,
  },
  { name: "ordinal", kind: "excluded", source: String.raw`\b\d{1,4}(?:st|nd|rd|th)\b` },
  { name: "wordNumber", kind: "number", source: WORD_NUMBER },
  {
    name: "identifier",
    kind: "identifier",
    source: String.raw`\b[A-Za-z][A-Za-z0-9]*(?:[-_\/][A-Za-z0-9]+)*\b`,
  },
  { name: "year", kind: "year", source: String.raw`\b(?:19|20|21)\d{2}\b` },
  {
    name: "number",
    kind: "number",
    source: String.raw`\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\b`,
  },
];

/** One expression, one left-to-right pass. Named groups say which rule won. */
const SCANNER = new RegExp(
  PATTERNS.map((pattern) => `(?<${pattern.name}>${pattern.source})`).join("|"),
  "gi",
);

const MULTIPLIERS: Record<string, number> = {
  k: 1000,
  thousand: 1000,
  m: 1000000,
  million: 1000000,
  bn: 1000000000,
  billion: 1000000000,
};

/** `1,758.00` -> 1758. Separators are notation, not value. */
function plainNumber(text: string): number {
  return Number.parseFloat(text.replace(/,/g, ""));
}

function moneyValue(token: string): number | null {
  const digits = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/.exec(token);
  if (!digits) return null;
  let value = plainNumber(digits[0]);
  const suffix = /\s?(thousand|million|billion|bn|k|m)\s*$/i.exec(token);
  if (suffix) value *= MULTIPLIERS[suffix[1].toLowerCase()];
  /* Magnitude only — see exclusion (3) in the header. */
  return Math.abs(value);
}

function longDateIso(token: string): string | null {
  const match = new RegExp(
    String.raw`^(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALTERNATION})\s+(\d{4})$`,
    "i",
  ).exec(token.trim());
  if (!match) return null;
  const month = MONTH_NAMES.indexOf(match[2].toLowerCase() as (typeof MONTH_NAMES)[number]) + 1;
  return isoDate(Number(match[3]), month, Number(match[1]));
}

function slashDateIso(token: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(token.trim());
  if (!match) return null;
  /*
   * DAY FIRST. This is a UK product, every date the payload holds is ISO, and
   * `03/04/2026` in a British maintenance report is the 3rd of April. Reading
   * it the other way would silently accept a date the data does not contain.
   */
  return isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
}

function monthYearIso(token: string): string | null {
  const match = new RegExp(String.raw`^(${MONTH_ALTERNATION})\s+(\d{4})$`, "i").exec(token.trim());
  if (!match) return null;
  const month = MONTH_NAMES.indexOf(match[1].toLowerCase() as (typeof MONTH_NAMES)[number]) + 1;
  return `${match[2]}-${String(month).padStart(2, "0")}`;
}

/**
 * Every figure in a piece of prose, in the order it was written.
 *
 * Exported on its own because the panel shows an operator what the validator
 * saw. A rule that refuses a draft and cannot say which token it objected to is
 * a rule people learn to distrust.
 */
export function extractFigures(prose: string): ExtractedFigure[] {
  const figures: ExtractedFigure[] = [];
  if (!prose) return figures;

  SCANNER.lastIndex = 0;
  for (const match of prose.matchAll(SCANNER)) {
    const groups = match.groups ?? {};
    const name = Object.keys(groups).find((key) => groups[key] !== undefined);
    if (!name) continue;
    const pattern = PATTERNS.find((entry) => entry.name === name);
    if (!pattern || pattern.kind === "excluded") continue;

    const token = match[0];
    const index = match.index ?? 0;
    let canonical: string | null = null;
    let kind: FigureKind = pattern.kind;

    switch (name) {
      case "isoDate":
        canonical = token;
        break;
      case "isoMonth":
        canonical = token;
        break;
      case "slashDate":
        canonical = slashDateIso(token);
        break;
      case "longDate":
        canonical = longDateIso(token);
        break;
      case "monthYear":
        canonical = monthYearIso(token);
        break;
      case "money": {
        const value = moneyValue(token);
        canonical = value === null ? null : canonicalNumber(value);
        break;
      }
      case "percent": {
        const digits = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/.exec(token);
        canonical = digits ? canonicalNumber(plainNumber(digits[0])) : null;
        break;
      }
      case "wordNumber": {
        const value = wordNumberValue(token);
        canonical = value === null ? null : canonicalNumber(value);
        break;
      }
      case "identifier": {
        /* A word with no digit in it is not an identifier, it is English. */
        if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) continue;
        canonical = token.toUpperCase();
        kind = "identifier";
        break;
      }
      case "year":
        canonical = token;
        break;
      case "number":
        canonical = canonicalNumber(plainNumber(token));
        break;
      default:
        canonical = null;
    }

    if (canonical === null || canonical === "") continue;
    figures.push({ kind, token: token.trim(), canonical, index });
  }

  return figures;
}

/* ---------------------------------------------------------------- hedges -- */

/**
 * Rounding and vagueness. Reported, never blocking — see exclusion (6).
 *
 * Deliberately excludes "about" and "around": both are far more often
 * prepositions than quantifiers ("a note about the site"), and a rule that
 * fires on ordinary English is a rule that gets switched off.
 */
const HEDGE_WORDS = [
  "approximately",
  "roughly",
  "circa",
  "nearly",
  "almost",
  "a few",
  "several",
  "dozens",
  "a handful",
  "or so",
  "in excess of",
  "somewhere between",
] as const;

const HEDGE_SCANNER = new RegExp(`\\b(${HEDGE_WORDS.join("|")})\\b`, "gi");

export interface HedgeFinding {
  word: string;
  index: number;
}

export function findHedges(prose: string): HedgeFinding[] {
  if (!prose) return [];
  HEDGE_SCANNER.lastIndex = 0;
  return [...prose.matchAll(HEDGE_SCANNER)].map((match) => ({
    word: match[0],
    index: match.index ?? 0,
  }));
}

/* -------------------------------------------------------------- the check -- */

/**
 * The sentence §4.3 specifies, word for word. It is the operator-facing text
 * and the API's `error`, so there is exactly one of it.
 */
export const ORPHAN_FIGURE_MESSAGE =
  "The draft contains a figure not present in the data.";

export interface FigureValidation {
  ok: boolean;
  /** `ORPHAN_FIGURE_MESSAGE` plus the offending tokens, or null when clean. */
  message: string | null;
  figures: ExtractedFigure[];
  orphans: ExtractedFigure[];
  /** Non-blocking. Rounding language a human should take out. */
  hedges: HedgeFinding[];
}

export interface ValidateOptions {
  /**
   * Whether spelled-out cardinals are figures. Default TRUE, and the default is
   * the contract — see the header. The switch exists so a test can demonstrate
   * exactly what turning it off would let through, not so a caller can quietly
   * relax the rule in production.
   */
  words?: boolean;
  /**
   * Whether identifier-shaped tokens are checked. Default TRUE. Off is for
   * prose about something the payload has no references for.
   */
  identifiers?: boolean;
}

function isPresent(figure: ExtractedFigure, locked: LockedFigureSet): boolean {
  switch (figure.kind) {
    case "money":
      return locked.amounts.has(figure.canonical);
    case "percent":
      return locked.percentages.has(figure.canonical);
    case "number":
      return locked.numbers.has(figure.canonical);
    case "date":
      return locked.dates.has(figure.canonical);
    case "month":
      return locked.months.has(figure.canonical);
    case "year":
      return locked.years.has(figure.canonical);
    case "identifier":
      return locked.identifiers.has(figure.canonical);
    default:
      return false;
  }
}

/**
 * Refuse a draft that states anything the data does not.
 *
 * The one call every generated block passes through before it is stored. It is
 * not a lint and it is not advisory: `ok: false` means the prose is discarded,
 * not saved with a warning on it.
 */
export function validateProseFigures(
  prose: string,
  locked: LockedFigureSet,
  options: ValidateOptions = {},
): FigureValidation {
  const words = options.words ?? true;
  const identifiers = options.identifiers ?? true;

  const figures = extractFigures(prose).filter((figure) => {
    if (!identifiers && figure.kind === "identifier") return false;
    if (!words && figure.kind === "number" && /[a-z]/i.test(figure.token)) return false;
    return true;
  });

  const orphans = figures.filter((figure) => !isPresent(figure, locked));

  return {
    ok: orphans.length === 0,
    message:
      orphans.length === 0
        ? null
        : `${ORPHAN_FIGURE_MESSAGE} ${
            orphans.length === 1 ? "The figure is" : "The figures are"
          } ${orphans.map((figure) => `"${figure.token}"`).join(", ")}.`,
    figures,
    orphans,
    hedges: findHedges(prose),
  };
}
