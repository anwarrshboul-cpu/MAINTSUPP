import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * WORKSTREAM 7 — W07-02 (the compliance half) and W07-09.
 *
 * WHAT THESE PIN, AND WHY THEY ARE WRITTEN AS BEHAVIOUR
 *
 * `PATCH /api/workspace {entity:"compliance"}` is a deliberate FULL REPLACE: the
 * UPDATE names site, requirement, status, expiry and the not-required flag
 * unconditionally, because the calendar's compliance PATCH sends all four keys
 * and depends on every one of them landing. That design is correct and is kept.
 *
 * What it made dangerous is OMISSION. With a full-replace statement, a key left
 * out of the body is not a no-op — it is an erasure — and the route used to
 * treat silence as an instruction:
 *
 *   - omitting `expiry` CLEARED the stored expiry date;
 *   - omitting `state` silently downgraded a Compliant document to Missing;
 *   - `state` accepted any string at all, straight into the column;
 *   - `expiry` accepted "not-a-date", after which the compliance digest's date
 *     parser rejected it and `continue`d, so the document never alerted again
 *     while still rendering on screen — a certificate that had quietly stopped
 *     being watched;
 *   - `kind` went through `text()`, whose `trim()` does not strip zero-width
 *     characters, so a requirement could be named U+200B U+200B U+200B and drawn
 *     as a blank row nobody could search for or describe.
 *
 * Two suites used to guard this statement by matching its SOURCE TEXT
 * character-for-character. A source pin exists because somebody was burned by
 * the statement changing, and it is not deleted here — see
 * `tests/prebatch-workspace-hardening.test.mjs` and
 * `tests/acceptance-correction-one-calendar-data.test.mjs`, which keep a
 * structural check that all five columns are still replaced. What is added is
 * the stronger half: assertions on what the endpoint DOES, which survive a
 * reformat and would have caught every defect above.
 *
 * These talk to a running server, as `tests/workstream-six-contractor-scope.test.mjs`
 * does, and skip cleanly when it is not up.
 */

const BASE = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const OWNER = { email: "owner@maintsupp.com", password: "Sunnamusk-Owner-2026" };

/*
 * Run-scoped. The workspace API has NO hard delete for a compliance row — the
 * DELETE verb archives it by setting `Not required` — so a fixed name would make
 * the second run's register ambiguous and the suite would then fail with the
 * product behaving correctly. Same reasoning, and same shape, as the Workstream
 * 6 suites.
 */
const PREFIX = `W7OFF-${crypto.randomUUID().slice(0, 8)}`;

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

let cookie = "";

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function signIn() {
  let response;
  try {
    response = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(OWNER),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  cookie = (response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(";")[0])
    .join("; ");
  return Boolean(cookie);
}

/** Any real site in this workspace. The tests are about the document, not the site. */
async function anySiteId() {
  const { json } = await call("GET", "/api/workspace");
  return json?.workspace?.stores?.[0]?.id ?? null;
}

/**
 * The document as the SITE DETAIL screen receives it.
 *
 * Read back through `/api/sites?id=`, not out of the table, because that is the
 * payload a human actually sees and it is the one that must not have been
 * damaged. `status` here is the DERIVED state, so these assertions also cover
 * the register's classification.
 */
async function readBack(siteId, kind) {
  const { json } = await call("GET", `/api/sites?id=${encodeURIComponent(siteId)}`);
  return (json?.compliance ?? []).find((row) => row.kind === kind) ?? null;
}

async function createFixture(siteId, kind, data = {}) {
  const { json } = await call("POST", "/api/workspace", {
    entity: "compliance",
    data: { siteId, kind, state: "Compliant", expiry: "2028-06-30", ...data },
  });
  return json?.id ?? null;
}

/** Archive, which is the only removal this API has. Best effort. */
async function archive(id) {
  if (id) await call("DELETE", "/api/workspace", { entity: "compliance", id });
}

/* ── W07-02 — the PATCH must not destroy what it was not told about ───────── */

test("W07-02 — a PATCH that omits `expiry` leaves the stored expiry byte-for-byte intact", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const siteId = await anySiteId();
  if (!siteId) return t.skip("this workspace has no sites");

  const kind = `${PREFIX}-omit-expiry`;
  const id = await createFixture(siteId, kind, { expiry: "2027-06-30" });
  try {
    assert.ok(id, "the fixture was created");
    const before = await readBack(siteId, kind);
    assert.equal(before?.expiryDate, "2027-06-30", "the fixture starts with its date");

    const { status } = await call("PATCH", "/api/workspace", {
      entity: "compliance",
      id,
      data: { siteId, kind, state: "Compliant" },
    });
    assert.equal(status, 400, "a PATCH with no `expiry` key is refused, not applied");

    const after = await readBack(siteId, kind);
    assert.equal(
      after?.expiryDate,
      before?.expiryDate,
      "and the stored expiry is unchanged, character for character",
    );
  } finally {
    await archive(id);
  }
});

test("W07-02 — a PATCH that omits `state` does not downgrade a Compliant row to Missing", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const siteId = await anySiteId();
  if (!siteId) return t.skip("this workspace has no sites");

  const kind = `${PREFIX}-omit-state`;
  const id = await createFixture(siteId, kind, { expiry: "2028-06-30" });
  try {
    const before = await readBack(siteId, kind);
    assert.equal(before?.status, "Compliant", "the fixture starts Compliant");

    const { status } = await call("PATCH", "/api/workspace", {
      entity: "compliance",
      id,
      data: { siteId, kind, expiry: "2028-06-30" },
    });
    assert.equal(status, 400, "a PATCH with no `state` key is refused");

    const after = await readBack(siteId, kind);
    assert.equal(after?.status, "Compliant", "the document is still Compliant, not Missing");
  } finally {
    await archive(id);
  }
});

test("W07-02 — `state` is refused unless it is one of the five register words", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const siteId = await anySiteId();
  if (!siteId) return t.skip("this workspace has no sites");

  const kind = `${PREFIX}-bad-state`;
  const id = await createFixture(siteId, kind);
  try {
    for (const bad of ["Banana", "compliant", "Valid", ""]) {
      const { status } = await call("PATCH", "/api/workspace", {
        entity: "compliance",
        id,
        data: { siteId, kind, state: bad, expiry: "2028-06-30" },
      });
      assert.equal(status, 400, `"${bad}" is not a compliance state`);
    }
    // And the five real ones are all accepted, so this is a guard and not a wall.
    for (const good of ["Compliant", "Expiring soon", "Expired", "Missing", "Not required"]) {
      const { status } = await call("PATCH", "/api/workspace", {
        entity: "compliance",
        id,
        data: { siteId, kind, state: good, expiry: "2028-06-30" },
      });
      assert.equal(status, 200, `"${good}" is a compliance state`);
    }
  } finally {
    await archive(id);
  }
});

test("W07-02 — an unparseable expiry is refused rather than stored and silently forgotten", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const siteId = await anySiteId();
  if (!siteId) return t.skip("this workspace has no sites");

  const kind = `${PREFIX}-bad-date`;
  const id = await createFixture(siteId, kind, { expiry: "2027-06-30" });
  try {
    for (const bad of ["not-a-date", "31/12/2027", "2027-13-45", "soon"]) {
      const { status } = await call("PATCH", "/api/workspace", {
        entity: "compliance",
        id,
        data: { siteId, kind, state: "Compliant", expiry: bad },
      });
      assert.equal(status, 400, `"${bad}" is not a calendar date`);
    }
    const after = await readBack(siteId, kind);
    assert.equal(after?.expiryDate, "2027-06-30", "and the good date survived every attempt");
  } finally {
    await archive(id);
  }
});

test("W07-02 — a requirement named only in zero-width characters is refused", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const siteId = await anySiteId();
  if (!siteId) return t.skip("this workspace has no sites");

  // U+200B zero-width space, U+FEFF byte-order mark, U+00AD soft hyphen. Every
  // one of these survives `String.prototype.trim`.
  const invisible = "​​​";
  const created = await call("POST", "/api/workspace", {
    entity: "compliance",
    data: { siteId, kind: invisible, state: "Missing" },
  });
  assert.equal(created.status, 400, "POST refuses an invisible requirement name");

  const kind = `${PREFIX}-invisible`;
  const id = await createFixture(siteId, kind);
  try {
    for (const bad of [invisible, "﻿", "­‍"]) {
      const { status } = await call("PATCH", "/api/workspace", {
        entity: "compliance",
        id,
        data: { siteId, kind: bad, state: "Compliant", expiry: "2028-06-30" },
      });
      assert.equal(status, 400, "PATCH refuses an invisible requirement name");
    }
  } finally {
    await archive(id);
  }
});

/* ── The contract the full replace exists for ────────────────────────────── */

test("W07-02 — the calendar's four-key PATCH still replaces all four", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const siteId = await anySiteId();
  if (!siteId) return t.skip("this workspace has no sites");

  const kind = `${PREFIX}-calendar`;
  const id = await createFixture(siteId, kind, { expiry: "2028-06-30" });
  try {
    /*
     * Exactly the body `portal-app.tsx` sends when a certificate is dragged to a
     * new day on the calendar: site, requirement, state and the new expiry. This
     * is the request the full replace exists to serve, and it must keep working.
     */
    const { status } = await call("PATCH", "/api/workspace", {
      entity: "compliance",
      id,
      data: { siteId, kind, state: "Compliant", expiry: "2029-01-15" },
    });
    assert.equal(status, 200, "the calendar's PATCH is accepted");

    const after = await readBack(siteId, kind);
    assert.equal(after?.expiryDate, "2029-01-15", "the dragged date landed");
    assert.equal(after?.kind, kind, "the requirement survived the replace");
    assert.equal(after?.siteId, siteId, "the site survived the replace");
  } finally {
    await archive(id);
  }
});

test("W07-02 — an EXPLICIT null clears the expiry, so clearing on purpose still works", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const siteId = await anySiteId();
  if (!siteId) return t.skip("this workspace has no sites");

  const kind = `${PREFIX}-explicit-clear`;
  const id = await createFixture(siteId, kind, { expiry: "2028-06-30" });
  try {
    const { status } = await call("PATCH", "/api/workspace", {
      entity: "compliance",
      id,
      data: { siteId, kind, state: "Missing", expiry: null },
    });
    assert.equal(status, 200, "an explicit null is a legitimate instruction");
    const after = await readBack(siteId, kind);
    assert.equal(after?.expiryDate, null, "and it cleared the date");
  } finally {
    await archive(id);
  }
});

/* ── W07-09 — the stored status is never what a screen reads ─────────────── */

test("W07-09 — the state is recomputed from the date, never read back from the column", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const siteId = await anySiteId();
  if (!siteId) return t.skip("this workspace has no sites");

  const kind = `${PREFIX}-stale-status`;
  /*
   * Stored "Compliant" against a date three years in the past. This is exactly
   * the shape that used to survive for ever: a status written on the day it was
   * true, and a register that read the word rather than the date. It is also
   * reachable through the UI — the Manage register form offers all five words
   * and does not check them against the expiry beside them.
   */
  const id = await createFixture(siteId, kind, { state: "Compliant", expiry: "2024-01-01" });
  try {
    const row = await readBack(siteId, kind);
    assert.equal(
      row?.status,
      "Expired",
      "a certificate that lapsed in 2024 reads Expired however it was filed",
    );
    assert.equal(row?.state, row?.status, "and the two names for it agree");
  } finally {
    await archive(id);
  }
});

test("W07-09 — a recorded date is honoured even for a requirement the board does not know", async (t) => {
  if (!(await signIn())) return t.skip("the development server is not running");
  const siteId = await anySiteId();
  if (!siteId) return t.skip("this workspace has no sites");

  /*
   * A requirement outside the twelve board slots, with a good date far in the
   * future. The board cannot say whether this kind tracks an expiry, but
   * somebody recorded one, and that is the only evidence there is. Classifying
   * it as "Missing" — which is what happens if the date is discarded because the
   * NAME is unknown — would file a valid certificate under "nothing held".
   */
  const kind = `${PREFIX}-unknown-kind`;
  const id = await createFixture(siteId, kind, { state: "Missing", expiry: "2029-06-30" });
  try {
    const row = await readBack(siteId, kind);
    assert.equal(row?.status, "Compliant", "the recorded date decides it");
    assert.equal(row?.tracksExpiry, true, "and the row says a date is tracked for it");
  } finally {
    await archive(id);
  }
});

/* ── The structural half, kept ───────────────────────────────────────────── */

test("W07-02 — the compliance UPDATE still replaces every column the calendar sends", async () => {
  /*
   * The behavioural tests above are the stronger guard, but this one is not
   * redundant: the calendar's dependence on a FULL REPLACE is a structural claim
   * about the statement, and a statement quietly made partial would still pass
   * every behavioural test that sends all four keys. It is asserted on the
   * statement rather than on one line of it, so reformatting is free.
   */
  const route = await read("app/api/workspace/route.ts");
  const patchAt = route.indexOf("export async function PATCH");
  assert.ok(patchAt > 0, "the PATCH handler is findable");
  const branch = route.slice(route.indexOf('} else if (entity === "compliance") {', patchAt));
  const updateAt = branch.indexOf("db.update(complianceDocuments)");
  assert.ok(updateAt > 0, "the compliance UPDATE is findable");
  const statement = branch.slice(updateAt, branch.indexOf(";", updateAt) + 1);

  for (const column of [
    "siteId",
    "kind",
    "status: state",
    "expiryDate",
    'notRequired: state === "Not required"',
  ]) {
    assert.ok(statement.includes(column), `the PATCH still replaces ${column}`);
  }
});
