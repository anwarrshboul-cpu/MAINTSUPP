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
 */

/** Where the explicit choice lives. Read by the boot script and by `theme.ts`. */
export const THEME_STORAGE_KEY = "maintsupp:theme-preference";

/** Set once the auto-written legacy value has been cleared. See above. */
export const THEME_MIGRATION_KEY = "maintsupp:theme-default-migrated";

/**
 * The pre-paint script, as source.
 *
 * Written by hand rather than compiled: it is inlined into the HTML, so every
 * byte is on the critical path, and it has to run in a browser that has not yet
 * loaded a single module. Everything is wrapped in try/catch because Safari's
 * private mode throws on `localStorage` access itself — a theme is not worth a
 * blank page.
 */
export const themeBootScript = [
  "(function(){try{",
  "var d=document,e=d.documentElement,s=null,c=null;",
  "try{s=window.localStorage}catch(x){}",
  "if(s){",
  `if(s.getItem(${JSON.stringify(THEME_MIGRATION_KEY)})!=="1"){`,
  `s.removeItem(${JSON.stringify(THEME_STORAGE_KEY)});`,
  `s.setItem(${JSON.stringify(THEME_MIGRATION_KEY)},"1");`,
  "}",
  `c=s.getItem(${JSON.stringify(THEME_STORAGE_KEY)});`,
  "}",
  'if(c!=="light"&&c!=="dark"){c="system"}',
  'var r=c==="system"?(e.ownerDocument.defaultView.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):c;',
  'e.setAttribute("data-theme",r);',
  "e.style.colorScheme=r;",
  'if(d.body){d.body.setAttribute("data-theme",r)}',
  "}catch(x){}})();",
].join("");
