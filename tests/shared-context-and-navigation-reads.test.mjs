/**
 * ONE REQUEST PER QUESTION, PER PAGE LOAD.
 *
 * The dashboard used to fetch `/api/context` twice and `/api/navigation` twice
 * on every load. Both duplications had the same shape: two callers, each
 * memoising its own read correctly, neither aware of the other. Measured cold
 * against production on 18 Sept 2026 — context 433ms and 298ms, navigation
 * 1,278ms and 1,178ms, for the same bytes both times.
 *
 * Nothing failed while that was true. The pages rendered, the tests passed, and
 * the only symptom was two seconds of duplicated waiting that nobody could see
 * without opening a waterfall. So these are source-level assertions: they fail
 * the moment a component reaches for the endpoint directly again, which is the
 * only way the duplicate comes back.
 */
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const portalApp = await readFile("app/(app)/portal/portal-app.tsx", "utf8");
const sidebarNav = await readFile("app/(app)/portal/sidebar-nav.tsx", "utf8");
const contextStore = await readFile("app/lib/runtime-context.ts", "utf8");
const navStore = await readFile("app/(app)/portal/navigation-store.ts", "utf8");
const capabilities = await readFile("app/lib/client-capabilities.ts", "utf8");

/** GET calls only. A POST to these endpoints is an action, not a read. */
function directGets(source, endpoint) {
  const calls = [...source.matchAll(/fetch\(\s*[`"']([^`"']+)[`"'][\s\S]{0,200}?\)/g)];
  return calls.filter(([whole, url]) => url.startsWith(endpoint) && !/method:\s*["'](POST|PUT|DELETE|PATCH)["']/.test(whole));
}

test("both stores memoise, and drop a rejected read rather than cache it", () => {
  for (const [name, source] of [["runtime-context", contextStore], ["navigation-store", navStore]]) {
    assert.match(source, /let pending: Promise<[^>]+> \| null = null;/, `${name} must hold one shared promise`);
    /* Without this, one failed read poisons the page until reload. */
    assert.match(source, /pending = null;\s*\n\s*throw error;/, `${name} must drop a rejected read`);
    assert.match(source, /options\?\.force/, `${name} must offer force, for writes and workspace switches`);
  }
});

test("nothing fetches /api/context for reading except the store", () => {
  assert.equal(directGets(portalApp, "/api/context").length, 0, "portal-app must read context through the store");
  assert.equal(directGets(capabilities, "/api/context").length, 0, "client-capabilities must read context through the store");
  assert.equal(directGets(contextStore, "/api/context").length, 1, "the store itself is the one reader");
});

test("nothing fetches /api/navigation for reading except the store", () => {
  assert.equal(directGets(portalApp, "/api/navigation").length, 0, "portal-app must read navigation through the store");
  assert.equal(directGets(sidebarNav, "/api/navigation").length, 0, "sidebar-nav must read navigation through the store");
  assert.equal(directGets(navStore, "/api/navigation").length, 1, "the store itself is the one reader");
});

test("the sidebar does not reintroduce ?sections=", () => {
  /*
   * The parameter only ever shaped `layout`, the pre-merged sidebar, which no
   * browser caller reads — `NavigationResponse` in sidebar-nav does not even
   * declare it. Sending it made two identical answers look like two different
   * questions, which is how the duplicate hid in plain sight.
   */
  assert.ok(!/api\/navigation\?sections=/.test(sidebarNav), "?sections= makes the shared read un-shareable");
  assert.ok(!/\blayout\b\s*[?:]/.test(sidebarNav.split("type NavigationResponse")[1]?.split("};")[0] ?? ""),
    "if the sidebar ever needs layout, it must fetch it deliberately rather than re-splitting this read");
});

test("the sidebar's loader has no dependencies, so mounting fetches once", () => {
  /*
   * It used to depend on `catalogueKeys`. portal-app finishing its sections
   * load changed the catalogue, which gave `load` a new identity, which re-ran
   * the mount effect — a second request for an answer that does not vary by
   * catalogue at all.
   */
  const loader = sidebarNav.split("const load = useCallback(")[1] ?? "";
  const deps = loader.match(/\}, \[([^\]]*)\]\);/);
  assert.ok(deps, "sidebar-nav must still define load as a useCallback");
  assert.equal(deps[1].trim(), "", "load must not depend on anything that changes after first paint");
});
