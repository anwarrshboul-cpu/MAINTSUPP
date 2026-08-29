/**
 * The theme decision, in the only place it can be made without a flash.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The theme used to be applied from React effects. Five of them wrote
 * `data-theme`, three wrote a hard-coded "dark", and the winner was whichever
 * ran last. Measured on a cold load of /dashboard/sites with a stored
 * preference of "light": first contentful paint at 176ms with no attribute set
 * — so the CSS default (dark) painted — and the correct attribute at 204.5ms.
 * 28.5ms of the wrong theme, *after* the content was on screen. An effect can
 * never win that race reliably, because it runs after paint by definition.
 *
 * So the decision moves to a blocking inline script that runs before the
 * browser has anything to paint. It is deliberately tiny — read a key, ask the
 * device, stamp two attributes — and it is the ONLY code that decides the
 * theme before hydration. `theme.ts` reads the same key with the same rules and
 * takes over afterwards; the constants are shared so the two cannot drift.
 *
 * It stamps BOTH `<html>` and `<body>`, because the stylesheets key off both:
 * the token blocks are on `:root`, and the entire light skin is written as
 * `body[data-theme="light"] …`. Stamping only the root would leave the light
 * skin unapplied until hydration, which is the flash again with extra steps.
 * That is also why the script is rendered as the first child of the app
 * layout's output rather than in `<head>` — `document.body` has to exist, and
 * at that point in the parse it does, with no rendered content after it yet.
 *
 * THE MIGRATION, and why it discards a stored value once
 *
 * `live-board.tsx` used to write its own state back to this key on mount, so a
 * first visit ended with an explicit "dark" nobody had chosen. Proved over CDP:
 * a fresh profile with the key removed had `maintsupp:theme-preference` set to
 * "dark" after one page load and no interaction. A stored value from before
 * this build therefore carries no information — a real choice and an
 * auto-written one are byte-identical — and leaving it in place would mean the
 * new device-follows default reached nobody who had ever opened the app.
 *
 * The one-off marker below clears the key exactly once per browser. The cost is
 * that somebody who had genuinely chosen dark on a light device re-picks it
 * once; the alternative is that the owner's "the default should be based on the
 * used device" is true only for browsers that have never seen MAINTSUPP. From
 * here on the key is written from a user gesture and nowhere else, so it stays
 * meaningful and this can never be needed again.
 *
 * WHAT A PHONE GETS WHEN NOTHING HAS BEEN CHOSEN, and why it is not the device
 *
 * The owner's requirement: on a phone the app is DARK out of the box. So an
 * ABSENT preference now resolves to dark below the phone boundary and keeps
 * following `prefers-color-scheme` above it. Nothing else moves:
 *
 *  · An explicit "light" or "dark" is still read first and still wins, on every
 *    width. The switch stays a switch.
 *  · An explicit "system" is now told apart from an absent value — previously
 *    both collapsed into the same branch, which cost nothing because they meant
 *    the same thing, and would now cost a phone the ability to opt back into
 *    its device. "System" is a real choice in `theme-toggle.tsx`'s select and
 *    it has to keep meaning the device.
 *  · Desktop policy is untouched: no preference above the boundary is still
 *    `prefers-color-scheme`, exactly as before.
 *
 * THE BOUNDARY IS THE ONE THE LAYOUT ALREADY USES — `(max-width: 760px)`, the
 * same string `live-board.tsx` gives `matchMedia` for `isMobile` and the same
 * width `globals.css` opens its phone blocks at. It is exported below so
 * `theme.ts` cannot drift from it, for the same reason the storage keys are.
 * A pointer or hover test was considered and rejected: it would put a
 * coarse-pointer 1024px tablet on the dark default while it was still being
 * given the DESKTOP layout, and a theme that flips at a different width from
 * the layout is its own bug.
 *
 * THE MIGRATION AND THIS DEFAULT DO NOT FIGHT. The one-off clear runs first and
 * removes a value that carried no information; the read that follows then finds
 * nothing, which is precisely the case this new default answers. A phone that
 * had an auto-written "dark" keeps dark, a phone that had an auto-written
 * "light" moves to dark once — and a real choice made after the migration sets
 * the marker itself (`setThemeChoice`), so the clear can never run over it.
 */

/** Where the explicit choice lives. Read by the boot script and by `theme.ts`. */
export const THEME_STORAGE_KEY = "maintsupp:theme-preference";

/** Set once the auto-written legacy value has been cleared. See above. */
export const THEME_MIGRATION_KEY = "maintsupp:theme-default-migrated";

/**
 * The phone boundary, shared with `theme.ts` so the pre-paint decision and the
 * post-hydration one cannot disagree by a pixel.
 *
 * The same query `live-board.tsx` uses for `isMobile`. Do not "tidy" it to 767
 * or 768 without moving that one too — the two have to name the same set of
 * screens or a phone can get the dark default with the desktop layout, or the
 * reverse.
 */
export const MOBILE_THEME_QUERY = "(max-width: 760px)";

/**
 * The pre-paint script, as source.
 *
 * Written by hand rather than compiled: it is inlined into the HTML, so every
 * byte is on the critical path, and it has to run in a browser that has not yet
 * loaded a single module. Everything is wrapped in try/catch because Safari's
 * private mode throws on `localStorage` access itself — a theme is not worth a
 * blank page.
 *
 * Reading the middle of it: `c` is the stored choice. Anything that is not one
 * of the three real choices means nobody has chosen, and that is still
 * "system" — EXCEPT below the phone boundary, where the product default is
 * dark. An explicit "system" skips both of those lines and still resolves
 * through the device, which is what keeps the picker's System option honest on
 * a phone. Kept out of the array itself because the prose would ship in the
 * response body.
 */
export const themeBootScript = [
  "(function(){try{",
  "var d=document,e=d.documentElement,w=e.ownerDocument.defaultView,s=null,c=null;",
  "try{s=window.localStorage}catch(x){}",
  "if(s){",
  `if(s.getItem(${JSON.stringify(THEME_MIGRATION_KEY)})!=="1"){`,
  `s.removeItem(${JSON.stringify(THEME_STORAGE_KEY)});`,
  `s.setItem(${JSON.stringify(THEME_MIGRATION_KEY)},"1");`,
  "}",
  `c=s.getItem(${JSON.stringify(THEME_STORAGE_KEY)});`,
  "}",
  'if(c!=="light"&&c!=="dark"&&c!=="system"){c="system";',
  `if(w.matchMedia(${JSON.stringify(MOBILE_THEME_QUERY)}).matches){c="dark"}}`,
  'var r=c==="system"?(w.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):c;',
  'e.setAttribute("data-theme",r);',
  "e.style.colorScheme=r;",
  'if(d.body){d.body.setAttribute("data-theme",r)}',
  "}catch(x){}})();",
].join("");
