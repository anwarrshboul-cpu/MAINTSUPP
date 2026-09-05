/**
 * THE OUTBOUND EMAIL KILL SWITCH.
 *
 * The compliance cascade already exists and the calendar work ahead of it will
 * generate mail from seeded data. A preview deployment that inherited a live
 * Resend key would post that to whoever the seed happened to name — a real
 * store manager, a real contractor — and there would be no way to take it
 * back. `EMAIL_MODE` is the one place that can be stopped, because
 * `sendNotification` is the one place this product sends from.
 *
 * The assertion that matters most is the last one in the first test: an UNSET
 * variable must never mean `live`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("an unset EMAIL_MODE is never live", async () => {
  const source = codeOnly(await read("app/lib/notifications.ts"));
  const parser = source.slice(source.indexOf("function emailMode("));
  assert.match(
    parser.slice(0, 400),
    /return "sink";/,
    "the fallback must be the SAFE mode — a deployment that forgets the variable must stop mailing strangers, not start",
  );
  assert.doesNotMatch(
    parser.slice(0, 400),
    /return "live";/,
    "nothing may fall through to live",
  );
  /* Only the three words are accepted; a typo is not a third behaviour. */
  assert.match(parser.slice(0, 400), /raw === "live" \|\| raw === "sink" \|\| raw === "log"/);
});

test("log mode sends nothing at all", async () => {
  const source = codeOnly(await read("app/lib/notifications.ts"));
  const guard = source.indexOf('config.mode === "log"');
  assert.notEqual(guard, -1, "log must be handled");
  const deliver = source.indexOf("async function deliverEmail");
  const send = source.indexOf("export async function sendNotification");
  assert.ok(guard > send, "the guard belongs inside sendNotification");
  assert.ok(
    guard < source.indexOf("deliverEmail(config, request)"),
    "and it must return BEFORE the network call, not after it",
  );
  assert.ok(deliver >= 0);
  /* Recorded, not silently dropped — the row is what a test asserts on and
     what `/api/notifications/replay` would post once a deployment may. */
  assert.match(
    source.slice(guard, guard + 700),
    /status: "suppressed"/,
    "a suppressed send must still leave a log row",
  );
});

test("sink redirects the address and keeps the intended one visible", async () => {
  const source = codeOnly(await read("app/lib/notifications.ts"));
  const deliver = source.slice(source.indexOf("async function deliverEmail"));
  assert.match(deliver.slice(0, 1400), /const to = sinking \? config\.sink : request\.to;/);
  assert.match(
    deliver.slice(0, 1400),
    /Intended for: /,
    "a redirected test that hides who it was for proves the provider works and nothing about the addressing",
  );
  assert.match(
    deliver.slice(0, 1400),
    /escapeHtml\(request\.to\)/,
    "the intended address is untrusted text and is escaped like every other value in these templates",
  );
  assert.match(deliver.slice(0, 1400), /\[SINK\]/, "and the subject says so too");
  /* The real recipient must not survive into the request body. */
  assert.doesNotMatch(
    deliver.slice(0, 1600),
    /to: \[request\.to\]/,
    "the delivery call must use the resolved address, not the requested one",
  );
});

test("there is exactly one place this product sends email from", async () => {
  /*
   * The kill switch is only a kill switch if nothing routes around it. If a
   * second `api.resend.com` call appears under `app/`, this test is the thing
   * that says so.
   */
  const { readdir } = await import("node:fs/promises");
  const hits = [];
  async function walk(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(next);
      } else if (/\.tsx?$/.test(entry.name)) {
        const source = await read(next);
        if (/api\.resend\.com/.test(source)) hits.push(next);
      }
    }
  }
  await walk("app");
  assert.deepEqual(
    hits,
    ["app/lib/notifications.ts"],
    `email leaves this app from one file; found ${hits.length}: ${hits.join(", ")}`,
  );
});

test("the mode is reportable, so a deployment's state is visible rather than assumed", async () => {
  const source = await read("app/lib/notifications.ts");
  assert.match(
    source,
    /export function outboundEmailMode\(\): EmailMode/,
    "something must be able to ask which mode this deployment is in",
  );
});
