/**
 * Drives the local Chrome over CDP and measures every route at every breakpoint.
 *
 * No Playwright, no Puppeteer. Both would pull a second browser binary into a
 * project whose dependency list is five runtime packages, and the whole job
 * here is "open a page, set a viewport, read three numbers" — which the DevTools
 * protocol does directly over a WebSocket that Node already speaks.
 *
 * What it reports per route and width:
 *   overflow        scrollWidth - clientWidth on <html>, the horizontal scroll
 *   offenders       the elements whose right edge is past the viewport
 *   smallTargets    interactive elements under the 44px touch minimum
 *   consoleErrors   anything the page logged as an error
 *   failedRequests  requests that did not come back
 *
 * Usage:
 *   npm run dev
 *   node scripts/responsive-audit.mjs [--base http://localhost:5176] [--width 390]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};

const BASE = (flag("--base", "http://localhost:5176")).replace(/\/$/, "");
const ONLY_WIDTH = flag("--width", null);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const WIDTHS = ONLY_WIDTH ? [Number(ONLY_WIDTH)] : [390, 768, 1024, 1280, 1440];

/** The touch minimum. 44px is the figure both Apple and the WCAG 2.5.5 AAA use. */
const TOUCH_MINIMUM = 44;

/*
 * The real routes, taken from app/(app) and the navigation catalogue.
 *
 * The dashboard is one optional catch-all — /dashboard/[[...section]] — and an
 * unrecognised slug falls back to the OVERVIEW rather than 404ing. That makes a
 * wrong list actively deceptive: it measures a real, clean page under the wrong
 * name. Two versions of this list were wrong before this one. Ten invented
 * /portal/* paths measured clean while logging a 404 each; then the section
 * KEYS were used as slugs, and `sectionRoutes` maps several of them elsewhere —
 * maintenance lives at /jobs, calendar at /planned, stores at /sites — so the
 * overview was silently measured three times over and the board, the heaviest
 * page in the app, was never measured at all.
 *
 * These are the values of `sectionRoutes` in portal-app.tsx. Check against it
 * when a section is added.
 */
const ROUTES = [
  "/",
  "/faqs",
  "/privacy",
  "/terms",
  "/login",
  "/portal",
  "/request",
  "/dashboard",
  "/dashboard/jobs",
  "/dashboard/planned",
  "/dashboard/units",
  "/dashboard/sites",
  "/dashboard/store-documentation",
  "/dashboard/contractors",
  "/dashboard/compliance",
  "/dashboard/documents",
  "/dashboard/reports",
  "/dashboard/settings",
  "/dashboard/team",
  // Nested, per `sectionRoutes`: admin-users -> "admin", admin-roles ->
  // "admin/roles", admin-clients -> "admin/clients". Written as the section
  // KEYS in an earlier version, which silently measured the overview three
  // more times — the third time this list has drifted, which is why the
  // comment above says to check it against sectionRoutes.
  "/dashboard/admin",
  "/dashboard/admin/roles",
  "/dashboard/admin/clients",
  "/cookies",
  "/dashboard/audit",
  "/dashboard/teams",
  "/dashboard/account",
];

const profile = mkdtempSync(path.join(tmpdir(), "maintsupp-audit-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=9222",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
]);
chrome.on("error", (error) => {
  console.error("Could not start Chrome:", error.message);
  process.exit(1);
});

/** Chrome needs a moment before its debugging port answers. */
async function debuggerUrl() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:9222/json/version");
      const body = await response.json();
      return body.webSocketDebuggerUrl;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Chrome's debugging port never answered.");
}

const socketUrl = await debuggerUrl();

/*
 * A minimal CDP client.
 *
 * Every command is id-tagged and resolved from one message handler; events
 * arrive without an id and are pushed to whoever is listening. That is the
 * whole protocol, and it is why this file has no dependencies.
 */
function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")));
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
  };
}

const cdp = connect(socketUrl);
await cdp.ready;

const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Runtime.enable", {}, sessionId);
await cdp.send("Log.enable", {}, sessionId);
await cdp.send("Network.enable", {}, sessionId);

/*
 * Sign in before measuring.
 *
 * An anonymous browser gets the demo shell, and the demo shell is not the
 * screen anyone is asking about: it draws fewer rows, no admin sections and no
 * account menu, so a layout audit against it measures a page the operator
 * never sees. The session is obtained over the API and injected as a cookie
 * rather than typed into the form, because a failed form fill would silently
 * degrade to auditing the signed-out shell again.
 */
const EMAIL = process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com";
const PASSWORD = process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026";

const signIn = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!signIn.ok) {
  console.error(`Sign-in failed (${signIn.status}). Is the dev server on ${BASE}?`);
  chrome.kill();
  process.exit(1);
}
for (const raw of signIn.headers.getSetCookie?.() ?? []) {
  const [pair] = raw.split(";");
  const index = pair.indexOf("=");
  await cdp.send(
    "Network.setCookie",
    {
      name: pair.slice(0, index).trim(),
      value: pair.slice(index + 1).trim(),
      domain: new URL(BASE).hostname,
      path: "/",
    },
    sessionId,
  );
}

let consoleErrors = [];
let failedRequests = [];
cdp.on((message) => {
  if (message.sessionId !== sessionId) return;
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    consoleErrors.push(message.params.entry.text.slice(0, 200));
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(
      (message.params.exceptionDetails.exception?.description ?? "exception").slice(0, 200),
    );
  }
  if (message.method === "Network.loadingFailed") {
    failedRequests.push(`${message.params.type}: ${message.params.errorText}`);
  }
});

/**
 * Read after the page settles.
 *
 * `documentElement.scrollWidth` past its `clientWidth` IS the horizontal
 * scrollbar — the thing that makes a phone layout feel broken. The offenders
 * list exists because the number alone never says which element did it.
 */
const MEASURE = `(() => {
  const root = document.documentElement;
  const overflow = root.scrollWidth - root.clientWidth;
  const viewport = root.clientWidth;

  const offenders = [];
  const smallTargets = [];
  for (const element of document.querySelectorAll("*")) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;

    if (box.right > viewport + 1) {
      const style = getComputedStyle(element);
      if (style.position === "fixed") continue;
      offenders.push({
        selector: element.tagName.toLowerCase() +
          (element.className && typeof element.className === "string"
            ? "." + element.className.trim().split(/\\s+/).slice(0, 2).join(".")
            : ""),
        right: Math.round(box.right),
        width: Math.round(box.width),
      });
    }

    if (element.matches("button, a[href], input, select, [role=button], [role=tab]")) {
      // A control inside a scrolling row can be narrow and still reachable, so
      // height is what is judged: it is the axis a thumb actually misses.
      if (box.height > 0 && box.height < ${TOUCH_MINIMUM} - 0.5) {
        smallTargets.push({
          selector: element.tagName.toLowerCase() +
            (element.className && typeof element.className === "string"
              ? "." + element.className.trim().split(/\\s+/).slice(0, 2).join(".")
              : ""),
          height: Math.round(box.height * 10) / 10,
          label: (element.textContent ?? "").trim().slice(0, 30),
        });
      }
    }
  }

  const seen = new Set();
  const unique = (list, key) => list.filter((entry) => {
    if (seen.has(key(entry))) return false;
    seen.add(key(entry));
    return true;
  });

  return {
    overflow,
    viewport,
    title: document.title,
    offenders: offenders.sort((a, b) => b.right - a.right).slice(0, 6),
    smallTargets: unique(smallTargets, (t) => t.selector + "|" + t.label).slice(0, 8),
    smallTargetCount: smallTargets.length,
  };
})()`;

const results = [];

for (const width of WIDTHS) {
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 },
    sessionId,
  );

  for (const route of ROUTES) {
    consoleErrors = [];
    failedRequests = [];

    await cdp.send("Page.navigate", { url: `${BASE}${route}` }, sessionId);
    // The board fetches after paint, so a load event is not the whole story.
    await new Promise((resolve) => setTimeout(resolve, 1800));

    const { result } = await cdp.send(
      "Runtime.evaluate",
      { expression: MEASURE, returnByValue: true, awaitPromise: false },
      sessionId,
    );

    results.push({
      route,
      width,
      ...result.value,
      consoleErrors: [...new Set(consoleErrors)].slice(0, 4),
      failedRequests: [...new Set(failedRequests)].slice(0, 4),
    });
  }
}

cdp.close();
chrome.kill();

/*
 * Cleanup must never lose the results.
 *
 * Chrome keeps writing its profile for a moment after the kill signal, so an
 * immediate `rmSync` throws ENOTEMPTY — and it sits above the reporting, so a
 * failed tidy-up threw away a completed audit. Wait briefly, then treat any
 * remaining failure as a temp directory the OS can collect.
 */
await new Promise((resolve) => setTimeout(resolve, 500));
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // A leftover profile in the system temp directory is not worth a failure.
}

const overflowing = results.filter((row) => row.overflow > 0);
const withErrors = results.filter((row) => row.consoleErrors.length);
const withFailures = results.filter((row) => row.failedRequests.length);
const withSmall = results.filter((row) => row.smallTargetCount > 0);

console.log(`${results.length} route/width combinations\n`);

console.log(`horizontal overflow : ${overflowing.length}`);
for (const row of overflowing) {
  console.log(`  ${String(row.width).padStart(4)}px ${row.route} — ${row.overflow}px`);
  for (const offender of row.offenders) {
    console.log(`         ${offender.selector} right=${offender.right} width=${offender.width}`);
  }
}

console.log(`\nconsole errors      : ${withErrors.length}`);
for (const row of withErrors) {
  console.log(`  ${String(row.width).padStart(4)}px ${row.route}`);
  for (const error of row.consoleErrors) console.log(`         ${error}`);
}

console.log(`\nfailed requests     : ${withFailures.length}`);
for (const row of withFailures) {
  console.log(`  ${String(row.width).padStart(4)}px ${row.route}`);
  for (const failure of row.failedRequests) console.log(`         ${failure}`);
}

console.log(`\ntouch targets under ${TOUCH_MINIMUM}px (390px only):`);
for (const row of withSmall.filter((entry) => entry.width === 390)) {
  console.log(`  ${row.route} — ${row.smallTargetCount}`);
  for (const target of row.smallTargets) {
    console.log(`         ${target.height}px  ${target.selector}  "${target.label}"`);
  }
}

process.exitCode = overflowing.length || withErrors.length ? 1 : 0;
