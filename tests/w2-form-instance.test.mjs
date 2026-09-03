/**
 * W2 REQUIREMENT B — A FORM BELONGS TO ONE REGISTER.
 *
 * THE OWNER'S WORDS: "Form must be implemented section-scoped: its own form ID,
 * fields derived from the instance's own columns, its own persisted settings,
 * its own public/shared URL, and submissions / results / responses scoped to
 * that instance. Do NOT solve this by 404, by hiding the action, or by pointing
 * at canonical Jobs."
 *
 * WHAT WAS ACTUALLY THERE. `ensureFormBuilder` in db/init.ts seeds exactly one
 * `form_configurations` row per organisation, hard-coded to
 * `board_id = 'maintenance'`, and nothing else in the product ever wrote that
 * table. Both of the forbidden answers had already been tried:
 *
 *   · POINTING AT CANONICAL JOBS. `boardIdFrom` in /api/board/form was an
 *     allow-list of two keys with `DEFAULT_BOARD_KEY` as the fallback, so
 *     `?board=<any section>` served the JOB BOARD's public form — its title,
 *     its questions, and a Location list naming 39 real stores — and a PATCH
 *     from that screen rewrote the job board's live public form.
 *   · HIDING THE ACTION. `typesFor` in /api/board/views reports `form`,
 *     `form-results` and `form-responses` as UNBUILT for a board with no form
 *     row, so the tab could not be added at all. Its own comment says the other
 *     half "belongs to the form lane".
 *
 * This file holds the third answer: a register can be given a form OF ITS OWN,
 * and every read and write on it is keyed by the board.
 *
 * It skips cleanly with no server. Fixtures are prefixed `S2FQA` in both the
 * section key and the label, and are swept BY EXACT KEY and BY EXACT JOB ID —
 * never by substring, which has eaten other lanes' fixtures on this shared
 * database before.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
/* Purging needs `data.delete`, which `admin` is deliberately not given. */
const SUPER = "super-admin@test.maintsupp.com";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/*
 * `app/lib/form-derive.ts` is deliberately NOT imported.
 *
 * It imports `../../db/monday-board-spec` without a file extension, which
 * `node --test` cannot resolve — it strips types rather than compiling. Every
 * other test in this suite reads such a file as SOURCE for the same reason. So
 * the derivation is held here two ways: source pins on the properties that make
 * it a derivation rather than a copy, and the live test below, which compares
 * an instance's real question set against the real job board's.
 */

/* ------------------------------------------------------------------ */
/* 1. OWNERSHIP — every row a form touches is keyed by the board       */
/* ------------------------------------------------------------------ */

test("W2 B a destroyed register takes its share token with it", async () => {
  /*
   * `form_configurations` carries the PUBLIC token, and `deleteBoardStructure`
   * did not clear it: a form left behind still resolved at `/f/:token` and
   * still accepted submissions, filing rows onto a board that no longer
   * existed. Its unique index is (organisation, board, view), so it also
   * silently refused any future form on a board that reused the key.
   *
   * A SOURCE PIN because the runtime observable needs a database; the live test
   * at the bottom is the same contract end to end. If `deleteBoardStructure`
   * moves, re-point this at its new home — the contract is that the token stops
   * resolving before anything slower is attempted.
   */
  const registry = codeOnly(await source("app/lib/board-registry.ts"));
  const fn = registry.slice(registry.indexOf("export async function deleteBoardStructure"));
  assert.match(fn, /\.delete\(formConfigurations\)/, "the form must be deleted with the board");
  assert.match(
    fn,
    /eq\(formConfigurations\.boardId, boardKey\)/,
    "and deleted by BOARD, not by organisation — that would take every board's form",
  );
  assert.match(fn, /eq\(formConfigurations\.organisationId, organisationId\)/);
});

test("W2 B every form read is keyed by (organisation, board, view)", async () => {
  const config = codeOnly(await source("app/lib/form-config.ts"));
  const load = config.slice(config.indexOf("export async function loadForm"));
  assert.match(load, /eq\(formConfigurations\.organisationId, organisationId\)/);
  assert.match(load, /eq\(formConfigurations\.boardId, boardId\)/);
  assert.match(load, /eq\(formConfigurations\.viewKey, viewKey\)/);
});

test("W2 B a public token yields the board from the stored row, never the request", async () => {
  /*
   * The whole tenancy of the public surface in one property. `loadFormByToken`
   * is unscoped by design — an anonymous visitor has no tenant — so the ROW is
   * the only authority there is, and the submit route must take both the
   * organisation and the board from it.
   */
  const submit = codeOnly(await source("app/api/forms/[token]/submit/route.ts"));
  assert.match(submit, /const boardKey = record\.boardId;/, "the board comes from the form row");
  assert.doesNotMatch(
    submit,
    /searchParams/,
    "the public submit must not read a query parameter — a `?board=` override would be a cross-board write",
  );
  assert.doesNotMatch(
    submit,
    /boardId: "maintenance"/,
    "a cell was written with the literal board key, filing an answer given on one register onto another",
  );
  for (const scoped of [
    /eq\(maintenanceGroups\.boardId, boardKey\)/,
    /eq\(maintenanceBoardColumns\.boardId, boardKey\)/,
    /eq\(maintenanceGroupItems\.boardId, boardKey\)/,
  ]) {
    assert.match(submit, scoped, `a submission must read and write only its own board: ${scoped}`);
  }
  assert.match(
    submit,
    /organisationId: record\.organisationId/,
    "and only its own organisation",
  );

  const publicRead = codeOnly(await source("app/api/forms/[token]/route.ts"));
  assert.doesNotMatch(
    publicRead,
    /searchParams/,
    "the public read must not take a board, an organisation or anything else from the request",
  );
});

test("W2 B a submission is PLACED, so it cannot be claimed by whichever board loads first", async () => {
  /*
   * `maintenance_requests` carries no `board_id`: a row's board is decided by
   * its `maintenance_group_items` placement. This route wrote none, and the
   * consequence was not that the row went nowhere — `ensureBoardState` in
   * /api/board files every UNPLACED work order in the organisation onto
   * whichever board is being loaded, into `groups[0]`. A submission through a
   * section's form therefore landed on whichever register somebody opened
   * first, usually the job board.
   */
  const submit = codeOnly(await source("app/api/forms/[token]/submit/route.ts"));
  assert.match(submit, /\.insert\(maintenanceGroupItems\)/, "the placement is what puts it on a board");
  assert.match(submit, /boardId: boardKey/, "and it is placed on the form's own board");
  assert.match(
    submit,
    /onConflictDoNothing\(\)/,
    "request_id is that table's primary key — a retry must not move a row already filed",
  );

  const boardRoute = codeOnly(await source("app/api/board/route.ts"));
  assert.match(
    boardRoute,
    /if \(placed\.has\(request\.id\)\) continue;/,
    "the adopt-the-unplaced loop this defends against must still be the thing being defended against",
  );
});

/* ------------------------------------------------------------------ */
/* 2. DERIVED FROM THE INSTANCE'S OWN COLUMNS                          */
/* ------------------------------------------------------------------ */

test("W2 B the questions are derived from columns, not chosen by board key", async () => {
  const derive = await source("app/lib/form-derive.ts");
  const code = codeOnly(derive);

  assert.match(code, /export function deriveFormConfig/);
  assert.match(code, /export function deriveFormQuestions/);
  assert.match(
    code,
    /CANONICAL_QUESTION_BY_COLUMN\[column\.key\]/,
    "the canonical default is looked up by the COLUMN's identity",
  );

  /*
   * THE PROPERTY THAT MAKES IT A DERIVATION. Nothing in this module may consult
   * a board key, a board kind or a template name: the moment one of those
   * decides what a form asks, an operator's edit to their own columns stops
   * being reflected and the form is a copy again.
   */
  for (const forbidden of [
    /"maintenance"/,
    /"jobs"/,
    /DEFAULT_BOARD_KEY/,
    /boardKey/,
    /templateStructure/,
    /\bkind\b/,
  ]) {
    assert.doesNotMatch(
      code,
      forbidden,
      `the derivation must not branch on ${forbidden} — that is copying by board key`,
    );
  }
});

test("W2 B the canonical question ids the submit route hard-codes are all reachable", async () => {
  /*
   * The submit route reads seven answers by literal id into first-class fields
   * of a work order. If the derivation ever stopped producing one of those ids
   * the answer would be collected and silently dropped, which is precisely the
   * failure the "answers keyed by question id" design was introduced to end.
   * So the two lists are checked against each other here rather than trusted.
   */
  const derive = await source("app/lib/form-derive.ts");
  const submit = await source("app/api/forms/[token]/submit/route.ts");

  const handled = [
    "single_selecty9rcyhe",
    "short_text64",
    "numbertb4g1z46",
    "short_text",
    "single_select",
    "status",
    "date",
    "upload_file",
  ];
  for (const id of handled) {
    assert.match(
      derive,
      new RegExp(`"${id}"`),
      `${id} is read by the submit route but no column maps to it`,
    );
  }
  assert.match(submit, /LOCATION_QUESTION_ID/);
  assert.match(submit, /answerFor\("short_text64", 120\)/);
});

test("W2 B a group id is never carried across from another board", async () => {
  const derive = await source("app/lib/form-derive.ts");
  assert.match(
    derive,
    /features\.board = \{ \.\.\.features\.board, itemGroupId: null \}/,
    "a stored group id names a row on ONE board; inheriting one is a cross-board write",
  );
});

/* ------------------------------------------------------------------ */
/* 3. ITS OWN URL, AND WHO MAY MINT ONE                                */
/* ------------------------------------------------------------------ */

test("W2 B creating a form mints its own locators and needs board.edit", async () => {
  const config = codeOnly(await source("app/lib/form-config.ts"));
  const create = config.slice(config.indexOf("export async function createFormForBoard"));
  assert.match(create, /shareToken: generateShareToken\(\)/, "its own long link");
  assert.match(create, /shortToken: generateShortToken\(\)/, "and its own alias");
  assert.match(create, /boardId: board\.key/);
  assert.match(
    create,
    /onConflictDoNothing\(\)/,
    "two operators opening the tab at once must not mint two tokens for one board",
  );

  const route = codeOnly(await source("app/api/board/form/route.ts"));
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("type PatchBody"));
  assert.match(
    post,
    /scopedDbWithCapability\(request, "board\.edit"\)/,
    "creating a form publishes an UNAUTHENTICATED write path; a `client` must not be able to do it by opening a tab",
  );
  assert.match(post, /board\.archived/, "an archived register must not gain a public intake");
  assert.match(
    post,
    /eq\(maintenanceBoardColumns\.boardId, board\.key\)/,
    "the derivation's only input is this board's own columns",
  );
});

test("W2 B a token for an archived board stops resolving", async () => {
  /*
   * A SOURCE PIN, and honestly so: nothing in the product sets
   * `boards.archived` today, so there is no runtime path to drive this from. It
   * is here because a purge already revokes the token (`deleteBoardStructure`
   * deletes the row) and archiving — the reversible half of the same gesture —
   * did not, which would leave a live unauthenticated intake pointed at a
   * register somebody had taken out of the workspace.
   *
   * The guard is deliberately "a board row exists AND says archived" rather
   * than "a board row exists": forms predate `boards`, and failing closed on a
   * missing row would take live client forms off the air.
   */
  const config = await source("app/lib/form-config.ts");
  const fn = config.slice(
    config.indexOf("export async function loadFormByToken"),
    config.indexOf("export async function createFormForBoard"),
  );
  assert.match(fn, /\.from\(boards\)/);
  assert.match(fn, /if \(board\?\.archived\) return null;/);
  assert.match(
    fn,
    /if \(!shareToken \|\| !\/\^\[a-f0-9\]\{10,64\}\$\/i\.test\(shareToken\)\) return null;/,
    "a hostile path segment must never reach the query",
  );
});

/* ------------------------------------------------------------------ */
/* 4. MASS ASSIGNMENT                                                  */
/* ------------------------------------------------------------------ */

test("W2 B an answer to a question the form did not ask is discarded", async () => {
  /*
   * The seven reads below take their ids from CONSTANTS, not from the form. So
   * with an unfiltered `answers[id]` a caller posting straight to the endpoint
   * could set the job's Priority — and therefore its SLA tier and due date,
   * which `priorityRule` computes from it — on a form whose Priority question
   * the operator had HIDDEN. The same held for the requested date, the
   * engineer, and the description that becomes the job's title.
   */
  const submit = await source("app/api/forms/[token]/submit/route.ts");
  assert.match(
    submit,
    /const answerFor = \(id: string, max = 400\) =>\s*askedIds\.has\(id\) \? trimString\(answers\[id\], max\) : "";/,
    "every read of an answer must be gated on the question having been asked",
  );
  assert.match(
    submit,
    /const askedIds = new Set\(asked\.map\(\(question\) => question\.id\)\);/,
  );
  assert.match(
    submit,
    /visibleIds\.has\(id\) \? trimString\(answers\[id\], 400\) : ""/,
    "a conditional question's trigger must come from the visible set, or a hidden question can be revealed by answering one",
  );
  assert.match(
    submit,
    /MAX_SUBMISSION_BYTES/,
    "an unauthenticated writer must not be able to make the worker parse an unbounded document",
  );
});

test("W2 B a submission cannot choose its own group, board or reference", async () => {
  const submit = codeOnly(await source("app/api/forms/[token]/submit/route.ts"));
  /* The group comes from the STORED setting, resolved against this board. */
  assert.match(submit, /record\.config\.features\.board\?\.itemGroupId/);
  assert.match(
    submit,
    /boardGroups\.find\(\(group\) => group\.id === String\(configuredGroupId\)\)/,
    "a stored group id from another board must resolve to nothing, not to that board's group",
  );
  /* The id is minted from the organisation's own series, never taken. */
  assert.match(submit, /const id = `MN-\$\{Number\(latest\.maxNumber \?\? 1048\) \+ 1\}`/);
  assert.doesNotMatch(submit, /body\.id\b/);
  assert.doesNotMatch(submit, /body\.reference/);
  assert.doesNotMatch(submit, /body\.organisationId/);

  const derive = await source("app/lib/form-derive.ts");
  assert.match(
    derive,
    /new Set\(\["name", "move"\]\)/,
    "the Group picker must never become a question — that is the mass assignment, offered",
  );
});

/* ------------------------------------------------------------------ */
/* 5. THE BUILDER DOES NOT FALL BACK ONTO SOMEBODY ELSE'S FORM         */
/* ------------------------------------------------------------------ */

test("W2 B the builder never draws another register's form", async () => {
  const builder = await source("app/(app)/portal/form-builder.tsx");

  /*
   * RE-POINTED reasoning, same contract. `FormView` fetches `/api/context` and
   * posts to `/api/maintenance`, neither of which takes a board, so it is the
   * job board's live form wherever it is mounted. It used to be the fallback
   * for "this board has no form", which is how a section's Form tab rendered
   * "Maintenance Request", its questions and 39 real store names with a working
   * Submit. It is now mounted only where the server says it would file here.
   */
  assert.match(
    builder,
    /form\.filesIntoThisBoard === false \? \(\s*<FormPreview form=\{form\} \/>/,
    "on any other register the register's OWN form is rendered instead",
  );
  assert.doesNotMatch(
    builder,
    /if \(!form\) return <FormView/,
    "a board with no form must not fall back to the job board's form",
  );
  assert.match(
    builder,
    /Create a form for this register/,
    "the answer to 'this register has no form' is to make it one, not to hide the tab",
  );
  /* Both fetches carry the board, and both re-run when it changes. */
  const fetches = [...builder.matchAll(/\/api\/board\/form\?board=\$\{encodeURIComponent\(boardId\)\}/g)];
  assert.ok(fetches.length >= 3, `every call must name the board, found ${fetches.length}`);
  /*
   * The two effects that READ `boardId` must depend on it. They had `[]`, so
   * the builder kept whichever board it first mounted with: moving between two
   * registers left the Form tab editing, sharing, and SAVING to the previous
   * one. Asserted per call site rather than by banning `[]` outright, because
   * the matchMedia effect below legitimately has no dependencies.
   */
  const boardDependent = [...builder.matchAll(/\}, \[boardId\]\);/g)];
  assert.ok(
    boardDependent.length >= 3,
    `the load effect, the PATCH and the create must all re-run for a new board, found ${boardDependent.length}`,
  );
});

/* ------------------------------------------------------------------ */
/* 6. RESULTS AND RESPONSES                                            */
/* ------------------------------------------------------------------ */

test("W2 B a shared-link submission counts as a response", async () => {
  /*
   * `formResponses` matched `source === "Portal form"` and monday's imported
   * "Incoming form answer" title. The public submit route writes
   * `source: "Shared form"`, deliberately, so the board can tell a link
   * submission from one raised inside the product — and that value was in
   * neither branch. Every submission through a shared link was therefore absent
   * from Results and from the response viewer, on every board.
   */
  const views = await source("app/(app)/portal/views/parity-views.tsx");
  assert.match(views, /item\.source === "Portal form"/);
  assert.match(views, /item\.source === "Shared form"/);

  const submit = await source("app/api/forms/[token]/submit/route.ts");
  assert.match(submit, /source: "Shared form"/, "and that is still what the route writes");
});


/* ------------------------------------------------------------------ */
/* Against a running server                                            */
/* ------------------------------------------------------------------ */

/**
 * A request, retried while the database says "busy".
 *
 * The dev server runs one Miniflare D1, and a 5xx from it is a LOCK, not an
 * answer. Every assertion below is about a route's DECISION — 201 or 403, 200
 * or 404 — and a decision cannot be read off a reply that says the workspace
 * was too busy to make one. Bounded, and only on 5xx: a 4xx is an answer and is
 * returned immediately, so this can never turn a refusal into a pass.
 */
const BUSY_ATTEMPTS = 6;
async function sendRetrying(url, init) {
  let response;
  for (let attempt = 0; attempt < BUSY_ATTEMPTS; attempt += 1) {
    response = await fetch(url, init);
    if (response.status < 500) return response;
    await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
  }
  return response;
}

function call(path, options = {}, identity = ADMIN) {
  return sendRetrying(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-maintsupp-identity": identity,
      ...(options.headers ?? {}),
    },
  });
}

/** Anonymous — no identity header at all, which is the public surface. */
function anonymous(path, options = {}) {
  return sendRetrying(`${BASE_URL}${path}`, {
    ...options,
    headers: { Accept: "application/json", ...(options.headers ?? {}) },
  });
}

async function body(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

/**
 * Whether a dev server is answering, decided ONCE and generously.
 *
 * ANY reply means it is up, a 5xx included: a 503 here is the local D1 saying
 * it is busy, not the server saying it is absent, and requiring `status < 500`
 * has silently skipped whole files under load before.
 */
let serverUp = null;
async function serverIsUp() {
  if (serverUp !== null) return serverUp;
  try {
    await fetch(`${BASE_URL}/api/workspace-sections`, {
      headers: { Accept: "application/json", "x-maintsupp-identity": ADMIN },
      signal: AbortSignal.timeout(30000),
    });
    serverUp = true;
  } catch {
    serverUp = false;
  }
  return serverUp;
}

/*
 * Three fixtures, created ONCE for the whole file.
 *
 * Provisioning a section is not cheap — a Jobs instance is 26 columns, six
 * groups, a view and a board row — and building two of them per test starved
 * the one Miniflare D1 this dev server has: measured, a single test took 47
 * seconds and the sweep that followed it never completed, so the NEXT test was
 * refused with "a section called S2FQA Alpha already exists" and blamed the
 * code under test. One setup, subtests underneath it, one sweep.
 */
const KEYS = {
  alpha: "section:s2fqa-alpha",
  beta: "section:s2fqa-beta",
  doomed: "section:s2fqa-doomed",
};

/**
 * Swept BY EXACT KEY and BY EXACT JOB ID.
 *
 * A submission puts a work order on the register, and a register with an item —
 * live, or merely in the recycle bin — refuses to be purged. So the jobs this
 * file created are binned and then emptied out of the bin first, by the ids the
 * submit responses actually returned. A substring sweep over titles has eaten
 * other lanes' fixtures on this shared database before, and `section:testtt` on
 * Staging is the OWNER'S data.
 */
async function sweep(jobs = []) {
  for (const { id, board } of jobs) {
    await call("/api/board", {
      method: "POST",
      body: JSON.stringify({ action: "delete_items", board, requestIds: [id] }),
    });
    const bin = await body(await call("/api/trash", {}, SUPER));
    const entry = (bin.bin?.entries ?? []).find((row) => row.entityId === id);
    if (entry) {
      await call(`/api/trash?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" }, SUPER);
    }
  }
  for (const key of Object.values(KEYS)) {
    await call(`/api/workspace-sections?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    await call(
      `/api/workspace-sections?key=${encodeURIComponent(key)}&purge=1`,
      { method: "DELETE" },
      SUPER,
    );
  }
}

/**
 * The FIXTURES could not be built because the database said busy.
 *
 * Distinguished from an assertion failure on purpose. `sendRetrying` already
 * absorbs a burst of D1 locks, but the local Miniflare is shared with every
 * other agent working in this tree and a sustained one outlasts any bounded
 * backoff — measured, `/api/workspace-sections` returned `Failed query: select
 * ... from organisations` for about a minute. A setup that never completed
 * proves nothing about the route under test, so these tests skip rather than
 * fail, exactly as they do when no server is there at all. An assertion that
 * did run still fails normally.
 */
class Busy extends Error {}

function onlyBusy(context, caught) {
  if (caught instanceof Busy) {
    context.skip(caught.message);
    return;
  }
  throw caught;
}

async function makeInstance(key, label) {
  const response = await call("/api/workspace-sections", {
    method: "POST",
    body: JSON.stringify({ key, label }),
  });
  const payload = await body(response);
  if (response.status >= 500) {
    throw new Busy(`the database was busy creating ${key}: ${payload.error}`);
  }
  assert.equal(response.status, 201, `creating ${key} failed: ${payload.error}`);
  return payload.section.boardKey;
}

async function makeForm(boardKey) {
  const response = await call(`/api/board/form?board=${encodeURIComponent(boardKey)}`, {
    method: "POST",
  });
  const payload = await body(response);
  if (response.status >= 500) {
    throw new Busy(`the database was busy creating a form on ${boardKey}: ${payload.error}`);
  }
  assert.equal(response.status, 201, `creating a form on ${boardKey} failed: ${payload.error}`);
  return payload;
}

test("live: a register's form is its own, and so is everything sent to it", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  const jobs = [];
  try {
    const alpha = await makeInstance(KEYS.alpha, "S2FQA Alpha");
    const beta = await makeInstance(KEYS.beta, "S2FQA Beta");
    const a = await makeForm(alpha);
    const b = await makeForm(beta);
    const canonical = await body(await call("/api/board/form?board=maintenance"));

    await t.test("two registers get two form ids and two links", () => {
      assert.notEqual(a.form.id, b.form.id, "one form id for two registers");
      assert.notEqual(a.form.shareToken, b.form.shareToken, "one share token for two registers");
      assert.notEqual(a.form.shortToken, b.form.shortToken, "one short link for two registers");
      assert.equal(a.form.boardKey, alpha);
      assert.equal(b.form.boardKey, beta);
    });

    await t.test("and neither of them is the job board's", () => {
      /* THE LEAK, asserted directly. `?board=<a section>` used to serve this. */
      assert.notEqual(a.form.id, canonical.form?.id, "the instance is editing the JOB BOARD's form");
      assert.notEqual(a.form.shareToken, canonical.form?.shareToken);
      assert.equal(a.form.title, "S2FQA Alpha", "the form is titled after its own register");
      assert.equal(canonical.form?.title, "Maintenance Request", "and the job board's is untouched");
      assert.equal(
        a.form.filesIntoThisBoard,
        false,
        "and the job board's live fillable form is not mounted on it",
      );
    });

    await t.test("creating twice is the same form, not a second token", async () => {
      const again = await call(`/api/board/form?board=${encodeURIComponent(alpha)}`, {
        method: "POST",
      });
      const repeat = await body(again);
      assert.equal(again.status, 200);
      assert.equal(repeat.created, false);
      assert.equal(
        repeat.form.shareToken,
        a.form.shareToken,
        "a second press must not revoke the link already handed out",
      );
    });

    await t.test("a Jobs instance asks the job board's questions, in its order", async (sub) => {
      if (!canonical.form) {
        sub.skip("the job board has no form on this database");
        return;
      }
      const ids = (form) => (form.config?.questions ?? []).map((question) => question.id).sort();
      assert.deepEqual(
        ids(a.form),
        ids(canonical.form),
        "a Jobs instance has the job board's columns, so it must DERIVE the job board's questions",
      );
      const titles = async (token) => {
        const payload = await body(await anonymous(`/api/forms/${token}`));
        return (payload.form?.questions ?? []).map((question) => question.title);
      };
      assert.deepEqual(
        await titles(a.form.shareToken),
        await titles(canonical.form.shareToken),
        "and ask them in the same order",
      );
    });

    await t.test("a token resolves to its own register and to no other", async () => {
      const readA = await body(await anonymous(`/api/forms/${a.form.shareToken}`));
      const readB = await body(await anonymous(`/api/forms/${b.form.shareToken}`));
      assert.equal(readA.state, "open");
      assert.equal(readA.form.title, "S2FQA Alpha");
      assert.equal(readB.form.title, "S2FQA Beta");
      assert.equal(readA.form.token, a.form.shareToken);

      /* The short alias is a second locator for the SAME form, not another. */
      const short = await body(await anonymous(`/api/forms/${a.form.shortToken}`));
      assert.equal(short.form?.title, "S2FQA Alpha");

      /* A token that does not exist must read exactly like one that does not
         belong to you, or the endpoint is an oracle for guessing tokens. */
      const missing = await anonymous(`/api/forms/${"0".repeat(64)}`);
      assert.equal(missing.status, 404);
      assert.deepEqual(await body(missing), { error: "This form could not be found." });
    });

    await t.test("a submission lands on its own register; ?board= is ignored", async (sub) => {
      const open = await body(await anonymous(`/api/forms/${a.form.shareToken}`));
      const location = (open.form?.questions ?? []).find(
        (question) => question.id === "single_selecty9rcyhe",
      );
      const site = location?.options?.[0]?.value;
      if (!site) {
        sub.skip("this workspace has no sites, so no location can be submitted");
        return;
      }

      /*
       * `?board=maintenance` on the public submit — the override this subtest
       * exists for. The route reads no query parameter at all, so it must be
       * inert: the job lands on the FORM's board, which is what the row says.
       */
      const response = await anonymous(
        `/api/forms/${a.form.shareToken}/submit?board=maintenance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answers: {
              single_selecty9rcyhe: site,
              short_text64: "S2FQA manager",
              numbertb4g1z46: "0000000000",
              short_text: "S2FQA fixture — lane F verification, safe to delete.",
              single_select: "Other",
              status: "Low",
              date: "2026-09-03",
            },
            /* Declared, not uploaded. A required File question is satisfied by a
               non-zero declaration; the single-use grant is what binds real
               files, and none are sent here. */
            fileCount: 1,
          }),
        },
      );
      const created = await body(response);
      assert.equal(response.status, 201, `the submission failed: ${created.error}`);
      const jobId = created.request.id;
      jobs.push({ id: jobId, board: alpha });

      const placedOn = async (boardKey) => {
        const payload = await body(await call(`/api/board?board=${encodeURIComponent(boardKey)}`));
        return (payload.items ?? []).some((item) => item.requestId === jobId);
      };

      assert.equal(
        await placedOn(alpha),
        true,
        "the submission must be on the register it was sent to",
      );
      assert.equal(await placedOn(beta), false, "and invisible from the other instance");
      assert.equal(
        await placedOn("maintenance"),
        false,
        "and invisible from canonical Jobs, whatever the query string asked for",
      );

      /* It is a form RESPONSE, which is what Results and the viewer count. */
      const payload = await body(await call(`/api/board?board=${encodeURIComponent(alpha)}`));
      const row = (payload.requests ?? []).find((request) => request.id === jobId);
      assert.ok(row, "the register must be able to see its own submission");
      assert.equal(row.source, "Shared form");
      assert.equal(row.location, site, "and it must carry the answer it was given");
    });

    await t.test("a reader may not mint a public form link", async () => {
      /*
       * A `client` holds `board.view` and `data.export` and nothing else.
       * Creating a form publishes an UNAUTHENTICATED write path into this
       * organisation's database, so it must be refused whether or not one
       * already exists — the capability is checked before anything is read.
       */
      const refused = await call(
        `/api/board/form?board=${encodeURIComponent(beta)}`,
        { method: "POST" },
        "client@test.maintsupp.com",
      );
      assert.ok(
        refused.status === 401 || refused.status === 403,
        `a reader must not be able to mint a public form link, got ${refused.status}`,
      );
    });
  } catch (caught) {
    onlyBusy(t, caught);
  } finally {
    await sweep(jobs);
  }
});

test("live: a purged register's token stops resolving", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  await sweep();
  try {
    const doomed = await makeInstance(KEYS.doomed, "S2FQA Doomed");
    const form = (await makeForm(doomed)).form;
    assert.equal((await anonymous(`/api/forms/${form.shareToken}`)).status, 200);

    await call(`/api/workspace-sections?key=${KEYS.doomed}`, { method: "DELETE" });
    const purged = await call(
      `/api/workspace-sections?key=${KEYS.doomed}&purge=1`,
      { method: "DELETE" },
      SUPER,
    );
    assert.equal(purged.status, 200, "the purge itself must succeed");
    assert.equal((await body(purged)).board, doomed);

    /*
     * THE WHOLE POINT. A form left behind still resolves and still accepts
     * submissions, filing rows onto a board that no longer exists — a live
     * unauthenticated intake surviving the deliberate destruction of the thing
     * it belonged to. Both locators must be dead.
     */
    assert.equal(
      (await anonymous(`/api/forms/${form.shareToken}`)).status,
      404,
      "the share link must not outlive the register",
    );
    assert.equal(
      (await anonymous(`/api/forms/${form.shortToken}`)).status,
      404,
      "and neither must the short alias",
    );

    const submitted = await anonymous(`/api/forms/${form.shareToken}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: {}, fileCount: 0 }),
    });
    assert.equal(submitted.status, 404, "and it must not still accept submissions");
  } catch (caught) {
    onlyBusy(t, caught);
  } finally {
    await sweep();
  }
});
