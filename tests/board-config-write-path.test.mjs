/**
 * THE JOBS BOARD'S TWO BLANKET 503s, AND WHAT THEY WERE HIDING.
 *
 * The reported fault was a banner reading "Views could not be loaded." above a
 * board, and a toast reading "The board change could not be saved." when a
 * column was added — both at once, on the live deployment, signed in as the
 * owner. Neither sentence named a cause and neither offered anything to do.
 *
 * The cause was not the board. It was Supabase's session-mode pooler running
 * out of clients: `(EMAXCONNSESSION) max clients reached in session mode - max
 * clients are limited to pool_size: 15`, recorded 181 times across twenty days
 * on the production project, spread over `/api/board/members`,
 * `/api/board/settings`, `/api/automations` and the dashboard. Opening the Jobs
 * board fires eight of those requests at once, which is why that page is where
 * an operator meets it.
 *
 * Two things made it unreadable, and this file pins the fix for both:
 *
 *   1. Both board routes collapsed EVERY throw into one 503 sentence, so a
 *      momentary capacity limit was indistinguishable from a permission
 *      problem or a board that does not exist. One of those is worth retrying
 *      and the others are not.
 *   2. `/api/board` and `/api/board/views` were the only two board routes with
 *      no `console.error` in the catch — which is exactly why neither appears
 *      in the deployment's error clusters while their siblings, failing in the
 *      same minute for the same reason, all do.
 *
 * Reads normalise CRLF — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/*
 * `db/pooler-capacity.ts` imports nothing, which is what makes it loadable
 * here at all: a data: URL resolves relative specifiers against the data URL
 * itself, so a module with even one import cannot be run this way. That is not
 * an accident of this test — it is why the predicate was given its own file
 * rather than being left in `db/node-pg-d1.ts`, which reaches for `postgres`
 * through `createRequire` and is Node-only.
 */
const capacity = await (async () => {
  const source = await read("db/pooler-capacity.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
})();

/*
 * Both shapes are copied from the production project's own error clusters, and
 * they are different shapes on purpose. The driver throws the first; by the
 * time a route's catch sees it, the adapter has re-thrown it as the second,
 * with `D1_ERROR:` in front and the failing statement behind. A predicate that
 * only matched the first would be correct in the driver and useless in the
 * route, which is the layer that has to explain it to somebody.
 */
const DRIVER_REFUSAL =
  "(EMAXCONNSESSION) max clients reached in session mode - " +
  "max clients are limited to pool_size: 15";
const WRAPPED_REFUSAL =
  "D1_ERROR: (EMAXCONNSESSION) max clients reached in session mode - " +
  "max clients are limited to pool_size: 30: SELECT id, email, password_hash";

test("the pooler's refusal is recognised as the driver throws it", () => {
  assert.equal(capacity.isPoolerAtCapacity({ message: DRIVER_REFUSAL }), true);
});

test("and still recognised once the adapter has wrapped it", () => {
  assert.equal(capacity.isPoolerAtCapacity(new Error(WRAPPED_REFUSAL)), true);
});

test("a raised pool_size does not stop it being recognised", () => {
  // The project's limit was moved from 15 to 30 and the refusals continued, so
  // the number must not be part of the match.
  for (const size of [15, 30, 60]) {
    const message = `(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: ${size}`;
    assert.equal(capacity.isPoolerAtCapacity({ message }), true, `pool_size ${size}`);
  }
});

test("nothing else is mistaken for it", () => {
  /*
   * The whole value of this predicate is that it is NARROW. `node-pg-d1.ts`
   * retries on it, and retrying is only safe because the refusal is issued
   * during the client startup exchange, before a Parse or a Bind — so the
   * statement provably did not run. A widened predicate would retry writes
   * through a socket that dropped mid-statement, and that is a duplicate row.
   */
  const others = [
    new Error("D1_ERROR: function pg_catalog.btrim(date) does not exist"),
    new Error("CONNECTION_CLOSED"),
    new Error("password authentication failed for user \"postgres\""),
    new Error("duplicate key value violates unique constraint"),
    { message: 42 },
    null,
    undefined,
  ];
  for (const error of others) {
    assert.equal(capacity.isPoolerAtCapacity(error), false, String(error));
  }
});

test("one author for the rule: node-pg-d1 imports it rather than restating it", async () => {
  const adapter = await read("db/node-pg-d1.ts");
  assert.match(
    adapter,
    /import \{ isPoolerAtCapacity \} from "\.\/pooler-capacity\.ts";/,
    "the adapter must import the predicate",
  );
  assert.doesNotMatch(
    adapter,
    /function isPoolerAtCapacity/,
    "a second definition here is how the two layers come to disagree",
  );
  /*
   * The `.ts` extension is load-bearing and not a style choice:
   * `tests/node-pg-d1.test.mjs` imports this module natively, and Node
   * resolves ESM specifiers literally. Dropping it took both node-pg-d1 suites
   * out on load once already — see docs/PRE-W14-REGRESSION.md.
   */
  assert.match(adapter, /from "\.\/sqlite-to-postgres\.ts"/);
});

test("busyRefusal answers with a retryable 503, not a blanket one", async () => {
  const source = await read("app/lib/tenant-db.ts");
  assert.match(source, /export function busyRefusal\(/);
  const body = source.slice(source.indexOf("export function busyRefusal("));
  assert.match(body, /isPoolerAtCapacity\(error\)/, "it must ask the shared predicate");
  assert.match(body, /status: 503/);
  assert.match(body, /retry: true/, "the flag a client branches on without parsing prose");
  assert.match(body, /"Retry-After": "2"/, "the same fact for anything that speaks HTTP");
  assert.match(
    body,
    /capacity, not permissions/,
    "the sentence exists to separate a full pool from a permission it is not",
  );
});

test("both board routes classify capacity before the generic 503, and log the rest", async () => {
  for (const file of ["app/api/board/route.ts", "app/api/board/views/route.ts"]) {
    const source = await read(file);
    assert.match(source, /busyRefusal/, `${file} must classify a full pool`);

    /*
     * ORDER IS THE WHOLE POINT. `anonymousRefusal` and `busyRefusal` both have
     * to run BEFORE the generic arm, because the generic arm only ever sees a
     * message and cannot tell any of them apart. A classifier placed after it
     * is dead code that still reads as a fix.
     */
    const busyAt = source.indexOf("busyRefusal(error");
    const genericAt = source.search(/error: "(The board change could not be saved|Board views are temporarily unavailable)/);
    assert.ok(busyAt > 0 && genericAt > 0, `${file}: both arms must exist`);
    assert.ok(busyAt < genericAt, `${file}: busyRefusal must be reached before the blanket 503`);

    /*
     * These two routes were the only board routes that swallowed their error
     * without a trace, which is why the fault could be seen on a screen and
     * not in the logs. `/api/board/members`, `/api/board/settings` and
     * `/api/board/csv` have always done this.
     */
    const logAt = source.indexOf("console.error");
    assert.ok(logAt > 0, `${file}: the swallowed error must be logged`);
    assert.ok(logAt < genericAt, `${file}: log before answering, not after`);
  }
});

test("the tab strip shows the server's reason instead of a constant", async () => {
  const loader = await read("app/(app)/portal/board-views-load.ts");

  /*
   * THE LINE THIS FILE EXISTS FOR. The loader used to read
   * `if (!response.ok) throw new Error("Views could not be loaded.")`, which
   * read the route's answer and discarded it. Every failure — a full pool, a
   * board this organisation does not have, an ended session — arrived on
   * screen as that one sentence.
   */
  assert.doesNotMatch(
    loader,
    /throw new Error\("Views could not be loaded\."\)/,
    "the server's reason must not be replaced by a constant",
  );
  assert.match(loader, /payload\.error \?\? "Views could not be loaded\."/, "…only fallen back to");
  assert.match(loader, /retryable: payload\.retry === true/, "Retry follows the server, not the status");
});

test("Retry is offered only where repeating the request could work", async () => {
  const chrome = await read("app/(app)/portal/board-chrome.tsx");
  assert.match(chrome, /error\.retryable && \(/, "the button is conditional on the server's flag");
  assert.match(chrome, /Retry/);
  // A board that does not exist is a 404 with no `retry` flag, so the button
  // must not be drawn for it. A control that cannot work is worse than none.
  assert.doesNotMatch(chrome, /\{error && \([\s\S]{0,400}?Retry\s*<\/button>[\s\S]{0,80}?\)\}\s*<button[^>]*Dismiss/);
});

test("a failed view write reports whether it is worth repeating", async () => {
  const writes = await read("app/(app)/portal/board-view-writes.ts");
  assert.match(writes, /retryable: payload\.retry === true/);
  assert.match(writes, /error: string; retryable: boolean/, "the failure shape carries both facts");
});

test("the strip's three states are distinguishable", async () => {
  const loader = await read("app/(app)/portal/board-views-load.ts");
  const chrome = await read("app/(app)/portal/board-chrome.tsx");
  assert.match(loader, /loading: boolean/, "loading is a state, not an inference");
  assert.match(chrome, /aria-busy=\{loading \|\| undefined\}/);
  /*
   * EMPTY DELIBERATELY STAYS SILENT. The built-in Store Documentation board
   * holds no `board_views` rows on purpose — it declares its three tabs in
   * `views/store-documentation-board.tsx` and would draw two strips if this
   * drew a second. A "no views yet, create one" panel would therefore be wrong
   * exactly where it appeared, so the third state is readable rather than
   * announced. This assertion is here so that stays a decision and not a
   * regression somebody re-opens.
   */
  assert.doesNotMatch(chrome, /No saved views yet/);
});
