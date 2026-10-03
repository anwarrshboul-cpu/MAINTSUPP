import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const hook = readFileSync("app/(app)/portal/use-notification-chime.ts", "utf8");
const portal = readFileSync("app/(app)/portal/portal-app.tsx", "utf8");

test("the chime file the hook names is shipped, and is small", () => {
  const src = hook.match(/NOTIFICATION_CHIME_SRC = "([^"]+)"/)?.[1];
  assert.ok(src, "the hook names its sound file");
  const file = `public${src}`;
  assert.ok(existsSync(file), `${file} must exist or the chime 404s silently`);
  assert.ok(statSync(file).size < 100_000, "a notification sound, not a track");
});

test("a first visit records what is unread and stays quiet", () => {
  assert.match(hook, /if \(seen === null \|\| mutedRef\.current\) return;\s+playChime\(\);/);
});

test("the chime waits for the read states, or everything would look unread", () => {
  assert.match(hook, /if \(!ready\) return;/);
  assert.match(portal, /setNotificationStatesLoaded\(true\)/);
  assert.match(portal, /useNotificationChime\(\s*unreadNotificationIds,\s*notificationStatesLoaded,\s*\)/);
});

test("the sound can be turned off from the panel", () => {
  assert.match(portal, /onToggleSound=\{notificationChime\.toggleMuted\}/);
  assert.match(portal, /\{soundMuted \? "Sound off" : "Sound on"\}/);
});
