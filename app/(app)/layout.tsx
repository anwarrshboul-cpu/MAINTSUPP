import type { ReactNode } from "react";
import globalsCss from "../globals.css?url";
import brandCss from "../brand-overrides.css?url";
import boardMetricsCss from "../board-metrics.css?url";
import { organisationThemeCss } from "../lib/theme-render.ts";
import {
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  THEME_COLOR_LIGHT_MEDIA,
  themeBootScript,
} from "./portal/theme-boot";

/**
 * Application layout — B2.
 *
 * The dashboard stylesheets load here and nowhere else. Before this split they
 * were in the root layout, so the marketing homepage downloaded 230KB of CSS it
 * never used.
 *
 * THE THEME IS DECIDED HERE, FIRST.
 *
 * `themeBootScript` is a ~400 byte blocking script that reads the stored
 * preference, falls back to `prefers-color-scheme`, and stamps `data-theme` and
 * `color-scheme` on `<html>` and `<body>` before the browser paints. It is the
 * first thing in this group's output, ahead of the stylesheets, so the tokens
 * resolve to the right palette the first time they are read — the theme used to
 * be applied from React effects and painted the wrong one for 28.5ms after
 * first contentful paint.
 *
 * It sits in this layout rather than the root one on purpose. The root layout
 * also wraps the marketing site, which loads none of these stylesheets, pins
 * its own `color-scheme: light` and was verified byte-identical to the design
 * archive; stamping a theme onto it would change a surface that is explicitly
 * out of scope. Everything that loads globals.css loads through here.
 *
 * AND THE ADDRESS BAR IS DECIDED HERE TOO.
 *
 * `<meta name="theme-color">` did not exist anywhere in the repo, so a phone
 * painted its address bar and overscroll gutter from its own default — white
 * on iOS, grey on Android — above a page whose ground is #0b1218. The tags go
 * in this layout for the same reason the boot script does: they are a statement
 * about the DASHBOARD's ground, and the marketing site is a light surface that
 * must not inherit them.
 *
 * Two tags, and the ORDER IS THE MECHANISM. A browser uses the first
 * `theme-color` whose `media` matches, so the light one is written first with
 * `(prefers-color-scheme: light)` and the dark one last with no media at all as
 * the fallback. That alone is right for a device-following "system" and right
 * for the dark default, with no script involved — which is what a browser with
 * JS disabled, and the first frame of every load, actually gets. It is wrong in
 * exactly one case, a stored choice that contradicts the device, and that case
 * is settled by `theme-boot.ts` before paint and by `applyTheme` on every
 * change afterwards: both flip this tag's media to "all" or "not all". They are
 * therefore the only writers of it — do not add an id or a second pair here.
 *
 * The values are imported, not typed out: `theme-boot.ts` holds them next to
 * the code that switches between them, so a colour cannot be changed in one
 * place and missed in the other.
 *
 * AND THE WORKSPACE'S OWN COLOURS ARE STAMPED HERE TOO.
 *
 * `organisationThemeCss()` returns the brand overrides this workspace has
 * chosen, as a `:root` block, and the element carrying them is rendered AFTER
 * the three stylesheet links above. That order is the whole mechanism: the block
 * reuses `globals.css`'s own selectors verbatim, so specificity ties and the
 * later rule wins by document order alone. A heavier selector would win too, and
 * would also outrank the `[data-theme]` rules further down `globals.css` that
 * these tokens are meant to cooperate with.
 *
 * It is almost always the empty string — no workspace has an override until
 * somebody opens the editor — and an empty string renders nothing at all, so the
 * common path adds no bytes and no risk. See `app/lib/theme-tokens.ts` for why
 * absence is the correct steady state rather than an unfinished one.
 *
 * This layout is async now, which it was not before. It wraps every screen that
 * loads `globals.css`, so putting the lookup here is what stops the next page
 * from forgetting it — the same argument `page-guard.ts` makes for putting the
 * session check at the route entry.
 *
 * THE COST, AND A CORRECTION. This comment used to say the read "is cached per
 * isolate for 30 seconds by `theme-repository.ts`". It is not, and has not been
 * since authenticated QA against the deployed Preview proved that cache wrong: a
 * value was changed, the database showed the new state, and the API kept answering
 * with the old one, because the write invalidated one serverless instance while the
 * read landed on another. The cache was removed and
 * `tests/theme-token-foundation.test.mjs` now asserts its ABSENCE.
 *
 * So the real bound is the other half of that sentence, which is still true: the
 * read is skipped entirely for a request with no session, and what remains is one
 * indexed lookup per document request on a table that is empty for every workspace
 * that has chosen nothing.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const themeCss = await organisationThemeCss();

  return (
    <>
      {/* Inline, and deliberately so: it is the only way to run code before
          first paint. The content is a module-level constant with no
          interpolation of anything a request can influence. */}
      <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      {/* Hoisted into <head> by React; rendered after the script because the
          script must stay this group's first child, and hoisting makes the JSX
          order irrelevant to where they land. */}
      <meta
        name="theme-color"
        media={THEME_COLOR_LIGHT_MEDIA}
        content={THEME_COLOR_LIGHT}
      />
      <meta name="theme-color" content={THEME_COLOR_DARK} />
      <link rel="stylesheet" href={globalsCss} />
      <link rel="stylesheet" href={brandCss} />
      <link rel="stylesheet" href={boardMetricsCss} />
      {/* Nothing is rendered when the workspace has no overrides, which is the
          usual case. The content is `#rrggbb` values re-serialised by
          `validateThemeToken` from parsed integers — never a caller's string —
          so there is no request-shaped input reaching this element. */}
      {themeCss ? (
        <style
          data-maintsupp-theme=""
          dangerouslySetInnerHTML={{ __html: themeCss }}
        />
      ) : null}
      {children}
    </>
  );
}
