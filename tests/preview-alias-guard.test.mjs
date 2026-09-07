/**
 * The preview alias script's production guard, exercised rather than pinned.
 *
 * The script moves `maintsupp-preview.vercel.app` onto a verified Preview
 * deployment, and its last act is to check that no production deployment
 * appeared because of the run. That check used to assert the project had NO
 * production URL at all, which was true when it was written. Two production
 * deployments were made by hand on 2026-09-05, so the project reports its
 * configured custom domain now and the check fired on every ordinary run —
 * printing a warning and exiting 1 AFTER successfully moving the alias, so a
 * normal update reported failure. A warning that always fires is one nobody
 * reads.
 *
 * What it watches for now is a CHANGE across the assignment, plus a value that
 * is neither "--" nor the domain it was told to expect. That is a pure function
 * of three strings, so these tests run it directly: no network, no Vercel
 * account, no deployment.
 *
 * The gates that do the real work are earlier in the script and are asserted
 * here too, because a guard that has been quietly weakened is worse than one
 * that never existed.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = "scripts/update-preview-alias.sh";

const load = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** Is there a bash to run? Windows without Git Bash has none. */
function haveBash() {
  try {
    execFileSync("bash", ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the script's own `production_verdict` with the three strings it takes.
 *
 * The function is lifted out of the file rather than copied into this test: a
 * copy would keep passing after the original had been changed, which is the
 * one thing this test exists to prevent.
 */
async function verdict(before, after, expected) {
  const source = await load(SCRIPT);
  const fn = source.match(/^production_verdict\(\) \{[\s\S]*?\n\}/m);
  assert.ok(fn, "the script must still keep this decision in a function of its inputs");

  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
  const program = `${fn[0]}\nproduction_verdict ${quote(before)} ${quote(after)} ${quote(expected)}`;

  try {
    const out = execFileSync("bash", ["-c", program], { encoding: "utf8" });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const EXPECTED = "https://maintsupp.com";

test("a legitimate, unchanged production URL is not a warning", { skip: !haveBash() }, async () => {
  const stable = await verdict(EXPECTED, EXPECTED, EXPECTED);
  assert.equal(
    stable.code,
    0,
    "this is what every ordinary preview update now looks like, and it used to exit 1",
  );
  assert.doesNotMatch(stable.out, /WARNING/, `it printed: ${stable.out.trim()}`);

  const none = await verdict("--", "--", EXPECTED);
  assert.equal(none.code, 0, 'a project with no production deployment at all still passes');
  assert.doesNotMatch(none.out, /WARNING/);
});

test("a production URL that appears during the run is a warning", { skip: !haveBash() }, async () => {
  const appeared = await verdict("--", EXPECTED, EXPECTED);
  assert.equal(appeared.code, 1, "an alias assignment must not produce a production deployment");
  assert.match(appeared.out, /WARNING/);
  assert.match(appeared.out, /changed during this run/);
  assert.match(appeared.out, /before: --/);
  assert.match(appeared.out, /after: {2}https:\/\/maintsupp\.com/);
});

test("a production URL that changes to something else is a warning", { skip: !haveBash() }, async () => {
  const moved = await verdict(EXPECTED, "https://not-ours.example", EXPECTED);
  assert.equal(moved.code, 1);
  assert.match(moved.out, /changed during this run/);
});

test("a stable but unexpected production URL is a warning too", { skip: !haveBash() }, async () => {
  const odd = await verdict("https://someone-else.example", "https://someone-else.example", EXPECTED);
  assert.equal(
    odd.code,
    1,
    "it did not change during this run, so the script did not cause it — but the project is not the one the script was told about",
  );
  assert.match(odd.out, /neither "--" nor the expected/);
  assert.doesNotMatch(
    odd.out,
    /changed during this run/,
    "and it must say which of the two things went wrong",
  );
});

test("an unreadable project table is a note, not a failure", { skip: !haveBash() }, async () => {
  for (const [before, after] of [["", EXPECTED], [EXPECTED, ""]]) {
    const unreadable = await verdict(before, after, EXPECTED);
    assert.equal(
      unreadable.code,
      0,
      "a warning that fires on its own parsing failure teaches people to ignore warnings",
    );
    assert.match(unreadable.out, /could not read the project table/);
    assert.doesNotMatch(unreadable.out, /WARNING/);
  }
});

/* ---- the gates that were already there, and must stay ------------------- */

test("the real protections are untouched", async () => {
  const source = await load(SCRIPT);

  assert.match(
    source,
    /\[\[ "\$TARGET" == "preview" \]\] \|\| die/,
    "only a deployment whose target is preview may go behind the client link — this is what stops the alias being moved onto a production deployment",
  );
  assert.match(
    source,
    /\[\[ "\$NAME" == "\$PROJECT" \]\] \|\| die/,
    "and it has to belong to this project",
  );
  assert.match(
    source,
    /\[\[ "\$code" == "200" \]\] \|\| die/,
    "and answer 200 before the client's link is moved onto it",
  );

  const code = source.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(
    code,
    /--prod\b/,
    "nothing in this file may promote anything",
  );
  assert.doesNotMatch(
    code,
    /vercel (?:domains|env|project) (?:add|rm|set)/,
    "and nothing in it may change Vercel configuration",
  );
});

test("the expected production URL is stated once, and is overridable", async () => {
  const source = await load(SCRIPT);
  assert.match(
    source,
    /EXPECTED_PRODUCTION="\$\{EXPECTED_PRODUCTION:-https:\/\/maintsupp\.com\}"/,
    "the value the guard compares against is a named constant with the real domain as its default",
  );
  assert.equal(
    (source.match(/https:\/\/maintsupp\.com/g) ?? []).length,
    2,
    "and it appears exactly twice: the default above, and the sentence in the header that explains why the old check had to change",
  );
});
