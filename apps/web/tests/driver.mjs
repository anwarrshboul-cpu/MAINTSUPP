/**
 * A minimal browser driver over the Chrome DevTools Protocol.
 *
 * No Playwright, no Puppeteer — both pull a second browser binary into a
 * project whose runtime dependency list is deliberately short, and the job here
 * is "open a page, set a viewport, read the DOM", which CDP does directly over
 * a WebSocket Node already speaks. This mirrors `scripts/responsive-audit.mjs`,
 * which the legacy app has used for the same reason since Stage 15.
 *
 * It drives a REAL browser, so what it measures is what a person gets: computed
 * layout, parsed attributes, actual console errors — not a JSDOM approximation
 * that agrees with the source and disagrees with Chrome.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The touch minimum. 44px is the figure both Apple and WCAG 2.5.5 AAA use. */
export const TOUCH_MINIMUM = 44;

export async function launch({ port = 9500 } = {}) {
  const profile = mkdtempSync(path.join(tmpdir(), "maintsupp-web-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
  ]);

  let failed = null;
  chrome.on("error", (error) => { failed = error; });

  const socketUrl = await (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (failed) throw failed;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        return (await response.json()).webSocketDebuggerUrl;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("Chrome's debugging port never answered");
  })();

  const socket = new WebSocket(socketUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")));
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (const domain of ["Page", "Runtime", "Log"]) await send(`${domain}.enable`, {}, sessionId);

  const consoleErrors = [];
  listeners.add((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      consoleErrors.push(message.params.entry.text);
    }
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(message.params.exceptionDetails.text ?? "uncaught exception");
    }
  });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  };

  return {
    consoleErrors,

    async viewport(width, height = 844) {
      await send("Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 2, mobile: width < 768 }, sessionId);
    },

    /** Navigates and settles. Console errors are reset per navigation. */
    async goto(url, settleMs = 1500) {
      consoleErrors.length = 0;
      await send("Page.navigate", { url }, sessionId);
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    },

    evaluate,
    html: () => evaluate("document.documentElement.outerHTML"),
    text: () => evaluate("document.body.innerText.replace(/\\s+/g, ' ')"),
    path: () => evaluate("location.pathname"),

    /**
     * Fills an input the way React notices.
     *
     * Assigning `.value` directly does not fire React's synthetic change event —
     * React tracks the previous value on the DOM node and skips the update — so
     * a form filled that way submits empty. Going through the prototype setter
     * and dispatching `input` is what makes a controlled component see it.
     */
    async fill(selector, value) {
      return evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
    },

    async submit(selector = "form") {
      return evaluate(`(() => {
        const form = document.querySelector(${JSON.stringify(selector)});
        if (!form) return false;
        form.requestSubmit();
        return true;
      })()`);
    },

    /**
     * Layout facts a phone actually cares about.
     *
     * `targetRect` counts the whole activation area: for a checkbox or radio
     * wrapped in its own <label>, clicking the words toggles the control, so
     * the label IS the target. Measuring the bare 18px box reports a failure
     * that is not one.
     */
    async layout() {
      return JSON.parse(await evaluate(`(() => {
        const doc = document.documentElement;
        const targetRect = (el) => {
          const label = el.closest("label");
          return label && (el.type === "checkbox" || el.type === "radio")
            ? label.getBoundingClientRect()
            : el.getBoundingClientRect();
        };
        const small = [...document.querySelectorAll('a,button,input,select,textarea,[role="tab"]')]
          .filter((el) => {
            const r = targetRect(el);
            if (r.width === 0 && r.height === 0) return false;      // not rendered
            if (el.closest('[aria-hidden="true"]')) return false;   // honeypots
            return r.height < ${TOUCH_MINIMUM} || r.width < ${TOUCH_MINIMUM};
          })
          .map((el) => {
            const r = targetRect(el);
            const what = el.className || el.name || el.textContent.trim().slice(0, 20);
            return el.tagName + "." + what + " " + Math.round(r.width) + "x" + Math.round(r.height);
          });
        return JSON.stringify({
          overflow: doc.scrollWidth - doc.clientWidth,
          small,
          title: document.title,
        });
      })()`));
    },

    /** Every `autocomplete` as the BROWSER parsed it, not as the source wrote it. */
    async autocomplete() {
      return JSON.parse(await evaluate(`JSON.stringify(
        [...document.querySelectorAll("input")].map((el) => ({
          name: el.name || el.type, type: el.type,
          autocomplete: el.autocomplete,
          checked: el.type === "checkbox" ? el.checked : undefined,
        })))`));
    },

    async close() {
      try { await send("Target.closeTarget", { targetId }); } catch { /* already gone */ }
      socket.close();
      chrome.kill();
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    },
  };
}

/** Whether a URL is answering, so the suite can skip rather than fail noisily. */
export async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}
