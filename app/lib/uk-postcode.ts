/**
 * UK POSTCODES — capture, normalise, validate. 2H.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 *
 * NOT geocoding. There is no geocoding provider configured in this product —
 * swept `app/`, `db/`, `worker/`, `docs/` and `package.json`: no Mapbox, no
 * Nominatim, no Google Geocoding, no postcodes.io, no OpenCage, and no
 * `geocod*` symbol anywhere. The one Google Maps reference is a link-out that
 * CONSUMES an address. So a postcode cannot become a latitude here, and nothing
 * in this file pretends otherwise.
 *
 * What it does instead is the half that needs no provider and was missing: a
 * postcode written any of the ways people write it becomes one canonical
 * string, and a postcode that is not a postcode is refused at the point somebody
 * types it rather than discovered later by whoever tries to plot it.
 *
 * ── WHY IT MATTERS ON THIS ESTATE ─────────────────────────────────────────
 *
 * Measured on Staging's Demo Client, 2026-09-10: all twelve sites carry
 * `postcode: null`, `latitude: null`, `longitude: null`. `siteCompleteness`
 * already counts postcode as a required detail, so every one of those twelve
 * reads "details missing" — and there was nothing anywhere that said what a
 * valid postcode looked like, so the field could be filled with anything and
 * the count would go quiet.
 *
 * ── THE FORMAT ────────────────────────────────────────────────────────────
 *
 * Outward code (area + district) then inward code (sector + unit), e.g.
 * `SW1A 1AA`, `M1 1AE`, `B33 8TH`, `CR2 6XH`, `DN55 1PT`. The inward code is
 * always exactly `digit letter letter`, and the two letters exclude C, I, K, M,
 * O and V — Royal Mail excludes them because they are the ones that misread in
 * handwriting and OCR. That exclusion is the single most useful part of the
 * pattern: it is what makes "SW1A 1AO" refusable.
 *
 * NOT a validation of EXISTENCE. `ZZ99 9ZZ` is well-formed and is not a real
 * delivery point. Only a lookup service knows the difference, and there is
 * none — so this refuses what cannot be a postcode and accepts what could be,
 * which is the honest boundary and is stated on `isValidUkPostcode` too.
 *
 * No database imports: the Sites form is a client component.
 */

/**
 * The Royal Mail format, anchored, over an already-stripped string.
 *
 * Written as one expression rather than assembled from parts because every
 * hand-assembled version of this pattern in the wild has a different set of
 * bugs, and a reader can check this one against the examples above.
 *
 *   [A-Z]{1,2}          area — one or two letters
 *   [0-9][A-Z0-9]?      district — a digit, then optionally a digit or letter
 *   [0-9]               sector
 *   [ABD-HJLNP-UW-Z]{2} unit — the alphabet minus C I K M O V
 */
const UK_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][ABD-HJLNP-UW-Z]{2}$/;

/**
 * The real codes the general pattern cannot express.
 *
 * Both of these begin with three letters, which no ordinary outward code does —
 * that is precisely why they need naming. BFPO codes (`BF1 1AA`) are NOT here:
 * they are ordinary in shape and the pattern above already accepts them, and
 * listing them would suggest the pattern does not.
 */
const SPECIAL_CASES = new Set([
  /* The Girobank, still issued, still printed on stationery. */
  "GIR0AA",
  /* `SAN TA1`. A real, deliverable Royal Mail code; refusing it is a bug
     somebody hits once a year and never gets round to reporting. */
  "SANTA1",
]);

/** Everything but letters and digits, folded to upper case. */
function strip(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Is this a well-formed UK postcode?
 *
 * Well-formed, NOT existing. `ZZ99 9ZZ` passes here and is not a real delivery
 * point; telling those apart needs a lookup service and this product has none.
 * The honest guarantee is "this cannot be a postcode" on the false side and
 * "this could be" on the true side.
 */
export function isValidUkPostcode(value: string): boolean {
  const stripped = strip(value);
  return stripped.length >= 5 && (UK_POSTCODE.test(stripped) || SPECIAL_CASES.has(stripped));
}

/**
 * The canonical spelling: upper case, one space before the three-character
 * inward code.
 *
 * THE SPACE IS PUT BACK FROM THE RIGHT, always. Splitting from the left needs to
 * know whether the district is one or two characters, which is the thing that
 * varies; the inward code is exactly three characters in every UK postcode
 * there has ever been. So "m11ae" and "M1 1AE" and "m1-1ae" all become "M1 1AE",
 * and no branch is needed.
 *
 * Anything this cannot parse is returned TRIMMED AND UNCHANGED rather than
 * mangled or emptied. A caller that wants the input refused should ask
 * `isValidUkPostcode`; a caller that is only tidying must never lose what
 * somebody typed — an overseas site's postal code goes through here too.
 */
export function formatUkPostcode(value: string): string {
  const stripped = strip(value);
  if (!isValidUkPostcode(value)) return value.trim();
  return `${stripped.slice(0, -3)} ${stripped.slice(-3)}`;
}

/**
 * The outward code — the half that identifies the town and the delivery office.
 *
 * The part a person recognises ("that's an M1 store"), and the only part of a
 * postcode that is useful for grouping without a lookup service. Returns null
 * rather than a guess for anything unparseable.
 */
export function postcodeOutwardCode(value: string): string | null {
  if (!isValidUkPostcode(value)) return null;
  return strip(value).slice(0, -3);
}

/** What a form should say, or `null` when there is nothing to say. */
export type PostcodeCheck = {
  /** The canonical spelling, ready to store. */
  value: string;
  /** A sentence for the field, or null when the value is fine or empty. */
  problem: string | null;
};

/**
 * Check one typed postcode.
 *
 * EMPTY IS NOT AN ERROR HERE, deliberately. A postcode is a detail
 * `siteCompleteness` chases, not a field that blocks a save — refusing to save a
 * site because its postcode is not to hand would make the form harder to finish
 * than the spreadsheet it replaces, and the missing-details list is the
 * mechanism that already exists for chasing it.
 *
 * Whether a country other than the UK is in play is the CALLER's question. This
 * module knows one format and says so; `site-form.tsx` shows the message as a
 * hint rather than a block for exactly that reason.
 */
export function checkPostcode(value: string): PostcodeCheck {
  const trimmed = value.trim();
  if (!trimmed) return { value: "", problem: null };
  if (!isValidUkPostcode(trimmed)) {
    return {
      value: trimmed,
      /* Names the shape rather than saying "invalid". "Invalid" tells somebody
         they are wrong; an example tells them what to type. */
      problem: "That does not look like a UK postcode — the format is like SW1A 1AA.",
    };
  }
  return { value: formatUkPostcode(trimmed), problem: null };
}
