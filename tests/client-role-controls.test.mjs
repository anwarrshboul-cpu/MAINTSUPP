/**
 * QA on 2026-10-01, signed in as a Cloud Test client: the server refused every
 * write correctly, but the UI still offered a working "+ New" record form, an
 * Import tab, "Import data" and "Developers" in the avatar menu, and the topbar
 * Invite and Integrations links. Each is now offered only with its capability.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("controls a client cannot use are not offered to one", async () => {
  const manager = await read("app/(app)/portal/workspace-data-manager.tsx");
  assert.match(manager, /const readOnlyTab = tab === "activity" \|\| tab === "import" \|\| !canEdit;/);
  assert.match(manager, /tabs\.filter\(\(item\) => item\.key !== "import" \|\| canImport\)/);
  assert.match(manager, /tab === "import" && canImport \?/);

  const app = await read("app/(app)/portal/portal-app.tsx");
  assert.match(app, /canEdit=\{runtimeContext\?\.capabilities\?\.\["sites\.edit"\] !== false\}/);
  assert.match(app, /canImport=\{runtimeContext\?\.capabilities\?\.\["data\.import"\] !== false\}/);
  assert.match(app, /\["users\.invite"\] !== false \? \(\s*<Link[\s\S]{0,120}href="\/dashboard\/account\/invite"/);
  assert.match(app, /\["integrations\.manage"\] !== false \? \(\s*<Link[\s\S]{0,120}href="\/dashboard\/account\/integrations"/);

  const menu = await read("app/(app)/portal/account-menu.tsx");
  assert.match(menu, /useCapability\("data\.import"\)/);
  assert.match(menu, /item\.key !== "import" \|\| canImport !== false/);
  assert.match(menu, /item\.key !== "developers" \|\| canIntegrate !== false/);
});
