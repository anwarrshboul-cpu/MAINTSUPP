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
 * path before they can be offered, which is a later phase.
 *
 * THE TYPEFACE IS NOW IN SCOPE; SIZES AND SPACING ARE STILL NOT, and the two halves
 * of that sentence have different reasons.
 *
 * The FAMILY funnels through one declaration — `app/brand-overrides.css`'s `body`
 * rule, plus its heading companion — so making it configurable is one token and one
 * `var()`. It was also the least controlled thing in the product: the stylesheet
 * named Inter and Manrope and the portal loaded neither, so a customer's typeface
 * was already whatever their machine happened to have.
 *
 * SIZES do not funnel anywhere. Measured on this commit: **2,043 `font-size`
 * declarations across `app/**` and ten of them read a `var()`.** A size control
 * would move ten rules while 2,033 ignored it — a switch that saves and changes
 * almost nothing, which is the same fault as a switch that changes something and
 * does not save. It also collides with a 16px floor on typed controls that ten test
 * files pin with a stated reason (iOS zooms a form field under 16px and does not
 * zoom back out). `docs/vibe-tokens.reference.css` and `docs/vibe-token-mapping.md`
 * already hold a risk-scored order for that migration; it is its own phase, not a
 * control.
 *
 * SHAPE, DEPTH AND THE BOARD'S RHYTHM ARE NOW IN SCOPE, AND THEY ARE THE THIRD
 * KIND OF TOKEN.
 *
 * A colour is a hex and a typeface is a key into a whitelist. A corner style is
 * neither: it is one name standing for a whole small family of measurements.
 * `TokenKind` gains `"choice"` for it, and the rule that makes fonts safe is the
 * rule that makes these safe — **the stored value is a KEY and nothing a caller
 * sends ever reaches the `<style>` element.** `"rounded"` is looked up here; the
 * pixels come from this file.
 *
 * WHICH AXES ARE OFFERED, AND THE ONE TEST EACH HAD TO PASS: does the property
 * FUNNEL? A control that saves and changes almost nothing is the same fault as a
 * control that changes something and does not save, and this product has been
 * bitten by both. Measured on this commit, across `app/**` with the marketing
 * site excluded, counting declarations and how many of them read a `var()`:
 *
 *   border-radius   1,129 declarations,   242 read a var()   -> OFFERED
 *   box-shadow        229 declarations,   122 read a var()   -> OFFERED
 *   the board grid   every dimension in `app/board-metrics.css` is a var()  -> OFFERED
 *   font-size       1,898 declarations,     2 read a var()   -> refused
 *   padding         1,833 declarations,    12 read a var()   -> refused
 *   line-height       303 declarations,     1 read a var()   -> refused
 *   font-weight       639 declarations,     0 read a var()   -> refused
 *   letter-spacing    205 declarations,     0 read a var()   -> refused
 *
 * So a TEXT SCALE and a general SPACING DENSITY are still not offered, and the
 * reason is arithmetic rather than taste: either would move a handful of rules
 * and leave nineteen hundred behind. `docs/vibe-tokens.reference.css` and
 * `docs/vibe-token-mapping.md` hold a risk-scored order for that migration; it is
 * its own phase, not a switch in front of one. What CAN be offered for density is
 * the surface where every dimension already funnels — the board — and that is
 * `layout.board_density`.
 *
 * WHY NO OPTION MAKES ANYTHING SMALLER THAN THE PRODUCT ALREADY SHIPS.
 *
 * The board's rows are 36px today, already below the 44px touch minimum this
 * repository pins in ten places, and typed controls are pinned at a literal 16px
 * because a smaller field makes iPhones zoom in and never zoom back out. A
 * "denser" option would take a row further below the touch minimum for everybody
 * in the workspace, which is a decision about accessibility dressed up as a
 * decision about taste. So the density token only ever makes rows TALLER, and
 * `sharp` corners and `flat` shadows change shape and depth without touching a
 * single dimension anybody has to hit.
 *
 * CHART PALETTES ARE NO LONGER OUT OF SCOPE, and this sentence used to say they
 * were. The always-dark dashboards' accents now come from `--chart-*`, which every
 * brand and status token below derives alongside its own family — so a workspace
 * that sets its primary colour sees it in its charts, which is what it would
 * reasonably have expected all along. See `deriveChartRung` for why those rungs are
 * mode-independent and why they had to be new names rather than an override of the
 * island's own.
 */

import { contrastRatio } from "../(app)/portal/chip-ink.ts";
import {
  AA_TEXT,
  type ThemeMode,
  deriveBrandFamily,
  deriveChartRung,
  deriveStatusFamily,
  parseHex,
} from "./theme-colour.ts";

export type { ThemeMode };

/** The CSS custom properties one token owns, for one mode. */
export type TokenFamily = Record<string, string>;

/**
 * What KIND of value a token holds, and why the catalogue has to know.
 *
 * Until the typeface tokens arrived every token was a colour, and two functions
 * encoded that assumption as a gate rather than as a type: `resolveThemeCss` and
 * `resolveThemeFamily` both treated an override as "set" only if `parseHex`
 * accepted it. A font name is not a hex, so a font token dropped into the
 * catalogue would have been **stored, audited, echoed back by `GET /api/theme`
 * and shown as changed in the panel — while emitting nothing at all.**
 *
 * That is the exact failure this product has already been bitten by twice, and
 * both bites are written down: `theme-repository.ts` records a cached read that
 * answered with a stale colour, and `app/(public)/f/[token]/public-form.tsx`
 * records a font picker that "did nothing on most phones — a control that changed
 * a stored value and nothing a submitter could see". A discriminator is what stops
 * the third.
 */
export type TokenKind = "colour" | "font" | "choice";

/** One option of a `choice` token: what it is called, and what it paints. */
export type ThemeTokenOption = {
  key: string;
  label: string;
  /** A sentence for the person choosing, not for a developer. */
  note: string;
  /** The custom properties this option sets, per mode. */
  family: Record<ThemeMode, TokenFamily>;
};

export type ThemeTokenDefinition = {
  key: string;
  label: string;
  group: string;
  /**
   * Colour, typeface or bounded choice. Decides validation, emission and whether
   * contrast applies.
   */
  kind: TokenKind;
  /**
   * For a `choice` token: the options a workspace may pick from, in the order the
   * control offers them.
   *
   * REQUIRED for that kind and absent for the others, and it is the whole of the
   * safety story: `validateThemeToken` refuses anything not in this list, so the
   * bound is the list rather than a range check somebody could widen by accident.
   */
  options?: readonly ThemeTokenOption[];
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

/* ------------------------------------------------------------------ */
/* Typefaces                                                           */
/* ------------------------------------------------------------------ */

/**
 * THE TYPEFACES A WORKSPACE MAY CHOOSE, AND WHY EVERY ONE COSTS NOTHING TO LOAD.
 *
 * Every stack below resolves on the visitor's own machine. Not one of them causes
 * a network request, and that is the whole design rather than a limitation:
 *
 *   - **No layout shift.** A webfont arrives after first paint, so the page reflows
 *     once it lands. The board's line lengths, its truncation points, its
 *     `line-clamp` and the twelve-plus `font-variant-numeric: tabular-nums`
 *     alignments were all measured against the metrics the product has now.
 *   - **No third party on the critical path.** `app/(marketing)/layout.tsx` fetches
 *     Manrope and Inter from Google for the marketing site, which is one page a
 *     visitor reads once. The portal is a shell somebody keeps open all day, and
 *     `app/(public)/f/[token]/public-form.tsx` already records what a runtime font
 *     `<link>` costs when it is wrong.
 *   - **Nothing new to license or ship.** No `.woff2` enters the repository.
 *
 * WHAT THIS REPLACES, WHICH WAS NOT A CHOICE AT ALL.
 *
 * `app/brand-overrides.css` named `Inter` for the body and `Manrope` for headings
 * and **the portal loaded neither** — no `@font-face`, no font file in the tree, no
 * `next/font`, no `<link>`. So the typeface a customer saw was already whatever
 * their machine happened to have, and two machines rendered the product
 * differently. `inter` and `manrope` are kept below for exactly that reason: on a
 * machine that has them, they are what the product has always meant to look like.
 *
 * THE VALUE STORED IS THE KEY, NEVER THE STACK.
 *
 * `theme_tokens.token_value` holds `"inter"`, and the stack is looked up here. A
 * caller's string is never echoed into the `<style>` element — the same rule the
 * hex validator follows by re-serialising from parsed integers. A font stack is a
 * far harder string to make safe than `#rrggbb`, so it is never trusted at all.
 */
export const FONT_STACKS: Readonly<Record<string, { label: string; stack: string }>> = {
  system: {
    label: "System default",
    stack:
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  inter: {
    label: "Inter",
    stack:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  manrope: {
    label: "Manrope",
    stack: "Manrope, Inter, ui-sans-serif, system-ui, sans-serif",
  },
  humanist: {
    label: "Humanist",
    stack:
      '"Segoe UI", Candara, Optima, "Trebuchet MS", ui-sans-serif, system-ui, sans-serif',
  },
  geometric: {
    label: "Geometric",
    stack: 'Avenir, "Avenir Next", Futura, Corbel, ui-sans-serif, system-ui, sans-serif',
  },
  serif: {
    label: "Serif",
    stack: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  },
};

export const FONT_KEYS: readonly string[] = Object.keys(FONT_STACKS);

/** The stack a stored key names, or null. Never echoes an unknown string. */
export function fontStack(key: string): string | null {
  return FONT_STACKS[key]?.stack ?? null;
}

/* ------------------------------------------------------------------ */
/* The bounded choices                                                 */
/* ------------------------------------------------------------------ */

/** Both modes, for a family that is the same in each. `blockAt` merges the dark
    block over the light one, so a mode-independent value is stated twice here for
    the same reason `--rail-*` is. */
function bothModes(family: TokenFamily): Record<ThemeMode, TokenFamily> {
  return { light: { ...family }, dark: { ...family } };
}

/**
 * CORNERS — the three rungs of the product's radius scale, together.
 *
 * `--radius-sm` carries the buttons, inputs, chips and small cards (203 rules),
 * `--radius` the panels and drawers, `--radius-lg` the largest surfaces. They move
 * as a set, because a workspace choosing "squared" means the product, not one
 * control — and because a scale whose rungs can cross is not a scale.
 *
 * WHAT THIS DOES NOT REACH, which the panel says out loud rather than leaving to be
 * discovered: 473 rectangular corners in this product are written as their own
 * literal and keep their own shape, and every deliberately circular thing —
 * avatars, the 999px pills — is left alone on purpose. A pill that squared off
 * with the panels would read as a bug rather than as a style.
 */
const CORNER_OPTIONS: readonly ThemeTokenOption[] = [
  {
    key: "sharp",
    label: "Squared",
    note: "Almost flat corners, for a technical, spreadsheet-like feel.",
    family: bothModes({ "--radius-sm": "2px", "--radius": "4px", "--radius-lg": "6px" }),
  },
  {
    key: "soft",
    label: "Soft (MAINTSUPP default)",
    note: "The shipped scale.",
    family: bothModes({ "--radius-sm": "8px", "--radius": "13px", "--radius-lg": "20px" }),
  },
  {
    key: "rounded",
    label: "Rounded",
    note: "Noticeably rounder panels, cards and buttons.",
    family: bothModes({ "--radius-sm": "12px", "--radius": "18px", "--radius-lg": "24px" }),
  },
];

/**
 * DEPTH — the shadow scale, which is mode-dependent and has to be.
 *
 * The light theme's shadows are a blue-grey ink (`rgba(7, 24, 38, …)`) because they
 * fall on a pale ground; the dark theme's are black, because a blue-grey shadow on
 * a dark ground is invisible. That is why every option below states both, and why
 * `derive` takes the mode.
 *
 * A shadow carries no text and no hit area, so no option here can fail contrast or
 * shrink a target. `flat` still keeps a hairline rather than going to `none`: a
 * panel needs SOME edge, and `--line` is not always enough on the dark theme.
 * Nothing in this product draws a focus ring from `--shadow-*` — the rings read
 * `--focus-ring` — so flattening cannot take a keyboard affordance with it.
 */
const DEPTH_OPTIONS: readonly ThemeTokenOption[] = [
  {
    key: "flat",
    label: "Flat",
    note: "Hairlines instead of shadows. Panels sit in the page rather than above it.",
    family: {
      light: {
        "--shadow-sm": "0 1px 1px rgba(7, 24, 38, 0.03)",
        "--shadow-md": "0 2px 6px rgba(7, 24, 38, 0.05)",
        "--shadow-lg": "0 4px 14px rgba(7, 24, 38, 0.08)",
      },
      dark: {
        "--shadow-sm": "0 1px 1px rgba(0, 0, 0, 0.18)",
        "--shadow-md": "0 2px 6px rgba(0, 0, 0, 0.24)",
        "--shadow-lg": "0 4px 14px rgba(0, 0, 0, 0.32)",
      },
    },
  },
  {
    key: "soft",
    label: "Soft (MAINTSUPP default)",
    note: "The shipped depth.",
    family: {
      light: {
        "--shadow-sm": "0 1px 2px rgba(7, 24, 38, 0.04)",
        "--shadow-md": "0 12px 36px rgba(7, 24, 38, 0.09)",
        "--shadow-lg": "0 28px 80px rgba(7, 24, 38, 0.16)",
      },
      dark: {
        "--shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.3)",
        "--shadow-md": "0 14px 38px rgba(0, 0, 0, 0.34)",
        "--shadow-lg": "0 28px 80px rgba(0, 0, 0, 0.5)",
      },
    },
  },
  {
    key: "raised",
    label: "Raised",
    note: "Deeper shadows, so dialogs and drawers lift further off the page.",
    family: {
      light: {
        "--shadow-sm": "0 2px 4px rgba(7, 24, 38, 0.07)",
        "--shadow-md": "0 18px 48px rgba(7, 24, 38, 0.14)",
        "--shadow-lg": "0 36px 96px rgba(7, 24, 38, 0.24)",
      },
      dark: {
        "--shadow-sm": "0 2px 4px rgba(0, 0, 0, 0.4)",
        "--shadow-md": "0 20px 50px rgba(0, 0, 0, 0.46)",
        "--shadow-lg": "0 36px 96px rgba(0, 0, 0, 0.62)",
      },
    },
  },
];

/**
 * THE BOARD'S VERTICAL RHYTHM — the one density this product can honestly offer.
 *
 * `app/board-metrics.css` declares every board dimension as a custom property and
 * applies them from one place, for a reason its own header gives: "The board
 * previously mixed 30px, 32px, 36px, 38px and 39px row heights… A grid only reads
 * as a grid when it is uniform." That uniformity is exactly what makes this
 * configurable when general padding is not — four properties own the whole grid.
 *
 * NOTHING GETS SHORTER. 36px is already under the 44px touch minimum, so a
 * "compact" option would push a row everybody in the workspace has to hit further
 * below it. Taller is the only direction a bounded engine may offer, and it is the
 * direction somebody using the board on a tablet on site actually wants.
 *
 * The four move together, keeping the relationships the board's own header set out:
 * a group header taller than a row, and a subitem row shorter than its parent.
 */
const BOARD_DENSITY_OPTIONS: readonly ThemeTokenOption[] = [
  {
    key: "standard",
    label: "Standard (MAINTSUPP default)",
    note: "The shipped grid — 36px rows, matching the board this replaced.",
    family: bothModes({
      "--board-row-height": "36px",
      "--board-header-height": "36px",
      "--board-group-header-height": "40px",
      "--board-subitem-row-height": "32px",
    }),
  },
  {
    key: "comfortable",
    label: "Comfortable",
    note: "A little more room in every row. Easier on a tablet.",
    family: bothModes({
      "--board-row-height": "42px",
      "--board-header-height": "40px",
      "--board-group-header-height": "46px",
      "--board-subitem-row-height": "38px",
    }),
  },
  {
    key: "spacious",
    label: "Spacious",
    note: "Rows above the 44px touch minimum throughout.",
    family: bothModes({
      "--board-row-height": "48px",
      "--board-header-height": "44px",
      "--board-group-header-height": "52px",
      "--board-subitem-row-height": "44px",
    }),
  },
];

/** The option a key names, for one mode, or null. Never echoes an unknown key. */
function optionFamily(
  options: readonly ThemeTokenOption[],
  key: string,
  mode: ThemeMode,
): TokenFamily | null {
  return options.find((option) => option.key === key)?.family[mode] ?? null;
}

/** The keys a choice token accepts. The bound the validator enforces. */
export function tokenOptionKeys(token: ThemeTokenDefinition): readonly string[] {
  return (token.options ?? []).map((option) => option.key);
}

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
    kind: "colour",
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
        "--chart-primary": "#12b4a8",
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
        /* The always-dark dashboards' primary series. One value for both modes —
           see `deriveChartRung`. */
        "--chart-primary": "#12b4a8",
      },
    },
    derive: (hex, mode) => ({
      ...deriveBrandFamily(hex, mode),
      ...deriveChartRung("primary", hex),
    }),
  },
  {
    key: "accent.info",
    label: "Information",
    group: "Status",
    kind: "colour",
    description: "Informational badges, scheduled work and the blue series in charts.",
    seedInput: "#38bdf8",
    seed: {
      light: {
        "--status-blue": "#0095ce",
        "--status-blue-bg": "rgba(56, 189, 248, 0.12)",
        "--status-blue-fg": "#006fa6",
        "--status-blue-wash": "#e7f7fe",
        "--chart-info": "#38bdf8",
      },
      dark: {
        "--status-blue": "#38bdf8",
        "--status-blue-bg": "rgba(56, 189, 248, 0.12)",
        "--status-blue-fg": "#38bdf8",
        "--status-blue-wash": "#153848",
        "--chart-info": "#38bdf8",
      },
    },
    derive: (hex, mode) => ({
      ...deriveStatusFamily("blue", hex, mode),
      ...deriveChartRung("info", hex),
    }),
  },
  {
    key: "status.success",
    label: "Success",
    group: "Status",
    kind: "colour",
    description: "Completed jobs, compliant certificates and anything within target.",
    seedInput: "#25d98b",
    seed: {
      light: {
        "--status-green": "#00a056",
        "--status-green-bg": "rgba(37, 217, 139, 0.12)",
        "--status-green-fg": "#007a34",
        "--status-green-wash": "#e5faf1",
        "--chart-success": "#25d98b",
      },
      dark: {
        "--status-green": "#25d98b",
        "--status-green-bg": "rgba(37, 217, 139, 0.12)",
        "--status-green-fg": "#25d98b",
        "--status-green-wash": "#133b3b",
        "--chart-success": "#25d98b",
      },
    },
    derive: (hex, mode) => ({
      ...deriveStatusFamily("green", hex, mode),
      ...deriveChartRung("success", hex),
    }),
  },
  {
    key: "status.warning",
    label: "Warning",
    group: "Status",
    kind: "colour",
    description: "Expiring certificates, approaching due dates and work awaiting action.",
    seedInput: "#ffd447",
    seed: {
      light: {
        "--status-yellow": "#ae8500",
        "--status-yellow-bg": "rgba(255, 212, 71, 0.12)",
        "--status-yellow-fg": "#8d6400",
        "--status-yellow-wash": "#fffae9",
        "--chart-warning": "#ffd447",
      },
      dark: {
        "--status-yellow": "#ffd447",
        "--status-yellow-bg": "rgba(255, 212, 71, 0.12)",
        "--status-yellow-fg": "#ffd447",
        "--status-yellow-wash": "#2d3b33",
        "--chart-warning": "#ffd447",
      },
    },
    derive: (hex, mode) => ({
      ...deriveStatusFamily("yellow", hex, mode),
      ...deriveChartRung("warning", hex),
    }),
  },
  {
    key: "status.danger",
    label: "Danger",
    group: "Status",
    kind: "colour",
    description: "Overdue work, expired certificates and destructive actions.",
    seedInput: "#ff4d5e",
    seed: {
      light: {
        "--status-red": "#fb495a",
        "--status-red-bg": "rgba(255, 77, 94, 0.12)",
        "--status-red-fg": "#ca0134",
        "--status-red-wash": "#ffeaec",
        "--chart-danger": "#ff4d5e",
      },
      dark: {
        "--status-red": "#ff4d5e",
        "--status-red-bg": "rgba(255, 77, 94, 0.12)",
        "--status-red-fg": "#ff6b77",
        "--status-red-wash": "#2d2b36",
        "--chart-danger": "#ff4d5e",
      },
    },
    derive: (hex, mode) => ({
      ...deriveStatusFamily("red", hex, mode),
      ...deriveChartRung("danger", hex),
    }),
  },
  {
    /*
     * THE HUE THE CATALOGUE WAS MISSING.
     *
     * `globals.css` has shipped the whole `--status-orange` family since the
     * palette was approved — base, `-bg`, `-fg` and `-wash`, in both blocks — and
     * fourteen places read it through `var()`. It carries "reactive work", "missing
     * certificate" and the 30-day due band on every dashboard. It was the one
     * shipped status hue a workspace could not set, and nothing but an omission
     * made it so.
     */
    key: "status.attention",
    label: "Attention",
    group: "Status",
    kind: "colour",
    description:
      "Reactive work, missing paperwork and the nearest due band — the orange series in charts.",
    seedInput: "#ff8a3d",
    seed: {
      light: {
        "--status-orange": "#dc6a0d",
        "--status-orange-bg": "rgba(255, 138, 61, 0.12)",
        "--status-orange-fg": "#b34400",
        "--status-orange-wash": "#fff1e8",
        "--chart-attention": "#ff8a3d",
      },
      dark: {
        "--status-orange": "#ff8a3d",
        "--status-orange-bg": "rgba(255, 138, 61, 0.12)",
        "--status-orange-fg": "#ff8a3d",
        "--status-orange-wash": "#2d3232",
        "--chart-attention": "#ff8a3d",
      },
    },
    /*
     * `"orange"` is the CSS name and `"attention"` is the series name, and they
     * differ on purpose. The stylesheet property has been `--status-orange` since
     * the palette was approved and renaming it would touch fourteen call sites for
     * no gain; the chart rung is new, so it gets the name that says what it means
     * rather than what colour it happens to be today.
     */
    derive: (hex, mode) => ({
      ...deriveStatusFamily("orange", hex, mode),
      ...deriveChartRung("attention", hex),
    }),
  },
  {
    /*
     * THE PORTAL'S BODY TYPEFACE.
     *
     * One declaration owns it — `app/brand-overrides.css`'s `body` rule, which
     * loads after `globals.css` and therefore wins. That is why this is a small
     * change rather than a migration of 2,043 font-size declarations: the FAMILY
     * funnels through one place, and the SIZES do not funnel anywhere.
     */
    key: "type.body",
    label: "Body typeface",
    group: "Typography",
    kind: "font",
    description:
      "Everything the portal sets in running text — tables, drawers, forms and labels.",
    seedInput: "inter",
    seed: {
      light: { "--type-body": FONT_STACKS.inter.stack },
      dark: { "--type-body": FONT_STACKS.inter.stack },
    },
    derive: (key) => ({ "--type-body": fontStack(key) ?? FONT_STACKS.inter.stack }),
  },
  {
    /*
     * AND THE HEADING TYPEFACE, which the product has always set separately —
     * `h1, h2, h3, .brand-word` take Manrope where the body takes Inter.
     */
    key: "type.display",
    label: "Heading typeface",
    group: "Typography",
    kind: "font",
    description: "Headings and the wordmark. May be the same as the body typeface.",
    seedInput: "manrope",
    seed: {
      light: { "--type-display": FONT_STACKS.manrope.stack },
      dark: { "--type-display": FONT_STACKS.manrope.stack },
    },
    derive: (key) => ({ "--type-display": fontStack(key) ?? FONT_STACKS.manrope.stack }),
  },
  {
    /*
     * CORNERS. The seed restates `globals.css`'s three rungs verbatim, which
     * `tests/theme-token-foundation.test.mjs` checks against the file itself, and
     * the `soft` option restates the same three — a test asserts those two agree,
     * so "the default option" and "what ships" cannot drift apart.
     */
    key: "shape.corners",
    label: "Corner style",
    group: "Surface",
    kind: "choice",
    description:
      "How rounded panels, cards, buttons, inputs and chips are. Pills and avatars stay round.",
    seedInput: "soft",
    options: CORNER_OPTIONS,
    seed: bothModes({ "--radius-sm": "8px", "--radius": "13px", "--radius-lg": "20px" }),
    derive: (key, mode) =>
      optionFamily(CORNER_OPTIONS, key, mode) ??
      (optionFamily(CORNER_OPTIONS, "soft", mode) as TokenFamily),
  },
  {
    key: "surface.depth",
    label: "Panel depth",
    group: "Surface",
    kind: "choice",
    description:
      "How far panels, dialogs and drawers lift off the page. Each theme keeps its own shadow ink.",
    seedInput: "soft",
    options: DEPTH_OPTIONS,
    seed: {
      light: {
        "--shadow-sm": "0 1px 2px rgba(7, 24, 38, 0.04)",
        "--shadow-md": "0 12px 36px rgba(7, 24, 38, 0.09)",
        "--shadow-lg": "0 28px 80px rgba(7, 24, 38, 0.16)",
      },
      dark: {
        "--shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.3)",
        "--shadow-md": "0 14px 38px rgba(0, 0, 0, 0.34)",
        "--shadow-lg": "0 28px 80px rgba(0, 0, 0, 0.5)",
      },
    },
    derive: (key, mode) =>
      optionFamily(DEPTH_OPTIONS, key, mode) ??
      (optionFamily(DEPTH_OPTIONS, "soft", mode) as TokenFamily),
  },
  {
    /*
     * THE BOARD'S ROW HEIGHT. The seeded values live in `app/board-metrics.css`
     * rather than `globals.css`, because that is where the board's geometry is
     * declared and applied; the foundation test reads both files for that reason.
     */
    key: "layout.board_density",
    label: "Board row height",
    group: "Layout",
    kind: "choice",
    description:
      "How tall the job board's rows are. Only taller than the shipped grid — a denser row would fall further below the 44px touch minimum.",
    seedInput: "standard",
    options: BOARD_DENSITY_OPTIONS,
    seed: bothModes({
      "--board-row-height": "36px",
      "--board-header-height": "36px",
      "--board-group-header-height": "40px",
      "--board-subitem-row-height": "32px",
    }),
    derive: (key, mode) =>
      optionFamily(BOARD_DENSITY_OPTIONS, key, mode) ??
      (optionFamily(BOARD_DENSITY_OPTIONS, "standard", mode) as TokenFamily),
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
    return { ok: false, reason: `${key} must be a string` };
  }

  const definition = themeTokenDefinition(key);
  if (definition?.kind === "choice") {
    /*
     * A KEY FROM THIS TOKEN'S OWN LIST, and nothing else. Same principle as the
     * font branch below and the hex branch under it: what arrives is discarded and
     * what is stored is an index into a list this file owns, so no part of a
     * request can reach the `<style>` element. The bound is the list, which is why
     * it is declared beside the pixels rather than as a range somebody could widen.
     */
    const allowed = tokenOptionKeys(definition);
    if (!allowed.includes(value)) {
      return { ok: false, reason: `${key} must be one of: ${allowed.join(", ")}` };
    }
    return { ok: true, key, value };
  }
  if (definition?.kind === "font") {
    /*
     * A whitelist INDEX, not a sanitised string. `fontStack` returns null for
     * anything it does not know, and what gets stored is the key rather than the
     * stack — so no part of a caller's input ever reaches the `<style>` element.
     * Same principle as the hex branch below, which re-serialises from parsed
     * integers and discards what arrived.
     */
    if (!fontStack(value)) {
      return {
        ok: false,
        reason: `${key} must be one of: ${FONT_KEYS.join(", ")}`,
      };
    }
    return { ok: true, key, value };
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

/**
 * Whether a stored value is a real override for this token.
 *
 * ONE PREDICATE, because there used to be two copies of `parseHex(value)` — one in
 * `resolveThemeCss` and one in `resolveThemeFamily` — and a second kind of token
 * would have had to be remembered in both. A token whose value fails this is
 * treated as unset and falls back to its seed, which is what makes "a workspace
 * that has chosen nothing emits nothing" true.
 */
function isOverrideSet(
  token: ThemeTokenDefinition,
  value: string | undefined,
): boolean {
  if (!value) return false;
  if (token.kind === "choice") return tokenOptionKeys(token).includes(value);
  return token.kind === "font" ? fontStack(value) !== null : parseHex(value) !== null;
}

/** The resolved custom properties for one mode: seed, with overrides derived over it. */
export function resolveThemeFamily(
  overrides: ThemeOverrides,
  mode: ThemeMode,
): TokenFamily {
  const out: TokenFamily = {};
  for (const token of THEME_TOKEN_CATALOGUE) {
    const chosen = overrides[token.key];
    const family = isOverrideSet(token, chosen)
      ? token.derive(chosen as string, mode)
      : token.seed[mode];
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
  const active = THEME_TOKEN_CATALOGUE.filter((token) =>
    isOverrideSet(token, overrides[token.key]),
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
  /*
   * Colour tokens only, and the `parseHex` guard in the loop below is what keeps it
   * so. A typeface has no ratio to measure — the contrast a font participates in is
   * between the INK and the GROUND, which the colour tokens already own — and
   * neither has a corner radius, a shadow or a row height. Running any of them
   * through this would compare a keyword to a background and report nonsense.
   */
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
