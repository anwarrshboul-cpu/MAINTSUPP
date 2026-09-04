/**
 * Helvetica, measured — the part of a PDF writer that cannot be guessed.
 *
 * WHY THIS FILE EXISTS
 *
 * A PDF places every piece of text at an absolute coordinate. Nothing wraps,
 * nothing reflows, nothing tells you afterwards that a column overflowed: text
 * that is too wide simply prints over the next column and the file still opens
 * cleanly. So a table layout is only as good as its text measurement, and text
 * measurement means the font's advance widths.
 *
 * Helvetica and Helvetica-Bold are two of the fourteen fonts every PDF reader
 * is required to have, which is why they are used: no font file has to be
 * embedded, the output stays small, and it renders identically everywhere. The
 * price is that their metrics are not in the file, so they are here — the
 * published AFM advance widths, in units of 1/1000 em.
 *
 * WINANSI, AND WHY THE ENCODING IS PART OF THE SAME PROBLEM
 *
 * A base-14 font is addressed by BYTE, not by code point. `/WinAnsiEncoding`
 * is the sane choice — it is Latin-1 in the upper half, so `£` is one byte
 * (0xA3) and every accented Latin letter survives. What does NOT survive is
 * anything above U+00FF, and this product's own text is full of characters that
 * are: the em dash in "Manchester — Piccadilly", the curly apostrophe a browser
 * inserts, the bullet in a joined validation message. Those have WinAnsi
 * positions in the 0x80-0x9F range and are mapped below. Anything with no
 * position becomes "?" rather than a byte that renders as a random glyph.
 *
 * A character that is transliterated must ALSO be measured as what it became,
 * which is why `encodeWinAnsi` and `measure` both go through `toWinAnsi`.
 */

/* ── Advance widths, 1/1000 em ───────────────────────────────────────────── */

/** Codes 32-126, in order, from the Helvetica AFM. */
const HELVETICA_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Codes 32-126, in order, from the Helvetica-Bold AFM. */
const HELVETICA_BOLD_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * The upper half, for the codes this product actually emits.
 *
 * Not the whole 0x80-0xFF table: the accented letters are all close to their
 * unaccented forms and the default below is the width of `o`, which is within a
 * few thousandths of an em of every one of them. The characters that are NOT
 * close — the em dash at a full em, the thin curly quotes — are listed, because
 * those are the ones that visibly break a column.
 */
const UPPER: Record<number, [number, number]> = {
  0x80: [556, 556], // euro
  0x91: [222, 278], // left single quote
  0x92: [222, 278], // right single quote
  0x93: [333, 500], // left double quote
  0x94: [333, 500], // right double quote
  0x95: [350, 350], // bullet
  0x96: [556, 556], // en dash
  0x97: [1000, 1000], // em dash
  0xa0: [278, 278], // no-break space
  0xa3: [556, 556], // pound
  0xb0: [400, 400], // degree
  0xd7: [584, 584], // multiplication
};

const DEFAULT_WIDTH = 556;

export type PdfFont = "regular" | "bold";

/* ── Encoding ────────────────────────────────────────────────────────────── */

/** Code points with a WinAnsi position outside Latin-1. */
const WINANSI_SPECIALS = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/** One code point as the byte a WinAnsi font will draw, or `?`. */
function toWinAnsiByte(codePoint: number): number {
  if (codePoint === 0x09) return 0x20; // a tab in a cell is a space
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  const special = WINANSI_SPECIALS.get(codePoint);
  if (special !== undefined) return special;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  return 0x3f; // "?"
}

/** A string as WinAnsi bytes. Never throws and never emits an unmapped byte. */
export function encodeWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint === 0x0a || codePoint === 0x0d) {
      bytes.push(0x20);
      continue;
    }
    bytes.push(toWinAnsiByte(codePoint));
  }
  return bytes;
}

/* ── Measurement ─────────────────────────────────────────────────────────── */

function widthOfByte(byte: number, font: PdfFont): number {
  if (byte >= 32 && byte <= 126) {
    const table = font === "bold" ? HELVETICA_BOLD_ASCII : HELVETICA_ASCII;
    return table[byte - 32] ?? DEFAULT_WIDTH;
  }
  const pair = UPPER[byte];
  if (pair) return font === "bold" ? pair[1] : pair[0];
  return DEFAULT_WIDTH;
}

/** The width of `text` at `size` points, in points. */
export function measure(text: string, font: PdfFont, size: number): number {
  let units = 0;
  for (const byte of encodeWinAnsi(text)) units += widthOfByte(byte, font);
  return (units * size) / 1000;
}

/**
 * `text` shortened to fit `maxWidth`, with an ellipsis when it was cut.
 *
 * A binary search would be tidier; a linear walk is used because it accumulates
 * the width it has already measured and so costs one pass over a string that is
 * usually short. The ellipsis is measured too — trimming to the budget and THEN
 * appending "…" is how a truncated cell ends up one character wider than the
 * column it was truncated to fit.
 */
export function truncateToWidth(
  text: string,
  font: PdfFont,
  size: number,
  maxWidth: number,
): string {
  if (measure(text, font, size) <= maxWidth) return text;
  const ellipsis = "…";
  const budget = maxWidth - measure(ellipsis, font, size);
  if (budget <= 0) return "";
  let width = 0;
  let out = "";
  for (const character of text) {
    const next = measure(character, font, size);
    if (width + next > budget) break;
    width += next;
    out += character;
  }
  return `${out.trimEnd()}${ellipsis}`;
}

/**
 * `text` broken into at most `maxLines` lines that each fit `maxWidth`.
 *
 * Word-wrapped where it can be; a single word longer than the column (a URL, a
 * reference with no spaces) is broken by character rather than allowed to
 * overflow, because in a PDF an overflow is silent and lands on top of the next
 * column.
 */
export function wrapToWidth(
  text: string,
  font: PdfFont,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  if (!text) return [""];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, font, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length >= maxLines) break;
    if (measure(word, font, size) <= maxWidth) {
      current = word;
      continue;
    }
    // A word wider than the column. Break it rather than overflow.
    let chunk = "";
    for (const character of word) {
      if (measure(chunk + character, font, size) > maxWidth) {
        lines.push(chunk);
        if (lines.length >= maxLines) break;
        chunk = character;
      } else {
        chunk += character;
      }
    }
    current = chunk;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (!lines.length) return [""];
  if (lines.length > maxLines) lines.length = maxLines;
  const last = lines.length - 1;
  const consumed = lines.join(" ");
  if (consumed.length < text.replace(/\s+/g, " ").trim().length) {
    lines[last] = truncateToWidth(`${lines[last]}…`, font, size, maxWidth);
  }
  return lines;
}
