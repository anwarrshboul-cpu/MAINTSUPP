/**
 * WHAT A CERTIFICATE IS CALLED — and why an editable list was not enough.
 *
 * ── THE DEFECT THIS MODULE EXISTS FOR ─────────────────────────────────────
 *
 * `ensureComplianceProfile` matched an existing requirement on EXACT `kind`.
 * Real estates do not use the board's vocabulary. Measured on Staging's Demo
 * Client (`org_…0002`, 12 sites) on 2026-09-10:
 *
 *   the estate's own name                       rows   the board's name for it
 *   ───────────────────────────────────────────  ────  ───────────────────────
 *   Fire risk assessment                          11   Fire Risk Assessment
 *   Electrical installation condition report       13   Electrical Wiring
 *   Emergency lighting certificate                 11   Emergency Lighting
 *   Fire alarm service certificate                  3   Fire Alarm
 *   Legionella risk assessment                     12   Water Hygiene
 *   PAT testing certificate                         4   PAT Test
 *   Air conditioning inspection report              3   — nothing
 *   Gas safety certificate                          3   — nothing
 *
 * Sixty real requirements. The repair recognised NONE of them and added twelve
 * more per site beside them, so twelve stores hold 204 rows where they should
 * hold about 66, and the confirm queue asks about roughly twenty-four
 * certificates per store — half of them the same certificate under another
 * name. The portfolio figure reads 18% because 144 of the 204 are excluded.
 *
 * Read the first row again: "Fire risk assessment" and "Fire Risk Assessment"
 * DIFFER ONLY IN CASE. That single row is the whole argument. A list an
 * operator can edit does not help somebody whose data already says
 * "Legionella risk assessment" and who has no idea the machine wanted "Water
 * Hygiene"; and no amount of editing fixes a mismatch caused by a capital R.
 * What the data asks for is a RESOLVER — normalise, then look through a
 * synonym map — with the editable list layered on top of it.
 *
 * ── THE THREE LAYERS, IN THE ORDER THEY ARE TRIED ─────────────────────────
 *
 *   1. `normaliseKind` — case, punctuation and spacing folded away. Free, and
 *      it alone would have prevented eleven of the duplicate rows above.
 *   2. `BUILT_IN_KIND_ALIASES` — the trade's ordinary names for the twelve
 *      board slots. Shipped, not configured, because a fresh tenant has no
 *      template yet and is exactly the tenant most likely to type
 *      "EICR" into a spreadsheet.
 *   3. the organisation's own template — `ComplianceTemplate`, stored in
 *      `workspace_settings`. This is where an estate adds "Gas safety
 *      certificate" as a requirement in its own right, or teaches the resolver
 *      a name only it uses.
 *
 * ── WHY THE EXTRA TWO ARE NOT ALIASES ─────────────────────────────────────
 *
 * "Air conditioning inspection report" and "Gas safety certificate" are not
 * other names for anything on the board. They are requirements the board does
 * not track, and folding them into a board slot would be a lie that loses a
 * real certificate. They stay as they are — `readComplianceRegister`'s second
 * loop already emits register-only rows — and the editable template is how an
 * estate promotes them to requirements it wants every site asked about.
 *
 * ── NO DATABASE IMPORTS ───────────────────────────────────────────────────
 *
 * Same discipline as `site-name-link.ts`: the Settings editor is a client
 * component and must be able to show an operator what the resolver would do
 * without the ORM going with it. The storage half is
 * `compliance-template-store.ts`.
 */

import { storeDocumentationKinds } from "../../db/monday-board-spec";

/**
 * Fold a requirement name to a comparison key.
 *
 * Case, punctuation, spacing and the word "certificate" are all noise: nobody
 * means a different thing by "PAT test certificate" than by "PAT Test". The
 * trailing-noun strip is deliberately a SUFFIX rule rather than a
 * remove-anywhere rule — "Certificate of insurance" must not become
 * "ofinsurance".
 *
 * Note what is NOT stripped: nothing that changes which certificate is meant.
 * "Fire alarm" and "Fire door" survive as different keys, and they must, or a
 * fold would merge two of the twelve.
 */
export function normaliseKind(value: string): string {
  const folded = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  /* One pass, not a loop: "…service certificate report" is not a thing anybody
     writes, and a loop here would eventually eat a real word. */
  const trimmed = folded.replace(
    /\s+(certificates?|reports?|records?|tests?|inspections?|services?)$/,
    "",
  );
  return (trimmed || folded).replace(/\s+/g, "");
}

/**
 * The trade's ordinary names for the twelve board slots.
 *
 * Every entry is either MEASURED on a real estate (marked) or a name this
 * industry uses so consistently that a fresh tenant typing it is the expected
 * case, not the unusual one. Nothing here is a guess about a name that could
 * mean two certificates — where a name is ambiguous it is left out, because a
 * wrong merge silently destroys evidence that a certificate exists and a
 * missing alias merely leaves a duplicate somebody can see and fix.
 *
 * Keys are RAW names; they are normalised when the map is built, so an entry
 * can be written the way a person would write it.
 */
export const BUILT_IN_KIND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "Electrical Wiring": [
    /* MEASURED — 13 rows on Staging's Demo Client. */
    "Electrical installation condition report",
    "EICR",
    "Fixed wire testing",
    "Electrical installation certificate",
  ],
  "PAT Test": [
    /* MEASURED — 4 rows. */
    "PAT testing certificate",
    "Portable appliance testing",
    "PAT",
  ],
  "Emergency Lighting": [
    /* MEASURED — 11 rows. */
    "Emergency lighting certificate",
    "Emergency light test",
  ],
  "Fire Alarm": [
    /* MEASURED — 3 rows. */
    "Fire alarm service certificate",
    "Fire alarm test",
    "Fire detection and alarm system",
  ],
  "Water Hygiene": [
    /*
     * MEASURED — 12 rows, and the one alias here that is a judgement rather
     * than a spelling. A legionella risk assessment IS the water hygiene
     * document this board slot holds for a retail unit; the trade uses the two
     * names for one certificate. Recorded as a judgement so that if an estate
     * ever tracks both separately, this is the line to remove.
     */
    "Legionella risk assessment",
    "Legionella",
    "Water hygiene risk assessment",
    "L8 risk assessment",
  ],
  "Fire Risk Assessment": [
    /*
     * MEASURED — 11 rows, and the cheapest of the eight: it differs from the
     * board's name only by a capital R. `normaliseKind` catches it before this
     * map is ever consulted; it is listed anyway so the measurement is not lost
     * if the normaliser is ever narrowed.
     */
    "Fire risk assessment",
    "FRA",
  ],
  "Fire Extinguisher": [
    "Fire extinguisher service",
    "Extinguisher service certificate",
  ],
  "Fire Door": ["Fire door inspection", "Fire door survey"],
  Sprinkler: ["Sprinkler system certificate", "Sprinkler service"],
  PLI: ["Public liability insurance", "Public liability"],
  RAMS: ["Risk assessment and method statement", "Risk assessment method statement"],
  Drawing: ["Store drawing", "Floor plan", "Site plan"],
};

/** One requirement in an organisation's template. */
export type TemplateKind = {
  /** The name written on every row this requirement creates. */
  kind: string;
  /**
   * Other names that mean this requirement.
   *
   * ADDITIVE to the built-in map, never a replacement for it. An operator
   * removing an alias they never added should not silently un-teach the
   * resolver something it shipped knowing — see `buildKindResolver`.
   */
  aliases: string[];
  /**
   * Whether new sites are given this requirement.
   *
   * A DISABLED REQUIREMENT IS STILL RESOLVED. That is the point of the flag
   * rather than deletion: an estate that switches "Sprinkler" off still holds
   * sprinkler certificates on the four sites that have them, and those rows must
   * keep matching their own name instead of being duplicated the next time
   * anything runs. Disabling stops creation; it never orphans history.
   */
  enabled: boolean;
  /**
   * True for the twelve the Store Documentation board itself tracks.
   *
   * They may be renamed or disabled but not removed, because the board has a
   * column for each of them and a register with no name for a column it can see
   * would show a certificate it cannot label.
   */
  board: boolean;
};

export type ComplianceTemplate = { kinds: TemplateKind[] };

/** The canonical twelve, with the aliases this module ships. */
export const DEFAULT_COMPLIANCE_TEMPLATE: ComplianceTemplate = {
  kinds: storeDocumentationKinds.map((kind) => ({
    kind,
    aliases: [...(BUILT_IN_KIND_ALIASES[kind] ?? [])],
    enabled: true,
    board: true,
  })),
};

/** Resolve a written requirement name to the template's name for it. */
export type KindResolver = (kind: string) => string | null;

/**
 * A resolver over the built-in map and, if given, an organisation's template.
 *
 * ── COLLISIONS ARE RESOLVED BY SPECIFICITY, NOT BY ORDER ──────────────────
 *
 * A canonical name always wins over an alias. Without that rule an operator who
 * types "Fire Alarm" into the aliases box of "Sprinkler" would make every real
 * Fire Alarm row resolve to Sprinkler — one typo silently moving eleven
 * certificates. So the canonical pass is applied after the alias pass and
 * overwrites it, and the FIRST alias claim wins over later ones, so the
 * built-in meaning of a name is not quietly reassigned by a template edit.
 *
 * Returns `null` for a name nothing claims. That is a real answer and callers
 * depend on it: a requirement outside the template keeps its own name and
 * survives as a register-only row rather than being folded into a slot it is
 * not.
 */
export function buildKindResolver(template?: ComplianceTemplate | null): KindResolver {
  const byKey = new Map<string, string>();
  const claim = (name: string, canonical: string, overwrite: boolean) => {
    const key = normaliseKind(name);
    if (!key) return;
    if (overwrite || !byKey.has(key)) byKey.set(key, canonical);
  };

  const kinds = template?.kinds?.length ? template.kinds : DEFAULT_COMPLIANCE_TEMPLATE.kinds;

  /* Pass 1 — aliases. Built-in first so a template cannot un-teach a shipped
     alias by omission, only by claiming the name for something else. */
  for (const entry of kinds) {
    for (const alias of BUILT_IN_KIND_ALIASES[entry.kind] ?? []) {
      claim(alias, entry.kind, false);
    }
  }
  for (const entry of kinds) {
    for (const alias of entry.aliases ?? []) claim(alias, entry.kind, false);
  }

  /* Pass 2 — the names themselves, which outrank every alias. */
  for (const entry of kinds) claim(entry.kind, entry.kind, true);

  return (kind: string) => byKey.get(normaliseKind(kind)) ?? null;
}

/**
 * The requirements a new or repaired site should be given.
 *
 * Only the enabled ones — see `TemplateKind.enabled` for why disabling is not
 * deletion.
 */
export function templateKinds(template?: ComplianceTemplate | null): string[] {
  const kinds = template?.kinds?.length ? template.kinds : DEFAULT_COMPLIANCE_TEMPLATE.kinds;
  return kinds.filter((entry) => entry.enabled).map((entry) => entry.kind);
}

/**
 * Read a template out of whatever came back from the settings blob.
 *
 * Total, and deliberately forgiving: this is read on the create path of every
 * site, and a settings row somebody hand-edited must not stop sites being
 * created. Anything unreadable is the default template, which is the same
 * behaviour the product had before templates existed.
 */
export function parseComplianceTemplate(value: unknown): ComplianceTemplate {
  if (!value || typeof value !== "object") return DEFAULT_COMPLIANCE_TEMPLATE;
  const raw = (value as { kinds?: unknown }).kinds;
  if (!Array.isArray(raw)) return DEFAULT_COMPLIANCE_TEMPLATE;

  const seen = new Set<string>();
  const kinds: TemplateKind[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind.trim() : "";
    if (!kind) continue;
    /* Two rows with the same name would make the register ask about one
       requirement twice, which is the defect this whole module is here to end.
       Keyed on the NORMALISED name, so "PAT Test" and "PAT test" cannot both
       survive a save either. */
    const key = normaliseKind(kind);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kinds.push({
      kind,
      aliases: Array.isArray(record.aliases)
        ? record.aliases
            .filter((alias): alias is string => typeof alias === "string" && alias.trim() !== "")
            .map((alias) => alias.trim())
        : [],
      /* Absent means enabled. A template written before the flag existed
         described twelve requirements every site got. */
      enabled: record.enabled !== false,
      board: record.board === true,
    });
  }
  if (!kinds.length) return DEFAULT_COMPLIANCE_TEMPLATE;

  /*
   * THE TWELVE BOARD SLOTS ARE RE-ADDED IF A SAVE DROPPED THEM.
   *
   * The board has a column for each, and a register that cannot name a column
   * it can see would show a certificate with no label. They come back disabled
   * where the operator had removed them, which honours the intent — no new site
   * gets them — without leaving the board unlabelled.
   */
  for (const kind of storeDocumentationKinds) {
    const key = normaliseKind(kind);
    if (seen.has(key)) continue;
    seen.add(key);
    kinds.push({
      kind,
      aliases: [...(BUILT_IN_KIND_ALIASES[kind] ?? [])],
      enabled: false,
      board: true,
    });
  }
  /* `board` is decided here, never trusted from the payload: it is a fact about
     `storeDocumentationCertificates`, not an operator's opinion. */
  const boardKeys = new Set(storeDocumentationKinds.map((kind) => normaliseKind(kind)));
  for (const entry of kinds) entry.board = boardKeys.has(normaliseKind(entry.kind));

  return { kinds };
}

/**
 * What a resolver would do to a set of names that already exist — the shape the
 * backfill preview and the Settings editor both render.
 *
 * Pure, so the preview a person approves is computed by the same code that will
 * act on it. A preview produced by a second implementation is a preview of
 * something else.
 */
export type KindMerge = {
  /** The name as it is written on the existing rows. */
  kind: string;
  /** The template's name for it, or `null` when nothing claims it. */
  canonical: string | null;
  /** True when the row already carries the template's own name. */
  exact: boolean;
};

export function classifyKinds(
  kinds: Iterable<string>,
  resolve: KindResolver,
): KindMerge[] {
  const out: KindMerge[] = [];
  const seen = new Set<string>();
  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    const canonical = resolve(kind);
    out.push({ kind, canonical, exact: canonical === kind });
  }
  return out;
}
