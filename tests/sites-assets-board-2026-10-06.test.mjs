/**
 * Sites and Assets as grouped boards, one asset per site, and the site register
 * following monday's Store Documentation (owner's request, 2026-10-06).
 *
 * "The sites for Sunnamusk have to match exactly the number of the sites that
 * are on monday.com … the assets should be exactly also the same number and the
 * locations in the site … I should be able to move them … if I just hold the
 * mouse … the opens should be at the beginning then the close should be at the
 * bottom … it can be as a group … I can name this group London."
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isPlaceholderStore,
  siteIsClosed,
  siteUnitId,
  siteUnitValues,
} from "../app/lib/site-unit-values.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

const site = (overrides = {}) => ({
  id: "site-x",
  name: "Westfield Stratford",
  type: "Kiosk",
  siteTypeValue: "Kiosk",
  address: "Kiosk K29 First Floor Level Westfield Stratford City",
  addressLine1: "Kiosk K29 First Floor Level Westfield Stratford City",
  status: "active",
  active: true,
  position: 4,
  ...overrides,
});

test("a site's own asset is named, typed, located and ordered from the site", () => {
  assert.equal(siteUnitId("site-x"), "site-unit-site-x");
  assert.deepEqual(siteUnitValues(site()), {
    name: "Westfield Stratford — Kiosk",
    category: "Kiosk",
    locationInSite: "Kiosk K29 First Floor Level Westfield Stratford City",
    status: "Active",
    position: 4,
  });
});

test("a closed site's asset is Inactive, and an untyped site's asset is a Store", () => {
  assert.equal(siteUnitValues(site({ status: "closed", active: false })).status, "Inactive");
  assert.equal(siteIsClosed({ status: "active", active: false }), true);
  const untyped = siteUnitValues(site({ type: "", siteTypeValue: null, address: "", addressLine1: null }));
  assert.equal(untyped.category, "Store");
  assert.equal(untyped.locationInSite, null);
});

test("monday's empty placeholder row is not a store; a real store is", () => {
  assert.equal(isPlaceholderStore({ name: "Item 5", address: "" }), true);
  assert.equal(isPlaceholderStore({ name: "Item 5", address: "Unit 1, Somewhere" }), false);
  assert.equal(isPlaceholderStore({ name: "Merry Hill", address: "" }), false);
});

test("an edit made on the asset itself is kept when the site changes", async () => {
  const source = await read("app/lib/site-units.ts");
  assert.match(source, /if \(current !== copied\) continue;/);
  assert.match(source, /siteMirror: JSON\.stringify\(next\)/);
});

test("every path that writes a site brings its asset along", async () => {
  for (const file of [
    "app/api/sites/route.ts",
    "app/api/sites/csv/route.ts",
    "app/api/workspace/route.ts",
    "app/api/sites/groups/route.ts",
    "app/api/assets/route.ts",
  ]) {
    assert.match(await read(file), /reconcileSiteUnits(Quietly)?\(/, `${file} must reconcile site units`);
  }
  const store = await read("app/lib/store-register-sync.ts");
  assert.match(store, /result\.units = await reconcileSiteUnits\(db, organisationId\)/);
});

test("Store Documentation drives the register: monday changes flow in, portal edits stand", async () => {
  const source = await read("app/lib/store-register-sync.ts");
  assert.match(source, /before\.address !== store\.address/);
  assert.match(source, /before\.type !== store\.type/);
  assert.match(source, /const groupChanged = before\.group !== store\.group/);
  /* It never deletes a site. */
  assert.doesNotMatch(source, /\.delete\(sites\)/);
  const sync = await read("app/lib/monday-live-sync.ts");
  assert.match(sync, /reconcileStoreRegister\(db, orgId\)/);
  assert.match(sync, /reconcileStoreRegister\(db, config\.organisationId\)/);
});

test("Sites and Assets mount the one grouped board; dragging saves the whole order", async () => {
  const sites = await read("app/(app)/portal/ops/sites-list.tsx");
  const assets = await read("app/(app)/portal/assets/assets-list.tsx");
  for (const source of [sites, assets]) {
    assert.match(source, /<GroupedBoard/);
    assert.match(source, /"manual"/);
  }
  const board = await read("app/(app)/portal/register/grouped-board.tsx");
  assert.match(board, /draggable=\{canArrange/);
  /* open first, closed last, inside every group */
  assert.match(board, /\[\.\.\.rows\.filter\(\(row\) => !row\.closed\), \.\.\.rows\.filter\(\(row\) => row\.closed\)\]/);
  /* a phone cannot drag: the same moves are in the menu */
  assert.match(board, /Move up/);
  assert.match(board, /Move group up/);
  const groups = await read("app/api/sites/groups/route.ts");
  assert.match(groups, /export async function PUT/);
  const assetsApi = await read("app/api/assets/route.ts");
  assert.match(assetsApi, /export async function PUT/);
});

test("the seeded Closed group sits below the others in every workspace", async () => {
  const init = await read("db/init.ts");
  assert.match(init, /await ensureSiteUnitsAndGroupOrder\(d1\);/);
  const seed = init.slice(init.indexOf("export async function seedStoreDocumentationGroups"));
  assert.ok(seed.indexOf('["other", "Other"') < seed.indexOf('["closed", "Closed"'), "Other is seeded before Closed");
});
