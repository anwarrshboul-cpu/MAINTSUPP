/**
 * Stage 27 — two layout defects the owner marked on their own screens.
 *
 * ---------------------------------------------------------------------------
 * A. REPORTS: "Edit layout" was floating under a chart
 *
 * The control that arranges the dashboard's panels rendered in a `.widget-bar`
 * of its own, below the Spend trend chart, while the page header carried a row
 * of controls — "All portfolios", the period picker, "Export spend" — with an
 * empty space beside them. The owner marked both and asked for the control to
 * move into that space, styled like its neighbours.
 *
 * It could not simply be moved: `DashboardWidgets` renders the bar AND owns the
 * saved arrangement, the panel list and the saving, and it has to stay where
 * the panels are. So the toolbar renders a slot and the bar is portalled into
 * it — the state does not move, the button does. Overview passes no slot and is
 * untouched, which is asserted here rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * B. JOBS: the six KPI meters became unreachable
 *
 * Measured at 1440x900 before anything changed: the page scrolls 480px, the
 * board is a nested scroller holding 36,838px of rows in a 645px window, and
 * with the page at the bottom the meter cards sat 128px ABOVE the viewport.
 * Every action inside the grid moves the nested scroller, which never moves the
 * page, so the only route back to the numbers was the outer scrollbar. At
 * 390x844 the card list is 89,220px of page scroll and the meters are one
 * screen in a hundred and six.
 *
 * Ruled out before this: stopping the page scrolling so only the grid moves.
 * Measured, and it left the grid 236px tall on a desktop and 165px on a phone —
 * about six rows — because the furniture above the grid is ~570px of a 900px
 * screen. Nothing on the page may be removed, so that furniture is a given.
 *
 * What ships: the meters section is `position: sticky` under the page's top
 * bar, and collapses there into one row of label-and-figure chips. Same six
 * cards, same six figures, same DOM — the strip is a restyling of the elements
 * that were already on the page, so it cannot come to disagree with them — and
 * the grid keeps every pixel of its height.
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO PROTECT
 *
 * The first version let the section shrink from 168px to 46px and it
 * oscillated. Chrome's scroll anchoring compensates for content above the
 * reader changing size, so collapsing took 122px out of the page and the
 * browser subtracted 122 from `scrollY` to hold the view still — which moved
 * the trigger back across its own line, expanding the section, which gave the
 * 122px back, and so on. Measured: parked at y=200 the strip flipped on and off
 * and the scroll position alternated 200/78 indefinitely.
 *
 * The collapse is therefore a pure repaint: the section takes the strip's
 * height and a bottom margin of exactly the difference, so the document is the
 * same height in both states. `documentElement.scrollHeight` identical
 * collapsed and expanded is the whole proof, and it is measured below in a real
 * browser at both widths.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

const BRAND = "app/brand-overrides.css";
const LIVE_BOARD = "app/(app)/portal/live-board.tsx";
const STRIP = "app/(app)/portal/jobs-meter-strip.tsx";
const WIDGETS = "app/(app)/portal/dashboard-widgets.tsx";
const ANALYTICS = "app/(app)/portal/dashboard-analytics.tsx";
const PORTAL = "app/(app)/portal/portal-app.tsx";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5174";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

/**
 * Every declaration block in a stylesheet, as `{ selectors, body }`.
 *
 * Parsed rather than string-searched. Three of the selectors this file cares
 * about appear in four rules each — a desktop rule, a hover rule and two mobile
 * ones — and `indexOf` finds whichever comes first, which is how an earlier
 * version of these assertions "passed" against a rule it was not about.
 *
 * A declaration block never contains a brace, so the pattern below cannot match
 * an at-rule's body; the engine simply steps past `@media (…) {` and picks up
 * the rules inside it. The selector list keeps its `@media` context only when
 * asked for, which is what `inside` is for.
 */
function declarationRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(clean))) {
    found.push({
      selectors: match[1]
        .trim()
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean),
      body: match[2],
    });
  }
  return found;
}

/** Rules whose selector list contains `selector` exactly — not as a prefix. */
function rulesSelecting(rules, selector) {
  return rules.filter((rule) => rule.selectors.includes(selector));
}

/** The single rule that names `selector` and declares `declaration`. */
function ruleFor(rules, selector, declaration) {
  const matches = rulesSelecting(rules, selector).filter((rule) =>
    rule.body.includes(declaration),
  );
  assert.equal(
    matches.length,
    1,
    `expected exactly one rule selecting ${selector} with ${declaration}, found ${matches.length}`,
  );
  return matches[0];
}

/* ------------------------------------------------------------------ */
/* A. Reports — the control moved, and only the control                */
/* ------------------------------------------------------------------ */

test("the toolbar renders a slot, and renders it before the export button", async () => {
  const source = await read(ANALYTICS);
  assert.match(source, /slotRef\?: \(node: HTMLDivElement \| null\) => void/);
  assert.match(source, /<div className="analytics-toolbar__slot" ref=\{slotRef\} \/>/);

  /*
   * Order is load-bearing, not cosmetic. Three rules in brand-overrides.css
   * select `.analytics-toolbar > button:last-child` to give the export button
   * the full width of the two-column mobile grid; a slot appended after it
   * would take that rule away from it silently.
   */
  const slotAt = source.indexOf('className="analytics-toolbar__slot"');
  const exportAt = source.indexOf("<button type=\"button\" onClick={onExport}>");
  assert.ok(slotAt > 0 && exportAt > 0, "both the slot and the export button must render");
  assert.ok(
    slotAt < exportAt,
    "the slot must render before the export button, or `> button:last-child` stops selecting Export",
  );
});

test("the widget bar can be portalled, and tells a missing slot from no slot", async () => {
  const source = await read(WIDGETS);
  assert.match(source, /import \{ createPortal \} from "react-dom";/);
  assert.match(source, /barSlot\?: HTMLElement \| null;/);
  assert.match(source, /const usesSlot = barSlot !== undefined;/);
  /*
   * `undefined` means no slot was asked for — draw the bar in place, which is
   * every surface but Reports. `null` means a slot was asked for and has not
   * mounted yet — draw nothing, rather than drawing the bar under the charts
   * for one commit and yanking it into the header on the next.
   */
  assert.match(source, /\{usesSlot \? barSlot && createPortal\(bar, barSlot\) : bar\}/);
});

test("both Reports and Overview ask for the header slot", async () => {
  /*
   * WHAT CHANGED, AND WHY THE ASSERTION FLIPPED.
   *
   * This used to require the opposite of Overview — that it ask for no slot at
   * all and keep its widget bar under the charts. That was right while Reports
   * was the only surface with a toolbar to portal into. Overview has one now,
   * and leaving Edit Layout stranded below the fold while the identical control
   * sat in the header one page over was the inconsistency a reader noticed
   * first. Both surfaces portal into their own toolbar.
   *
   * `usesSlot` still tells `undefined` from `null`, so a surface with no
   * toolbar is unaffected — see the test above.
   */
  const source = await read(PORTAL);

  const reportsAt = source.indexOf("function ReportsView(");
  assert.ok(reportsAt > 0, "ReportsView must exist");
  const reports = source.slice(reportsAt, source.indexOf("\nfunction ", reportsAt + 10));
  assert.match(reports, /const \[layoutSlot, setLayoutSlot\] = useState<HTMLElement \| null>\(null\);/);
  assert.match(reports, /slotRef=\{setLayoutSlot\}/);
  assert.match(reports, /surface="reports"\s*\n\s*barSlot=\{layoutSlot\}/);

  const overviewAt = source.indexOf("function OverviewView(");
  assert.ok(overviewAt > 0, "OverviewView must exist");
  const overview = source.slice(overviewAt, source.indexOf("\nfunction ", overviewAt + 10));
  assert.match(overview, /surface="overview"/);
  assert.match(
    overview,
    /const \[overviewLayoutSlot, setOverviewLayoutSlot\] = useState<HTMLElement \| null>\(null\);/,
    "Overview holds its own slot element",
  );
  assert.match(overview, /slotRef=\{setOverviewLayoutSlot\}/, "the toolbar publishes the slot");
  assert.match(overview, /barSlot=\{overviewLayoutSlot\}/, "and the widget bar portals into it");
});

test("the header control is styled by the toolbar's own rules, not by a copy of them", async () => {
  const rules = declarationRules(await read(BRAND));

  // display: contents, so the portalled bar is laid out as one more chip in the
  // row rather than as a box the flex/grid has to place separately.
  const slot = ruleFor(rules, ".analytics-toolbar__slot", "display: contents");
  assert.ok(slot);

  /*
   * The chip look is ONE definition. A second set of paddings, borders and
   * radii for this button would be a second answer to "what does a control in
   * this row look like", and the two would drift the first time either was
   * tuned. So the claim asserted is structural: EVERY rule that shapes a button
   * in this toolbar also names the portalled one.
   */
  const CHIP = ".analytics-toolbar .widget-bar--in-toolbar > button";
  const shaping = rulesSelecting(rules, ".analytics-toolbar > button");
  assert.ok(shaping.length >= 4, `expected the chip rules, found ${shaping.length}`);
  for (const rule of shaping) {
    assert.ok(
      rule.selectors.includes(CHIP),
      `this rule shapes the toolbar's buttons but not the portalled one:\n${rule.selectors.join(",\n")} {${rule.body}}`,
    );
  }

  const hover = rulesSelecting(rules, ".analytics-toolbar > button:hover");
  assert.equal(hover.length, 1);
  assert.ok(hover[0].selectors.includes(`${CHIP}:hover`), "and the hover state comes with it");
});

/* ------------------------------------------------------------------ */
/* B. Jobs — the collapsing sticky meter strip                         */
/* ------------------------------------------------------------------ */

test("the meters stick under the top bar and pass beneath it", async () => {
  const rule = ruleFor(declarationRules(await read(BRAND)), ".live-job-metrics", "position: sticky");
  assert.match(rule.body, /top:\s*var\(--jobs-rail-top\)/);

  const layer = Number(rule.body.match(/z-index:\s*(\d+)/)?.[1]);
  const topbar = ruleFor(
    declarationRules(await read("app/globals.css")),
    ".portal-topbar",
    "position: sticky",
  );
  const topbarLayer = Number(topbar.body.match(/z-index:\s*(\d+)/)?.[1]);
  assert.ok(
    layer > 0 && layer < topbarLayer,
    `the strip must sit under the top bar: ${layer} vs ${topbarLayer}`,
  );
});

test("collapsing costs the document no height — the anti-oscillation invariant", async () => {
  const rules = declarationRules(await read(BRAND));
  const rule = ruleFor(rules, ".live-job-metrics.is-collapsed", "margin-bottom");

  // Height and a bottom margin of exactly what the cards gave up. Losing either
  // half puts the oscillation back — see the header of this file.
  assert.match(rule.body, /height:\s*var\(--jobs-rail-h\)/);
  assert.match(
    rule.body,
    /margin-bottom:\s*calc\(var\(--jobs-rail-natural[^)]*\)\s*-\s*var\(--jobs-rail-h\)\)/,
    "the collapsed section must give back, as margin, exactly the height it stopped occupying",
  );
});

test("the natural height is measured, and never measured while collapsed", async () => {
  const source = await read(STRIP);

  /*
   * The expanded height is 168px at 1440, two rows of three under 1380 and a
   * horizontal scroller under 760 — three numbers, and a fourth the next time
   * the grid is tuned. It is read off the element.
   */
  assert.match(source, /new ResizeObserver\(record\)/);
  assert.match(source, /column\.style\.setProperty\("--jobs-rail-natural", `\$\{height\}px`\)/);

  /*
   * And the guard. A ResizeObserver delivers straight after layout while React
   * runs effect cleanup after paint, so the collapse fires the observer once
   * more before it is disconnected. Without this the recorded "natural" height
   * was the strip's own 46px, the margin computed to zero, and the page shrank
   * after all.
   */
  assert.match(source, /if \(element\.classList\.contains\("is-collapsed"\)\) return;/);
});

test("the trigger is the heading above, whose position the collapse cannot move", async () => {
  const source = await read(STRIP);
  // The heading, and nothing between it and the top of the document, changes
  // size when the meters collapse — so its offset is invariant under the very
  // effect it triggers, which is what makes the loop impossible.
  assert.match(await read(LIVE_BOARD), /live-jobs-analytics-heading" ref=\{anchorRef\}/);
  assert.match(source, /observer\.observe\(trigger\)/);
  assert.match(source, /rootMargin: `-\$\{line \+ 1\}px 0px 0px 0px`/);

  // The line is measured off the real top bar, not restated: that bar is 71px
  // on a desktop and 64px under 430px, and between those widths its height and
  // the `--mobile-topbar-height` token do not agree.
  assert.match(source, /document\.querySelector\("\.portal-topbar"\)/);
  assert.match(source, /page\.current\?\.style\.setProperty\("--jobs-rail-top", `\$\{line\}px`\)/);
});

test("the strip removes nothing: six cards, and one control that is new", async () => {
  const source = await read(LIVE_BOARD);
  const from = source.indexOf("className={sectionClassName}");
  assert.ok(from > 0, "the meters section must render from the strip's own class");
  const section = source.slice(from, source.indexOf("</section>", from));
  const cards = section.match(/<AnalyticsMetricCard /g) ?? [];
  assert.equal(cards.length, 6, "all six meters must still render in both states");

  for (const label of [
    "Open",
    "P1 critical",
    "Awaiting parts",
    "Awaiting approval",
    "Closed in period",
    "Avg SLA target",
  ]) {
    assert.ok(section.includes(`label="${label}"`), `${label} must still be one of the meters`);
  }

  /*
   * Three states, not two. "pinned but expanded" is its own value because the
   * pinned box is then taller than the strip, and the phone's bars have to step
   * down by the cards' height rather than by the strip's — folding it into
   * "not pinned" drew the cards straight over the board's identity bar.
   */
  const strip = await read(STRIP);
  assert.match(strip, /railState: stuck \? \(collapsed \? "on" : "open"\) : "off"/);
  assert.match(
    strip,
    /sectionClassName: `analytics-metric-grid analytics-metric-grid--six live-job-metrics\$\{\s*stuck \? " is-stuck" : ""\s*\}\$\{collapsed \? " is-collapsed" : ""\}`/,
  );

  // The toggle exists only while the section is stuck: a seventh child at the
  // top of the page would be a seventh cell in a six-column grid.
  assert.match(section, /<JobsMeterToggle stuck=\{meters\.stuck\}/);
  assert.match(strip, /if \(!stuck\) return null;/);
  assert.match(strip, /aria-expanded=\{!collapsed\}/);
  assert.match(strip, /const label = collapsed \? "Show meter detail" : "Collapse meters";/);
  assert.match(strip, /aria-label=\{label\}/);

  // What the strip gives up, and only that.
  const dropped = ruleFor(
    declarationRules(await read(BRAND)),
    ".live-job-metrics.is-collapsed .analytics-spark",
    "display: none",
  );
  assert.ok(
    dropped.selectors.includes(".live-job-metrics.is-collapsed .analytics-metric__copy > span"),
    "the sparkline and the caption go together, and nothing else goes with them",
  );
  assert.equal(dropped.selectors.length, 2);
});

test("the phone's sticky bars move with the strip, and its heights do not", async () => {
  const css = await read(BRAND);

  /*
   * `top` on a sticky box changes where it paints and nothing about the flow,
   * so offsetting these three is free of the anchoring problem the section's
   * own height had. `.board-chrome` is in the list because it pins at `top: 0`
   * — deliberately, so its tab rows tuck up behind the page's top bar and only
   * its bottom row stays on screen. That makes its visible bottom edge a fixed
   * distance from the VIEWPORT: measured with the strip in and that rule out,
   * the board identity bar ran to y182 while the toolbar stayed pinned at y163,
   * overlapping it by 19px.
   */
  const rules = declarationRules(css);
  for (const [selector, declaration] of [
    [".mobile-board-bar", "top: calc(var(--mobile-topbar-height)"],
    [".live-board-toolbar", "top: calc(var(--mobile-topbar-height)"],
    [".board-chrome", "position: sticky"],
  ]) {
    const rule = ruleFor(rules, selector, declaration);
    assert.match(
      rule.body,
      /var\(--jobs-stack-offset/,
      `${selector} must step down with the rest of the stack`,
    );
  }

  // And the offset is zero everywhere but the phone, so the desktop board's
  // chrome — which shares that rule — pins exactly where it always did.
  const base = ruleFor(rules, ".live-board-page", "--jobs-stack-offset");
  assert.match(base.body, /--jobs-stack-offset:\s*0px/);
  const phone = ruleFor(rules, '.live-board-page[data-jobs-rail="on"]', "--jobs-stack-offset");
  assert.match(phone.body, /--jobs-stack-offset:\s*var\(--jobs-rail-h\)/);

  /*
   * And the one that deliberately does not. `.live-board-scroll` sets a HEIGHT;
   * moving it would change the document's height and hand scroll anchoring
   * exactly the correction this whole mechanism was rebuilt to avoid.
   */
  for (const scroller of rulesSelecting(rules, ".live-board-scroll")) {
    if (!/height:\s*calc\(100dvh/.test(scroller.body)) continue;
    assert.doesNotMatch(
      scroller.body,
      /--jobs-rail-h/,
      "the grid window is a height, not an offset — it must not follow the strip",
    );
  }
});

test("the strip paints through tokens, so it follows both themes", async () => {
  const css = await read(BRAND);
  const start = css.indexOf("/* ---- Jobs: the collapsing sticky meter strip");
  assert.ok(start > 0, "the strip's rules must be a named block");
  const block = css.slice(start, css.indexOf("\n.analytics-spark__line", start));

  /*
   * The only literals allowed are the shadow and the focus tint, which are
   * alpha over whatever is behind them and are the same in both themes. Every
   * surface and every ink is a token, so the strip cannot be the one element
   * that stays light on a dark page — which is precisely the defect the theme
   * work was done to fix.
   */
  const hexes = block.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexes, [], `the strip must colour through tokens, found: ${hexes.join(", ")}`);
  assert.match(block, /background:\s*var\(--surface-head\)/);
  assert.match(block, /color:\s*var\(--ink\)/);
});

/* ------------------------------------------------------------------ */
/* The same claims, measured in a real browser                         */
/* ------------------------------------------------------------------ */

/**
 * A minimal CDP client — the harness from scripts/responsive-audit.mjs.
 *
 * No Playwright and no Puppeteer: both pull a second browser binary into a
 * project with five runtime dependencies, and the job here is "open a page,
 * set a viewport, read some numbers", which the DevTools protocol does over a
 * WebSocket Node already speaks.
 */
async function openBrowser() {
  const profile = mkdtempSync(path.join(tmpdir(), "maintsupp-stage27-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=9334",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
  ]);
  chrome.on("error", () => undefined);

  let socketUrl = null;
  for (let attempt = 0; attempt < 60 && !socketUrl; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:9334/json/version");
      socketUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!socketUrl) {
    chrome.kill();
    return null;
  }

  const socket = new WebSocket(socketUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);

  /*
   * Signed in over the API and injected as a cookie rather than typed into the
   * form: a failed form fill degrades silently to measuring the signed-out
   * shell, which is a different page with different furniture.
   */
  const signIn = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!signIn.ok) {
    socket.close();
    chrome.kill();
    return null;
  }
  for (const raw of signIn.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const split = pair.indexOf("=");
    await send(
      "Network.setCookie",
      {
        name: pair.slice(0, split).trim(),
        value: pair.slice(split + 1).trim(),
        domain: new URL(BASE_URL).hostname,
        path: "/",
      },
      sessionId,
    );
  }

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  };

  return {
    async viewport(width, height) {
      await send(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: width < 768 },
        sessionId,
      );
    },
    async theme(scheme) {
      await send(
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: scheme }] },
        sessionId,
      );
    },
    /**
     * Navigate, and wait for the page to actually be the page.
     *
     * These screens fetch after paint — the board pulls 745 rows and Reports
     * pulls a saved panel arrangement — so a load event says nothing about
     * whether the thing being measured exists yet. `until` is polled rather
     * than slept through: an earlier version slept 3.2 seconds and measured
     * Reports before its layout arrived, which reported the "Edit layout"
     * control missing when it was merely late.
     */
    async go(route, until = "true") {
      await send("Page.navigate", { url: `${BASE_URL}${route}` }, sessionId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const ready = await evaluate(`(() => { try { return Boolean(${until}); } catch { return false; } })()`);
        if (ready) break;
      }
      // `scroll-behavior: smooth` on <html> animates every programmatic scroll,
      // which turns "set the position, then read it" into a race.
      await evaluate(`document.documentElement.style.scrollBehavior = "auto"`);
    },
    evaluate,
    /**
     * Scroll, then wait for the page to settle.
     *
     * Headless Chrome throttles frames on an idle page, and the intersection
     * observation steps run per frame — so a fixed sleep after a scroll is a
     * coin toss. Driving `requestAnimationFrame` from inside the page forces
     * the frames the observer needs, and the poll makes the wait as long as it
     * has to be and no longer.
     */
    async scrollTo(y, expectation) {
      await evaluate(`window.scrollTo(0, ${y})`);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const settled = await evaluate(`new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(Boolean(${expectation}))));
        })`);
        if (settled) return true;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return false;
    },
    async close() {
      socket.close();
      chrome.kill();
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // A leftover profile in the system temp directory is not worth a failure.
      }
    },
  };
}

/** Shared across the measuring tests — one Chrome, one sign-in, five pages. */
let browser = null;
let browserReason = null;

test.before(async () => {
  if (!existsSync(CHROME)) {
    browserReason = "Google Chrome is not installed at the standard path";
    return;
  }
  try {
    await fetch(`${BASE_URL}/api/auth/login`, { method: "HEAD" });
  } catch {
    browserReason = `no dev server on ${BASE_URL}`;
    return;
  }
  browser = await openBrowser();
  if (!browser) browserReason = `could not drive Chrome against ${BASE_URL}`;
});

test.after(async () => {
  if (browser) await browser.close();
});

/*
 * What "loaded" means on each screen.
 *
 * Not a sleep. The board fetches its 745 rows after paint and Reports fetches
 * a saved panel arrangement, so a fixed wait measures whichever of the two the
 * machine happened to finish — an earlier version of this file slept 3.2
 * seconds and reported Reports' "Edit layout" control missing when it was
 * simply late.
 */
const JOBS = "/dashboard/jobs";
const JOBS_READY = `document.querySelectorAll(".live-job-metrics .analytics-metric").length === 6
  && /^[1-9]/.test(document.querySelector(".live-board-heading__meta strong")?.textContent ?? "")
  && (window.innerWidth <= 760
      ? document.querySelectorAll(".board-mobile__card").length > 700
      : document.querySelectorAll(".live-sheet tbody tr").length > 40)`;
const REPORTS_READY = `document.querySelector(".analytics-toolbar .widget-bar button")
  && document.querySelectorAll(".insight-grid > *").length > 0`;
const OVERVIEW_READY = `document.querySelector(".widget-bar button")
  && document.querySelectorAll(".insight-grid > *").length > 0`;

/** The rectangle of everything this file measures on the jobs board. */
const JOBS_PROBE = `(() => {
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
    };
  };
  const meters = document.querySelector(".live-job-metrics");
  return {
    scrollY: Math.round(window.scrollY),
    pageHeight: document.documentElement.scrollHeight,
    maxScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    collapsed: meters?.classList.contains("is-collapsed") ?? null,
    topbar: box(".portal-topbar"),
    meters: box(".live-job-metrics"),
    toggle: box(".live-job-metrics__toggle"),
    boardBar: box(".mobile-board-bar"),
    boardToolbar: box(".live-board-toolbar"),
    gridWindow: box(".live-board-scroll"),
    figures: [...document.querySelectorAll(".live-job-metrics .analytics-metric")].map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        label: card.querySelector("small")?.textContent ?? "",
        value: card.querySelector("strong")?.textContent ?? "",
        onScreen: rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
      };
    }),
  };
})()`;

test("1440: the meters stay on screen all the way down, and the page never changes height", async (t) => {
  if (!browser) return t.skip(browserReason);

  await browser.theme("light");
  await browser.viewport(1440, 900);
  await browser.go(JOBS, JOBS_READY);

  const top = await browser.evaluate(JOBS_PROBE);
  assert.equal(top.collapsed, false, "the cards are drawn in full at the top of the page");
  assert.equal(top.figures.length, 6, "six meters");
  const expandedFigures = top.figures.map((figure) => `${figure.label}=${figure.value}`);

  // The defect, as it was: at the bottom of the page the cards used to sit
  // 128px above the viewport.
  await browser.scrollTo(
    top.maxScroll,
    `document.querySelector(".live-job-metrics").classList.contains("is-collapsed")`,
  );
  const bottom = await browser.evaluate(JOBS_PROBE);

  assert.equal(bottom.collapsed, true, "the strip collapses once the cards reach the top bar");
  assert.equal(
    bottom.meters.top,
    bottom.topbar.height,
    "the strip pins flush under the top bar",
  );
  assert.ok(
    bottom.meters.height < top.meters.height,
    `the strip must be shorter than the cards: ${bottom.meters.height} vs ${top.meters.height}`,
  );

  // Every figure still on screen, and still the same figure.
  for (const figure of bottom.figures) {
    assert.ok(figure.onScreen, `"${figure.label}" must still be on screen at the bottom of the page`);
  }
  assert.deepEqual(
    bottom.figures.map((figure) => `${figure.label}=${figure.value}`),
    expandedFigures,
    "the strip shows the cards' own numbers — it is the same DOM, so it cannot show others",
  );

  /*
   * THE INVARIANT. Identical document height in both states is what stops
   * Chrome's scroll anchoring moving the scroll position, which is what stopped
   * the trigger being pushed back across its own line.
   */
  assert.equal(
    bottom.pageHeight,
    top.pageHeight,
    "collapsing must cost the document no height, or the strip oscillates",
  );
  assert.equal(bottom.overflowX, 0, "no horizontal scrollbar");
});

test("1440: parking anywhere in the scroll range settles, and stays settled", async (t) => {
  if (!browser) return t.skip(browserReason);

  await browser.viewport(1440, 900);
  await browser.go(JOBS, JOBS_READY);

  const readings = [];
  // 200 is in here on purpose: it is the position at which the first version of
  // this feature alternated 200/78 for as long as it was left alone.
  for (const y of [0, 60, 90, 100, 150, 200, 250, 300, 480]) {
    await browser.scrollTo(y, "true");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const first = await browser.evaluate(JOBS_PROBE);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const second = await browser.evaluate(JOBS_PROBE);
    readings.push({ y, first, second });
  }

  for (const { y, first, second } of readings) {
    assert.equal(
      first.collapsed,
      second.collapsed,
      `parked at y=${y} the strip flipped from ${first.collapsed} to ${second.collapsed}`,
    );
    assert.equal(
      first.scrollY,
      second.scrollY,
      `parked at y=${y} the page moved itself from ${first.scrollY} to ${second.scrollY}`,
    );
    assert.equal(
      first.scrollY,
      y,
      `asking for y=${y} must land on y=${y}; it landed on ${first.scrollY}`,
    );
  }

  // And the collapse follows the scroll rather than the clock.
  assert.equal(readings[0].first.collapsed, false, "expanded at the top");
  assert.equal(readings.at(-1).first.collapsed, true, "collapsed at the bottom");
});

test("the reader can put the full cards back, and that costs no height either", async (t) => {
  if (!browser) return t.skip(browserReason);

  const CLICK = `(() => {
    document.querySelector(".live-job-metrics__toggle").click();
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const meters = document.querySelector(".live-job-metrics");
      resolve({
        pageHeight: document.documentElement.scrollHeight,
        scrollY: Math.round(window.scrollY),
        collapsed: meters.classList.contains("is-collapsed"),
        stuck: meters.classList.contains("is-stuck"),
        rail: document.querySelector(".live-board-page").getAttribute("data-jobs-rail"),
        height: Math.round(meters.getBoundingClientRect().height),
        top: Math.round(meters.getBoundingClientRect().top),
        sparklines: meters.querySelectorAll(".analytics-spark").length,
        sparklineDrawn: getComputedStyle(meters.querySelector(".analytics-spark")).display !== "none",
        boardBarTop: Math.round(
          document.querySelector(".mobile-board-bar")?.getBoundingClientRect().top ?? -1,
        ),
      });
    })));
  })()`;

  for (const [width, height, park] of [[1440, 900, 480], [390, 844, 6000]]) {
    await browser.viewport(width, height);
    await browser.go(JOBS, JOBS_READY);
    const collapsedProbe = `document.querySelector(".live-job-metrics").classList.contains("is-collapsed")`;
    await browser.scrollTo(park, collapsedProbe);
    const strip = await browser.evaluate(JOBS_PROBE);

    const opened = await browser.evaluate(CLICK);
    assert.equal(opened.collapsed, false, `${width}: pressing it restores the cards`);
    assert.equal(opened.stuck, true, `${width}: and they are still pinned where the strip was`);
    assert.equal(opened.top, strip.meters.top, `${width}: at the same line`);
    assert.ok(opened.height > strip.meters.height, `${width}: and they are taller than the strip`);
    assert.equal(opened.sparklines, 6, `${width}: with all six sparklines back in the DOM`);
    assert.equal(opened.sparklineDrawn, true, `${width}: and actually drawn`);
    assert.equal(
      opened.pageHeight,
      strip.pageHeight,
      `${width}: expanding must cost the document no height either`,
    );
    assert.equal(opened.scrollY, strip.scrollY, `${width}: and must not move the reader`);

    /*
     * The three-valued attribute. Treating "pinned but expanded" as "not
     * pinned" was a real defect on a phone: the board's identity bar snapped
     * back under the top bar and the cards, still pinned and still 141px tall,
     * drew straight over it.
     */
    assert.equal(opened.rail, "open", `${width}: the page must know it is pinned and open`);
    if (width <= 760) {
      assert.ok(
        opened.boardBarTop >= opened.top + opened.height,
        `390: the board bar sits at y${opened.boardBarTop}, under cards ending at y${opened.top + opened.height}`,
      );
    }

    const closed = await browser.evaluate(CLICK);
    assert.equal(closed.collapsed, true, `${width}: and pressing it again gives the strip back`);
    assert.equal(closed.rail, "on");
    assert.equal(closed.pageHeight, strip.pageHeight);
    assert.equal(closed.scrollY, strip.scrollY);
  }
});

test("1440: the grid keeps its height — the rejected fix left it 236px", async (t) => {
  if (!browser) return t.skip(browserReason);

  await browser.viewport(1440, 900);
  await browser.go(JOBS, JOBS_READY);
  const top = await browser.evaluate(JOBS_PROBE);
  await browser.scrollTo(
    480,
    `document.querySelector(".live-job-metrics").classList.contains("is-collapsed")`,
  );
  const bottom = await browser.evaluate(JOBS_PROBE);

  assert.ok(top.gridWindow.height >= 600, `the grid window is ${top.gridWindow.height}px`);
  assert.equal(
    bottom.gridWindow.height,
    top.gridWindow.height,
    "collapsing the meters must not change the grid's window either way",
  );
});

test("390: four sticky bars, in sequence, none of them overlapping", async (t) => {
  if (!browser) return t.skip(browserReason);

  await browser.viewport(390, 844);
  await browser.go(JOBS, JOBS_READY);

  const top = await browser.evaluate(JOBS_PROBE);
  assert.equal(top.collapsed, false);
  const before = top.pageHeight;

  await browser.scrollTo(
    6000,
    `document.querySelector(".live-job-metrics").classList.contains("is-collapsed")`,
  );
  const scrolled = await browser.evaluate(JOBS_PROBE);

  assert.equal(scrolled.collapsed, true);
  assert.equal(scrolled.pageHeight, before, "the phone's page must not change height either");
  assert.equal(scrolled.overflowX, 0, "no horizontal scrollbar at 390px");

  // Top bar, strip, board identity bar, board toolbar — in that order, with no
  // bar starting before the one above it has finished.
  const stack = [
    ["the top bar", scrolled.topbar],
    ["the meter strip", scrolled.meters],
    ["the board identity bar", scrolled.boardBar],
    ["the board toolbar", scrolled.boardToolbar],
  ];
  for (let index = 1; index < stack.length; index += 1) {
    const [name, box] = stack[index];
    const [above, previous] = stack[index - 1];
    assert.ok(
      box.top >= previous.bottom,
      `${name} starts at y${box.top}, above the bottom of ${above} at y${previous.bottom}`,
    );
  }

  // The way back to the full cards has to be tappable.
  assert.ok(
    scrolled.toggle && scrolled.toggle.height >= 44,
    `the strip's toggle is ${scrolled.toggle?.height ?? 0}px; the touch minimum is 44px`,
  );

  for (const figure of scrolled.figures) {
    assert.ok(figure.value.length > 0, `"${figure.label}" must still carry its figure`);
  }
});

test("390: the last of the 745 cards is still reachable", async (t) => {
  if (!browser) return t.skip(browserReason);

  await browser.viewport(390, 844);
  await browser.go(JOBS, JOBS_READY);

  /*
   * The whole card list, not a page of it. A naive flex chain clipped this in
   * earlier testing — the list rendered, the scroller did not grow with it, and
   * everything past the first screenful was unreachable — so the check is that
   * the LAST card can be brought fully into view below the sticky furniture.
   */
  const cards = await browser.evaluate(`document.querySelectorAll(".board-mobile__card").length`);
  assert.ok(cards > 700, `the phone list should hold the whole board, found ${cards} cards`);

  await browser.scrollTo(
    999999,
    `document.querySelector(".live-job-metrics").classList.contains("is-collapsed")`,
  );
  const last = await browser.evaluate(`(() => {
    const cards = document.querySelectorAll(".board-mobile__card");
    const card = cards[cards.length - 1];
    const rect = card.getBoundingClientRect();
    const toolbar = document.querySelector(".live-board-toolbar").getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      text: (card.textContent ?? "").trim().slice(0, 40),
      chromeBottom: Math.round(toolbar.bottom),
      viewport: window.innerHeight,
    };
  })()`);

  assert.ok(
    last.top >= last.chromeBottom,
    `the last card starts at y${last.top}, underneath the sticky furniture which ends at y${last.chromeBottom}`,
  );
  assert.ok(
    last.bottom <= last.viewport,
    `the last card ends at y${last.bottom}, below the ${last.viewport}px viewport`,
  );
  assert.ok(last.text.length > 0, "and it is a real card, with content");
});

test("the strip is readable in dark as well as light", async (t) => {
  if (!browser) return t.skip(browserReason);

  /*
   * Measured from the pixels the browser actually computes, not from the
   * tokens. stage-twentysix-contrast.test.mjs already proves the palette; what
   * this proves is that the strip USES it — that its ground is one of the
   * theme's surfaces and its ink one of the theme's inks, in both states.
   */
  const RATIO = `(() => {
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const luminance = (colour) => {
      const [r, g, b] = colour.match(/[\\d.]+/g).map(Number);
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const opaque = (element) => {
      let node = element;
      while (node) {
        const background = getComputedStyle(node).backgroundColor;
        if (background && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(background)) return background;
        node = node.parentElement;
      }
      return "rgb(255, 255, 255)";
    };
    const ratio = (fg, bg) => {
      const a = luminance(fg);
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const strip = document.querySelector(".live-job-metrics.is-collapsed");
    if (!strip) return null;
    const ground = opaque(strip);
    const out = [];
    for (const card of strip.querySelectorAll(".analytics-metric")) {
      for (const part of ["small", "strong"]) {
        const node = card.querySelector(part);
        out.push({
          what: (card.querySelector("small")?.textContent ?? "") + " " + part,
          ratio: Math.round(ratio(getComputedStyle(node).color, ground) * 100) / 100,
        });
      }
    }
    const toggle = strip.querySelector(".live-job-metrics__toggle");
    out.push({
      what: "toggle",
      ratio: Math.round(ratio(getComputedStyle(toggle).color, opaque(toggle)) * 100) / 100,
    });
    return out;
  })()`;

  for (const scheme of ["light", "dark"]) {
    await browser.theme(scheme);
    await browser.viewport(1440, 900);
    await browser.go(JOBS, JOBS_READY);
    await browser.scrollTo(
      480,
      `document.querySelector(".live-job-metrics").classList.contains("is-collapsed")`,
    );
    const measured = await browser.evaluate(RATIO);
    assert.ok(measured && measured.length === 13, `the strip must be collapsed in ${scheme}`);
    const failures = measured.filter((entry) => entry.ratio < 4.5);
    assert.deepEqual(
      failures,
      [],
      `below 4.5:1 in ${scheme}: ${failures.map((f) => `${f.what} ${f.ratio}:1`).join(", ")}`,
    );
  }
  await browser.theme("light");
});

test("Reports draws the layout control in the header, sized like its neighbours", async (t) => {
  if (!browser) return t.skip(browserReason);

  await browser.viewport(1440, 900);
  await browser.go("/dashboard/reports", REPORTS_READY);

  const measured = await browser.evaluate(`(() => {
    const shape = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        height: Math.round(element.getBoundingClientRect().height),
        minHeight: style.minHeight,
        padding: style.padding,
        radius: style.borderRadius,
        border: style.borderColor,
        background: style.backgroundColor,
      };
    };
    const bar = document.querySelector(".widget-bar");
    const toolbar = document.querySelector(".analytics-page-heading .analytics-toolbar");
    return {
      bars: document.querySelectorAll(".widget-bar").length,
      inHeader: Boolean(toolbar && bar && toolbar.contains(bar)),
      label: bar?.querySelector("button")?.textContent?.trim(),
      control: shape(bar?.querySelector("button")),
      exportButton: shape([...document.querySelectorAll(".analytics-toolbar > button")].pop()),
      exportLabel: [...document.querySelectorAll(".analytics-toolbar > button")].pop()?.textContent?.trim(),
      editorOpen: Boolean(document.querySelector(".widget-editor")),
      grids: document.querySelectorAll(".insight-grid").length,
    };
  })()`);

  assert.equal(measured.bars, 1, "there must be exactly one layout bar, not one in each place");
  assert.equal(measured.inHeader, true, "and it must be inside the page header's toolbar");
  assert.equal(measured.label, "Edit layout");
  assert.equal(measured.exportLabel, "Export spend");
  assert.deepEqual(
    measured.control,
    measured.exportButton,
    "the control must be the same shape as the control beside it",
  );
  assert.equal(measured.editorOpen, false, "the editor stays shut until it is asked for");
  assert.equal(measured.grids, 1, "and the panels themselves have not moved");

  // Pressing it still opens the panel editor, down where the panels are.
  const opened = await browser.evaluate(`(() => {
    document.querySelector(".widget-bar button").click();
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const editor = document.querySelector(".widget-editor");
      const toolbar = document.querySelector(".analytics-toolbar");
      resolve({
        open: Boolean(editor),
        inHeader: Boolean(editor && toolbar.contains(editor)),
        rows: editor ? editor.querySelectorAll("li").length : 0,
        label: document.querySelector(".widget-bar button").textContent.trim(),
      });
    })));
  })()`);
  assert.equal(opened.open, true, "the editor must still open");
  assert.equal(opened.inHeader, false, "it belongs with the panels, not in the header row");
  assert.equal(opened.rows, 5, "all five Reports panels are listed");
  assert.equal(opened.label, "Done");
});

test("Overview keeps its layout bar exactly where it was", async (t) => {
  if (!browser) return t.skip(browserReason);

  await browser.viewport(1440, 900);
  await browser.go("/dashboard", OVERVIEW_READY);

  const measured = await browser.evaluate(`(() => {
    const bar = document.querySelector(".widget-bar");
    const grid = document.querySelector(".insight-grid");
    const toolbar = document.querySelector(".analytics-toolbar");
    const documentTop = (element) => Math.round(element.getBoundingClientRect().top + window.scrollY);
    return {
      bars: document.querySelectorAll(".widget-bar").length,
      inToolbar: Boolean(bar && toolbar.contains(bar)),
      className: bar?.className,
      barTop: bar ? documentTop(bar) : null,
      gridTop: grid ? documentTop(grid) : null,
      slots: document.querySelectorAll(".analytics-toolbar__slot").length,
    };
  })()`);

  assert.equal(measured.bars, 1);
  assert.equal(measured.inToolbar, false, "Overview's bar must not have moved into the header");
  assert.equal(measured.className, "widget-bar", "and it must not pick up the header modifier");
  assert.ok(
    measured.barTop < measured.gridTop,
    "it sits above the panels it arranges, as it always did",
  );
  assert.equal(measured.slots, 0, "no slot is rendered on a surface that did not ask for one");
});
