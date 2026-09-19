/**
 * Deriving a coherent family of shades from one chosen brand colour.
 *
 * WHY A DERIVATION EXISTS AT ALL
 *
 * The palette in `app/globals.css` does not hold one teal. It holds eight, and
 * they are not decoration — each has a job that the others cannot do:
 *
 *   --brand-primary  #12b4a8   the colour itself
 *   --brand-bright   #20d8c6   the lift used on hover and on dark grounds
 *   --brand-light    #55e8d8   the lightest rung, for thin strokes on dark
 *   --brand-muted    #147d77   the recessive rung, for borders and rules
 *   --brand-fill     #009c91   a shade that clears 3:1 as a FILL on white
 *   --brand-fg       #00746a   a shade that clears 4.5:1 as TEXT on white
 *   --brand-wash     #e3f6f5   the tint a selected row sits on
 *   --brand-glow     rgba(...) the same colour at 22% for focus rings
 *
 * The same is true of every status hue: `--status-green`, `-fg`, `-bg`, `-wash`.
 *
 * All of those are SEPARATE LITERALS. Nothing derives them from each other. So
 * an admin who sets "primary = purple" and gets only `--brand-primary` repainted
 * would be looking at a purple button with a teal focus ring, a teal hover, teal
 * borders and a teal selected row. That is precisely the "configuration that
 * does not affect actual components" the master specification forbids — a colour
 * picker that appears to work and does not.
 *
 * Hence this module. Give it one hex and a mode and it returns the whole family,
 * with the two contrast-bearing rungs SOLVED rather than guessed: `-fg` is
 * darkened (light mode) or lightened (dark mode) until it actually measures
 * 4.5:1 against that mode's ground, and `-fill` until it measures 3:1.
 *
 * WHAT THIS MODULE IS DELIBERATELY NOT USED FOR
 *
 * It does not produce the SHIPPED palette. Those eight values were hand-tuned
 * and contrast-verified by a person, and a generated approximation of them would
 * be a visual change to every existing customer on the day this ships for no
 * benefit whatever. The platform defaults in `theme-tokens.ts` are therefore the
 * exact literals from `globals.css`, and this file runs only when somebody has
 * actually chosen a colour of their own. Nothing an organisation has not edited
 * is ever derived.
 *
 * All arithmetic is sRGB → HSL and back, plus the WCAG luminance already
 * implemented in `chip-ink.ts` — which is imported rather than restated, because
 * two contrast implementations that disagree is how an inaccessible pair ships.
 */

// The `.ts` is deliberate and load-bearing, matching `job-metrics.ts` and
// `overview-intel.ts`: the bundler resolves an extensionless specifier, but
// `node --test` importing this module directly does not, and the tests for this
// file do exactly that.
import { chipInk, contrastRatio } from "../(app)/portal/chip-ink.ts";

export type ThemeMode = "light" | "dark";

/**
 * The surface each mode's contrast targets are measured against.
 *
 * Light measures against `#ffffff` because `--background-card` IS white in the
 * light palette, and a card is the ground almost every branded element sits on.
 * Dark measures against `#102630`, the dark palette's `--background-card`, for
 * the same reason. Measuring against the page background instead would be
 * slightly more forgiving and would let a shade through that fails on the cards
 * where it is actually used.
 */
export const MODE_GROUND: Record<ThemeMode, string> = {
  light: "#ffffff",
  dark: "#102630",
};

/** WCAG AA for body text. */
export const AA_TEXT = 4.5;

/** WCAG AA for a graphical object or a large-text fill. */
export const AA_FILL = 3;

/* ------------------------------------------------------------------ */
/* sRGB <-> HSL                                                        */
/* ------------------------------------------------------------------ */

export type Rgb = { r: number; g: number; b: number };
export type Hsl = { h: number; s: number; l: number };

/** `#rgb` or `#rrggbb`, case-insensitive. Anything else is null. */
export function parseHex(value: string): Rgb | null {
  const raw = value.trim().toLowerCase();
  if (!raw.startsWith("#")) return null;
  const hex = raw.slice(1);
  const expand = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (expand.length !== 6 || !/^[0-9a-f]{6}$/.test(expand)) return null;
  return {
    r: parseInt(expand.slice(0, 2), 16),
    g: parseInt(expand.slice(2, 4), 16),
    b: parseInt(expand.slice(4, 6), 16),
  };
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) =>
    clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: channel(h + 1 / 3) * 255,
    g: channel(h) * 255,
    b: channel(h - 1 / 3) * 255,
  };
}

/** Shift lightness by `delta` (-1..1), keeping hue and saturation. */
export function shiftLightness(hex: string, delta: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const hsl = rgbToHsl(rgb);
  return toHex(hslToRgb({ ...hsl, l: clamp(hsl.l + delta, 0, 1) }));
}

/** Blend `hex` into `ground` by `amount` (0 = all hex, 1 = all ground). */
export function mix(hex: string, ground: string, amount: number): string {
  const a = parseHex(hex);
  const b = parseHex(ground);
  if (!a || !b) return hex;
  const t = clamp(amount, 0, 1);
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

/** `rgba(r, g, b, alpha)` from a hex, matching the palette's existing form. */
export function rgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const round = (n: number) => clamp(Math.round(n), 0, 255);
  return `rgba(${round(rgb.r)}, ${round(rgb.g)}, ${round(rgb.b)}, ${alpha})`;
}

/* ------------------------------------------------------------------ */
/* The contrast-bearing rungs                                          */
/* ------------------------------------------------------------------ */

/**
 * The nearest shade of `hex` that clears `target` against `ground`.
 *
 * Walks lightness one step at a time — down on a pale ground, up on a deep one —
 * and returns the FIRST shade that measures well enough, so the result stays as
 * close to the chosen colour as the requirement allows. A hue that cannot reach
 * the target at all (a mid yellow needing 4.5:1 on white is the usual case)
 * bottoms out at near-black or tops out at near-white rather than looping, which
 * is the correct answer: that is genuinely the most legible shade of that hue.
 *
 * Deliberately a search rather than a formula. Luminance is not linear in HSL
 * lightness, and the step at which a given hue crosses 4.5:1 varies enough
 * between hues that a fixed offset gets some of them wrong — which is the exact
 * mistake `chip-ink.ts` was written to undo.
 */
export function solveForContrast(
  hex: string,
  ground: string,
  target: number,
  step = 0.01,
): string {
  if (!parseHex(hex) || !parseHex(ground)) return hex;
  if (contrastRatio(hex, ground) >= target) return hex;

  const groundIsPale = contrastRatio(ground, "#000000") > contrastRatio(ground, "#ffffff");
  const direction = groundIsPale ? -1 : 1;

  const base = rgbToHsl(parseHex(hex) as Rgb);
  for (let i = 1; i <= 100; i += 1) {
    const l = clamp(base.l + direction * step * i, 0, 1);
    const candidate = toHex(hslToRgb({ ...base, l }));
    if (contrastRatio(candidate, ground) >= target) return candidate;
    if (l === 0 || l === 1) return candidate;
  }
  return groundIsPale ? "#000000" : "#ffffff";
}

/**
 * A text shade that reads on the page AND on its own tinted background.
 *
 * `globals.css` states the contract in the light-palette comment: a `-fg` shade
 * must clear "4.5:1 on every light surface and on its own wash". Solving against
 * the page alone satisfies half of it and quietly misses the other half —
 * measured across 1,331 hues, 84% of them produced a `-fg` that read on the page
 * and failed on its own wash, because the wash sits between the page and the
 * hue and is therefore the harder ground of the two.
 *
 * Solving twice fixes it. The first call moves far enough for the page; the
 * second starts from that result and keeps going if the wash needs more. Both
 * grounds lie on the same side of the text shade, so the second call never
 * undoes the first.
 */
export function solveForText(base: string, ground: string, wash: string): string {
  return solveForContrast(solveForContrast(base, ground, AA_TEXT), wash, AA_TEXT);
}

/* ------------------------------------------------------------------ */
/* The families                                                        */
/* ------------------------------------------------------------------ */

/** Every CSS custom property the brand family paints, for one mode. */
export type BrandFamily = Record<string, string>;

/**
 * The chrome's own copies of the brand colour.
 *
 * WHY THIS IS NOT OPTIONAL, MEASURED RATHER THAN ASSUMED.
 *
 * `--brand-*` is read 172 times across `app/**\/*.css` and `--status-*` 99
 * times, so overriding those two families repaints most of the product. But the
 * sidebar and topbar do not read either: they read `--rail-*` (133 uses) and
 * `--legacy-*` (71 uses), two sets of flat literals that `globals.css` pins on
 * purpose so the chrome does not shift between the dark and light themes.
 *
 * Theme-invariance is the right call and this does not undo it. But it is about
 * DARK versus LIGHT, not about whose product it is — and the navigation rail is
 * the first thing anyone looks at. A "brand colour" that repaints the buttons
 * and leaves the sidebar teal is the half-feature the master specification's
 * "no fake implementation" rule exists to prevent, so the brand-derived members
 * of those two sets are listed here and follow the override too.
 *
 * It is an explicit allowlist and not a hue test. A filter over these sets by
 * hue also catches `--legacy-canvas`, `--legacy-line-soft`, `--rail-bg` and the
 * other near-greys, which carry a slight blue-teal cast and are GROUNDS — they
 * must stay exactly where they are whatever the brand becomes. Every entry below
 * was chosen by what it means, not by what it measures.
 *
 * The `--rail-*` entries take one value for both themes, because `globals.css`
 * declares them once with no dark override. Deriving them per mode would give
 * the rail two appearances and quietly break the invariance the pin exists for,
 * so they are solved against the dark ground the rail always sits on.
 */
export function deriveChromeFamily(base: string, mode: ThemeMode): BrandFamily {
  const ground = MODE_GROUND[mode];
  const dark = MODE_GROUND.dark;

  /* Theme-invariant: one value in both blocks. The rail is always a dark
     surface, so everything here is measured against the dark ground. */
  const railWash = mix(base, dark, 0.78);
  const railBright = shiftLightness(base, 0.16);

  return {
    "--rail-accent": railBright,
    "--rail-active-fg": shiftLightness(base, 0.19),
    "--rail-active-bg": railWash,
    "--rail-selected-bg": mix(base, dark, 0.8),

    /* Mode-independent in `globals.css` too — declared once, no dark override. */
    "--legacy-brand-primary": base,
    "--legacy-brand-hover": shiftLightness(base, 0.07),
    "--legacy-on-brand-primary": chipInk(base),
    "--legacy-on-brand-bright": chipInk(base),
    /* `--legacy-brand-solid` and `--legacy-switch-on` carry the same value in
       both themes in the shipped palette; keep that property by solving both
       against white, the harder of the two grounds. */
    "--legacy-brand-solid": solveForContrast(base, "#ffffff", AA_TEXT),

    /* Mode-dependent: these do have dark overrides. */
    "--legacy-accent-fg": solveForText(base, ground, mix(base, ground, 0.86)),
    "--legacy-switch-on":
      mode === "dark" ? base : solveForContrast(base, "#ffffff", AA_TEXT),
    "--legacy-teal-100": mix(base, ground, mode === "dark" ? 0.8 : 0.88),
    "--legacy-teal-500": base,
    "--legacy-teal-600": solveForText(base, ground, mix(base, ground, 0.86)),
    "--legacy-teal-700": solveForText(base, ground, mix(base, ground, 0.86)),
  };
}

/**
 * The eight brand rungs, derived from one chosen colour.
 *
 * The lightness offsets are read off the shipped palette rather than invented:
 * against `#12b4a8` (L=0.475), `--brand-bright` #20d8c6 is +0.01 in HSL terms
 * but noticeably more vivid, `--brand-light` #55e8d8 is +0.12, and
 * `--brand-muted` #147d77 is -0.19. Those three are aesthetic rungs with no
 * contrast requirement, so an offset is the right tool. `-fill` and `-fg` carry
 * requirements and are solved instead.
 */
export function deriveBrandFamily(base: string, mode: ThemeMode): BrandFamily {
  const ground = MODE_GROUND[mode];
  // A wash is the ground with a breath of the hue in it, not a pale version of
  // the hue: on dark it must stay dark, which mixing toward the ground gives
  // for free and lightening never would.
  const wash = mix(base, ground, mode === "dark" ? 0.82 : 0.9);

  return {
    "--brand-primary": base,
    "--brand-bright": shiftLightness(base, 0.08),
    "--brand-light": shiftLightness(base, 0.16),
    "--brand-muted": shiftLightness(base, -0.19),
    "--brand-fill": solveForContrast(base, ground, AA_FILL),
    "--brand-fg": solveForText(base, ground, wash),
    "--brand-wash": wash,
    "--brand-glow": rgba(base, 0.22),
    /* The chrome's own copies — see `deriveChromeFamily` for why the sidebar
       cannot be left out of a brand change. */
    ...deriveChromeFamily(base, mode),
    // The ink that sits ON the brand colour — a button label — which is the
    // exact question `chipInk` already answers for a ground that comes from
    // data rather than from design, and answers with a measured ratio rather
    // than a brightness shortcut. Deriving a hue-tinted ink here instead was
    // tried and produced `#000000` on the house teal: starting from a heavily
    // darkened base and then solving AGAINST that base walks to black, because
    // the base is the pale side of the pair. Reusing the audited function is
    // both shorter and right.
    "--on-brand-primary": chipInk(base),
  };
}

/** Every CSS custom property one status hue paints, for one mode. */
export type StatusFamily = Record<string, string>;

/**
 * The four rungs of a status hue (`--status-<name>`, `-bg`, `-fg`, `-wash`).
 *
 * `-bg` is the hue at 12% alpha in both modes, which is what the shipped
 * palette does and why it needs no mode-specific handling: an alpha fill
 * composites over whatever surface it lands on, so it is correct in both.
 */
export function deriveStatusFamily(
  name: string,
  base: string,
  mode: ThemeMode,
): StatusFamily {
  const ground = MODE_GROUND[mode];
  const wash = mix(base, ground, mode === "dark" ? 0.86 : 0.92);
  return {
    [`--status-${name}`]: solveForContrast(base, ground, AA_FILL),
    [`--status-${name}-bg`]: rgba(base, 0.12),
    [`--status-${name}-fg`]: solveForText(base, ground, wash),
    [`--status-${name}-wash`]: wash,
  };
}
