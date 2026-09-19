/**
 * Which colours an organisation may change, what they paint, and what ships.
 *
 * THE FALLBACK RULE, WHICH IS THE WHOLE DESIGN
 *
 * `theme_tokens` holds OVERRIDES, not the palette. A token with no row falls
 * back to `SEED` below — the exact literals already in `app/globals.css`. This
 * is the same shape `role_capabilities` uses for permissions, `navigation_layouts`
 * for the sidebar and `dashboard_meters` for meter colours, and it is chosen here
 * for the same three reasons:
 *
 *   - An empty table is a working system. A fresh workspace, or one whose rows
 *     were lost, paints exactly what ships today.
 *   - Adding a token to the catalogue does not silently repaint anybody. It
 *     takes the seed it was declared with.
 *   - **Nothing changes visually on the day this ships.** Not one organisation
 *     has a row, so `resolveThemeCss` returns an empty string and the browser
 *     sees byte-for-byte what it sees now.
 *
 * WHY THE SEED IS LITERALS AND NOT DERIVED
 *
 * `theme-colour.ts` can derive a whole family from one hex, and it would be
 * tidier to derive the default family from `#12b4a8` too. That would be wrong.
 * The shipped values were hand-tuned and contrast-verified by a person —
 * `--brand-fg` is `#00746a` because that is what measures 4.5:1 on white, not
 * because a formula produced it — and a generated approximation would be a
 * visual change to every existing customer for no benefit. Derivation runs only
 * when somebody has actually chosen a colour of their own.
 *
 * WHY ONE HEX PER TOKEN RATHER THAN ONE PER THEME
 *
 * An administrator picks "our brand is purple" once. Asking them to pick a light
 * purple and a dark purple, and to get both contrast-correct, is asking them to
 * do the job this module exists to do. So an override is a single hex and both
 * themes are derived from it, each solved against its own ground.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Surfaces (`--background-*`) and text (`--text-*`) are NOT configurable in this
 * phase, and their absence is a decision rather than an omission. Every other
 * token is an accent sitting on a stable ground; a background is the ground, so
 * a bad choice does not degrade one control, it makes the product unreadable and
 * takes the theme editor down with it. They need a preview and a reset-to-safe
 * path before they can be offered, which is a later phase. Typography, spacing,
 * icons and chart palettes are likewise out of scope here.
 */

import { contrastRatio } from "../(app)/portal/chip-ink.ts";
import {
  AA_TEXT,
  type ThemeMode,
  deriveBrandFamily,
  deriveStatusFamily,
  parseHex,
} from "./theme-colour.ts";

export type { ThemeMode };

/** The CSS custom properties one token owns, for one mode. */
export type TokenFamily = Record<string, string>;

export type ThemeTokenDefinition = {
  key: string;
  label: string;
  group: string;
  /** Written for the person choosing a colour, not for a developer. */
  description: string;
  /**
   * The swatch an administrator sees before they have chosen anything.
   *
   * The DARK base, because dark is the product's default theme
   * (`DEFAULT_THEME_CHOICE` in `theme-boot.ts`) and so is what they are looking
   * at while they edit.
   */
  seedInput: string;
  /** The exact shipped literals, per mode. Never derived. */
  seed: Record<ThemeMode, TokenFamily>;
  /** The whole family, derived from one chosen hex. */
  derive: (hex: string, mode: ThemeMode) => TokenFamily;
};

/**
 * Every colour an organisation may change.
 *
 * Dotted `noun.role`, matching the capability catalogue's convention so a token
 * key and the audit line it produces read as the same vocabulary.
 */
export const THEME_TOKEN_CATALOGUE: readonly ThemeTokenDefinition[] = [
  {
    key: "brand.primary",
    label: "Primary brand colour",
    group: "Brand",
    description:
      "The main accent. Buttons, links, active navigation, focus rings and selected rows.",
    seedInput: "#12b4a8",
    seed: {
      light: {
        "--brand-primary": "#12b4a8",
        "--brand-bright": "#20d8c6",
        "--brand-light": "#55e8d8",
        "--brand-muted": "#147d77",
        "--brand-fill": "#009c91",
        "--brand-fg": "#00746a",
        "--brand-wash": "#e3f6f5",
        "--brand-glow": "rgba(18, 180, 168, 0.22)",
        "--on-brand-primary": "#06221f",
        /* The chrome's own copies of the brand colour. See
           `deriveChromeFamily` for why the sidebar and topbar are included. */
        "--rail-accent": "#5fd6cd",
        "--rail-active-fg": "#6fdcd3",
        "--rail-active-bg": "#123c3a",
        "--rail-selected-bg": "#12343a",
        "--legacy-brand-primary": "#12b4a8",
        "--legacy-brand-hover": "#22c9bd",
        "--legacy-on-brand-primary": "#06191a",
        "--legacy-on-brand-bright": "#06191a",
        "--legacy-brand-solid": "#0b7a72",
        "--legacy-accent-fg": "#0a6f68",
        "--legacy-switch-on": "#0b7a72",
        "--legacy-teal-100": "#dff5f2",
        "--legacy-teal-500": "#12b5aa",
        "--legacy-teal-600": "#087771",
        "--legacy-teal-700": "#087771",
      },
      dark: {
        "--brand-primary": "#12b4a8",
        "--brand-bright": "#20d8c6",
        "--brand-light": "#55e8d8",
        "--brand-muted": "#147d77",
        "--brand-fill": "#12b4a8",
        "--brand-fg": "#20d8c6",
        "--brand-wash": "#10373e",
        "--brand-glow": "rgba(18, 180, 168, 0.22)",
        "--on-brand-primary": "#06221f",
        /* `--rail-*` is declared once in `globals.css` with no dark override, so
           these four repeat the light values deliberately — the rail is
           theme-invariant and must stay so. */
        "--rail-accent": "#5fd6cd",
        "--rail-active-fg": "#6fdcd3",
        "--rail-active-bg": "#123c3a",
        "--rail-selected-bg": "#12343a",
        "--legacy-brand-primary": "#12b4a8",
        "--legacy-brand-hover": "#22c9bd",
        "--legacy-on-brand-primary": "#06191a",
        "--legacy-on-brand-bright": "#06191a",
        "--legacy-brand-solid": "#0b7a72",
        "--legacy-accent-fg": "#5fd6cd",
        "--legacy-switch-on": "#12b4a8",
        "--legacy-teal-100": "#123c3a",
        "--legacy-teal-500": "#12b4a8",
        "--legacy-teal-600": "#63aeaa",
        "--legacy-teal-700": "#63aeaa",
      },
    },
    derive: (hex, mode) => deriveBrandFamily(hex, mode),
  },
  {
    key: "accent.info",
    label: "Information",
    group: "Status",
    description: "Informational badges, scheduled work and the blue series in charts.",
    seedInput: "#38bdf8",
    seed: {
      light: {
        "--status-blue": "#0095ce",
        "--status-blue-bg": "rgba(56, 189, 248, 0.12)",
        "--status-blue-fg": "#006fa6",
        "--status-blue-wash": "#e7f7fe",
      },
      dark: {
        "--status-blue": "#38bdf8",
        "--status-blue-bg": "rgba(56, 189, 248, 0.12)",
        "--status-blue-fg": "#38bdf8",
        "--status-blue-wash": "#153848",
      },
    },
    derive: (hex, mode) => deriveStatusFamily("blue", hex, mode),
  },
  {
    key: "status.success",
    label: "Success",
    group: "Status",
    description: "Completed jobs, compliant certificates and anything within target.",
    seedInput: "#25d98b",
    seed: {
      light: {
        "--status-green": "#00a056",
        "--status-green-bg": "rgba(37, 217, 139, 0.12)",
        "--status-green-fg": "#007a34",
        "--status-green-wash": "#e5faf1",
      },
      dark: {
        "--status-green": "#25d98b",
        "--status-green-bg": "rgba(37, 217, 139, 0.12)",
        "--status-green-fg": "#25d98b",
        "--status-green-wash": "#133b3b",
      },
    },
    derive: (hex, mode) => deriveStatusFamily("green", hex, mode),
  },
  {
    key: "status.warning",
    label: "Warning",
    group: "Status",
    description: "Expiring certificates, approaching due dates and work awaiting action.",
    seedInput: "#ffd447",
    seed: {
      light: {
        "--status-yellow": "#ae8500",
        "--status-yellow-bg": "rgba(255, 212, 71, 0.12)",
        "--status-yellow-fg": "#8d6400",
        "--status-yellow-wash": "#fffae9",
      },
      dark: {
        "--status-yellow": "#ffd447",
        "--status-yellow-bg": "rgba(255, 212, 71, 0.12)",
        "--status-yellow-fg": "#ffd447",
        "--status-yellow-wash": "#2d3b33",
      },
    },
    derive: (hex, mode) => deriveStatusFamily("yellow", hex, mode),
  },
  {
    key: "status.danger",
    label: "Danger",
    group: "Status",
    description: "Overdue work, expired certificates and destructive actions.",
    seedInput: "#ff4d5e",
    seed: {
      light: {
        "--status-red": "#fb495a",
        "--status-red-bg": "rgba(255, 77, 94, 0.12)",
        "--status-red-fg": "#ca0134",
        "--status-red-wash": "#ffeaec",
      },
      dark: {
        "--status-red": "#ff4d5e",
        "--status-red-bg": "rgba(255, 77, 94, 0.12)",
        "--status-red-fg": "#ff6b77",
        "--status-red-wash": "#2d2b36",
      },
    },
    derive: (hex, mode) => deriveStatusFamily("red", hex, mode),
  },
] as const;

export const THEME_TOKEN_KEYS: readonly string[] = THEME_TOKEN_CATALOGUE.map(
  (token) => token.key,
);

export function themeTokenDefinition(key: string): ThemeTokenDefinition | null {
  return THEME_TOKEN_CATALOGUE.find((token) => token.key === key) ?? null;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * A stored override, normalised, or a reason it was refused.
 *
 * Refusing rather than coercing is the point. This value is interpolated into a
 * `<style>` element, so the ONLY thing that may ever reach it is a six-digit hex
 * this function has re-serialised from parsed integers — never the caller's
 * string. `#fff` is accepted and returned expanded; anything with a semicolon,
 * a brace, a `url(`, a comment marker or an unknown token key is refused. There
 * is no escape hatch and no "trusted" caller.
 */
export type TokenValidation =
  | { ok: true; key: string; value: string }
  | { ok: false; reason: string };

export function validateThemeToken(key: unknown, value: unknown): TokenValidation {
  if (typeof key !== "string" || !themeTokenDefinition(key)) {
    return { ok: false, reason: `Unknown theme token: ${String(key)}` };
  }
  if (typeof value !== "string") {
    return { ok: false, reason: `${key} must be a colour string` };
  }
  const rgb = parseHex(value);
  if (!rgb) {
    return {
      ok: false,
      reason: `${key} must be a hex colour such as #12b4a8`,
    };
  }
  // Re-serialised from the parsed channels, so whatever arrived is discarded.
  const hex = `#${[rgb.r, rgb.g, rgb.b]
    .map((n) => Math.round(n).toString(16).padStart(2, "0"))
    .join("")}`;
  return { ok: true, key, value: hex };
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/** `token key -> chosen hex`. Only keys an organisation has actually set. */
export type ThemeOverrides = Readonly<Record<string, string>>;

/** The resolved custom properties for one mode: seed, with overrides derived over it. */
export function resolveThemeFamily(
  overrides: ThemeOverrides,
  mode: ThemeMode,
): TokenFamily {
  const out: TokenFamily = {};
  for (const token of THEME_TOKEN_CATALOGUE) {
    const chosen = overrides[token.key];
    const family =
      chosen && parseHex(chosen) ? token.derive(chosen, mode) : token.seed[mode];
    Object.assign(out, family);
  }
  return out;
}

/**
 * The selectors the emitted block must use, copied from `app/globals.css`.
 *
 * They are copied EXACTLY on purpose. CSS resolves a tie in specificity by
 * document order, and this block is rendered after the three stylesheet links
 * in `app/(app)/layout.tsx`, so matching the selectors makes it win by one rule
 * and nothing more. Using a heavier selector (`html:root`, or an id) would win
 * too, but it would also outrank the `[data-theme]` overrides further down
 * `globals.css` that these tokens are supposed to cooperate with.
 */
const LIGHT_SELECTOR = ":root";
const DARK_SELECTOR = ':root:not([data-theme="light"]), body[data-theme="dark"]';

/**
 * The `<style>` body for an organisation, or an empty string.
 *
 * Empty is the important case and the common one: an organisation that has
 * changed nothing emits no CSS at all, so the page is byte-identical to today's
 * and there is nothing to go wrong. Only tokens that were actually overridden
 * are emitted — the seed is already in `globals.css` and restating it would be a
 * second copy of the palette that could drift.
 */
export function resolveThemeCss(overrides: ThemeOverrides): string {
  const active = THEME_TOKEN_CATALOGUE.filter(
    (token) => overrides[token.key] && parseHex(overrides[token.key] as string),
  );
  if (active.length === 0) return "";

  const block = (selector: string, mode: ThemeMode) => {
    const declarations: string[] = [];
    for (const token of active) {
      const family = token.derive(overrides[token.key] as string, mode);
      for (const [property, value] of Object.entries(family)) {
        declarations.push(`${property}:${value}`);
      }
    }
    return `${selector}{${declarations.join(";")}}`;
  };

  return `${block(LIGHT_SELECTOR, "light")}${block(DARK_SELECTOR, "dark")}`;
}

/* ------------------------------------------------------------------ */
/* The runtime contrast check                                          */
/* ------------------------------------------------------------------ */

export type ContrastWarning = {
  mode: ThemeMode;
  property: string;
  /** What the colour was measured against, so the message can name it. */
  against: string;
  ratio: number;
  required: number;
  message: string;
};

/**
 * WHY THIS EXISTS, AND WHY IT IS NOT OPTIONAL.
 *
 * `tests/stage-twentysix-contrast.test.mjs` parses the hex values straight out
 * of `app/globals.css` and recomputes every WCAG pair on every run. Its own
 * header explains the reasoning: a test with the values written into it is a
 * second copy of the palette, so the palette is read from source instead and
 * cannot rot.
 *
 * That is an excellent test and it keeps working — but it proves something about
 * the file, and once a colour can come from the database the file is no longer
 * the whole answer. The static proof still covers what MAINTSUPP ships; nothing
 * covers what an administrator picks. Without a check at the point of choosing,
 * this phase would hand every workspace owner a supported, documented way to
 * make their own product unreadable, and the suite would stay green throughout.
 *
 * So the same arithmetic runs at the moment of the edit.
 *
 * WHICH PAIRS ARE WORTH MEASURING — this is the part that is easy to get wrong,
 * and the first two attempts at it here got it wrong in both directions.
 *
 * **Not** `-fg` or `-fill` against the page. Those are SOLVED by
 * `theme-colour.ts`: the search walks lightness until it measures well enough,
 * and since black reaches 21:1 on any pale ground and white does the same on any
 * deep one, they cannot fail. Checking them yields a validator that can never
 * fire — a reassuring green tick that proves nothing.
 *
 * **Not** the bare `--brand-primary` against the page either, which was the
 * second attempt. It looks right — a button is filled with it — but the palette
 * has a separate rung for exactly that job (`--brand-fill`, documented in
 * `globals.css` as "fill shades 3:1 against white"), and measuring the wrong one
 * made the check report a failure **on the shipped palette**: the house teal
 * `#12b4a8` is 2.59:1 on white. A validator that warns about the default is
 * worse than none, because it teaches people to dismiss it.
 *
 * What CAN fail is text on a ground the solver never considered:
 *
 *   1. `--on-brand-primary` on `--brand-primary`. `chipInk` picks the better of
 *      its two inks and deepens once, but a narrow band of mid-tones leaves
 *      every available ink under AA. Swept across 4,096 colours this is 0.4% of
 *      them, worst case 4.48:1 on `#887700` — rare, real, and worth saying.
 *   2. `-fg` on its own `-wash`. `globals.css` states the contract — "-fg text
 *      shades 4.5:1 on every light surface AND ON ITS OWN WASH" — but the
 *      derivation solves `-fg` against the page, not against the wash, so a
 *      custom hue can satisfy one and miss the other.
 *
 * Only OVERRIDDEN tokens are measured. Reporting the seed's own characteristics
 * back to somebody who has changed nothing is the same false-positive mistake in
 * a different costume.
 *
 * Reporting rather than refusing is deliberate: a brand is not ours to veto, and
 * every rung that carries body text on the page is solved regardless. The honest
 * action is to name the weak pair and let a person decide.
 */
export function themeContrastWarnings(
  overrides: ThemeOverrides,
): ContrastWarning[] {
  const warnings: ContrastWarning[] = [];

  const add = (
    mode: ThemeMode,
    property: string,
    against: string,
    ratio: number,
    required: number,
    message: string,
  ) => {
    if (ratio >= required) return;
    warnings.push({
      mode,
      property,
      against,
      ratio: Math.round(ratio * 100) / 100,
      required,
      message,
    });
  };

  for (const token of THEME_TOKEN_CATALOGUE) {
    const chosen = overrides[token.key];
    if (!chosen || !parseHex(chosen)) continue;

    for (const mode of ["light", "dark"] as const) {
      const family = token.derive(chosen, mode);

      const brand = family["--brand-primary"];
      const ink = family["--on-brand-primary"];
      if (brand?.startsWith("#") && ink?.startsWith("#")) {
        add(
          mode,
          "--on-brand-primary",
          brand,
          contrastRatio(ink, brand),
          AA_TEXT,
          `On the ${mode} theme, label text on ${token.label.toLowerCase()} reaches ` +
            `only ${contrastRatio(ink, brand).toFixed(2)}:1 against the colour it ` +
            `sits on, below the 4.5:1 needed to be readable. A slightly darker or ` +
            `lighter shade would fix it.`,
        );
      }

      // `-fg` on its own `-wash`, for whichever family this token owns.
      for (const [property, value] of Object.entries(family)) {
        if (!property.endsWith("-fg") || !value.startsWith("#")) continue;
        const wash = family[property.replace(/-fg$/, "-wash")];
        if (!wash?.startsWith("#")) continue;
        add(
          mode,
          property,
          wash,
          contrastRatio(value, wash),
          AA_TEXT,
          `On the ${mode} theme, ${token.label.toLowerCase()} text reaches only ` +
            `${contrastRatio(value, wash).toFixed(2)}:1 on its own tinted ` +
            `background, below the 4.5:1 needed to be readable.`,
        );
      }
    }
  }

  return warnings;
}
