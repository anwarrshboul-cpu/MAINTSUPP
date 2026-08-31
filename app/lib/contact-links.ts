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
/**
 * Drop the national trunk digit that international notation writes in brackets.
 *
 * `+44 (0) 20 7946 0958` is one number written for two audiences: dial
 * `020 7946 0958` inside the UK, or `+44 20 7946 0958` from outside it. The
 * bracketed `0` is explicitly the digit you do NOT dial internationally — the
 * brackets are the notation SAYING so — so carrying it through produced
 * `wa.me/4402079460958`, a country code followed by a digit no number has.
 * Measured: that link opens on "the phone number shared via url is invalid",
 * which is the exact failure the WhatsApp column was added to avoid.
 *
 * This is NOT the country-code guess the rest of this module refuses. Nothing
 * is invented and nothing is assumed about which country the number belongs
 * to: a digit the writer already marked as optional is removed, and only when
 * they marked it. A bare `07812 224644` still has no brackets and still
 * resolves to nothing, exactly as before.
 *
 * Deliberately narrow — a single `0` alone inside its brackets. `(020)` is a
 * whole area code in the British style of writing a NATIONAL number, and
 * `telHref` must keep every one of its digits.
 */
function withoutBracketedTrunk(value: string): string {
  /*
   * ONLY where a country code is actually stated, and that condition is the
   * whole guard rather than a refinement of it.
   *
   * Stripping unconditionally re-created the exact fault this module exists to
   * prevent, one step further along. `(0)20 7946 0958` is a NATIONAL number —
   * somebody's London landline, written the way a website writes it. Removing
   * its bracketed zero leaves `2079460958`, which no longer opens with a trunk
   * `0`, so the bare-digits branch below reads it as already international and
   * hands WhatsApp `wa.me/2079460958` — a real number in EGYPT. `(0)7812
   * 224644` went to RUSSIA the same way. Both returned NO link before the
   * bracket rule existed, and a confident link to a stranger is far worse than
   * a value the screen simply prints.
   *
   * `+44 (0) 20 …` and `0044 (0) 20 …` are different: the `+` or the `00` has
   * already named the country, so the bracketed digit is unambiguously the
   * national prefix that international dialling drops. That is the only case
   * where the brackets mean what the ITU notation says they mean, and it is
   * the only case handled here.
   */
  const statesCountryCode = value.startsWith("+") || digitsOnly(value).startsWith("00");
  return statesCountryCode ? value.replace(/\(\s*0\s*\)/, " ") : value;
}

export function telHref(raw: string | null | undefined): string | null {
  const value = withoutBracketedTrunk((raw ?? "").trim());
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
  const value = withoutBracketedTrunk((raw ?? "").trim());
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
