/**
 * Stage 28 — the landing page rebuild, checked against the brief's own audit.
 *
 * The brief ends with a six-point audit to run before finishing. This file is
 * that audit, written down so it runs on every commit rather than once. Its
 * source assertions read the components; its live assertions drive a real
 * browser and skip when nothing is listening on the dev server.
 *
 * WHY A SEPARATE FILE. `stage-eleven-marketing` covers the porting rules that
 * predate the rebuild — no iframe, copy ported not rewritten, legal pages
 * reachable. Those are still true and still worth holding. What is here is the
 * new contract: ten sections, four validated behaviours and the anchors that
 * tie them together.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/* ── 1. Ten sections, each exactly once ──────────────────────────────────── */

/** The ten, by the anchor each one owns. Section 10 is a band plus a panel. */
const ANCHORS = [
  "hero",
  "report",
  "sectors",
  "services",
  "problem",
  "how",
  "pricing",
  "case-study",
  "portal",
  "trust",
  "review",
];

test("the page is ten sections and no more", async () => {
  const page = await read("app/(marketing)/page.tsx");
  const rendered = [...page.slice(page.indexOf("HomePage")).matchAll(/<([A-Z][A-Za-z]*)\s*\/>/g)];
  assert.equal(rendered.length, 11, "ten sections; section 10 is two components");
});

/* ── 2. Copy rules ───────────────────────────────────────────────────────── */

test("the forbidden claims appear nowhere on the marketing site", async () => {
  /*
   * The brief lists six phrases that must never be used, and the reason is not
   * squeamishness: Maintsupp does not employ engineers, so "our engineers" is a
   * statement a client could hold them to. Checked across every section, the
   * legal pages and the shared copy — a rule enforced in one file is a rule
   * that moves to another file.
   */
  const forbidden = [
    /\bour engineers\b/i,
    /\bour nationwide team\b/i,
    /24\/7 coverage/i,
    /guaranteed same-day fix/i,
    /100% first-time fix/i,
    /\bwe certify\b/i,
  ];
  const dir = path.join(root, "app/(marketing)");
  const offenders = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|ts)$/.test(entry.name)) {
        const source = readFileSync(full);
        for (const pattern of forbidden) {
          if (pattern.test(source)) {
            offenders.push(`${path.relative(root, full)} — ${pattern}`);
          }
        }
      }
    }
  };
  const { readFileSync } = await import("node:fs");
  walk(dir);
  assert.deepEqual(offenders, [], "the brief forbids these phrases");
});

test("every price is shown + VAT", async () => {
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  // Each of the four money figures outside the tier cards carries it inline;
  // the per-store figures carry it in the shared price line.
  assert.match(pricing, /\+ VAT/, "the price line must say + VAT");
  for (const figure of ["£295/month", "£65 each", "£125 per incident", "£25/store"]) {
    const at = pricing.indexOf(figure);
    assert.ok(at > 0, `${figure} is missing`);
    assert.match(
      pricing.slice(at, at + 60),
      /\+ VAT/,
      `${figure} must be followed by "+ VAT"`,
    );
  }
});

test("the Total Care saving is derived from the prices above it", async () => {
  /*
   * "Most popular — save £20 per store" is true at both numbered bands, and it
   * is computed rather than typed so it cannot come to contradict the cards.
   * The arithmetic is checked here against the same table the component uses.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  const bands = [...pricing.matchAll(
    /coordination: (\d+), compliance: (\d+), total: (\d+)/g,
  )].map(([, coordination, compliance, total]) => ({
    coordination: Number(coordination),
    compliance: Number(compliance),
    total: Number(total),
  }));

  /*
   * Three numbered bands now, not two: 26+ used to be a "Custom" card with a
   * button and carries a published rate. The approved figures, pinned here so
   * a price cannot drift silently — they are quoted to clients.
   */
  assert.deepEqual(bands, [
    { coordination: 65, compliance: 55, total: 100 },
    { coordination: 58, compliance: 48, total: 88 },
    { coordination: 52, compliance: 42, total: 78 },
  ]);

  /* The badge claims a saving per band; each band's cards must produce it. */
  assert.deepEqual(
    bands.map((band) => band.coordination + band.compliance - band.total),
    [20, 18, 16],
  );
  assert.match(pricing, /save £\{saving\} per store/, "the badge must read the computed figure");
  assert.match(
    pricing,
    /const saving = band\.coordination \+ band\.compliance - band\.total/,
    "and must derive it from the band on screen rather than a typed number",
  );
});

test("the store count drives the band, the rate and the monthly total", async () => {
  /*
   * The calculator is the section's one input. If any of these stops being
   * derived, the page can show a reader a rate their own store count does not
   * qualify for — which is worse than showing no calculator at all.
   */
  const pricing = await read("app/(marketing)/_sections/pricing.tsx");
  assert.match(pricing, /type="range"/, "there is a real slider, not a band picker alone");
  assert.match(pricing, /function bandForCount/, "the band is computed from the count");
  assert.match(
    pricing,
    /amount \* storeCount/,
    "the monthly total is rate x count, not a typed figure",
  );
  /* The struck-through price is the entry band's, so it cannot contradict it. */
  assert.match(pricing, /was=\{entryBand\[plan\.key\]\}/);
  assert.match(pricing, /was > amount/, "and only shows once the reader is past that band");
});

/* ── 3. The Report a Job form ────────────────────────────────────────────── */

test("the form asks the brief's eleven questions, in order", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  const order = [
    "rjSite",
    "rjName",
    "rjPhone",
    "rjEmail",
    "rjAddress",
    "rjPostcode",
    "rjCategory",
    "rjUrgency",
    "rjDesc",
    "rjUpload",
    "rjAccess",
  ];
  const positions = order.map((id) => ({ id, at: form.indexOf(`id="${id}"`) }));
  for (const { id, at } of positions) assert.ok(at > 0, `${id} is missing from the form`);
  const sorted = [...positions].sort((a, b) => a.at - b.at).map((entry) => entry.id);
  assert.deepEqual(sorted, order, "the fields must appear in the brief's order");
});

test("the eight required fields are validated, and the three optional ones are not", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  const checks = form.slice(form.indexOf("const CHECKS"), form.indexOf("type FieldValue"));
  for (const id of [
    "rjSite",
    "rjName",
    "rjPhone",
    "rjEmail",
    "rjAddress",
    "rjPostcode",
    "rjCategory",
    "rjUrgency",
  ]) {
    assert.match(checks, new RegExp(`"${id}"`), `${id} must be required`);
  }
  for (const id of ["rjDesc", "rjAccess"]) {
    assert.doesNotMatch(checks, new RegExp(`"${id}"`), `${id} is optional in the brief`);
  }
});

test("every invalid field is reported at once, not one at a time", async () => {
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  assert.match(
    form,
    /const \[errors, setErrors\] = useState<Record<string, string>>\(\{\}\)/,
    "a map, not a single field — the brief asks for an error on every one",
  );
  assert.match(form, /const found: Record<string, string> = \{\};/);
  assert.match(form, /if \(message\) found\[name\] = message;/, "collect, do not return early");
  assert.match(form, /scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
  assert.match(form, /focus\(\{ preventScroll: true \}\)/, "scroll first, then focus");
});

test("the priority and engineer values the form sends exist on the board", async () => {
  /*
   * THE BUG THIS REPLACES. The old form sent `"High"` for a trading-impaired
   * fault and `"HVAC"` / `"Plumber"` / `"Specialist"` for three of its five
   * categories. None of those four are in the board's option sets, and
   * `configuredValue` silently substitutes the default rather than refusing —
   * so the second-most-urgent report a store can make arrived at the bottom of
   * the pile, and nobody could see why.
   */
  const form = await read("app/(marketing)/_sections/report-job.tsx");
  const spec = await read("db/monday-board-spec.ts");

  const priorities = new Set(
    [...spec.slice(spec.indexOf("priority: [")).slice(0, 200).matchAll(/opt\("([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );
  const engineers = new Set(
    [
      ...spec
        .slice(spec.indexOf("engineer_required: ["))
        .slice(0, 260)
        .matchAll(/opt\("([^"]+)"/g),
    ].map((match) => match[1]),
  );
  assert.ok(priorities.size >= 3 && engineers.size >= 4, "board spec moved; fix this test");

  for (const [, value] of form.matchAll(/priority: "([^"]+)"/g)) {
    assert.ok(priorities.has(value), `priority "${value}" is not on the board`);
  }
  for (const [, value] of form.matchAll(/engineer: "([^"]+)"/g)) {
    assert.ok(engineers.has(value), `engineer "${value}" is not on the board`);
  }
});

/* ── 4. Chrome ───────────────────────────────────────────────────────────── */

test("Portal Login is the name everywhere, and it points at the portal", async () => {
  /*
   * Read with the explanations stripped. The comment beside the header link
   * says why it is not called "Client Login", so a raw search finds the phrase
   * being ruled out and fails on the sentence that rules it out.
   */
  const chrome = (await read("app/(marketing)/_sections/chrome.tsx"))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const hits = [...chrome.matchAll(/Portal Login/g)];
  assert.ok(hits.length >= 3, `expected it in the utility bar, header and footer; found ${hits.length}`);
  assert.match(chrome, /href="\/portal"/);
  assert.doesNotMatch(chrome, /Client Login/, "the brief names it Portal Login for a reason");
});

test("every nav anchor names a section that exists", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  const nav = chrome.slice(chrome.indexOf("const NAV = ["), chrome.indexOf("] as const;"));
  const targets = [...nav.matchAll(/\["#([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length >= 4, "the brief lists four in-page destinations");
  for (const target of targets) {
    assert.ok(ANCHORS.includes(target), `#${target} has no section`);
  }
});

test("the footer carries the legal line verbatim", async () => {
  const chrome = await read("app/(marketing)/_sections/chrome.tsx");
  for (const fragment of [
    "Maintsupp is a trading name of Maintauk Ltd",
    "company no. 17262302",
    "C/O MJR Accounting & Tax Services",
    "One Canada Square, London, E14 5AA",
  ]) {
    assert.ok(
      chrome.replace(/&amp;/g, "&").includes(fragment),
      `the legal line is missing: ${fragment}`,
    );
  }
});

/* ── 5. Live, in a real browser ──────────────────────────────────────────── */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function openBrowser(width, height) {
  const profile = mkdtempSync(path.join(tmpdir(), "maintsupp-stage28-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=9343",
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
      socketUrl = (await (await fetch("http://127.0.0.1:9343/json/version")).json())
        .webSocketDebuggerUrl;
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
  const consoleErrors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(String(message.params.args?.[0]?.value ?? "error"));
    }
    if (message.method === "Runtime.exceptionThrown") consoleErrors.push("uncaught exception");
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
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: width < 768 },
    sessionId,
  );

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

  await send("Page.navigate", { url: `${BASE_URL}/` }, sessionId);
  for (let attempt = 0; attempt < 140; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await evaluate(`Boolean(document.querySelector("#rjForm"))`)) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 900));

  return {
    evaluate,
    consoleErrors,
    close() {
      socket.close();
      chrome.kill();
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* the profile is a temp dir; a locked file is not worth failing over */
      }
    },
  };
}

test("live: the ten sections are on the page, once each, with no duplicate heading", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const browser = await openBrowser(1440, 900);
  if (!browser) {
    t.skip("Chrome is not available");
    return;
  }
  try {
    const found = await browser.evaluate(`(() => {
      const main = document.querySelector("main#top");
      const ids = [...main.querySelectorAll(":scope > section")].map(s => s.id);
      const h2 = [...main.querySelectorAll("h2")].map(h => h.textContent.trim());
      return { ids, h1: main.querySelectorAll("h1").length, dupes: h2.filter((h,i) => h2.indexOf(h) !== i) };
    })()`);
    assert.deepEqual(found.ids, ANCHORS, "the sections, in the brief's order");
    assert.equal(found.h1, 1, "one h1 on the page");
    assert.deepEqual(found.dupes, [], "a repeated heading means a section is drawn twice");
    assert.deepEqual(browser.consoleErrors, []);
  } finally {
    browser.close();
  }
});

test("live: an empty Report a Job cannot be submitted", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  const browser = await openBrowser(1440, 900);
  if (!browser) {
    t.skip("Chrome is not available");
    return;
  }
  try {
    await browser.evaluate(
      `document.querySelector("#rjForm button[type=submit]").click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const state = await browser.evaluate(`(() => {
      const form = document.querySelector("#rjForm");
      const shown = [...form.querySelectorAll(".field__err")].filter(p => !p.hidden && p.textContent.trim());
      const invalid = [...form.querySelectorAll(".is-invalid")];
      const red = invalid.map(el => {
        const control = el.tagName === "FIELDSET"
          ? el.querySelector(".chipgroup label")
          : el.querySelector("input,select,textarea");
        return control ? getComputedStyle(control).borderColor : null;
      });
      return { shown: shown.length, invalid: invalid.length, red: [...new Set(red)] };
    })()`);

    assert.equal(state.shown, 8, "an inline message on every one of the eight");
    assert.equal(state.invalid, 8, "and a red outline on every one");
    assert.equal(state.red.length, 1, `every invalid control takes the same red; got ${state.red}`);
    assert.match(state.red[0], /^rgb\(/, "the outline must be a real computed colour");
    assert.deepEqual(browser.consoleErrors, []);
  } finally {
    browser.close();
  }
});

test("live: every in-page anchor lands on something, at both widths", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no dev server on ${BASE_URL}`);
    return;
  }
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    const browser = await openBrowser(width, height);
    if (!browser) {
      t.skip("Chrome is not available");
      return;
    }
    try {
      const result = await browser.evaluate(`(() => {
        const hrefs = [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute("href"));
        return {
          missing: [...new Set(hrefs)].filter(h => h !== "#" && !document.querySelector(h)),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          brokenImages: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
        };
      })()`);
      assert.deepEqual(result.missing, [], `dead anchors at ${width}px`);
      assert.equal(result.overflow, 0, `${width}px scrolls sideways by ${result.overflow}px`);
      assert.equal(result.brokenImages, 0, `broken images at ${width}px`);
    } finally {
      browser.close();
    }
  }
});
