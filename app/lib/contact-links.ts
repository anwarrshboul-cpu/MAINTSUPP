/**
 * Turning a contact number somebody typed into a link a phone can act on.
 *
 * Two different questions hide inside "make the number clickable", and they
 * have different answers:
 *
 *  - `tel:` is forgiving. A handset dials whatever it is handed and the user
 *    is standing right there to see it fail, so a national number with spaces
 *    in it is a perfectly good dial string once the spacing is removed.
 *
 *  - `https://wa.me/<number>` is NOT forgiving, and it is not the user's own
 *    dialler resolving it. WhatsApp addresses people by full international
 *    number with no `+`, no `00`, and no national trunk `0`. Hand it a UK
 *    number as it is written on a van — `07812 224644` — and it opens on "the
 *    phone number shared via url is invalid", which is a broken promise
 *    dressed up as a working button.
 *
 * So this module refuses rather than guesses. The brief for the field said it
 * outright: do not silently invent a country code. A number we cannot resolve
 * to an international one is still SHOWN — the coordinator can read it and
 * dial it by hand — it simply is not made into a WhatsApp action that would
 * dead-end. `whatsappHref` returning null is the caller's signal to render the
 * digits as plain text instead of a link.
 *
 * Both live here rather than beside the contractor table because the contractor
 * register is not the only place a number is printed, and a second copy of
 * these rules is how the two drift.
 */

/** Everything that is not a digit. Spacing, brackets, dashes, the lot. */
function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

/**
 * A `tel:` href, or null when there is nothing to dial.
 *
 * Keeps a leading `+` because it is meaningful to a dialler, and drops every
 * other non-digit. The visible label is the caller's business: what was typed
 * is what a person recognises, and this is only the machine half.
 */
export function telHref(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const plus = value.startsWith("+");
  const digits = digitsOnly(value);
  // Four digits is an extension, not a number anybody can be reached on.
  if (digits.length < 5) return null;
  return `tel:${plus ? "+" : ""}${digits}`;
}

/**
 * The international number WhatsApp wants, or null when the value cannot be
 * resolved to one without guessing.
 *
 * The three shapes that ARE resolvable:
 *
 *  - `+44 7812 224644` — an explicit `+`. The country code is stated.
 *  - `0044 7812 224644` — the `00` international prefix. Same statement,
 *    older notation; the prefix is dropped and the rest is the number.
 *  - `447812224644` — bare digits that do not open with `0`. A leading zero
 *    on a bare string is a national trunk prefix, and which country's trunk
 *    it is is exactly the thing we are not allowed to assume.
 *
 * Length is checked against E.164: at most 15 digits, and short enough strings
 * are extensions or typos rather than reachable numbers.
 */
export function whatsappNumber(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  let digits = digitsOnly(value);
  if (!digits) return null;

  if (value.startsWith("+")) {
    // Stated country code. Nothing to strip.
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    /*
     * A national number. Reaching it needs a country, and the only country we
     * could supply is one we made up — so this is where we stop.
     */
    return null;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** The `https://wa.me/…` action, or null. See `whatsappNumber` for the rules. */
export function whatsappHref(raw: string | null | undefined): string | null {
  const number = whatsappNumber(raw);
  return number ? `https://wa.me/${number}` : null;
}
