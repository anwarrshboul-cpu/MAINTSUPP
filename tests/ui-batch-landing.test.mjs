/**
 * UI batch — the landing page review, pinned.
 *
 * Each of these came from a screenshot review on a phone: the comparison
 * became a table, the urgency pills became a select, the three upload tiles
 * became one "+ Add" button with a menu, the stage list left the stepper,
 * the founder placeholder went, the drawer opens from the left, and the
 * pricing band buttons stopped moving under the thumb that pressed them.
 * Source pins, so the decisions survive the next tidy-up.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const stripComments = (source) =>
  source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The declaration block for the first rule whose selector contains `selector`. */
function ruleFor(css, selector) {
  const at = css.indexOf(selector);
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

test("urgency is one required select carrying the four approved values", async () => {
  const form = stripComments(await read("app/(marketing)/_sections/report-job.tsx"));
  const field = form.slice(form.indexOf('id="rjUrgency"') - 80, form.indexOf('id="rjUrgency-err"'));
  assert.match(field, /<select\s+id="rjUrgency"/, "a select, not radios");
  assert.match(field, /required/);
  assert.match(field, /<option value="">Select urgency<\/option>/, "the placeholder option");
  assert.match(field, /value=\{entry\.code\}/, "the option value is the P-code the server maps");
  assert.match(field, /aria-invalid=\{invalid\("rjUrgency"\)\}/);
  assert.ok(!form.includes('type="radio"'), "no radio inputs remain in the form");
  assert.ok(!form.includes("chipgroup"), "and the pill pattern is gone from it");

  /* The four values and their wording are unchanged, and still carry no SLA. */
  for (const label of [
    "P1 — Critical, site unsafe or cannot trade",
    "P2 — Urgent, trading impaired",
    "P3 — Routine",
    "P4 — Cosmetic / quote request",
  ]) {
    assert.ok(form.includes(label), `urgency wording changed: ${label}`);
  }
  assert.ok(!/Within \d+ hrs|Next working day|working days/.test(form), "no response-time promise");
});

test("media is one + Add button opening a menu over the same three inputs", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(form, /id="rjAddMedia"/, "the single Add button");
  assert.match(form, /aria-haspopup="menu"/);
  assert.match(form, /aria-expanded=\{menuOpen\}/);
  assert.match(form, /role="menu"/);
  /* Four menu items in the JSX — the two `[role="menuitem"]` querySelector
     strings that drive focus are not items. */
  assert.equal((stripComments(form).match(/(?<!\[)role="menuitem"(?!\])/g) ?? []).length, 4, "three sources and a Cancel");
  assert.ok(!form.includes('className="upload__btn"'), "the three permanent tiles are gone");

  /* The same three hidden inputs, with the same capture behaviour. */
  assert.match(form, /id="rjCamera"[\s\S]{0,120}accept="image\/\*"\s+capture="environment"/);
  assert.match(form, /id="rjVideo"[\s\S]{0,120}accept="video\/\*"\s+capture="environment"/);
  assert.match(form, /id="rjLibrary"[\s\S]{0,120}accept="image\/\*,video\/\*"/);
  assert.match(form, /pick\(cameraRef\)/);
  assert.match(form, /pick\(videoRef\)/);
  assert.match(form, /pick\(libraryRef\)/);

  /* Keyboard: Escape closes and focus returns to the button. */
  assert.match(form, /case "Escape":\s*event\.preventDefault\(\);\s*closeMenu\(\);/);
  assert.match(form, /addRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  /* The drop zone stays on the container: four drag handlers sit between the
     id and onDrop, so the window is wide enough to hold them. */
  assert.match(form, /id="rjUpload"[\s\S]{0,900}onDrop=/);

  const css = await read("app/(marketing)/marketing.css");
  const mobile = css.slice(css.indexOf(".upload__backdrop{display:none}"));
  assert.match(mobile, /@media \(max-width:760px\)\{\s*\.upload__backdrop\{display:block;position:fixed;inset:0/, "a backdrop on a phone");
  assert.match(mobile, /\.upload__menu\{position:fixed;left:0;right:0;bottom:0/, "and the menu is a bottom sheet there");

  /* The sheet sits ABOVE the cookie notice. At --z-toast (500) the notice
     covered the sheet's Cancel row — and the foot of the drawer — on a first
     visit, and a tap there pressed "Reject non-essential" instead. A cookie
     bar is page furniture: above the sticky header, below every overlay. */
  assert.match(css, /\.cookie\{position:fixed;inset:auto 0 0;z-index:calc\(var\(--z-sticky\) \+ 50\);/);
  /* The backdrop owns its dismissal. The outside-press closer used to remove
     it on pointerdown, before the finger lifted, so the tap's click was
     hit-tested against the header beneath and a link took the press. */
  assert.match(form, /if \(\(target as Element\)\.closest\?\.\("\.upload__backdrop"\)\) return;/);
  assert.match(form, /className="upload__backdrop"[\s\S]{0,120}onClick=\{\(\) => closeMenu\(\)\}/, "closing from the backdrop's own click returns focus to + Add");
});

test("the stage list is gone and only the stage name is red", async () => {
  /* Comments out: the file explains what it removed, by name. */
  const workflow = stripComments(await read("app/(marketing)/_sections/workflow.tsx"));
  assert.ok(!workflow.includes("wf__steps"), "the left-hand list is gone");
  assert.ok(!workflow.includes('role="tablist"'), "and its tab semantics with it");
  assert.ok(!workflow.includes('role="tabpanel"'), "a tabpanel with no tab is an ARIA error");
  assert.ok(!workflow.includes("aria-labelledby"), "nothing points at a tab that no longer exists");
  assert.match(
    workflow,
    /<span className="wf__stage-name">\{stage\.name\}<\/span> — \{stage\.heading\}/,
    "the name is its own span; the dash and heading are outside it",
  );
  /* Keyboard access moved to the card. */
  assert.match(workflow, /className="wf__stage"[\s\S]{0,200}tabIndex=\{0\}/);
  assert.match(workflow, /onKeyDown=\{handleKeyDown\}/);
  assert.match(workflow, /key === "ArrowRight"/);
  assert.match(workflow, /key === "ArrowLeft"/);
  assert.match(workflow, /aria-live="polite"/);
  /* Everything the card carried is still there. */
  /* "What the system records" is the owner's later wording for the second
     definition term; what this list pins is that the term is still there. */
  for (const kept of ["Stage {active + 1} of {COUNT}", "What you do", "What the system records", "wf__bar", "wfPrev", "wfNext", "Swipe the panel, or use the arrows."]) {
    assert.ok(workflow.includes(kept), `lost from the stepper: ${kept}`);
  }
  assert.equal((workflow.match(/name: "/g) ?? []).length, 7, "seven stages");

  const css = await read("app/(marketing)/marketing.css");
  assert.ok(!css.includes(".wf__steps"), "the list's styles went with it");
  assert.ok(!/\.wf\{[^}]*grid-template-columns/.test(css), "no second column is reserved");
  assert.match(css, /\.wf__stage-name\{color:var\(--critical\)\}/, "red is the page's critical token");
});

test("the drawer opens from the left edge and locks the page without shifting it", async () => {
  const css = await read("app/(marketing)/marketing.css");
  const panel = ruleFor(css, ".drawer__panel{");
  assert.match(panel, /inset:0 auto 0 0/, "pinned to the left edge");
  assert.match(css, /@keyframes slideIn\{from\{transform:translateX\(-100%\)\}\}/, "and slides in from it");
  assert.match(panel, /overflow-y:auto/, "the list scrolls inside the panel on a short phone");
  assert.match(panel, /overscroll-behavior:contain/);

  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  assert.match(chrome, /body\.style\.position = "fixed";/, "overflow:hidden alone does not hold on iOS");
  assert.match(chrome, /body\.style\.top = `-\$\{scrollY\}px`;/);
  assert.match(chrome, /body\.style\.paddingRight = `\$\{scrollbar\}px`;/, "the scrollbar width is kept, so nothing shifts sideways");
  assert.match(chrome, /window\.scrollTo\(\{ top: scrollY, left: 0, behavior: "instant"/, "the position is handed back instantly");
  /* Closes via ×, via the backdrop, and after navigating; Escape and the trap stay. */
  assert.match(chrome, /className="drawer__close"[^>]*onClick=\{close\}/);
  assert.match(chrome, /if \(event\.target === event\.currentTarget\) close\(\);/);
  assert.match(chrome, /*
     * One handler reading the anchor's own href (not a `follow(href)` factory
     * called during render — react-hooks/refs forbids a ref-touching function
     * from running in render). The behaviour is identical: close, then follow.
     */
    /<a href=\{href\} onClick=\{onDrawerLink\}>/);
  /* An anchor chosen from the drawer is followed AFTER the lock releases —
     otherwise the release's scroll restore undoes the jump a frame later. */
  assert.match(chrome, /pendingHash\.current = href;/);
  assert.match(chrome, /destination\.scrollIntoView\(\{ behavior: reduced \? "auto" : "smooth", block: "start" \}\);/);
  assert.match(chrome, /event\.key === "Escape"/);
  assert.match(chrome, /event\.shiftKey && document\.activeElement === first/);
  for (const item of ["Report a Job", "Portal Login", "Services", "How It Works", "Pricing", "Case Study", "Contact Us", "Book a Portfolio Review"]) {
    assert.ok(chrome.includes(item), `drawer item missing: ${item}`);
  }
});

test("back-to-top is bounded by the page, not by a scroll percentage", async () => {
  /*
   * The button used to appear at `y > 700` and then float over whatever was
   * beneath it. On a phone every section is one full-width column, so measured
   * against a 20px scroll sweep it covered 36% of the How It Works "Next"
   * button, 100% of a price in the mobile pricing table, 31% of the "26+
   * stores" tier button and 30% of the footer links including the published
   * email address. Raising the button only moved which of those it ate.
   *
   * What this pins is the shape of the answer: the button is shown only once
   * it has come to rest below the top of the footer's legal block — the last
   * thing on the page, and the only part of it holding no link and no control.
   * A scroll percentage must not come back: the depth at which the footer's
   * links finish is 98.8% at 320px and 99.6% at 1280px, and it moves again
   * every time the page's height changes.
   */
  /* Stripped: this function's own comment quotes the `y > 700` it replaced. */
  const chrome = stripComments(await read("app/(marketing)/_sections/chrome.tsx"));
  const furniture = chrome.slice(
    chrome.indexOf("export function ScrollFurniture"),
    chrome.indexOf("const cookieStore"),
  );
  /* `y > 0` is allowed — it only asks whether the reader has scrolled at all.
     Any other number is a threshold, and a threshold is the bug. */
  assert.doesNotMatch(furniture, /y\s*>\s*[1-9]\d*/, "no absolute pixel depth");
  assert.doesNotMatch(furniture, /scrollHeight[^;]*\*\s*0\.\d/, "and no percentage of the page either");
  assert.match(furniture, /getElementById\("ftrLegal"\)/, "the boundary is an element on the page");
  assert.match(
    furniture,
    /legal\.getBoundingClientRect\(\)\.top <= window\.innerHeight - lane/,
    "shown once the button's own top edge is below that element's top",
  );
  /* `lane` must come from the computed style, not a rect: the hidden state
     carries translateY(10px), and a rect would make the button's measured top
     jump the instant it appeared, flipping the test back off on one scroll. */
  assert.match(furniture, /getComputedStyle\(button\)\.bottom/);
  assert.match(furniture, /button\.offsetHeight/);
  assert.doesNotMatch(furniture, /totop\.current\.getBoundingClientRect/);
  /* And the element it keys off has to exist, with the id it looks up. */
  assert.match(chrome, /className="wrap ftr__legal" id="ftrLegal"/);

  const css = await read("app/(marketing)/marketing.css");
  const totop = ruleFor(css, ".totop{");
  assert.match(totop, /position:fixed/);
  assert.match(totop, /bottom:calc\(20px \+ var\(--cookie-lane,0px\) \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(totop, /right:max\(20px,env\(safe-area-inset-right\)\)/);
  assert.match(css, /\.totop\{right:max\(14px,env\(safe-area-inset-right\)\);bottom:calc\(14px \+ var\(--cookie-lane,0px\) \+ env\(safe-area-inset-bottom\)\);width:44px;height:44px\}/,
    "44px is the floor on a phone — never smaller, never display:none");

  /*
   * THE COOKIE BANNER. It is fixed to the same bottom edge at z-index 150, and
   * the button's lane is the very end of the page — exactly and only where the
   * banner sits. At z-index 100 the button was 100% obscured on a first visit:
   * its centre and all four corners hit-tested to "Accept all".
   *
   * Three things have to hold together, so all three are pinned. The button is
   * lifted by the banner's measured height, it outranks the banner, and the
   * FOOTER's lane grows by that same height — without the third the lift eats
   * the window, because raising the button also raises the point at which it
   * may appear (measured: a 20px window at 375px, one scroll step).
   */
  assert.match(totop, /z-index:calc\(var\(--z-sticky\) \+ 60\)/, "above the cookie banner's +50");
  assert.match(furniture, /document\.getElementById\("cookie"\)/, "the banner is measured, not assumed");
  assert.match(furniture, /setProperty\(\s*"--cookie-lane"/);
  assert.doesNotMatch(furniture, /--cookie-lane",?\s*`1?\d{2,3}px`/, "measured, never a hardcoded height");

  /*
   * AND MEASURED CONTINUOUSLY, NOT ONCE.
   *
   * One reading in the effect plus one on `resize` left the lane stale: at 375
   * and 360 the banner settles at 168px and the lane published 158.75 — short
   * by 21.25, one of the banner's own line heights — while a resize corrected
   * it to 180 on the spot. Identical with `fonts.status === "loaded"` and 1.5s
   * after `fonts.ready`, so it is not a font race; it is a fixed element's
   * height treated as a constant.
   *
   * The banner's own box has to be watched, so the published value comes from
   * live geometry however the banner reflows — a wrapped line, a rotation, a
   * reader's text size. The observer must be attached to the element and let
   * go on cleanup, and none of it may be keyed to a viewport width.
   */
  assert.match(furniture, /new ResizeObserver\(/, "the banner's box is observed, not sampled once");
  assert.match(furniture, /observer\.observe\(banner\)/, "and observed on the banner element itself");
  assert.match(furniture, /observer\?\.disconnect\(\)/, "and let go when the effect is torn down");
  assert.match(furniture, /document\.fonts\.ready\.then\(/, "re-published when the type lands");
  assert.match(
    furniture,
    /addEventListener\("orientationchange", settle\)/,
    "and when the phone is turned",
  );
  assert.doesNotMatch(
    furniture,
    /innerWidth/,
    "the lane is geometry, never a width special-case for 375 or 360",
  );
  /* The effect re-runs when the banner appears after hydration and when it is
     dismissed — the same store the banner itself renders from. */
  assert.match(furniture, /useSyncExternalStore\(cookieStore\.subscribe/);
  assert.match(furniture, /\}, \[choice\]\);/);

  /* The footer's bottom padding is the button's lane: at the very bottom of
     the page it has to be over nothing at all, banner up or not.

     86px made that true and nothing else. The window the button was available
     for is the legal block's height plus this padding minus the button's own
     reach, which measured 213px at 430/390/375, 233 at 360 and 253 at 320 —
     1.3% of a page 16,300–17,100px tall, a control you had to catch rather
     than one you could use. 280px is the same guarantee with a window worth
     having: measured after, 406px at 375 and 447 at 320, 1.9x, for a footer
     +16.5% at 320. Every link, line and control sits above this padding, so
     the whole cost is navy below the copyright line — and 280 is where that
     band stops, at 49% of a 320x568 viewport, because it is bought pixel for
     pixel and past half a screen it reads as a page that did not finish. */
  const lane = /padding-block:(?:clamp\(40px,3\.4vw,50px\)|34px) calc\(280px \+ var\(--cookie-lane,0px\) \+ env\(safe-area-inset-bottom\)\)/;
  assert.match(ruleFor(css, ".ftr{"), lane);
  /* And the phone override must not quietly cancel it — it did, with `16px`,
     which left the button clearing the copyright line only by the accident of
     how tall the legal paragraphs happen to wrap. */
  assert.equal((css.match(new RegExp(lane, "g")) ?? []).length, 2, "base rule and the max-width:620px override");

  /* Navy on --navy-deep was 1.10:1. The button only ever appears over the
     footer now, so it has to read against it. */
  assert.match(totop, /background:var\(--teal-text\)/);
});

test("Contact Us is in both navs, and both send you to the section the footer already calls Contact", async () => {
  /*
   * One list feeds both bars, so the only way "Contact Us" can be in the
   * desktop nav and missing from the drawer — the failure this pins — is for
   * somebody to stop rendering NAV in one of them. Both halves are asserted.
   *
   * `#review` is not a new destination. The footer's own "Contact" link has
   * always pointed there, and `#review` is the Book a Portfolio Review section,
   * whose form asks for name, company, email and phone. No phone number, email
   * or address was invented for this link.
   */
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  const nav = chrome.slice(chrome.indexOf("const NAV = ["), chrome.indexOf("] as const;"));
  assert.match(nav, /\["#review", "Contact Us"\]/, "Contact Us belongs in the shared nav list");

  const order = [...nav.matchAll(/\["#[a-z-]+", "([^"]+)"\]/g)].map((match) => match[1]);
  assert.deepEqual(order, ["Services", "How It Works", "Pricing", "Case Study", "Contact Us"]);

  /* Desktop: the list renders into .nav__list, and Portal Login follows it. */
  assert.match(chrome, /<nav className="nav" aria-label="Primary">[\s\S]*?NAV\.map/, "the desktop bar renders NAV");
  assert.ok(
    chrome.indexOf('className="nav" aria-label="Primary"') < chrome.indexOf('className="nav__link hdr__login"'),
    "Portal Login comes after the section links",
  );

  /* Drawer: the same list, the same close-then-go handler as its siblings, and
     it sits above the Book a Portfolio Review button. */
  assert.match(chrome, /<nav aria-label="Mobile">[\s\S]*?NAV\.map[\s\S]*?<a href=\{href\} onClick=\{onDrawerLink\}>/);
  assert.ok(
    chrome.indexOf('aria-label="Mobile"') < chrome.lastIndexOf('href="#review" onClick={onDrawerLink}'),
    "the section links precede the CTA in the drawer",
  );

  /* And the destination exists — the same anchor the footer uses. */
  assert.match(chrome, /<a href="#review">Contact<\/a>/, "the footer convention this reuses");
  const finalCta = await read("app/(marketing)/_sections/final-cta.tsx");
  assert.match(finalCta, /<section className="section finalcta" id="review">/, "#review is a real section");
});

test("the pricing band buttons do not move under the thumb that pressed them", async () => {
  /*
   * The handler was never the defect: a tap on any band moved the pill, the
   * slider and the prices in both Chromium and WebKit. What moved was the
   * row itself — the note above it is one line on 1–10 and two lines on the
   * other two bands, so the card grew by a line the moment 11–25 or 26+ was
   * pressed (+21px at 390 and 430, measured). The note reads the same shape
   * for every band now, and the room it takes is reserved.
   *
   * 722 and 384, not 700 and 360: both breakpoints were set from those two
   * measurements alone, and a 320-800px sweep in both engines against the
   * preview found the row still moving +21px wherever the reservation was a
   * line short of what the longest note actually wraps to — 361-384px (which
   * includes 375px: iPhone SE 2/3, 6/7/8, X/XS and 13 mini, the phone the
   * report came from) and 701-722px (tablet portrait). Three lines to 384,
   * two to 722, one above.
   */
  const css = await read("app/(marketing)/marketing.css");
  /* 3.2em is two lines at the note's line-height of 1.6 — not 2.4em, which
     is two lines of glyphs and not two lines of text. */
  assert.match(css, /\.pricing__band-note\{[^}]*line-height:1\.6\}/);
  assert.match(css, /@media \(max-width:722px\)\{\.pricing__band-note\{min-height:3\.2em\}\}/);
  /* 384, not 360 — the widths in between are where the note takes a third
     line, and they are the common iPhone widths. */
  assert.match(css, /@media \(max-width:384px\)\{\.pricing__band-note\{min-height:4\.8em\}\}/);
  assert.match(css, /\.switcher button\{touch-action:manipulation\}/, "a tap is a tap, not half a double-tap");

  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  assert.match(pricing, /you are on the \$\{band\.label\} rate`\}/, "one sentence shape for every band");
  assert.ok(!pricing.includes("You have unlocked"), "the contradictory 'save £N' note is gone");
  assert.match(pricing, /below the \$\{entryBand\.label\} rate on Total Care/, "the figure says what it is");
  /* The approved numbers, untouched. */
  assert.match(pricing, /coordination: 65, compliance: 55, total: 100/);
  assert.match(pricing, /coordination: 58, compliance: 48, total: 88/);
  assert.match(pricing, /coordination: 52, compliance: 42, total: 78/);
});

test("the hero feed keeps one height, so the page below it stops jumping", async () => {
  /*
   * Measured at 390px: the rotating feed line alternated between 85px and
   * 104px every 4.2 seconds, and everything beneath it — the pricing band
   * buttons included — shifted 19px with it. Two lines are reserved for the
   * detail line, so a one-line item and a two-line item take the same room.
   */
  const css = await read("app/(marketing)/marketing.css");
  assert.match(css, /\.hero__feed span\{[^}]*min-height:3\.2em;line-height:1\.6/, "two lines reserved for the detail line");
});
