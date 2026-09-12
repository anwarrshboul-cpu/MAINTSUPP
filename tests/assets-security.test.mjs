/**
 * THE ASSETS SECTION, AGAINST A RUNNING SERVER.
 *
 * The half of the section's contract that cannot be read out of a file: whether
 * the route actually refuses. A source pin proves a predicate is written; only
 * a request proves it is reached.
 *
 * ── WHAT IT MEASURES, AND WHY EACH ONE IS HERE ─────────────────────────────
 *
 *   · CRUD, end to end, because a register that cannot round-trip a record is
 *     not a register.
 *   · The three relationship rules, each of which fails differently: a foreign
 *     parent is a disclosure, a cross-site parent is a lie about where a thing
 *     is, and a cycle is a page that never finishes rendering.
 *   · Cross-tenant ids on every relation — site, parent, supplier, primary
 *     image — because "it exists globally" is not "it is yours".
 *   · The bin, the restore and the fact that neither destroys history.
 *   · The export's scoping and its formula safety.
 *
 * ── HOW IT BEHAVES ─────────────────────────────────────────────────────────
 *
 * It SKIPS, not fails, when no development server answers — the convention
 * roughly thirty other suites here follow, because a suite that fails on a
 * quiet tree teaches everyone to ignore it.
 *
 * Every fixture is prefixed `ZZQA-ASSETS-<run>` and swept at the end. The
 * prefix is RUN-SCOPED deliberately: this product has no hard delete for an
 * asset from the register (binning is reversible and purging is a separate
 * capability), so a fixed prefix makes a second run's register ambiguous and
 * the suite then fails with the product behaving correctly.
 */

import assert from "node:assert/strict";
import test from "node:test";

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: "owner@maintsupp.com", password: "Sunnamusk-Owner-2026" };
const RUN = crypto.randomUUID().slice(0, 8);
const PREFIX = `ZZQA-ASSETS-${RUN}`;

let cookie = "";

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* A CSV or a bare-text refusal. `text` is the payload either way. */
  }
  return { status: response.status, json, text };
}

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE}/api/context`, {
      signal: AbortSignal.timeout(4000),
    });
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

/** The fixtures this run created, swept in the last test. */
const created = [];

async function makeAsset(fields) {
  const result = await call("POST", "/api/assets", { data: fields });
  if (result.status === 200 && result.json?.id) created.push(result.json.id);
  return result;
}

/**
 * A site and a contractor this workspace owns, read rather than assumed.
 *
 * The estate differs between a developer's machine and CI, so the suite takes
 * whatever the register actually holds instead of naming a store that may not
 * be there.
 */
let world = null;
async function loadWorld() {
  if (world) return world;
  const list = await call("GET", "/api/assets");
  if (list.status !== 200) return null;
  const sites = list.json?.sites ?? [];
  if (sites.length < 2) return null;
  world = {
    siteA: sites[0].id,
    siteB: sites[1].id,
    supplier: (list.json?.suppliers ?? [])[0]?.id ?? null,
    category: (list.json?.categories ?? [])[0]?.value ?? "",
    status: (list.json?.statuses ?? [])[0]?.value ?? "",
  };
  return world;
}

/* ── CRUD ─────────────────────────────────────────────────────────────────── */

test("an asset can be created, read back, edited and binned", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has fewer than two sites");

  const create = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} LED strip`,
    kind: "component",
    category: w.category,
    status: w.status,
    manufacturer: "Lumaflex",
    model: "LF-STRIP-3000",
    partNumber: `${PREFIX}-PART`,
    specs: [{ key: "Colour temperature", value: "3000", unit: "K" }],
    replacementCost: "42.50",
  });
  assert.equal(create.status, 200, JSON.stringify(create.json));
  assert.match(create.json.assetNumber, /^AST-\d{6,}$/, "a create mints a quotable reference");

  const read = await call("GET", `/api/assets?id=${encodeURIComponent(create.json.id)}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.asset.name, `${PREFIX} LED strip`);
  assert.equal(read.json.asset.kind, "component");
  /* Money is pence in the column, never a float. */
  assert.equal(read.json.asset.replacementCostPence, 4250);
  /* The specification survived the round trip through the JSON column. */
  assert.deepEqual(JSON.parse(read.json.asset.specs), [
    { key: "Colour temperature", value: "3000", unit: "K" },
  ]);

  const edit = await call("PATCH", "/api/assets", {
    id: create.json.id,
    data: {
      siteId: w.siteA,
      name: `${PREFIX} LED strip (edited)`,
      kind: "component",
      category: w.category,
      status: w.status,
      model: "LF-STRIP-4000",
    },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));

  const after = await call("GET", `/api/assets?id=${encodeURIComponent(create.json.id)}`);
  assert.equal(after.json.asset.model, "LF-STRIP-4000");
  /*
   * THE ASSET NUMBER IS STABLE ACROSS AN EDIT. It is a reference somebody
   * quotes on an order; a number that changed when a model was corrected would
   * be worse than no number.
   */
  assert.equal(after.json.asset.assetNumber, create.json.assetNumber);
});

test("an unknown or foreign id is 404, not a cheerful 200", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");

  /*
   * An UPDATE whose WHERE clause matches nothing is a SUCCESSFUL update. The
   * route this replaced answered `{ ok: true }` for an id in another tenant,
   * which told the caller an edit had happened to a row that was never touched.
   */
  for (const [method, body] of [
    ["PATCH", { id: "unit-does-not-exist", data: { name: "x", siteId: "y" } }],
    ["DELETE", { id: "unit-does-not-exist" }],
  ]) {
    const result = await call(method, "/api/assets", body);
    assert.equal(result.status, 404, `${method} answered ${result.status}`);
  }
  const read = await call("GET", "/api/assets?id=unit-does-not-exist");
  assert.equal(read.status, 404);
});

/* ── Relationships ────────────────────────────────────────────────────────── */

test("a parent must be real, at the same site, and not a loop", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has fewer than two sites");

  const base = { kind: "equipment", category: w.category, status: w.status };
  const cabinet = await makeAsset({ ...base, siteId: w.siteA, name: `${PREFIX} cabinet` });
  assert.equal(cabinet.status, 200, JSON.stringify(cabinet.json));

  /* A legitimate child. The rule has to be usable as well as safe. */
  const light = await makeAsset({
    ...base,
    kind: "component",
    siteId: w.siteA,
    name: `${PREFIX} light`,
    parentUnitId: cabinet.json.id,
  });
  assert.equal(light.status, 200, JSON.stringify(light.json));

  /* A parent at a DIFFERENT site is a lie about where the thing is. */
  const elsewhere = await makeAsset({
    ...base,
    siteId: w.siteB,
    name: `${PREFIX} cross-site child`,
    parentUnitId: cabinet.json.id,
  });
  assert.equal(elsewhere.status, 400, JSON.stringify(elsewhere.json));
  assert.match(elsewhere.json.error, /same site/i);

  /* A parent that does not exist at all. */
  const ghost = await makeAsset({
    ...base,
    siteId: w.siteA,
    name: `${PREFIX} ghost parent`,
    parentUnitId: "unit-not-a-real-id",
  });
  assert.equal(ghost.status, 400);
  assert.match(ghost.json.error, /not in this workspace/i);

  /* SELF. The zero-length cycle, which a plain walk never reaches. */
  const itself = await call("PATCH", "/api/assets", {
    id: cabinet.json.id,
    data: {
      ...base,
      siteId: w.siteA,
      name: `${PREFIX} cabinet`,
      parentUnitId: cabinet.json.id,
    },
  });
  assert.equal(itself.status, 400);
  assert.match(itself.json.error, /part of itself/i);

  /*
   * THE REAL LOOP: the cabinet already holds the light, so making the light the
   * cabinet's parent closes the circle. This is the one a single self-check
   * misses.
   */
  const loop = await call("PATCH", "/api/assets", {
    id: cabinet.json.id,
    data: {
      ...base,
      siteId: w.siteA,
      name: `${PREFIX} cabinet`,
      parentUnitId: light.json.id,
    },
  });
  assert.equal(loop.status, 400, JSON.stringify(loop.json));
  assert.match(loop.json.error, /own ancestor/i);
});

test("a supplier must be a contractor in this workspace", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has fewer than two sites");

  const foreign = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} foreign supplier`,
    kind: "equipment",
    category: w.category,
    status: w.status,
    supplierContractorId: "contractor-belonging-to-nobody",
  });
  assert.equal(foreign.status, 400, JSON.stringify(foreign.json));
  assert.match(foreign.json.error, /not a contractor in this workspace/i);

  if (w.supplier) {
    const linked = await makeAsset({
      siteId: w.siteA,
      name: `${PREFIX} linked supplier`,
      kind: "equipment",
      category: w.category,
      status: w.status,
      supplierContractorId: w.supplier,
    });
    assert.equal(linked.status, 200, JSON.stringify(linked.json));
  }
});

test("a site the caller cannot reach is refused, not silently accepted", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has fewer than two sites");

  const foreign = await makeAsset({
    siteId: "site-belonging-to-another-tenant",
    name: `${PREFIX} foreign site`,
    kind: "equipment",
    category: w.category,
    status: w.status,
  });
  assert.equal(foreign.status, 400, JSON.stringify(foreign.json));
  assert.match(foreign.json.error, /not one you can add assets to/i);

  /* And a create with no site at all: the site is mandatory by design. */
  const orphan = await makeAsset({
    name: `${PREFIX} orphan`,
    kind: "equipment",
    category: w.category,
    status: w.status,
  });
  assert.equal(orphan.status, 400);
  assert.match(orphan.json.error, /site/i);
});

test("a javascript: supplier link never reaches the column", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has fewer than two sites");

  const created = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} hostile link`,
    kind: "equipment",
    category: w.category,
    status: w.status,
    supplierUrl: "javascript:alert(document.cookie)",
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const read = await call("GET", `/api/assets?id=${encodeURIComponent(created.json.id)}`);
  /*
   * Stored as NULL rather than stored and hidden. The detail screen renders the
   * supplier URL as an anchor, so a `javascript:` value in this column is
   * stored XSS against everybody who can open the asset.
   */
  assert.equal(read.json.asset.supplierUrl, null);
});

/* ── The lifecycle history ────────────────────────────────────────────────── */

test("a replacement is recorded without destroying what came before", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has fewer than two sites");

  const asset = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} transformer`,
    kind: "component",
    category: w.category,
    status: w.status,
    model: "VT-LPV-40-24",
  });
  assert.equal(asset.status, 200, JSON.stringify(asset.json));

  const event = await call("POST", "/api/assets", {
    assetId: asset.json.id,
    event: {
      eventType: "Replaced",
      previousDetail: "Voltarc VT-LPV-40-24",
      replacementDetail: "Voltarc VT-LPV-60-24",
      cost: "31.80",
      notes: "Uprated to 60W.",
    },
  });
  assert.equal(event.status, 200, JSON.stringify(event.json));

  /* The asset's own model is then corrected by a separate edit — the route
     deliberately does not guess which field a replacement changed. */
  await call("PATCH", "/api/assets", {
    id: asset.json.id,
    data: {
      siteId: w.siteA,
      name: `${PREFIX} transformer`,
      kind: "component",
      category: w.category,
      status: w.status,
      model: "VT-LPV-60-24",
    },
  });

  const read = await call("GET", `/api/assets?id=${encodeURIComponent(asset.json.id)}`);
  assert.equal(read.json.asset.model, "VT-LPV-60-24", "the record describes what is fitted today");
  const replaced = read.json.history.find((row) => row.eventType === "Replaced");
  assert.ok(replaced, "the replacement is on the timeline");
  /*
   * THE WHOLE POINT. The part that came out is still answerable, from a row the
   * edit above could not touch.
   */
  assert.equal(replaced.previousDetail, "Voltarc VT-LPV-40-24");
  assert.equal(replaced.costPence, 3180, "and its cost is pence, not a float");
});

test("a status change writes its own history entry, and re-saving does not", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has fewer than two sites");

  const list = await call("GET", "/api/assets");
  const other = (list.json?.statuses ?? []).find((entry) => entry.value !== w.status);
  if (!other) return t.skip("this workspace has only one status configured");

  const asset = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} status trail`,
    kind: "equipment",
    category: w.category,
    status: w.status,
  });
  assert.equal(asset.status, 200, JSON.stringify(asset.json));

  const body = {
    siteId: w.siteA,
    name: `${PREFIX} status trail`,
    kind: "equipment",
    category: w.category,
  };
  await call("PATCH", "/api/assets", { id: asset.json.id, data: { ...body, status: other.value } });

  const changed = await call("GET", `/api/assets?id=${encodeURIComponent(asset.json.id)}`);
  const entries = changed.json.history.filter((row) => row.eventType === "Status changed");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].replacementDetail, other.value);

  /* Re-saving the same form must not invent a second event. */
  await call("PATCH", "/api/assets", { id: asset.json.id, data: { ...body, status: other.value } });
  const again = await call("GET", `/api/assets?id=${encodeURIComponent(asset.json.id)}`);
  assert.equal(
    again.json.history.filter((row) => row.eventType === "Status changed").length,
    1,
    "a save that changed nothing is not an event",
  );
});

/* ── The KPI row ──────────────────────────────────────────────────────────── */

test("the tiles are counted from the rows the caller may see", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");

  const list = await call("GET", "/api/assets");
  assert.equal(list.status, 200);
  const rows = list.json.assets;
  /*
   * Derived from the array that was sent, so the tile and the list below it are
   * incapable of disagreeing. A second aggregate with its own predicate is how
   * a restricted member came to read estate-wide totals off a dashboard.
   */
  assert.equal(list.json.totals.all, rows.length);
  assert.equal(
    list.json.totals.equipment,
    rows.filter((row) => row.kind === "equipment").length,
  );
  assert.equal(
    list.json.totals.replacementParts,
    rows.filter((row) => row.kind === "replacement_part").length,
  );
  assert.equal(
    list.json.totals.needsReplacement,
    rows.filter((row) => (row.status ?? "").toLowerCase() === "needs replacement").length,
  );
});

/* ── The bin ──────────────────────────────────────────────────────────────── */

test("binning an asset keeps its history and leaves its children alone", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has fewer than two sites");

  const base = { kind: "equipment", category: w.category, status: w.status };
  const parent = await makeAsset({ ...base, siteId: w.siteA, name: `${PREFIX} bin parent` });
  const child = await makeAsset({
    ...base,
    kind: "component",
    siteId: w.siteA,
    name: `${PREFIX} bin child`,
    parentUnitId: parent.json.id,
  });
  assert.equal(child.status, 200, JSON.stringify(child.json));

  await call("POST", "/api/assets", {
    assetId: parent.json.id,
    event: { eventType: "Serviced", notes: "before the bin" },
  });

  const binned = await call("DELETE", "/api/assets", { id: parent.json.id });
  assert.equal(binned.status, 200, JSON.stringify(binned.json));

  /* Gone from the register, and gone from the single read. */
  const list = await call("GET", "/api/assets");
  assert.ok(!list.json.assets.some((row) => row.id === parent.json.id));
  assert.equal((await call("GET", `/api/assets?id=${parent.json.id}`)).status, 404);

  /* THE CHILD IS STILL THERE. Binning one thing removes one thing. */
  assert.ok(
    list.json.assets.some((row) => row.id === child.json.id),
    "binning a parent must not cascade into its parts",
  );

  /* And it can come back, with its history. */
  const bin = await call("GET", "/api/trash");
  const entry = (bin.json?.bin?.entries ?? []).find(
    (row) => row.entityType === "asset" && row.entityId === parent.json.id,
  );
  assert.ok(entry, "the asset is in the bin under its own kind");

  const restored = await call("POST", "/api/trash", { id: entry.id });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));

  const back = await call("GET", `/api/assets?id=${encodeURIComponent(parent.json.id)}`);
  assert.equal(back.status, 200, "restore puts it back on the register");
  assert.ok(
    back.json.history.some((row) => row.notes === "before the bin"),
    "and its history survived the round trip",
  );
});

/* ── The export ───────────────────────────────────────────────────────────── */

test("the export is scoped, and a formula cannot ride out in a cell", async (t) => {
  if (!up) return t.skip("no development server");
  if (!(await signIn())) return t.skip("could not sign in");
  const w = await loadWorld();
  if (!w) return t.skip("this workspace has fewer than two sites");

  const hostile = await makeAsset({
    siteId: w.siteA,
    name: `${PREFIX} =1+1`,
    kind: "equipment",
    category: w.category,
    status: w.status,
    partNumber: "@SUM(A1:A9)",
  });
  assert.equal(hostile.status, 200, JSON.stringify(hostile.json));

  const csv = await call("GET", "/api/assets/csv");
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes(PREFIX), "the fixture is in the file");
  /*
   * Neutralised with a leading apostrophe — the literal-text marker every
   * spreadsheet honours. Without it, opening the export runs the cell.
   */
  assert.ok(
    csv.text.includes(`"'@SUM(A1:A9)"`),
    "an @-prefixed part number must not reach Excel as a formula",
  );
  assert.ok(
    !/(^|,)"?=1\+1/.test(csv.text),
    "nor an =-prefixed name",
  );

  /* Filtering by a site narrows the file. */
  const narrowed = await call("GET", `/api/assets/csv?siteId=${encodeURIComponent(w.siteB)}`);
  assert.equal(narrowed.status, 200);
  assert.ok(
    !narrowed.text.includes(`${PREFIX} =1+1`),
    "an export filtered to another site must not carry this row",
  );
});

/* ── Sweep ────────────────────────────────────────────────────────────────── */

test("the fixtures this run created are swept", async (t) => {
  if (!up) return t.skip("no development server");
  if (!signedIn) return t.skip("nothing was created");

  /*
   * By REMEMBERED ID, never by a name-substring search over the register.
   * `tests` share one Miniflare D1, and a substring sweep here has repeatedly
   * eaten another suite's fixtures. Binning is the reversible verb, which is
   * all this suite is entitled to: the permanent purge needs `data.delete`.
   */
  let swept = 0;
  for (const id of created) {
    const result = await call("DELETE", "/api/assets", { id });
    if (result.status === 200) swept += 1;
  }
  assert.ok(
    swept >= created.length - 1,
    `expected to sweep the run's fixtures, swept ${swept} of ${created.length}`,
  );
});
