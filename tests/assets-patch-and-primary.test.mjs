/**
 * TWO DEFECTS THAT SHIPPED PAST A GREEN SUITE, PINNED.
 *
 * Both were found by an independent review driving the running server, and
 * neither could have been caught by the suite as it stood — which is the point
 * of this file. The Assets live suite sent PARTIAL `PATCH` bodies, destroyed
 * fields it had created four lines earlier, and asserted nothing about them, so
 * the data loss passed green.
 *
 * ── 1. `PATCH` WAS A WHOLE-RECORD REPLACE ──────────────────────────────────
 *
 * Every column was written from a payload coerced over the whole body whether
 * or not the caller had mentioned it. Two consequences, both live:
 *
 *   · The files panel's "Make primary" sends `{ primaryImageId }` and nothing
 *     else. The route found no `name` in it and answered
 *     400 "Give the asset a name." for an asset that plainly had one, so the
 *     feature could not be used at all.
 *   · The edit form carries neither `primaryImageId` (set from the files
 *     panel) nor `nextServiceDueAt` (derived from a service event), so an
 *     ordinary save nulled both — destroying the thumbnail and the date the
 *     product had just worked out for itself.
 *
 * An absent key now means UNCHANGED. That is a contract, not an implementation
 * detail, so the tests below assert it field group by field group rather than
 * once: the failure mode was one column at a time.
 *
 * ── 2. THE PRIMARY IMAGE ───────────────────────────────────────────────────
 *
 * `primary_image_id` is a single column, so "only one primary" is structural
 * rather than something code has to maintain — and that is worth pinning, both
 * because a future change to a join table would silently break it and because
 * the ISOLATION around it is not structural at all: the id is checked against
 * the asset's own files, and without that check a row's thumbnail could be
 * pointed at any document in the workspace and rendered inline to everyone who
 * can open the asset.
 *
 * Skips rather than fails when no development server answers, as the ~30 other
 * live suites here do. Fixtures are run-scoped and swept at the end.
 */

import assert from "node:assert/strict";
import test from "node:test";

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: "owner@maintsupp.com", password: "Sunnamusk-Owner-2026" };
const PREFIX = `ZZQA-PATCH-${crypto.randomUUID().slice(0, 8)}`;

let cookie = "";

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* A bare-text refusal. `text` is the payload either way. */
  }
  return { status: response.status, json, text };
}

/** The upload path, which is multipart and therefore not `call`. */
async function upload(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const response = await fetch(`${BASE}/api/files`, {
    method: "POST",
    headers: cookie ? { cookie } : undefined,
    body: form,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* The Workers form parser refuses an oversized body in bare text. */
  }
  /* `POST /api/files` answers 201, not 200. Guarding on `=== 200` made both
     primary-image tests SKIP on a perfectly good upload, reporting "file
     storage unavailable" for a file that had just been stored — a test that
     silently does not run is worse than one that fails. */
  return { status: response.status, ok: response.ok, json, text };
}

/**
 * A real PNG, small enough for the direct upload path.
 *
 * A one-pixel image rather than random bytes because `PUT /api/files/[id]`
 * verifies a thumbnail by MAGIC BYTES, and because the register renders this
 * as an `<img>`: a fixture that is not actually an image would pass the upload
 * and prove nothing about the screen.
 */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function pngFile(name) {
  return new File([PNG_1PX], name, { type: "image/png" });
}

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/context`, { signal: AbortSignal.timeout(4000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

const up = await serverIsUp();

let signedIn = false;
async function signIn() {
  if (signedIn) return true;
  const result = await call("POST", "/api/auth/login", OWNER);
  signedIn = result.status === 200;
  return signedIn;
}

const created = [];

async function makeAsset(fields) {
  const result = await call("POST", "/api/assets", { data: fields });
  if (result.status === 200 && result.json?.id) created.push(result.json.id);
  return result;
}

async function readAsset(id) {
  const result = await call("GET", `/api/assets?id=${encodeURIComponent(id)}`);
  return result.json?.asset ?? null;
}

let world = null;
async function loadWorld() {
  if (world) return world;
  const list = await call("GET", "/api/assets");
  if (list.status !== 200) return null;
  const sites = list.json?.sites ?? [];
  if (!sites.length) return null;
  world = {
    siteA: sites[0].id,
    siteB: sites[1]?.id ?? sites[0].id,
    category: (list.json?.categories ?? [])[0]?.value ?? "",
    status: (list.json?.statuses ?? [])[0]?.value ?? "",
    supplier: (list.json?.suppliers ?? [])[0]?.id ?? null,
  };
  return world;
}

/** An asset carrying a value in every group the tests below check separately. */
async function fullyPopulatedAsset(w, label) {
  return makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} ${label}`,
    kind: "component",
    category: w.category,
    status: w.status,
    manufacturer: "Lumaflex",
    model: "LF-STRIP-3000",
    partNumber: `${PREFIX}-PART`,
    serialNumber: `${PREFIX}-SERIAL`,
    assetTag: `${PREFIX}-TAG`,
    specification: "24V warm white tape",
    colour: "Warm white",
    colourCode: "WW30",
    paintReference: "AP 7016 Anthracite",
    quantity: 3,
    locationInSite: "Front of house",
    installedAt: "2025-01-15",
    warrantyExpiry: "2028-01-15",
    purchasePrice: "120.00",
    lastServicedAt: "2025-06-01",
    serviceIntervalMonths: 12,
    supplier: "Voltarc Direct",
    supplierReference: "VLT-001",
    supplierEmail: "parts@example.com",
    supplierPhone: "0113 496 0118",
    supplierUrl: "https://parts.example.com/vlt-001",
    lastReplacedAt: "2025-03-02",
    replacementIntervalMonths: 36,
    replacementPartNumber: "LF-STRIP-3000-5M",
    replacementModel: "Lumaflex LF-STRIP-3000",
    replacementSpecification: "Cut to 300mm multiples",
    replacementSupplier: "Voltarc Direct",
    replacementNotes: "Order the 5m reel",
    replacementCost: "42.50",
    notes: "Original fit-out",
    specs: [
      { key: "Voltage", value: "24", unit: "V" },
      { key: "Colour temperature", value: "3000", unit: "K" },
    ],
  });
}

/* ── 1. Partial PATCH ─────────────────────────────────────────────────────── */

test("a scalar-only PATCH leaves every other field exactly as it was", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has no sites");

  const asset = await fullyPopulatedAsset(w, "scalar");
  assert.equal(asset.status, 200, JSON.stringify(asset.json));
  const before = await readAsset(asset.json.id);

  const patched = await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { name: `${PREFIX} scalar (renamed)` },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));

  const after = await readAsset(asset.json.id);
  assert.equal(after.name, `${PREFIX} scalar (renamed)`, "the one field asked for changed");

  /*
   * Everything else, named individually. A loop over `Object.keys` would pass
   * just as happily against a route that returned the row unchanged, and the
   * defect was one column at a time.
   */
  for (const field of [
    "manufacturer", "model", "partNumber", "serialNumber", "assetTag",
    "specification", "colour", "colourCode", "paintReference", "quantity",
    "locationInSite", "installedAt", "warrantyExpiry", "purchasePricePence",
    "lastServicedAt", "serviceIntervalMonths", "supplier", "supplierReference",
    "supplierEmail", "supplierPhone", "supplierUrl", "lastReplacedAt",
    "replacementIntervalMonths", "replacementPartNumber", "replacementModel",
    "replacementSpecification", "replacementSupplier", "replacementNotes",
    "replacementCostPence", "notes", "specs", "kind", "category", "status",
    "siteId", "assetNumber",
  ]) {
    assert.deepEqual(after[field], before[field], `PATCH must not touch ${field}`);
  }
});

test("a specification-only PATCH leaves the scalars alone, and the reverse", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has no sites");

  const asset = await fullyPopulatedAsset(w, "specs");
  assert.equal(asset.status, 200, JSON.stringify(asset.json));

  await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { specs: [{ key: "IP rating", value: "65", unit: "" }] },
  });
  let after = await readAsset(asset.json.id);
  assert.deepEqual(JSON.parse(after.specs), [{ key: "IP rating", value: "65", unit: "" }]);
  assert.equal(after.model, "LF-STRIP-3000", "a specs edit must not clear the model");
  assert.equal(after.partNumber, `${PREFIX}-PART`);

  /* And the reverse: editing a scalar must not empty the specification list. */
  await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { model: "LF-STRIP-4000" },
  });
  after = await readAsset(asset.json.id);
  assert.equal(after.model, "LF-STRIP-4000");
  assert.deepEqual(
    JSON.parse(after.specs),
    [{ key: "IP rating", value: "65", unit: "" }],
    "a scalar edit must not empty the specifications",
  );
});

test("supplier and replacement are independent of one another", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has no sites");

  const asset = await fullyPopulatedAsset(w, "supply");
  assert.equal(asset.status, 200, JSON.stringify(asset.json));

  await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { supplier: "Northgate Climate Direct", supplierReference: "NG-99" },
  });
  let after = await readAsset(asset.json.id);
  assert.equal(after.supplier, "Northgate Climate Direct");
  assert.equal(after.supplierReference, "NG-99");
  assert.equal(after.replacementPartNumber, "LF-STRIP-3000-5M", "replacement survives");
  assert.equal(after.replacementCostPence, 4250, "and so does its cost");
  assert.equal(after.supplierEmail, "parts@example.com", "unmentioned supplier fields too");

  await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { replacementNotes: "Two-week lead time" },
  });
  after = await readAsset(asset.json.id);
  assert.equal(after.replacementNotes, "Two-week lead time");
  assert.equal(after.supplier, "Northgate Climate Direct", "supplier survives");
  assert.equal(after.replacementPartNumber, "LF-STRIP-3000-5M");
});

test("an explicit empty string clears a nullable field, and only that one", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has no sites");

  const asset = await fullyPopulatedAsset(w, "clear");
  assert.equal(asset.status, 200, JSON.stringify(asset.json));

  /*
   * "Absent means unchanged" must not become "nothing can ever be cleared".
   * A key that IS present with an empty value is a deliberate clear.
   */
  await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { manufacturer: "" },
  });
  const after = await readAsset(asset.json.id);
  assert.equal(after.manufacturer, null, "an explicit empty value clears the field");
  assert.equal(after.model, "LF-STRIP-3000", "and clears nothing else");
  assert.equal(after.serialNumber, `${PREFIX}-SERIAL`);
});

test("the parent can be set and cleared without disturbing the record", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has no sites");

  const parent = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} cabinet`,
    kind: "equipment",
    category: w.category,
    status: w.status,
  });
  const child = await fullyPopulatedAsset(w, "child");
  assert.equal(child.status, 200, JSON.stringify(child.json));

  await call("PATCH", "/api/assets", {
    id: child.json.id,
    data: { parentUnitId: parent.json.id },
  });
  let after = await readAsset(child.json.id);
  assert.equal(after.parentUnitId, parent.json.id);
  assert.equal(after.model, "LF-STRIP-3000", "setting a parent changes nothing else");
  assert.equal(after.replacementPartNumber, "LF-STRIP-3000-5M");

  await call("PATCH", "/api/assets", {
    id: child.json.id,
    data: { parentUnitId: "" },
  });
  after = await readAsset(child.json.id);
  assert.equal(after.parentUnitId, null, "and it can be cleared");
  assert.equal(after.model, "LF-STRIP-3000");
});

test("a form-shaped PATCH does not clear the derived next-service date", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has no sites");

  const asset = await fullyPopulatedAsset(w, "derived");
  assert.equal(asset.status, 200, JSON.stringify(asset.json));

  /* A service event derives the date. */
  await call("POST", "/api/assets", {
    assetId: asset.json.id,
    event: { eventType: "Serviced", performedAt: "2026-02-10" },
  });
  const serviced = await readAsset(asset.json.id);
  assert.ok(serviced.nextServiceDueAt, "a service event derives the next date");
  const derived = serviced.nextServiceDueAt;

  /*
   * THE EXACT SHAPE THE EDIT FORM SENDS. It carries no `nextServiceDueAt` and
   * no `primaryImageId`, because one is derived and the other is set from the
   * files panel. Before the fix this save nulled both.
   */
  await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: {
      siteId: w.siteA,
      name: `${PREFIX} derived`,
      kind: "component",
      category: w.category,
      status: w.status,
      manufacturer: "Lumaflex",
      model: "LF-STRIP-3000",
      notes: "Edited from the form",
    },
  });
  const after = await readAsset(asset.json.id);
  assert.equal(after.nextServiceDueAt, derived, "the derived date survives a form save");
  assert.equal(after.notes, "Edited from the form");
});

test("a PATCH that never mentions the name is not refused for want of one", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has no sites");

  const asset = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} nameless patch`,
    kind: "equipment",
    category: w.category,
    status: w.status,
  });
  assert.equal(asset.status, 200, JSON.stringify(asset.json));

  const patched = await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { notes: "no name in this body" },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));

  /* But a PATCH that DOES mention the name still may not empty it. */
  const emptied = await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { name: "   " },
  });
  assert.equal(emptied.status, 400);
  assert.match(emptied.json.error, /name/i);
  assert.equal((await readAsset(asset.json.id)).name, `${PREFIX} nameless patch`);
});

/* ── 2. The primary image ─────────────────────────────────────────────────── */

test("an image can be made primary, and only one is", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has no sites");

  const asset = await fullyPopulatedAsset(w, "primary");
  assert.equal(asset.status, 200, JSON.stringify(asset.json));

  const first = await upload({
    file: pngFile("first.png"),
    kind: "general",
    unitId: asset.json.id,
    siteId: w.siteA,
    title: `${PREFIX} first`,
  });
  if (!first.ok) {
    return t.skip(`file storage unavailable: ${first.status} ${first.text.slice(0, 120)}`);
  }
  const second = await upload({
    file: pngFile("second.png"),
    kind: "general",
    unitId: asset.json.id,
    siteId: w.siteA,
    title: `${PREFIX} second`,
  });
  assert.ok(second.ok, `second upload: ${second.status} ${second.text.slice(0, 200)}`);

  /*
   * THE EXACT BODY THE FILES PANEL SENDS — `{ primaryImageId }` and nothing
   * else. This answered 400 "Give the asset a name." before the fix, so the
   * control could not be used at all.
   */
  const set = await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { primaryImageId: first.json.file.id },
  });
  assert.equal(set.status, 200, JSON.stringify(set.json));

  let after = await readAsset(asset.json.id);
  assert.equal(after.primaryImageId, first.json.file.id);
  assert.equal(after.name, `${PREFIX} primary`, "and the record is otherwise untouched");
  assert.equal(after.model, "LF-STRIP-3000");

  /* Choosing another makes it the primary and the first no longer is. */
  await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { primaryImageId: second.json.file.id },
  });
  after = await readAsset(asset.json.id);
  assert.equal(after.primaryImageId, second.json.file.id);
  assert.notEqual(after.primaryImageId, first.json.file.id, "exactly one primary, ever");

  /* Idempotent: setting the same one twice is not an error. */
  const again = await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { primaryImageId: second.json.file.id },
  });
  assert.equal(again.status, 200);
  assert.equal((await readAsset(asset.json.id)).primaryImageId, second.json.file.id);

  /* And it can be cleared back to no thumbnail. */
  await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: { primaryImageId: "" },
  });
  assert.equal((await readAsset(asset.json.id)).primaryImageId, null);
});

test("a primary image must be one of THIS asset's own files", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has no sites");

  const mine = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} mine`,
    kind: "equipment",
    category: w.category,
    status: w.status,
  });
  const theirs = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} theirs`,
    kind: "equipment",
    category: w.category,
    status: w.status,
  });
  assert.equal(theirs.status, 200, JSON.stringify(theirs.json));

  const file = await upload({
    file: pngFile("theirs.png"),
    kind: "general",
    unitId: theirs.json.id,
    siteId: w.siteA,
    title: `${PREFIX} theirs`,
  });
  if (!file.ok) {
    return t.skip(`file storage unavailable: ${file.status} ${file.text.slice(0, 120)}`);
  }

  /*
   * WITHOUT THIS CHECK the column is an arbitrary attachment id: a caller could
   * point one asset's thumbnail at any document in the workspace — a
   * contractor's insurance certificate, another site's drawing — which the
   * register would then render inline to everyone who can see the asset.
   */
  const stolen = await call("PATCH", "/api/assets", {
    id: mine.json.id,
    data: { primaryImageId: file.json.file.id },
  });
  assert.equal(stolen.status, 400, JSON.stringify(stolen.json));
  assert.match(stolen.json.error, /not one of this asset's files/i);
  assert.equal((await readAsset(mine.json.id)).primaryImageId, null, "and nothing was written");

  /* An id that belongs to nobody is refused the same way. */
  const invented = await call("PATCH", "/api/assets", {
    id: mine.json.id,
    data: { primaryImageId: "att-does-not-exist" },
  });
  assert.equal(invented.status, 400);
  assert.equal((await readAsset(mine.json.id)).primaryImageId, null);
});

test("a primary image cannot be set on an asset the caller cannot reach", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");

  /* Another tenant's asset is simply not found — the same answer an id that
     does not exist gets, because saying "forbidden" confirms it exists. */
  const foreign = await call("PATCH", "/api/assets", {
    id: "unit-belonging-to-another-tenant",
    data: { primaryImageId: "att-anything" },
  });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.json));
});

/* ── Sweep ────────────────────────────────────────────────────────────────── */

test("the fixtures this run created are swept", async (t) => {
  if (!up) return t.skip("no development server");
  if (!signedIn) return t.skip("nothing was created");

  /*
   * By REMEMBERED ID, never by a name-substring search over the register: the
   * suites share one Miniflare D1 and a substring sweep here has repeatedly
   * eaten another suite's fixtures. Binning is the reversible verb, which is
   * all this suite is entitled to — the permanent purge needs `data.delete`.
   */
  let swept = 0;
  for (const id of created) {
    const result = await call("DELETE", "/api/assets", { id });
    if (result.status === 200) swept += 1;
  }
  assert.equal(swept, created.length, `swept ${swept} of ${created.length} fixtures`);
});
