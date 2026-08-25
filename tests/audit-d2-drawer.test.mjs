import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * AUDIT D2 — the job drawer is a dialog.
 *
 * WHAT WAS WRONG. `RequestDrawer` painted a full-screen overlay — scroll lock
 * taken, scrim over the page — out of a bare `<aside>`. Verified in a browser
 * against the running dev server: after opening a job from the board,
 * `document.activeElement` was still the board's "Open item page" button and the
 * drawer did not contain it, so the next Tab walked a 27-column grid before it
 * reached the overlay; `role` and `aria-modal` were both null, so a screen
 * reader was told a complementary landmark had appeared rather than a modal;
 * and Escape — which closes the evidence manager, the media viewer and every
 * anchored popover in this app — did nothing at all.
 *
 * These assertions are on the SOURCE rather than on a rendered tree because the
 * repo has no React test renderer wired up; the behaviour itself was verified in
 * Chromium (focus into the drawer, Tab staying inside, Escape closing it, focus
 * returning to the opener, Escape inside a textarea keeping the draft, Escape
 * with a popover open closing only the popover).
 */

const SOURCE = readFileSync(
  new URL("../app/(app)/portal/portal-app.tsx", import.meta.url),
  "utf8",
  // This is a Windows checkout: source-slicing on "\n" alone finds nothing when
  // the working tree happens to hold CRLF.
).replace(/\r\n/g, "\n");

/** The `<aside className="detail-drawer" …>` opening tag, whole. */
function drawerTag() {
  const at = SOURCE.indexOf('className="detail-drawer"');
  assert.notEqual(at, -1, "the drawer's root element moved or was renamed");
  const start = SOURCE.lastIndexOf("<aside", at);
  const end = SOURCE.indexOf(">", at);
  assert.ok(start !== -1 && end !== -1, "could not read the drawer's opening tag");
  return SOURCE.slice(start, end + 1);
}

test("the drawer's root element is a modal dialog", () => {
  const tag = drawerTag();
  assert.match(tag, /role="dialog"/, "the drawer must announce itself as a dialog");
  assert.match(
    tag,
    /aria-modal="true"/,
    "the scroll lock and the scrim already make it modal; the markup has to say so",
  );
  assert.match(
    tag,
    /aria-label=\{`\$\{request\.id\} details`\}/,
    "a dialog needs an accessible name",
  );
});

test("the drawer container is programmatically focusable", () => {
  const tag = drawerTag();
  assert.match(
    tag,
    /tabIndex=\{-1\}/,
    "focus is moved to the container on open, which needs tabIndex -1",
  );
  assert.match(tag, /ref=\{drawerRef\}/, "the focus effect needs a handle on the surface");
});

test("opening the drawer moves focus into it, and closing gives it back", () => {
  assert.match(
    SOURCE,
    /const drawerRef = useRef<HTMLElement \| null>\(null\);/,
    "the drawer's own ref went missing",
  );
  assert.match(
    SOURCE,
    /if \(surface && !surface\.contains\(document\.activeElement\)\) \{\s*surface\.focus\(\{ preventScroll: true \}\);/,
    "focus must move into the drawer when it mounts",
  );
  // The restore is deliberately conditional: a close caused by clicking some
  // other control has already put focus somewhere on purpose.
  assert.match(
    SOURCE,
    /if \(!active \|\| active === document\.body\) \{\s*opener\.focus\(\{ preventScroll: true \}\);/,
    "focus must return to the opener when it would otherwise be lost",
  );
});

test("Escape closes the drawer, but yields to whatever is on top of it", () => {
  const at = SOURCE.indexOf('if (event.key !== "Escape" || event.defaultPrevented) return;');
  assert.notEqual(at, -1, "the drawer's Escape handler went missing");
  const handler = SOURCE.slice(at, at + 1800);

  assert.match(
    handler,
    /if \(evidenceOpen \|\| mobileEditor\) return;/,
    "the evidence manager and the mobile field editor are innermost and close first",
  );
  assert.match(
    handler,
    /document\.querySelector\("\.ms-layer \.ms-popover"\)/,
    "an open anchored popover owns the Escape press",
  );
  assert.match(
    handler,
    /target\.closest\("input, textarea, select, \[contenteditable='true'\]"\)/,
    "Escape in a box abandons what is being typed; it must not also bin the drawer",
  );
  assert.match(handler, /onClose\(\);/, "…and otherwise it closes the drawer");
  assert.match(
    SOURCE,
    /window\.addEventListener\("keydown", onKeyDown\);/,
    "the listener follows the window-level convention media-viewer.tsx uses",
  );
});
