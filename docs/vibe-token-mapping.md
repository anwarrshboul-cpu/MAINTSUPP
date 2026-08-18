# MAINTSUPP tokens ↔ Vibe tokens

A side-by-side of MAINTSUPP's own design tokens against monday.com's published
Vibe tokens. **This is an analysis, not a change.** No CSS has been modified.

- Vibe values and their provenance: [`vibe-tokens.reference.css`](./vibe-tokens.reference.css)
  (`@vibe/core@4.5.8/dist/tokens/tokens.css`, captured 2026-08-18)
- Our values: [`app/globals.css`](../app/globals.css) `:root` (lines 21–171) and
  the dark block (190–251); board geometry in
  [`app/board-metrics.css`](../app/board-metrics.css)

**Reading the "Matters?" column.** This ranks *parity impact* — how much the
difference changes whether MAINTSUPP feels like monday — not how wrong we are.
A difference can be large and not matter (brand fonts) or small and matter a
lot (a 60ms hover on a surface repeated 753 times).

---

## 1. Motion — the largest gap, and the one with no prior data

MAINTSUPP has **no motion tokens at all**. Every duration and easing is a
literal at its use site. Across `app/**/*.css` there are 19 distinct durations
and, apart from one hand-written curve in `media-viewer.css`, no easing beyond
the CSS keywords `ease` / `ease-out` / `ease-in-out`.

### 1a. Durations

| Ours (literal, where used) | Vibe equivalent | Differ? | Matters? |
|---|---|---|---|
| `120ms` — sidebar rail width, cell hover, toggle | `--motion-productive-medium` **100ms** | +20ms, off-scale | **Low.** Already close to monday's tier. |
| `130ms` ×9 — nav button, request card, checkbox, textarea focus, select border | `--motion-productive-medium` **100ms** | +30ms, off-scale | **High.** These are the most repeated interactions in the product. |
| `140ms` ×4 — drawer rows, board column resize | `--motion-productive-medium` **100ms** | +40ms, off-scale | Medium. |
| `150ms` ×4 — secondary button, account menu | `--motion-productive-long` **150ms** | **No — exact match** | None. Already correct. |
| `160ms` ×3 — cards, raise-ticket panel | `--motion-productive-long` **150ms** | +10ms, off-scale | **Low.** Within noise of correct. |
| `170ms` — modal entrance | `--motion-expressive-short` **250ms** | −80ms, off-scale | Medium. Ours is faster than monday's. |
| `180ms` ×10 — drawer, toast, mobile sheet, group expand | `--motion-expressive-short` **250ms** | −70ms, off-scale | Medium. Same as above. |
| `200ms`, `220ms` ×3 — panel width/height | `--motion-expressive-short` **250ms** | −30/−50ms | Low. |
| `260ms`, `450ms` — marketing fades | `--motion-expressive-short/long` **250/400ms** | ≈, off-scale | None — marketing, not board. |
| `700ms`, `800ms`, `1s`, `2400ms` — spinners, pulse | *(no Vibe token)* | n/a | None. Loops, correctly outside the scale. |

The pattern is consistent and worth naming: **our feedback animations are
slower than monday's, and our entrance animations are faster.** Vibe separates
these into two tiers deliberately — productive (70/100/150ms) for "I did
something, the UI kept up", expressive (250/400ms) for "something arrived, watch
it". We compressed both toward a middle band of 130–180ms, which is the wrong
end of each.

The board row is the sharpest case. A hover at 130ms repeated down 36px rows
across 753 jobs reads as lag in a way a single 130ms hover never does — this is
exactly why monday puts board interactions in the 70–100ms tier.

### 1b. Easing — we have no equivalent for any of this

| Ours | Vibe equivalent | Differ? | Matters? |
|---|---|---|---|
| `ease` (the default) on ~20 state transitions — implicitly `cubic-bezier(0.25, 0.1, 0.25, 1)` | `--motion-timing-transition` `cubic-bezier(0.4, 0, 0.2, 1)` | **Yes.** Vibe's is more decisive at both ends; `ease` loiters at the start. | **High.** Free to change, applies everywhere. |
| `ease-out` ×5 on entrances (drawer, toast, modal, mobile sheet, raise-ticket) | `--motion-timing-enter` `cubic-bezier(0, 0, 0.35, 1)` | Yes, but **same family** — both decelerate. Vibe's is more pronounced. | **Medium.** Our instinct was right; the curve is just softer than monday's. |
| *(nothing)* — exits reuse the entrance curve or none | `--motion-timing-exit` `cubic-bezier(0.4, 0, 1, 1)` | **Yes — we have no exit curve at all.** | Medium. Dismissals currently decelerate, which is backwards. |
| *(nothing)* | `--motion-timing-emphasize` `cubic-bezier(0, 0, 0.2, 1.4)` | **Yes — no counterpart.** Overshoots and settles. | Low. Attention-drawing only; we may not want it. |
| `cubic-bezier(0.22, 0.61, 0.36, 1)` — media-viewer zoom | closest is `--motion-timing-enter` | Yes; ours is a stock easeOutCubic | **None.** Isolated, works, leave it. |
| `ease-in-out` — `board-pulse` loop | *(no Vibe token for loops)* | n/a | None. |

Both `prefers-reduced-motion` blocks (`globals.css:9796`, `brand-overrides.css:2779`)
already zero everything out and are unaffected by any of this.

---

## 2. Spacing — we have no scale; monday does

MAINTSUPP defines **no `--space-*` tokens**. Spacing is written as literals.
Counting every `gap` / `padding` / `margin` pixel literal in the board and
portal stylesheets (1,690 occurrences, excluding 1px borders):

- **39% land on Vibe's scale** (8px ×186, 12px ×177, 4px ×94, 16px ×60, 20px ×46, 2px ×69, 24px ×22, 40px ×11)
- **61% do not** (10px ×194, 14px ×121, 6px ×104, 9px ×103, 7px ×101, 18px ×79, 5px ×73, 3px ×72, 11px ×60, 13px ×39, 22px ×35, 15px ×30, 28px ×14)

The single most-used spacing value in the codebase — **10px, 194 times** — does
not exist on monday's scale. Neither do 9px, 7px, 11px or 13px, which together
account for another 300 uses. Vibe's scale is 2/4/8/12/16/20/24/32/40/48/64/80:
there is no 6, 10, 14, 18 or 28 in it by construction.

| Ours | Vibe equivalent | Differ? | Matters? |
|---|---|---|---|
| `--board-cell-padding-x: 8px` | `--space-8` **8px** | **No — exact match** | None. Already correct. |
| ~1,025 off-scale literals | 12-step 4px-based scale | Yes, pervasively | **Medium, but high-risk.** See below. |

**Recommendation: do not chase this one broadly.** Nudging 10px→8px or 12px in
1,000 places is a very large diff with real regression risk (row heights, wrap
points, the enforced breakpoint set) for a change nobody can see at any single
site. The honest read is that this is a *tidiness* finding dressed as a parity
finding. Where it genuinely matters is board-row internals, and there our one
spacing token is already exactly right.

---

## 3. Border radius

| Ours | Vibe equivalent | Differ? | Matters? |
|---|---|---|---|
| `--board-chip-radius: 4px` | `--border-radius-small` **4px** | **No — exact match** | None. Status chips are correct. |
| `--radius-sm: 8px` | `--border-radius-medium` **8px** | **No — exact match** | None. |
| `--radius: 13px` | nearest is `--border-radius-12` **12px** | **Yes, +1px** — and 13px is off-scale (Vibe has no odd radii) | **Low.** 1px is barely perceptible, but it is free to fix and provably off-scale. |
| `--radius-lg: 20px` | `--border-radius-big` **16px** is Vibe's **ceiling** | **Yes, +4px — rounder than anything monday draws** | **Medium.** Our large surfaces are visibly softer than monday's. |

Two of our four radii are already exactly monday's. `--radius: 13px → 12px` is
the single cheapest, lowest-risk parity win in this whole document.

---

## 4. Shadows / elevation

| Ours | Vibe equivalent | Differ? | Matters? |
|---|---|---|---|
| `--shadow-sm` `0 1px 2px rgba(7,24,38,.04)` | `--box-shadow-xs` `0px 4px 6px -4px rgba(0,0,0,.1)` | **Yes** — ours is far tighter and ~2.5× fainter | Low. |
| *(none)* | `--box-shadow-small` `0px 4px 8px rgba(0,0,0,.2)` | **We have no counterpart** — 3 steps vs Vibe's 4 | Low. |
| `--shadow-md` `0 12px 36px rgba(7,24,38,.09)` | `--box-shadow-medium` `0px 6px 20px rgba(0,0,0,.2)` | **Yes** — ours has 2× the offset and blur at half the alpha | **Medium.** |
| `--shadow-lg` `0 28px 80px rgba(7,24,38,.16)` | `--box-shadow-large` `0px 15px 50px rgba(0,0,0,.3)` | **Yes** — same pattern, ~1.8× the geometry at half the alpha | **Medium.** |

There is a consistent house style here, and it is a real stylistic difference
rather than an error: **ours are large, diffuse and faint; monday's are tight,
compact and dark.** Ours read as a soft ambient lift, monday's as a crisp card
edge. Swapping them would noticeably change the product's character, so this is
a judgement call for you, not a defect to fix.

One thing we already get right: Vibe keeps shadow *geometry* identical across
themes and changes only the colour/alpha. Our dark block does exactly the same
(same offsets, alpha raised to .3/.34/.5). Same principle, independently
arrived at.

---

## 5. Typography

| Ours | Vibe equivalent | Differ? | Matters? |
|---|---|---|---|
| `--board-font-size: 14px` (cells) | `--font-text2-*` **14px**/20px | **No — size matches exactly** | None. Board text is correct. |
| Board header `13px` | 12px (`text3`) or 14px (`text2`) | **Yes — 13px is off-scale** | Low. |
| Status chip `13px / 500` | `--font-text3-medium` 12px/600 or `text2-medium` 14px/600 | Yes, on both size and weight | Low. |
| Cell `line-height: var(--board-row-height)` (36px) | `text2` line-height **20px** | Yes — but ours is a vertical-centring trick, not a type decision | **None.** Not comparable; leave it. |
| `Inter` / `Manrope` | `Figtree` / `Poppins` | **Yes** | **None — deliberate.** See below. |

The font stack is the one place where a difference is fully intentional.
Figtree/Poppins *is* what monday renders in, so this is recorded as a fact in
the reference file, but MAINTSUPP is not trying to be mistaken for monday — it
is a separate product that reproduces monday's board. Changing the typeface
would be a branding decision with a large blast radius (every measured line
length, every truncation point, the header line-clamp in `board-metrics.css`)
and no functional parity gain. **Recommend leaving it.**

Worth knowing if anyone ever does reach for Vibe's type tokens: the package
ships **two overlapping and mutually inconsistent type ladders**. The legacy
numbered one has `--font-size-10` and `-20` both at 14px, three line-heights all
at 24px, and caps `--font-weight-bold` at **500**. The newer named ladder
(`--font-text2-bold` etc.) is clean and uses real 600/700. They disagree — old
h3 is 24px, new h3 is 18px. Use the named one.

---

## 6. Z-index — Vibe publishes none

| Ours | Vibe equivalent | Differ? | Matters? |
|---|---|---|---|
| `--z-sticky: 40` … `--z-toast: 800` (12 steps) | **none published** | n/a | **None — no action possible.** |

Checked, not assumed: all 332 properties in Vibe's `tokens.css` were enumerated
and grouped by prefix — there is no `--z-*` family, and a direct search for
`z-index`/`zindex` in both `@vibe/core@4.5.8` and the SCSS sources in
`@vibe/style@4.1.0` returns nothing. Vibe handles layering inside its React
components rather than exposing a public scale.

**Our 12-step ladder has no external counterpart and needs no change.** It is
also more explicit than what Vibe offers, which is a point in its favour.

---

## 7. Board geometry — outside Vibe's scope

`board-metrics.css` (`--board-row-height: 36px`, `--board-header-height: 36px`,
the per-type column widths, the 16px/20px icon pair) has **no Vibe counterpart
whatsoever**. These are monday *application* dimensions, not *design-system*
dimensions, and Vibe publishes no row-height, header-height or column-width
tokens.

This matters for expectations: Vibe cannot validate our board geometry. Those
values can only ever be checked against monday's live DOM. The tokens close the
gap on motion, radii, shadows and type — not on the grid itself.

Two observations anyway:

- `--board-row-height: 36px` is off Vibe's spacing scale (32 and 40 are on it).
  This is almost certainly *correct* regardless — 36px is a row height, not a
  spacing step, and monday's own board does not constrain row heights to the
  spacing scale.
- `--board-cell-padding-x: 8px` is `--space-8` exactly, which is a good sign
  that the inferred geometry was not far off.

---

## Summary — what I'd actually change, ranked

Nothing below has been applied. Each is one change, independently verifiable.

| # | Change | Why | Risk |
|---|---|---|---|
| 1 | Introduce `--motion-*` tokens (durations + the 4 curves) into `globals.css`, defining them only — no use sites yet | Establishes the vocabulary with zero visual change; every later step becomes a one-line edit | **None.** Purely additive. |
| 2 | Retime board-row and control feedback from 130–180ms to the productive tier (100/150ms) | The single most-felt difference; our most repeated interactions are ~1.5× slower than monday's | Low, visual only |
| 3 | Replace bare `ease` with `--motion-timing-transition`, and `ease-out` entrances with `--motion-timing-enter` | We currently have no easing vocabulary at all; monday's curves are more decisive | Low, visual only |
| 4 | `--radius: 13px → 12px` | Provably off-scale, 1px, free | **Very low** |
| 5 | Give exits `--motion-timing-exit` | Dismissals currently decelerate, which is backwards | Low |
| 6 | Lengthen modal/drawer/toast entrances 170–180ms → 250ms | Our expressive tier is faster than monday's | Low, but more noticeable than #2 — worth doing alone |
| 7 | `--radius-lg: 20px → 16px` | Above monday's ceiling | Medium — changes every large card |

**Explicitly not recommended:** the colour tokens (tuned for WCAG AA in both
themes, verified at 0 failures — a swap would undo that), the font stack (brand
decision), the shadow geometry (a real house style, your call not a defect), and
a bulk spacing migration (~1,000 edits, invisible individually, real regression
risk).

Suggested order: **#1 and #4 together** (additive plus a 1px value change,
essentially unreviewable-risk), then **#2**, then **#3**, checking both themes
at 320/360/390/640/768/1024/1280 between each.
