/**
 * XML text, escaped once and in one place.
 *
 * Three exporters build XML by string concatenation, and a site called
 * "Smith & Co." breaks all three in the same way: Word and Excel do not report
 * a bad entity as a bad entity, they report the whole file as corrupt and offer
 * to repair it. So there is one escape function and the writers are not allowed
 * a second.
 *
 * CONTROL CHARACTERS ARE STRIPPED, NOT ESCAPED
 *
 * XML 1.0 has no legal representation for most C0 control characters — not
 * `&#x1;`, not anything, and a numeric reference to one is as invalid as the
 * raw byte. They do arrive in real data (a job note pasted out of a terminal, a
 * NUL that survived an import), so the only safe handling is removal. Tab,
 * newline and carriage return are legal and are kept, as are the two
 * permanently-unassigned code points at the end of the BMP, which are not.
 */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Escape a string for use as XML character data or an attribute value. */
export function xmlText(value: string): string {
  return value
    .replace(CONTROL, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The declaration every OOXML part begins with. */
export const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
