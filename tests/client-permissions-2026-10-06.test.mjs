/**
 * The owner's rule (2026-10-06): "the majority of the settings should be only
 * for us, the owners or the admins". A client reads, exports and reports faults;
 * workspace configuration is MAINTSUPP's.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

test("a client's default capabilities stay read, export, report a fault and arrange their own sidebar", async () => {
  const permissions = await read("app/lib/permissions.ts");
  assert.match(permissions, /client: \["board\.view", "requests\.create", "data\.export", "navigation\.personalise"\]/);
});

test("scheduled report emails are configuration: settings.edit, not data.export", async () => {
  for (const file of ["app/api/reports/schedules/route.ts", "app/api/reports/schedules/run/route.ts"]) {
    const source = await read(file);
    assert.match(source, /scopedDbWithCapability\(request, "settings\.edit"\)/);
    assert.doesNotMatch(source, /scopedDbWithCapability\(request, "data\.export"\)/);
  }
});

test("the Settings screen's targets cannot be typed into without settings.edit", async () => {
  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /aria-label=\{`\$\{option\.value\} SLA`\}\s*disabled=\{!canEditSettings\}/);
  assert.match(app, /aria-label="Compliance warning window in days"\s*disabled=\{!canEditSettings\}/);
});
