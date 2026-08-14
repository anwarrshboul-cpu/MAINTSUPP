/**
 * The label colour for a chip whose GROUND is data, not design.
 *
 * WHY THIS EXISTS
 *
 * Status, priority, tier and label chips are painted from a colour stored on
 * the option row — monday's palette, imported with the board. That hex cannot
 * follow a theme and should not: an "Urgent" chip is the same red on a white
 * page and on a black one, and the whole point of the colour is that it is
 * recognised at a glance. What CAN follow it is the text on top.
 *
 * It did not. The label was hard-coded `#ffffff` at nine render sites, and the
 * two places that did try to think about it used a perceived-brightness
 * shortcut — `(0.299r + 0.587g + 0.114b) / 255 > 0.6` — which is not a contrast
 * ratio and gets the mid-tones exactly wrong. Measured over CDP before this
 * module existed, identical in BOTH themes because a literal cannot do
 * otherwise:
 *
 *   white on #00c875 (Done)          2.21:1   1,069 nodes
 *   white on #fdab3d (Working on it) 1.90:1     665 nodes
 *   white on #9aadbd (Waiting)       2.6 :1      74 nodes
 *
 * `#fdab3d` is the clearest case: white scores 1.90:1 and `#101820` scores
 * 9.43:1 on the same ground. The brightness shortcut put it at 0.66 — over its
 * own threshold, so it happened to pick dark — while `#00c875` computes to 0.51
 * and got white, which is the failing pair above. The threshold was answering a
 * different question from the one WCAG asks.
 *
 * So: compute the real ratio, keep the stored colour when it is legible, and
 * flip to the better of the two inks when it is not. Nothing is removed, no
 * chip changes its ground, and the DATABASE IS NOT REWRITTEN — `text_color`
 * stays exactly as imported, because the same row is read by the mobile app and
 * by the monday export, and a stored value that disagrees with monday's is a
 * data change dressed up as a styling fix. This is a render-time decision.
 */

/** Ink for a pale ground. The product's darkest surface, not pure black. */
export const CHIP_INK_DARK = "#101820";

/** Ink for a deep ground. */
export const CHIP_INK_LIGHT = "#ffffff";

/**
 * The rung below `CHIP_INK_DARK`, for the three mid-tone grounds that neither
 * house ink can carry.
 *
 * monday's red #e2445c, purple #a25ddc and blue #0086c0 sit almost exactly at
 * the luminance where white and dark ink are equally bad: the best either
 * manages is 4.44:1, 4.38:1 and 4.41:1 — under AA by a hair, and no amount of
 * choosing between them fixes it. #101820 is not black; it is the product's
 * darkest surface, and that 0.9% of luminance is the whole margin. Going one
 * step deeper on those three grounds returns 4.98:1, 4.91:1 and 4.94:1.
 *
 * It is deliberately the last resort: every other chip keeps the house ink, so
 * this does not quietly turn the palette's dark labels into black.
 */
export const CHIP_INK_DEEP = "#05080b";

/**
 * WCAG AA for body-sized text. Chips render at 8-13px, so the large-text
 * allowance (3:1) never applies to them.
 */
const AA = 4.5;

/** `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb()/rgba()`. Anything else is null. */
function parse(colour: string | null | undefined): [number, number, number] | null {
  if (!colour) return null;
  const value = colour.trim().toLowerCase();

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      const [r, g, b] = [...hex].map((c) => parseInt(c + c, 16));
      return Number.isNaN(r + g + b) ? null : [r, g, b];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return Number.isNaN(r + g + b) ? null : [r, g, b];
    }
    return null;
  }

  const match = value.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2]];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]) {
  const channel = (raw: number) => {
    const s = raw / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG contrast ratio between two colours, 1 to 21.
 *
 * Exported because the contrast test recomputes the chip pairs from the seed
 * palette with it, so a colour added to the board cannot quietly ship an
 * unreadable label.
 */
export function contrastRatio(a: string, b: string): number {
  const first = parse(a);
  const second = parse(b);
  if (!first || !second) return 1;
  const one = luminance(first);
  const two = luminance(second);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

/**
 * The label colour to paint on `background`.
 *
 * `preferred` is the colour stored against the option. It is kept whenever it
 * clears AA, so a deliberate choice — monday's dark ink on its pale yellows,
 * an admin's own pick — survives untouched. Only a failing pair is overridden,
 * and then by whichever of the two inks reads better on that exact ground.
 */
export function chipInk(
  background: string | null | undefined,
  preferred?: string | null,
): string {
  // An unparseable ground means there is nothing to measure against, and
  // guessing would be worse than leaving the caller's intent alone.
  if (!parse(background)) return preferred ?? CHIP_INK_LIGHT;
  const ground = background as string;

  if (preferred && parse(preferred) && contrastRatio(preferred, ground) >= AA) {
    return preferred;
  }

  const dark = contrastRatio(CHIP_INK_DARK, ground);
  const light = contrastRatio(CHIP_INK_LIGHT, ground);
  const best = dark >= light ? CHIP_INK_DARK : CHIP_INK_LIGHT;
  if (Math.max(dark, light) >= AA) return best;

  // Neither house ink reaches AA on this ground; see CHIP_INK_DEEP.
  return contrastRatio(CHIP_INK_DEEP, ground) >= light ? CHIP_INK_DEEP : CHIP_INK_LIGHT;
}

/**
 * `background` and `color` for a chip, ready to spread into a style prop.
 *
 * The single place that decides what a data-coloured chip looks like. Callers
 * that had their own copy of this arithmetic now defer to it.
 */
export function chipStyle(
  background: string | null | undefined,
  preferred?: string | null,
): { background: string; color: string } {
  const ground = background ?? "#c4c4c4";
  return { background: ground, color: chipInk(ground, preferred) };
}
