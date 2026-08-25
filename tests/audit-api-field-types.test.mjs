/**
 * Audit — PATCH /api/maintenance refuses a value the field cannot hold.
 *
 * `requestFieldValues` drops malformed values on purpose: it is shared with
 * the automation engine, where a rule firing with an impossible value should
 * not take the whole run down. Routed straight to a person's PATCH, that
 * became the one answer an API must never give — `{ tier: "abc" }` returned
 * 200 with the row unchanged, so the caller was told an edit had happened
 * that had not. A payload with one bad field beside good ones was worse: the
 * good ones were written and nothing said the rest had been ignored.
 *
 * `invalidRequestFields` mirrors the coercion rule for rule, and the route
 * refuses the whole payload before writing any of it. What must NOT change is
 * compatibility: an absent key is absent, an unknown key is still ignored, and
 * every shape a real client already sends still passes.
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

const fieldsModule = await (async () => {
  const source = await read("app/lib/request-fields.ts");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
})();

const { invalidRequestFields, requestFieldValues } = fieldsModule;

test("a value the field cannot hold is reported", () => {
  const bad = [
    [{ tier: "abc" }, "tier"],
    [{ tier: 99 }, "tier"],
    [{ tier: 2.5 }, "tier"],
    [{ cost: "free" }, "cost"],
    [{ dueAt: "not-a-date" }, "dueAt"],
    [{ requestedAt: 17 }, "requestedAt"],
    [{ description: 123 }, "description"],
    [{ status: false }, "status"],
    [{ contractor: 42 }, "contractor"],
    [{ source: "Telepathy" }, "source"],
    [{ parentId: 7 }, "parentId"],
  ];
  for (const [fields, key] of bad) {
    const problems = invalidRequestFields(fields);
    assert.equal(problems.length, 1, `${JSON.stringify(fields)} should report exactly one problem`);
    assert.ok(problems[0].startsWith(key), `the message must name ${key}: ${problems[0]}`);
  }
});

test("every shape a real client already sends is still accepted", () => {
  const good = [
    {},
    { cost: null },
    { cost: "" },
    { cost: 12.5 },
    { contractor: null },
    { assignee: null },
    { tier: 1 },
    { tier: 20 },
    { dueAt: "2026-10-05" },
    { dueAt: "2026-10-05T09:30:00.000Z" },
    { nextUpdateAt: null },
    { completedAt: "" },
    { source: "Manual" },
    { source: "Portal form" },
    { description: "", priority: "Low" },
    { somethingThisBuildHasNeverHeardOf: "x", priority: "Medium" },
    { parentId: null },
    { parentId: "MN-1000" },
  ];
  for (const fields of good) {
    assert.deepEqual(
      invalidRequestFields(fields),
      [],
      `${JSON.stringify(fields)} must still be accepted`,
    );
  }
});

test("the validator mirrors the coercion: anything it accepts is not silently dropped", () => {
  // The two must not drift. If a value passes validation it has to survive
  // coercion, or the caller gets a 200 for an edit that did not happen.
  const accepted = [
    ["tier", { tier: 3 }],
    ["cost", { cost: 40 }],
    ["priority", { priority: "High" }],
    ["contractor", { contractor: "Acme" }],
    ["dueAt", { dueAt: "2026-10-05" }],
  ];
  for (const [key, fields] of accepted) {
    assert.deepEqual(invalidRequestFields(fields), []);
    const values = requestFieldValues(fields);
    const written = Object.keys(values).length > 0;
    assert.ok(written, `${key} passed validation but coercion produced nothing`);
  }
});

test("a payload with one bad field is refused whole, so nothing is half-written", async () => {
  const problems = invalidRequestFields({ priority: "Low", tier: "abc" });
  assert.equal(problems.length, 1);

  const route = await read("app/api/maintenance/route.ts");
  const guard = route.slice(route.indexOf("if (fields) {"), route.indexOf("if (fields) {") + 400);
  assert.match(guard, /invalidRequestFields\(fields\)/);
  assert.match(guard, /status: 400/);
  // and it has to run before the write, not after
  assert.ok(
    route.indexOf("invalidRequestFields(fields)") < route.indexOf("requestFieldValues(fields)"),
    "the refusal must come before any value is written",
  );
});

test("the automation engine keeps its own drop-on-malformed behaviour", () => {
  // Deliberately unchanged: a rule must not fail a run over one bad value.
  const values = requestFieldValues({ tier: "abc", priority: "High" });
  assert.equal(values.tier, undefined, "coercion still drops rather than throws");
  assert.equal(values.priority, "High", "and still applies the good ones");
});
