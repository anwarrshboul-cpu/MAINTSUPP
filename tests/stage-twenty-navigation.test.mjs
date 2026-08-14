/**
 * Stage 20 — the customisable sidebar.
 *
 * Three halves, which is one more than usual and deliberate.
 *
 * The first exercises the resolver directly, because the merge is where every
 * interesting failure lives and it is a pure function: no server, no browser,
 * no fixture. The centrepiece is the one property this stage exists to
 * guarantee — a section added to the product after somebody saved a layout
 * *appears* rather than vanishing. That is a silent failure by nature (their
 * nav looks fine, it is simply missing something), so it is tested from several
 * directions rather than once.
 *
 * The second reads the source and pins the shape: organisation scoping through
 * `scopedDb`, locks enforced in the handler, the catalogue derived from
 * `sectionMeta` rather than hand-written.
 *
 * The third talks to a running dev server, because a rule that is only checked
 * in a unit test is a rule about a function, not about the API. It skips when
 * nothing is listening, so the suite still passes without a server.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BUILT_IN_GROUPS,
  BUILT_IN_ORDER,
  builtInCatalogue,
  lockViolations,
  resolveNavigation,
  sanitiseArrangement,
  sanitiseLocked,
  toArrangement,
  workspaceLabelMap,
} from "../app/api/navigation/layout.ts";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const CLIENT = "client@sunnamusk-uk.test.maintsupp.com";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const OPERATIONS = BUILT_IN_GROUPS[0].key;
const WORKSPACE = BUILT_IN_GROUPS[1].key;

/** A section row for an arrangement, with the boring fields filled in. */
function item(key, extra = {}) {
  return {
    key,
    kind: "section",
    label: null,
    hidden: false,
    group: OPERATIONS,
    position: 0,
    ...extra,
  };
}

function heading(key, label = null) {
  return { key, kind: "group", label, hidden: false, group: null, position: 0 };
}

const visible = (result) => result.flat.filter((row) => !row.hidden).map((row) => row.key);
const everything = (result) => result.flat.map((row) => row.key);

/* ══════════════════════════════════════════════════════════════════════════
   1. The resolver
   ══════════════════════════════════════════════════════════════════════════ */

test("with nothing stored, the sidebar is the built-in order", () => {
  const result = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: [],
    userItems: null,
    locked: [],
  });
  assert.deepEqual(
    everything(result),
    BUILT_IN_ORDER.map((entry) => entry.key),
  );
  assert.deepEqual(
    result.groups.map((group) => group.label),
    BUILT_IN_GROUPS.map((group) => group.label),
  );
  // Nothing has "appeared" for somebody who has never arranged anything.
  assert.deepEqual(result.appeared, []);
});

test("the workspace default overrides the built-in order", () => {
  const result = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: [
      heading(OPERATIONS),
      item("reports"),
      item("overview"),
    ],
    userItems: null,
    locked: [],
  });
  assert.deepEqual(everything(result).slice(0, 2), ["reports", "overview"]);
});

test("a person's own arrangement wins over the workspace default", () => {
  const result = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: [heading(OPERATIONS), item("reports"), item("overview")],
    userItems: [heading(OPERATIONS), item("compliance"), item("overview")],
    locked: [],
  });
  assert.deepEqual(everything(result).slice(0, 2), ["compliance", "overview"]);
});

test("each layer only overrides the keys it names", () => {
  // The workspace default moves Settings to the top; the user says nothing
  // about Settings, so the default's opinion survives underneath theirs.
  const result = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: [heading(OPERATIONS), item("settings"), item("overview")],
    userItems: [heading(OPERATIONS), item("overview")],
    locked: [],
  });
  const order = everything(result);
  assert.equal(order[0], "overview", "the user's opinion applies");
  assert.ok(
    order.indexOf("settings") < order.indexOf("maintenance"),
    "the default's opinion about Settings survives where the user had none",
  );
});

/* ── the property this stage exists for ──────────────────────────────────── */

test("A SECTION THAT NO SAVED LAYOUT KNOWS ABOUT STILL APPEARS", () => {
  // Exactly the case the other Stage 20 teams create: /dashboard/admin,
  // /dashboard/audit, /dashboard/teams and /dashboard/account arrive after
  // people have already arranged their sidebars.
  const catalogue = [
    ...builtInCatalogue(),
    { key: "admin", label: "Admin", group: OPERATIONS },
    { key: "audit", label: "Audit", group: WORKSPACE },
    { key: "teams", label: "Teams", group: WORKSPACE },
    { key: "account", label: "Account", group: WORKSPACE },
  ];
  // A fully specified layout, saved before any of them existed. Derived from
  // the whole of BUILT_IN_ORDER rather than a hand-listed subset, so that a
  // section added to the built-in order later — as the three administration
  // screens were — does not read as one of this fixture's four arrivals and
  // quietly weaken the exact-equality assertion below.
  const saved = [
    heading(OPERATIONS),
    ...BUILT_IN_ORDER.filter((entry) => entry.group === OPERATIONS).map((entry) =>
      item(entry.key),
    ),
    heading(WORKSPACE),
    ...BUILT_IN_ORDER.filter((entry) => entry.group === WORKSPACE).map((entry) =>
      item(entry.key, { group: WORKSPACE }),
    ),
  ];

  const result = resolveNavigation({
    catalogue,
    workspaceItems: saved,
    userItems: saved,
    locked: [],
  });

  for (const key of ["admin", "audit", "teams", "account"]) {
    assert.ok(
      visible(result).includes(key),
      `${key} must appear even though no stored layout mentions it`,
    );
  }
  assert.deepEqual(result.appeared.sort(), ["account", "admin", "audit", "teams"]);

  // And under the right heading, not swept to the bottom of the sidebar.
  const byKey = new Map(result.flat.map((row) => [row.key, row.group]));
  assert.equal(byKey.get("admin"), OPERATIONS);
  assert.equal(byKey.get("audit"), WORKSPACE);
});

test("a new section survives a layout that reordered everything else", () => {
  const catalogue = [
    ...builtInCatalogue(),
    { key: "audit", label: "Audit", group: WORKSPACE },
  ];
  const result = resolveNavigation({
    catalogue,
    // An aggressive rearrangement: reversed, renamed, half of it hidden.
    workspaceItems: [
      heading(OPERATIONS, "Everything"),
      ...[...BUILT_IN_ORDER].reverse().map((entry, index) =>
        item(entry.key, { hidden: index % 2 === 0, label: `X${index}` }),
      ),
    ],
    userItems: null,
    locked: [],
  });
  assert.ok(visible(result).includes("audit"));
});

test("a saved key the catalogue no longer contains is dropped, not drawn", () => {
  const result = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: [heading(OPERATIONS), item("overview"), item("retired-section")],
    userItems: null,
    locked: [],
  });
  assert.ok(
    !everything(result).includes("retired-section"),
    "a nav item with no destination is a labelled 404",
  );
});

test("deleting a heading never deletes the sections under it", () => {
  const result = resolveNavigation({
    catalogue: builtInCatalogue(),
    // The Workspace heading is simply absent from the saved arrangement.
    workspaceItems: [heading(OPERATIONS), item("overview")],
    userItems: null,
    locked: [],
  });
  assert.ok(everything(result).includes("team"));
});

/* ── never strand the user ───────────────────────────────────────────────── */

test("a layout with everything hidden still leaves one item visible", () => {
  const result = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: [
      heading(OPERATIONS),
      ...BUILT_IN_ORDER.map((entry) => item(entry.key, { hidden: true })),
    ],
    userItems: null,
    locked: [],
  });
  assert.equal(
    visible(result).length,
    1,
    "the first item in render order is forced back on",
  );
});

test("the last-resort rule holds for a layout crafted straight into the database", () => {
  // Not saved through the API, so no handler validation ever ran on it.
  const result = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: [],
    userItems: BUILT_IN_ORDER.map((entry) => item(entry.key, { hidden: true })),
    locked: [],
  });
  assert.ok(visible(result).length >= 1);
});

/* ── locking ─────────────────────────────────────────────────────────────── */

test("a locked item is un-hidden and un-renamed when the layout resolves", () => {
  const result = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: [heading(OPERATIONS), item("compliance")],
    userItems: [heading(OPERATIONS), item("compliance", { hidden: true, label: "Gone" })],
    locked: ["compliance"],
  });
  const row = result.flat.find((entry) => entry.key === "compliance");
  assert.equal(row.hidden, false);
  assert.equal(row.label, "Compliance");
  assert.equal(row.locked, true);
});

test("lockViolations names hiding and renaming, and tolerates omission", () => {
  const labels = workspaceLabelMap([heading(OPERATIONS), item("compliance")]);
  assert.deepEqual(
    lockViolations([item("compliance", { hidden: true })], ["compliance"], labels),
    [{ key: "compliance", reason: "hidden" }],
  );
  assert.deepEqual(
    lockViolations([item("compliance", { label: "Nope" })], ["compliance"], labels),
    [{ key: "compliance", reason: "renamed" }],
  );
  assert.deepEqual(
    lockViolations([item("compliance")], ["compliance"], labels),
    [],
    "reordering a locked item is allowed — a lock is about seeing it",
  );
  assert.deepEqual(
    lockViolations([item("overview")], ["compliance"], labels),
    [],
    "omitting a locked item is not a violation: it inherits from the default",
  );
});

/* ── sanitising ──────────────────────────────────────────────────────────── */

test("garbage in an arrangement is coerced rather than trusted or thrown", () => {
  const items = sanitiseArrangement([
    { key: "overview", hidden: "yes", label: 12 },
    { key: "overview" },
    { key: "../../etc/passwd" },
    { key: "<script>" },
    null,
    { key: "group:ops", label: "a".repeat(400) },
    { key: "maintenance", hidden: true },
  ]);
  assert.deepEqual(
    items.map((entry) => entry.key),
    ["overview", "group:ops", "maintenance"],
    "duplicates and malformed keys are dropped",
  );
  assert.equal(items[0].hidden, false, '"yes" is not true');
  assert.equal(items[0].label, null, "a number is not a label");
  assert.equal(items[1].label.length, 60, "labels are capped");
  assert.equal(items[1].hidden, false, "a heading can never be hidden");
  assert.equal(items[2].hidden, true);
  assert.deepEqual(sanitiseArrangement("not an array"), []);
  assert.deepEqual(sanitiseLocked(["overview", "group:ops", 7]), ["overview"]);
});

test("toArrangement round-trips a resolved layout", () => {
  const first = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: [heading(OPERATIONS, "Daily"), item("reports"), item("overview")],
    userItems: null,
    locked: [],
  });
  const again = resolveNavigation({
    catalogue: builtInCatalogue(),
    workspaceItems: toArrangement(first.groups),
    userItems: null,
    locked: [],
  });
  assert.deepEqual(everything(again), everything(first));
  assert.equal(again.groups[0].label, "Daily");
});

/* ══════════════════════════════════════════════════════════════════════════
   2. The shape of the code
   ══════════════════════════════════════════════════════════════════════════ */

test("the navigation route is organisation-scoped through scopedDb", async () => {
  const text = await source("app/api/navigation/route.ts");
  assert.match(text, /scopedDb\(request\)/);
  assert.doesNotMatch(
    text,
    /maintsupp_demo_organisation/,
    "the route must not read the organisation cookie itself",
  );
  assert.match(
    text,
    /eq\(navigationLayouts\.organisationId, context\.orgId\)/,
    "every layout query is filtered on the resolved organisation",
  );
});

test("locking is enforced in the PUT handler, not only in the UI", async () => {
  const route = await source("app/api/navigation/route.ts");
  assert.match(route, /lockViolations\(/, "the handler runs the lock check");
  assert.match(route, /status: 422/, "and refuses rather than silently correcting");
  assert.match(
    route,
    /mayEditDefault\(context\)/,
    "and the workspace default is admin-only",
  );
  assert.match(
    route,
    /context\.actor\.role === "admin"/,
    "on the role the database granted, not on anything in the request",
  );
});

test("the browser's built-in order and the server's copy of it cannot drift", async () => {
  // The order is written twice on purpose: `navPrimary` / `navSecondary` in the
  // file that draws the sidebar, where anybody adding a section will look, and
  // `BUILT_IN_ORDER` in the shared module, so the API can answer without a
  // browser. Two copies are only safe while something checks they agree.
  const portal = await source("app/(app)/portal/portal-app.tsx");
  const literal = (name) => {
    const start = portal.indexOf(`const ${name}: Section[] = [`);
    assert.ok(start >= 0, `${name} must still be a literal array`);
    const body = portal.slice(start, portal.indexOf("];", start));
    return [...body.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);
  };

  assert.deepEqual(
    literal("navPrimary"),
    BUILT_IN_ORDER.filter((entry) => entry.group === OPERATIONS).map((e) => e.key),
  );
  assert.deepEqual(
    literal("navSecondary"),
    BUILT_IN_ORDER.filter((entry) => entry.group === WORKSPACE).map((e) => e.key),
  );
});

test("the sidebar catalogue is derived from sectionMeta, never hand-written", async () => {
  const portal = await source("app/(app)/portal/portal-app.tsx");
  assert.match(
    portal,
    /Object\.keys\(sectionMeta\)/,
    "a section added to sectionMeta must reach the catalogue on its own",
  );
  assert.match(
    portal,
    /sectionRoutes\[key as Section\] !== undefined/,
    "and must have a destination before it can be offered",
  );
  assert.doesNotMatch(
    portal,
    /navPrimary\.map\(\(section\)/,
    "the sidebar is no longer a `.map` over a constant",
  );
  assert.match(portal, /<SidebarNav/, "the nav renders through the layout component");
});

test("dragging has a keyboard equivalent and announces the result", async () => {
  const nav = await source("app/(app)/portal/sidebar-nav.tsx");
  assert.match(nav, /ArrowUp/);
  assert.match(nav, /ArrowDown/);
  assert.match(nav, /altKey/, "Alt + arrow moves the focused row");
  assert.match(nav, /aria-live="polite"/, "and the outcome is announced");
  assert.match(nav, /aria-label=\{`Move \$\{item\.label\} up`\}/, "with visible buttons too");
});

test("every built-in section has a route, so nothing in the nav can 404", async () => {
  const portal = await source("app/(app)/portal/portal-app.tsx");
  for (const entry of BUILT_IN_ORDER) {
    assert.ok(
      portal.includes(`  ${entry.key}: "`) || portal.includes(`  "${entry.key}": "`),
      `${entry.key} needs a sectionRoutes entry`,
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   3. The live API
   ══════════════════════════════════════════════════════════════════════════ */

async function serverIsUp() {
  try {
    const response = await fetch(`${BASE_URL}/api/navigation`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const live = await serverIsUp();

function call(path, options = {}, identity = ADMIN) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-maintsupp-identity": identity,
      ...(options.headers ?? {}),
    },
  });
}

/** Back to the built-in order, both layers. */
async function clear() {
  await call("/api/navigation", {
    method: "PUT",
    body: JSON.stringify({ scope: "workspace", reset: true }),
  });
  for (const identity of [ADMIN, CLIENT]) {
    await call("/api/navigation", { method: "DELETE" }, identity);
  }
}

test("live: GET answers with the built-in order when nothing is stored", { skip: !live }, async () => {
  await clear();
  const payload = await (await call("/api/navigation")).json();
  assert.equal(payload.source, "builtin");
  const keys = payload.layout.groups.flatMap((group) =>
    group.items.map((entry) => entry.key),
  );
  assert.deepEqual(keys, BUILT_IN_ORDER.map((entry) => entry.key));
  await clear();
});

test("live: an admin sets the workspace default and everyone inherits it", { skip: !live }, async () => {
  await clear();
  const response = await call("/api/navigation", {
    method: "PUT",
    body: JSON.stringify({
      scope: "workspace",
      locked: ["compliance"],
      items: [
        heading(OPERATIONS),
        item("compliance"),
        item("overview"),
        item("reports", { hidden: true }),
      ],
    }),
  });
  assert.equal(response.status, 200);

  const seen = await (await call("/api/navigation", {}, CLIENT)).json();
  assert.equal(seen.source, "workspace");
  assert.deepEqual(seen.locked, ["compliance"]);
  const first = seen.layout.groups[0].items[0];
  assert.equal(first.key, "compliance");
  assert.equal(first.locked, true);
  await clear();
});

test("live: a client cannot write the workspace default", { skip: !live }, async () => {
  await clear();
  const response = await call(
    "/api/navigation",
    {
      method: "PUT",
      body: JSON.stringify({
        scope: "workspace",
        items: [heading(OPERATIONS), item("overview")],
      }),
    },
    CLIENT,
  );
  assert.equal(response.status, 403);
  await clear();
});

test("live: A CRAFTED PUT THAT HIDES A LOCKED ITEM IS REJECTED", { skip: !live }, async () => {
  await clear();
  await call("/api/navigation", {
    method: "PUT",
    body: JSON.stringify({
      scope: "workspace",
      locked: ["compliance"],
      items: [heading(OPERATIONS), item("compliance"), item("overview")],
    }),
  });

  // Nothing in the browser is involved here. This is the payload somebody
  // writes in a console once they notice the button is disabled.
  const hide = await call(
    "/api/navigation",
    {
      method: "PUT",
      body: JSON.stringify({
        scope: "user",
        items: [heading(OPERATIONS), item("compliance", { hidden: true }), item("overview")],
      }),
    },
    CLIENT,
  );
  assert.equal(hide.status, 422);
  const hideBody = await hide.json();
  assert.deepEqual(hideBody.violations, [{ key: "compliance", reason: "hidden" }]);

  const rename = await call(
    "/api/navigation",
    {
      method: "PUT",
      body: JSON.stringify({
        scope: "user",
        items: [heading(OPERATIONS), item("compliance", { label: "Nonsense" }), item("overview")],
      }),
    },
    CLIENT,
  );
  assert.equal(rename.status, 422);
  assert.deepEqual((await rename.json()).violations, [
    { key: "compliance", reason: "renamed" },
  ]);

  // And nothing was written: the refusal is total, not partial.
  const after = await (await call("/api/navigation", {}, CLIENT)).json();
  assert.equal(after.source, "workspace", "no personal layout was created");
  await clear();
});

test("live: a person's own arrangement wins, and reset gives it back", { skip: !live }, async () => {
  await clear();
  await call("/api/navigation", {
    method: "PUT",
    body: JSON.stringify({
      scope: "workspace",
      items: [heading(OPERATIONS), item("settings"), item("overview")],
    }),
  });
  await call(
    "/api/navigation",
    {
      method: "PUT",
      body: JSON.stringify({
        scope: "user",
        items: [heading(OPERATIONS, "Mine"), item("reports"), item("overview")],
      }),
    },
    CLIENT,
  );

  let seen = await (await call("/api/navigation", {}, CLIENT)).json();
  assert.equal(seen.source, "user");
  assert.equal(seen.layout.groups[0].label, "Mine");
  assert.equal(seen.layout.groups[0].items[0].key, "reports");

  const reset = await call("/api/navigation", { method: "DELETE" }, CLIENT);
  assert.equal(reset.status, 200);
  seen = await (await call("/api/navigation", {}, CLIENT)).json();
  assert.equal(seen.source, "workspace");
  assert.equal(seen.layout.groups[0].items[0].key, "settings");
  await clear();
});

test("live: a section the stored layout never heard of comes back visible", { skip: !live }, async () => {
  await clear();
  await call("/api/navigation", {
    method: "PUT",
    body: JSON.stringify({
      scope: "user",
      items: [
        heading(OPERATIONS),
        ...BUILT_IN_ORDER.map((entry) => item(entry.key)),
      ],
    }),
  });

  // The browser reports a catalogue containing four sections that did not
  // exist when that layout was saved.
  const sections = [...BUILT_IN_ORDER.map((entry) => entry.key), "admin", "audit", "teams", "account"];
  const payload = await (
    await call(`/api/navigation?sections=${sections.join(",")}`)
  ).json();
  const shown = payload.layout.groups
    .flatMap((group) => group.items)
    .filter((entry) => !entry.hidden)
    .map((entry) => entry.key);
  for (const key of ["admin", "audit", "teams", "account"]) {
    assert.ok(shown.includes(key), `${key} must survive a layout that predates it`);
  }
  /*
   * The four are reported, and no BUILT-IN is reported that the layout already
   * knew about.
   *
   * This was `deepEqual` against exactly those four, which made it a test of
   * the whole workspace rather than of this layout: `stage-twentythree-sections`
   * creates a live custom section (`section:cctv-test`) against the same server
   * and the same workspace, and `node --test` runs the two files at the same
   * time. That section is genuinely new to this layout, so reporting it is
   * correct behaviour — and the run failed anyway, on whichever file happened
   * to be mid-flight. Running either file alone passed, which is the signature
   * of a race rather than a defect.
   *
   * The property worth pinning survives: a custom section may join the list,
   * but a built-in the layout already carries may never be called new.
   */
  const appeared = payload.layout.appeared;
  for (const key of ["account", "admin", "audit", "teams"]) {
    assert.ok(appeared.includes(key), `${key} must be reported as new to this layout`);
  }
  const unexpected = appeared.filter(
    (key) => !["account", "admin", "audit", "teams"].includes(key) && !key.startsWith("section:"),
  );
  assert.deepEqual(unexpected, [], "a section the layout already carried was reported as new");
  await clear();
});

test("live: a layout saved by one organisation is invisible to another", { skip: !live }, async () => {
  await clear();
  await call("/api/navigation", {
    method: "PUT",
    body: JSON.stringify({
      scope: "workspace",
      items: [heading(OPERATIONS), item("reports"), item("overview")],
    }),
  });
  const other = await (
    await call("/api/navigation", {}, "admin@demo-client-ltd.test.maintsupp.com")
  ).json();
  assert.equal(
    other.source,
    "builtin",
    "the other tenant's workspace default must not leak across",
  );
  await clear();
});

test("live: an empty or malformed save is refused", { skip: !live }, async () => {
  await clear();
  const empty = await call("/api/navigation", {
    method: "PUT",
    body: JSON.stringify({ scope: "user", items: [] }),
  });
  assert.equal(empty.status, 400);
  const junk = await call("/api/navigation", {
    method: "PUT",
    body: JSON.stringify({ scope: "user", items: "nonsense" }),
  });
  assert.equal(junk.status, 400);
  await clear();
});
