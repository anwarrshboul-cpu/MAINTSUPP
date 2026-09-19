/**
 * The intake form's share token, and who may be handed one.
 *
 * THE FINDING.
 *
 * `POST /api/board/form` says, in its own words, why creating a form needs
 * `board.edit`: it "MINTS AN UNAUTHENTICATED WRITE PATH into this
 * organisation's database, so it cannot be a read: a `client`, whose
 * capabilities are `board.view` and `data.export`, must not be able to publish
 * an intake by opening a tab."
 *
 * That reasoning was applied to minting and not to reading, and the two reach
 * the same place. A `client` could not create a form and did not need to: `GET`
 * handed them `shareToken`, `shortToken`, `shareUrl` and `presentedUrl` for the
 * form that already existed — a live, unauthenticated write path into the
 * workspace, publishable anywhere.
 *
 * Measured on `main` before the change, against a real `client` account:
 * `GET /api/board/form` answered 200 with all four fields populated, the token
 * it returned opened `/api/forms/<token>` with no session at all, and
 * `PATCH /api/board/form` refused that same account 403. Read the credential
 * with `board.view`; need `board.edit` to rotate it.
 *
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT.
 *
 * The four fields now follow the authority that mints and rotates them. The
 * route still answers `board.view`, because the Form tab is not capability-gated
 * in the UI and the builder draws the questions and the preview for anybody who
 * can open the board; taking the whole payload away would break a surface a
 * reader is entitled to. Nothing about `/api/forms/[token]` or its submit route
 * was touched, so a link already in somebody's hands keeps working — which the
 * live half below proves rather than assumes.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/* ================================================================== */
/* Source: the credential follows the authority that mints it          */
/* ================================================================== */

test("the serialiser withholds the credential unless the caller may mint one", async () => {
  const src = await read("app/api/board/form/route.ts");

  assert.match(
    src,
    /maySeeCredential: boolean,/,
    "the serialiser must take the decision as an argument",
  );
  assert.ok(
    !/maySeeCredential: boolean = /.test(src) && !/maySeeCredential\?: boolean/.test(src),
    "the parameter must be REQUIRED, not defaulted or optional — a future call " +
      "site has to decide rather than inherit the permissive answer by forgetting",
  );

  /*
   * All four together, or none. `shortToken` is not a lesser secret:
   * `loadFormByToken` matches EITHER against the same row, so withholding one
   * and sending the other would withhold nothing.
   */
  for (const field of [
    /shareToken: maySeeCredential \? record\.shareToken : ""/,
    /shortToken: maySeeCredential \? record\.shortToken : null/,
    /shareUrl: maySeeCredential \? shareUrl\(request, record\.shareToken\) : ""/,
    /presentedUrl: maySeeCredential \? presentedShareUrl\(request, record\) : ""/,
  ]) {
    assert.match(src, field, "every credential-bearing field must be conditional");
  }

  assert.match(
    src,
    /canShare: maySeeCredential,/,
    "the answer must be stated so the builder can leave the controls out rather " +
      "than draw an empty box",
  );
});

test("the GET resolves board.edit, and the write handlers pass it unconditionally", async () => {
  const src = await read("app/api/board/form/route.ts");

  assert.match(
    src,
    /const guard = await scopedDbWithCapability\(request, "board\.view"\);[\s\S]{0,800}?const mayShare = can\(subject, "board\.edit"\);/,
    "GET must still admit board.view and decide the credential on board.edit",
  );

  /* POST and PATCH already required `board.edit` to be reached at all, so they
     pass `true` — and PATCH must, or a rotation would hand back the OLD link. */
  assert.equal(
    (src.match(/^\s+true,$/gm) ?? []).length,
    2,
    "the two POST call sites must pass the literal true",
  );
  assert.match(
    src,
    /serialiseForm\(request, saved, await formOptionOverrides\(db, orgId, saved\.config\), true\)/,
    "PATCH must pass true — it may have just rotated the token",
  );
});

test("the browser is told, but the browser is not the boundary", async () => {
  const model = await read("app/(app)/portal/form-builder-model.ts");
  assert.match(model, /canShare: boolean;/);
  assert.match(
    model,
    /rendering hint, NOT the boundary/,
    "the model must record that the server empties the fields regardless",
  );

  const builder = await read("app/(app)/portal/form-builder.tsx");
  assert.match(builder, /\{form\.canShare && \(/, "the share controls must be conditional");
  assert.equal(
    (builder.match(/\{form\.canShare && \(/g) ?? []).length,
    2,
    "both the desktop pair and the phone strip must be gated",
  );
});

/* ================================================================== */
/* Live: the matrix, over HTTP                                         */
/* ================================================================== */

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:3000";
const OWNER = {
  email: process.env.MAINTSUPP_EMAIL ?? "owner@maintsupp.com",
  password: process.env.MAINTSUPP_PASSWORD ?? "Sunnamusk-Owner-2026",
};
const DEMO = "org_000000000000000000000002";
const STAMP = `${Date.now()}`;
const PASSWORD = `formtoken fixture ${STAMP} ok`;
const CREDENTIAL_FIELDS = ["shareToken", "shortToken", "shareUrl", "presentedUrl"];

function jar(existing, response) {
  const next = new Map(
    (existing ?? "").split("; ").filter(Boolean).map((p) => [p.split("=")[0], p]),
  );
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const pair = header.split(";")[0];
    next.set(pair.split("=")[0], pair);
  }
  return [...next.values()].join("; ");
}

async function call(cookie, path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const serverUp = await (async () => {
  try {
    const r = await fetch(`${BASE_URL}/api/context`, { signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
})();

let ownerCookie = null;
async function asOwner() {
  if (ownerCookie) return ownerCookie;
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OWNER),
  });
  if (!response.ok) return null;
  ownerCookie = jar("", response);
  return ownerCookie;
}

const invitedAccounts = [];
const createdJobs = [];

async function onboard(role, label) {
  const cookie = await asOwner();
  const email = `formtoken-${label}-${STAMP}@sec.test.maintsupp.com`;
  const created = await call(cookie, "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, role, organisationId: DEMO }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  invitedAccounts.push(email);
  const token = String(created.body.inviteUrl).split("/invite/")[1];
  const accepted = await fetch(`${BASE_URL}/api/auth/invitations/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, fullName: `FormToken ${label}` }),
  });
  assert.equal(accepted.status, 201);
  return { email, cookie: jar("", accepted) };
}

after(async () => {
  if (!serverUp || !ownerCookie) return;

  /*
   * Swept BY EXACT ID, never by a title prefix. `CLAUDE.md` records that a
   * substring sweep in this repository "has repeatedly eaten other fixtures",
   * and the submit response hands back the id it created, so there is no reason
   * to guess. MN-1049 is asserted against by name because it is the one row
   * other suites pin.
   */
  for (const id of createdJobs) {
    assert.notEqual(id, "MN-1049", "MN-1049 must never be touched");
    await call(ownerCookie, "/api/board?board=maintenance", {
      method: "POST",
      body: JSON.stringify({ action: "delete_items", requestIds: [id] }),
    });
    const bin = await call(ownerCookie, "/api/trash");
    const entry = (bin.body?.bin?.entries ?? []).find((row) => row.entityId === id);
    if (entry) await call(ownerCookie, `/api/trash?id=${entry.id}`, { method: "DELETE" });
  }

  if (!invitedAccounts.length) return;
  const roster = await call(ownerCookie, `/api/admin/users?organisationId=${DEMO}`);
  for (const user of roster.body?.users ?? []) {
    if (!invitedAccounts.includes(user.email) || !user.active) continue;
    await call(ownerCookie, "/api/admin/users", {
      method: "PATCH",
      body: JSON.stringify({ userId: user.id, action: "deactivate", organisationId: DEMO }),
    });
  }
});

test(
  "live: board.edit is handed the link, board.view is not",
  { skip: !serverUp },
  async (t) => {
    if (!(await asOwner())) return t.skip("the seeded owner could not sign in");

    /* An Owner holds `board.edit`, and so does a Manager by default. A Client
       holds `board.view` and `data.export` and nothing else. */
    const manager = await onboard("manager", "manager");
    const client = await onboard("client", "client");

    for (const [role, cookie] of [["owner", ownerCookie], ["manager", manager.cookie]]) {
      const { status, body } = await call(cookie, "/api/board/form?board=maintenance");
      assert.equal(status, 200, `${role} must still reach the builder`);
      assert.equal(body.form.canShare, true, `${role} holds board.edit`);
      assert.ok(body.form.shareToken, `${role} must still be handed the token`);
      assert.ok(
        String(body.form.presentedUrl).includes(body.form.shortToken ?? body.form.shareToken),
        `${role}'s presented link must carry one of the two locators`,
      );
    }

    const asClient = await call(client.cookie, "/api/board/form?board=maintenance");
    assert.equal(asClient.status, 200, "the builder still opens — the questions are readable");
    assert.equal(asClient.body.form.canShare, false);
    for (const field of CREDENTIAL_FIELDS) {
      assert.ok(
        !asClient.body.form[field],
        `${field} must be empty for a board.view-only reader — before this batch ` +
          "it carried a live unauthenticated write path",
      );
    }
    /* The questions still arrive, or the narrowing broke the surface. */
    assert.ok(asClient.body.form.config, "the form's configuration must still be served");
    assert.equal(typeof asClient.body.form.title, "string");
  },
);

test(
  "live: a board.view reader can neither mint nor rotate the credential",
  { skip: !serverUp },
  async (t) => {
    if (!(await asOwner())) return t.skip("the seeded owner could not sign in");
    const client = await onboard("client", "rotate");

    const minted = await call(client.cookie, "/api/board/form", {
      method: "POST",
      body: JSON.stringify({ board: "maintenance" }),
    });
    assert.equal(minted.status, 403, "creating an intake needs board.edit");

    const rotated = await call(client.cookie, "/api/board/form", {
      method: "PATCH",
      body: JSON.stringify({ board: "maintenance", regenerateToken: true }),
    });
    assert.equal(rotated.status, 403, "revoking the link needs board.edit");
  },
);

test(
  "live: a link already issued still works, anonymously, end to end",
  { skip: !serverUp },
  async (t) => {
    if (!(await asOwner())) return t.skip("the seeded owner could not sign in");

    /*
     * THE REQUIREMENT THIS BATCH COULD MOST EASILY HAVE BROKEN.
     *
     * The token is read as a Manager, so the form and the job it creates belong
     * to the DEMONSTRATION workspace rather than the live one. Deliberately:
     * this test posts a real submission, and a fixture in a customer's own
     * workspace is not a fixture, it is a job somebody has to triage.
     */
    const manager = await onboard("manager", "submit");
    const form = await call(manager.cookie, "/api/board/form?board=maintenance");
    const token = form.body.form.shareToken;
    assert.ok(token, "the manager must be handed a token to test with");

    const anonymous = await fetch(`${BASE_URL}/api/forms/${token}`);
    assert.equal(anonymous.status, 200, "an issued link must still open with no session");
    const published = await anonymous.json();
    const questions = published.form?.questions ?? [];
    assert.ok(questions.length > 0, "the public form must still carry its questions");

    const answers = {};
    for (const question of questions) {
      if (!question.required) continue;
      if (question.type === "SingleSelect") {
        answers[question.id] = (question.options ?? [])[0]?.value ?? "";
      } else if (question.type === "Number") {
        answers[question.id] = "1";
      } else if (question.type === "Date") {
        answers[question.id] = "2026-09-19";
      } else {
        answers[question.id] = `ZZQA-FORMTOKEN-${STAMP}`;
      }
    }

    const submitted = await fetch(`${BASE_URL}/api/forms/${token}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    const result = await submitted.json();

    /*
     * WHAT THIS ASSERTS, AND WHY IT IS NOT SIMPLY `=== 201`.
     *
     * The submit route runs its gates in order: resolve the token, then
     * availability, then login and password, and only then the answers. Those
     * first three are everything this batch could have broken — the change is to
     * who is HANDED a token, and a token that no longer resolved would fail
     * here as 404, a closed form as 410, a login-required one as 401.
     *
     * Reaching field validation therefore proves the whole credential path is
     * intact. Demanding 201 as well would make the test depend on the shape of
     * whichever workspace's form it happens to find: this one requires a
     * photograph, so a JSON body can never complete it, and hard-coding an
     * upload would test multipart rather than the token.
     *
     * So: 201 where the form can be completed by answers alone — and the job is
     * swept by its exact id — or a 400 that names a FIELD, which is the server
     * saying "your link is good, your answers are not".
     */
    assert.notEqual(submitted.status, 404, "an issued token must still resolve");
    assert.notEqual(submitted.status, 401, "an issued token must still authenticate");
    assert.notEqual(submitted.status, 410, "the form must still be open");

    if (submitted.status === 201) {
      assert.ok(result.request?.id, "a completed submission must return its job");
      createdJobs.push(result.request.id);
    } else {
      assert.equal(
        submitted.status,
        400,
        `the only acceptable refusal is a field-level one: ${JSON.stringify(result)}`,
      );
      assert.match(
        String(result.error ?? ""),
        /required/i,
        "a 400 must be about an ANSWER, not about the link",
      );
    }
  },
);

test(
  "live: a token that was never issued is refused, and says nothing",
  { skip: !serverUp },
  async (t) => {
    if (!(await asOwner())) return t.skip("the seeded owner could not sign in");

    /*
     * Rotation IS the revocation path (`PATCH { regenerateToken: true }`,
     * `board.edit`, and it replaces BOTH locators so the old short link dies
     * too). This test deliberately does not exercise it by rotating: the only
     * form reachable here is a real workspace's live intake, and rotating it
     * would break whatever links that workspace has already given out — a
     * destructive act for a test to perform. The authority to rotate is covered
     * above by the 403; what is left to prove here is that a token which is not
     * current buys nothing, which an unissued one shows without breaking anybody.
     */
    const bogus = "f".repeat(40);
    const read = await fetch(`${BASE_URL}/api/forms/${bogus}`);
    assert.equal(read.status, 404, "an unissued token must not resolve");

    const submit = await fetch(`${BASE_URL}/api/forms/${bogus}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: {} }),
    });
    assert.equal(submit.status, 404, "and must not accept a submission");

    /* Malformed input is refused by the shape check before any lookup. */
    const malformed = await fetch(`${BASE_URL}/api/forms/not-a-token`);
    assert.equal(malformed.status, 404);
  },
);
