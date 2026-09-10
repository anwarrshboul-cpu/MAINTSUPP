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
 * WHAT ANYBODY GETS WHEN NOTHING HAS BEEN CHOSEN: DARK, ON EVERY WIDTH
 *
 * This used to be dark below `(max-width: 760px)` and `prefers-color-scheme`
 * above it. The owner's requirement is now simply that the signed-in portal is
 * DARK out of the box — the product was designed in dark, the rail is dark in
 * both skins by token, and a desktop whose OS happens to say "light" was being
 * handed a palette nobody had asked for. So an ABSENT preference resolves to
 * dark, full stop, and the width query is gone rather than left dangling: a
 * default that is the same on both sides of a boundary has no boundary, and an
 * exported constant nothing reads is a trap for the next person.
 *
 * Nothing else moves, and these are the parts that must not:
 *
 *  · An explicit "light" or "dark" is still read first and still wins, on every
 *    width. The switch stays a switch.
 *  · An explicit "system" is still told apart from an absent value, and still
 *    resolves through `prefers-color-scheme`. That is the ONLY thing keeping
 *    the picker's System option honest now that the fallback no longer asks the
 *    device: collapsing the two would make System unreachable and the control
 *    decorative, which the brief ruled out in as many words.
 *  · The stored preference is never rewritten to carry the new default. A user
 *    with nothing stored still has nothing stored; they are simply painted
 *    dark. Only `setThemeChoice` writes the key.
 *
 * The DEFAULT is exported as `DEFAULT_THEME_CHOICE` so this script and
 * `theme.ts` state it exactly once, for the same reason the storage keys are
 * shared: the pre-paint decision and the value React reads a moment later
 * disagreeing by so much as a string is a one-frame flash, and avoiding that is
 * the entire reason this script exists.
 *
 * THE MIGRATION AND THIS DEFAULT DO NOT FIGHT. The one-off clear runs first and
 * removes a value that carried no information; the read that follows then finds
 * nothing, which is precisely the case this default answers. A browser that had
 * an auto-written "dark" keeps dark, one that had an auto-written "light" moves
 * to dark once — and a real choice made after the migration sets the marker
 * itself (`setThemeChoice`), so the clear can never run over it.
 *
 * IT ALSO MOVES `<meta name="theme-color">`, and has to.
 *
 * The two theme-color tags are rendered by `app/(app)/layout.tsx` and the
 * browser picks the FIRST whose `media` matches — so with no script at all a
 * light device gets the light tint and everyone else the dark one, which is
 * right for "system" and right for the dark default. It is wrong in exactly one
 * case: a stored choice that contradicts the device. Mobile Chrome and Safari
 * read theme-color at first paint and tint the address bar with it, so that has
 * to be settled here rather than in an effect — the same argument as the
 * attributes above. One attribute write does it: the light tag is enabled with
 * `media="all"` or disabled with `media="not all"`, so the colour literals stay
 * in the markup and are not restated in script.
 */

/** Where the explicit choice lives. Read by the boot script and by `theme.ts`. */
export const THEME_STORAGE_KEY = "maintsupp:theme-preference";

/** Set once the auto-written legacy value has been cleared. See above. */
export const THEME_MIGRATION_KEY = "maintsupp:theme-default-migrated";

/**
 * The account whose `users.theme_preference` this browser has already taken.
 *
 * Read and written by `theme-toggle.tsx`, never by the script below — the
 * reconciliation needs a network round trip and cannot happen before paint.
 * Holding the USER ID rather than a boolean is what makes "signing in on a new
 * device adopts your preference" work exactly once per account per browser: a
 * second sign-in as the same person finds the marker already set and leaves the
 * local mirror alone, so a later local change is not silently undone.
 */
export const THEME_PROFILE_KEY = "maintsupp:theme-profile-synced";

/**
 * What "nothing has been chosen" paints, stated once for both decision points.
 *
 * Shared with `theme.ts` so the pre-paint stamp and the value React reads
 * afterwards cannot drift, for the same reason the storage keys are shared.
 * This replaced `MOBILE_THEME_QUERY`, which existed only to make this answer
 * depend on the viewport width; it does not any more, so the query is gone
 * rather than left exported and unread.
 */
export const DEFAULT_THEME_CHOICE = "dark" as const;

/**
 * The `<meta name="theme-color">` pair, and the one selector that finds the
 * switchable half of it.
 *
 * The values are the two `--canvas` grounds from `globals.css` — #0b1218 dark,
 * #f4f7f8 light — because the browser paints this behind the address bar and
 * the overscroll area, which is the page's ground and not the topbar's. They
 * live here rather than in the layout so the layout, `theme.ts` and the boot
 * script are all reading one declaration.
 */
export const THEME_COLOR_DARK = "#0b1218";
export const THEME_COLOR_LIGHT = "#f4f7f8";

/**
 * The light tag's media, as rendered. Restored by nothing: once script is
 * running, `applyTheme` owns this attribute and sets "all" or "not all".
 */
export const THEME_COLOR_LIGHT_MEDIA = "(prefers-color-scheme: light)";

/**
 * Only the light tag carries `media`, so `[media]` is what tells the two apart
 * without an id the metadata layer might rewrite.
 */
export const THEME_COLOR_META_SELECTOR = 'meta[name="theme-color"][media]';

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
 * of the three real choices means nobody has chosen, and that is now
 * `DEFAULT_THEME_CHOICE` — dark, on every width. An explicit "system" skips
 * that line and still resolves through the device, which is what keeps the
 * picker's System option honest. Kept out of the array itself because the prose
 * would ship in the response body.
 *
 * The last two lines are the address-bar tint. They are last because they are
 * the only part that can find nothing to do: the tags are hoisted into `<head>`
 * and the head is fully parsed before this runs (measured on the dev server —
 * `</head>` at byte 4103, this script at 4232), but a `null` here must not cost
 * the page its theme, so the attributes are stamped first and the guard is
 * explicit rather than leaning on the outer try/catch.
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
  `if(c!=="light"&&c!=="dark"&&c!=="system"){c=${JSON.stringify(DEFAULT_THEME_CHOICE)}}`,
  'var r=c==="system"?(w.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):c;',
  'e.setAttribute("data-theme",r);',
  "e.style.colorScheme=r;",
  'if(d.body){d.body.setAttribute("data-theme",r)}',
  `var m=d.querySelector(${JSON.stringify(THEME_COLOR_META_SELECTOR)});`,
  'if(m){m.setAttribute("media",r==="light"?"all":"not all")}',
  "}catch(x){}})();",
].join("");
