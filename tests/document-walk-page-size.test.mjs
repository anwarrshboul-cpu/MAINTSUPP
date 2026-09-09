/**
 * The register's walk page size and the endpoint's ceiling must agree.
 *
 *   node --test tests/document-walk-page-size.test.mjs
 *
 * The portal shell enters the document walk on mount, so the number of requests
 * one dashboard load makes is the size of the attachment estate divided by this
 * page size. At 100 a page, the monday migration's 3,107 attachments made that
 * 32 requests per load — and on a serverless host each request can be a cold
 * instance opening its own pool against a session-mode pooler. That is the
 * shape of EMAXCONNSESSION: many small invocations, not one greedy query.
 *
 * A walk size ABOVE the endpoint ceiling is the quiet failure this pins. The
 * walk would ask for 500, silently receive the ceiling, and take more pages
 * than its own arithmetic expects — which is exactly the regression that would
 * undo the fix without failing anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/*
 * Both constants are read from source rather than imported.
 * `document-register.ts` imports `../../lib/expiry-status` without a `.ts`
 * specifier — deliberately, because ten suites transpile that module to a
 * data: URL — so it cannot be loaded natively here. Reading the text is also
 * how the rest of this suite pins a contract.
 */
const route = await readFile("app/api/files/route.ts", "utf8");
const register = await readFile("app/(app)/portal/views/document-register.ts", "utf8");

const constant = (name) => {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(register);
  assert.ok(match, `could not read ${name}`);
  return Number(match[1]);
};
const DOCUMENT_WALK_SIZE = constant("DOCUMENT_WALK_SIZE");
const DOCUMENT_WALK_MAX_PAGES = constant("DOCUMENT_WALK_MAX_PAGES");

function endpointCeiling(source) {
  const match = /Number\(search\.get\("limit"\)\)\s*\|\|\s*(\d+),\s*1\),\s*(\d+)\)/.exec(source);
  assert.ok(match, "could not read the limit clamp from app/api/files/route.ts");
  return { fallback: Number(match[1]), ceiling: Number(match[2]) };
}

test("the walk never asks for more than the endpoint will return", () => {
  const { ceiling } = endpointCeiling(route);
  assert.ok(
    DOCUMENT_WALK_SIZE <= ceiling,
    `walk asks for ${DOCUMENT_WALK_SIZE} but /api/files caps at ${ceiling}`,
  );
});

test("the ceiling is high enough that a migrated estate is not 32 requests", () => {
  const { ceiling } = endpointCeiling(route);
  // 3,107 attachments is what the monday migration brings.
  const requests = Math.ceil(3107 / Math.min(DOCUMENT_WALK_SIZE, ceiling));
  assert.ok(requests <= 8, `one dashboard load would make ${requests} /api/files requests`);
});

test("the default page size is unchanged, so no existing caller moves", () => {
  // Only a caller that explicitly asks for more than 100 gets more than 100.
  assert.equal(endpointCeiling(route).fallback, 100);
});

test("the walk still refuses to be unbounded", () => {
  // The cap exists so one filter cannot become an unbounded fetch, and hitting
  // it is reported on screen rather than silently truncating a total.
  assert.ok(DOCUMENT_WALK_MAX_PAGES > 0);
  assert.ok(DOCUMENT_WALK_SIZE * DOCUMENT_WALK_MAX_PAGES <= 250_000);
});
