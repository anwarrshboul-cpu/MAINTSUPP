/**
 * The MAINTSUPP app without an app store (2026-10-04): maintsupp.com installs
 * from /app, and notifies through Web Push. These pins hold the contracts that
 * would fail silently — an app that quietly stops being installable, a service
 * worker that starts caching portal data, a notification that carries a job
 * link's secret.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the manifest makes an installable, branded app that opens on /app", async () => {
  const manifest = JSON.parse(await read("public/manifest.webmanifest"));
  assert.equal(manifest.name, "MAINTSUPP");
  assert.equal(manifest.display, "standalone");
  assert.match(manifest.start_url, /^\/app/);
  assert.equal(manifest.scope, "/");
  const sizes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
  for (const needed of ["192x192:any", "512x512:any", "512x512:maskable"]) {
    assert.ok(sizes.includes(needed), `icon ${needed}`);
  }
  for (const icon of manifest.icons) {
    await readFile(new URL(`../public${icon.src}`, import.meta.url));
  }
});

test("every page links the manifest and registers the service worker", async () => {
  const layout = await read("app/layout.tsx");
  assert.match(layout, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
  assert.match(layout, /apple-mobile-web-app-capable/);
  assert.match(layout, /<PwaRegister \/>/);
  const register = await read("app/pwa-register.tsx");
  assert.match(register, /serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
});

test("the service worker caches nothing the portal reads", async () => {
  const sw = await read("public/sw.js");
  assert.doesNotMatch(sw, /cache\.put|cache\.add|caches\.open/, "no page or API response is stored");
  assert.match(sw, /request\.mode !== "navigate"/, "only page loads get the offline screen");
  assert.match(sw, /target\.origin !== self\.location\.origin/, "a notification only opens our own pages");
});

test("a contractor's notification names the job, never its link", async () => {
  const notify = await read("app/lib/push-notify.ts");
  assert.match(notify, /const contractorUrl = \(job: Job\) => `\/app\?ref=\$\{encodeURIComponent\(job\.id\)\}`/);
  assert.doesNotMatch(notify, /\/j\/\$\{/, "no job-link token in any payload");
});

test("recipients are re-checked when a notification is sent", async () => {
  const notify = await read("app/lib/push-notify.ts");
  assert.match(notify, /if \(member\.status !== "active"\) return false;/, "a removed member hears nothing");
  assert.match(notify, /scope && job && !\(job\.siteId && scope\.includes\(job\.siteId\)\)/, "site scope holds");
  assert.match(notify, /!token\.revokedAt && new Date\(token\.expiresAt\)\.getTime\(\) >= now/, "dead links hear nothing");
});

test("a contractor subscribes only through a job link that still opens", async () => {
  const route = await read("app/api/push/route.ts");
  assert.match(route, /const scope = await resolveJobToken\(db, token\);\s*if \(!scope\) continue;/);
});

test("an alert while the app is open plays the MAINTSUPP sound, and respects mute", async () => {
  const sw = await read("public/sw.js");
  assert.match(sw, /client\.postMessage\(\{ type: "maintsupp-alert" \}\)/);
  const register = await read("app/pwa-register.tsx");
  assert.match(register, /new Audio\("\/assets\/sounds\/maintsupp-notification\.mp3"\)/);
  assert.match(register, /"maintsupp:chime:muted"/, "the portal bell's mute switch is honoured");
  await readFile(new URL("../public/assets/sounds/maintsupp-notification.mp3", import.meta.url));
});

test("alerts are on by default once a phone has allowed them, off only by choice", async () => {
  const client = await read("app/lib/push-client.ts");
  assert.match(client, /if \(alertSupport\(\) !== "ready" \|\| alertsTurnedOff\(\)\) return false;\s*if \(Notification\.permission !== "granted"\) return false;/);
  const prompt = await read("app/(app)/portal/alerts-prompt.tsx");
  assert.match(prompt, /await keepAlertsOn\(\);/);
  const page = await read("app/(app)/dashboard/[[...section]]/page.tsx");
  assert.match(page, /<AlertsPrompt \/>/);
});

test("Keep me signed in is on by default and only ever shortens the cookie", async () => {
  const session = await read("app/lib/auth-session.ts");
  assert.match(session, /if \(options\.remember === false\) \{\s*return `\$\{SESSION_COOKIE\}=\$\{encodeURIComponent\(token\)\}; Path=\/; HttpOnly; SameSite=Lax\$\{secure\}`;/);
  const form = await read("app/(app)/login/sign-in-form.tsx");
  assert.match(form, /const \[remember, setRemember\] = useState\(true\);/);
  assert.doesNotMatch(form, /localStorage\.setItem\([^)]*password/i, "the password is never remembered");
});

test("inside WhatsApp and similar, the install page offers to open a real browser", async () => {
  const page = await read("app/(public)/app/app-home.tsx");
  assert.match(page, /\[\/WhatsApp\/i, "WhatsApp"\]/);
  assert.match(page, /intent:\/\/maintsupp\.com\/app#Intent;scheme=https;package=com\.android\.chrome;end/);
});

test("the portal sign-in page offers the app download", async () => {
  const form = await readFile(new URL("../app/(app)/login/sign-in-form.tsx", import.meta.url), "utf8");
  assert.match(form, /<a className="login-form__download" href="\/app">[\s\S]*?Download the app/);
});
