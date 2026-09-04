import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const SCRIPT = "scripts/update-preview-alias.sh";

/**
 * The client's link is moved by a script, and these are the reasons why.
 *
 * `maintsupp-preview.vercel.app` is what the client has. Whatever sits behind
 * it is, for them, the product. So the interesting part of this script is not
 * the one line that moves the alias — it is everything it refuses to move the
 * alias to, and none of that survives being left to whoever is at the keyboard
 * at the time.
 */

test("the script cannot promote anything to production", async () => {
  const script = await read(SCRIPT);
  const code = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  assert.doesNotMatch(code, /--prod\b/, "no executable line may pass --prod");
  assert.doesNotMatch(code, /vercel\s+deploy/, "this script moves an alias; it does not deploy");
  assert.doesNotMatch(code, /vercel\s+promote/, "and it does not promote");

  /* Only these Vercel subcommands, and only one of them writes anything. */
  const commands = [...code.matchAll(/vercel\s+([a-z]+(?:\s+[a-z]+)?)/g)].map((m) => m[1].trim());
  const allowed = new Set(["ls", "inspect", "alias ls", "alias set", "project ls"]);
  for (const command of commands) {
    assert.ok(allowed.has(command), `unexpected command: vercel ${command}`);
  }
});

test("it refuses anything that is not a ready maintsupp-portal preview", async () => {
  const script = await read(SCRIPT);

  assert.match(script, /PROJECT="maintsupp-portal"/);
  assert.match(
    script,
    /\[\[ "\$NAME" == "\$PROJECT" \]\] \|\| die/,
    /*
     * Re-pointed 2026-09-04, not dropped. This used to say the older
     * `maintsupp` and `website` projects "both have live production domains",
     * which was the reason at the time and is no longer true — both were
     * deleted in the consolidation to a single project. The CHECK is what the
     * contract was, and it outlives the account state that motivated it: the
     * script must refuse a foreign deployment whether or not a second project
     * happens to exist this week.
     */
    "a deployment from another project must be refused, however few projects the account currently has",
  );
  assert.match(
    script,
    /\[\[ "\$TARGET" == "preview" \]\] \|\| die/,
    "a production deployment must be refused outright",
  );
  assert.match(
    script,
    /\*maintsupp-portal-\*\) ;;/,
    "and a foreign URL should be caught on its host name, before any network call",
  );
});

test("the alias itself can never be a project host name", async () => {
  /*
   * Renamed from "…can never be a production domain" on 2026-09-04, because
   * four of these five stopped being production domains that day and the
   * guard still matters — more, not less.
   *
   * `maintsupp-portal.vercel.app` is the surviving project's own domain. The
   * other four belonged to `maintsupp` and `website`, which were deleted; a
   * deleted project releases its `*.vercel.app` name, so those are now
   * claimable by anyone. Pointing the client's link at a name a stranger
   * controls is a worse outcome than the one the original list guarded
   * against, so every entry is pinned here — including the two the earlier
   * version of this test did not cover.
   */
  const script = await read(SCRIPT);
  const guard = script.slice(script.indexOf('case "$ALIAS" in'), script.indexOf("esac"));
  for (const domain of [
    "maintsupp.vercel.app",
    "maintsupp-maintsupp.vercel.app",
    "website-rho-seven-8mdd7vw83c.vercel.app",
    "website-maintsupp.vercel.app",
    "maintsupp-portal.vercel.app",
  ]) {
    assert.ok(guard.includes(domain), `${domain} must be on the refused list`);
  }
});

test("the alias only moves to a deployment that answered 200", async () => {
  /*
   * The gate, not a report. Moving the link to something that 500s would take
   * the client's preview down AND lose the deployment that was working, which
   * is the whole rollback story.
   */
  const script = await read(SCRIPT);
  const smoke = script.slice(script.indexOf('for path in "/" "/login"'), script.indexOf("---- 4."));
  assert.match(smoke, /\[\[ "\$code" == "200" \]\] \|\| die/);
  /* Ordering is checked against the EXECUTABLE lines: the header comment
     explains `vercel alias set`, and a plain indexOf would find the prose. */
  const runnable = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.ok(
    runnable.indexOf('for path in "/" "/login"') < runnable.indexOf("vercel alias set"),
    "the smoke test must run BEFORE the alias moves, or it is just commentary",
  );
  assert.match(
    smoke,
    /The alias has NOT been moved/,
    "and say plainly that the client still has the previous deployment",
  );
});

test("it carries no credentials and prints the rollback command", async () => {
  const script = await read(SCRIPT);
  const code = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  assert.doesNotMatch(code, /prj_[A-Za-z0-9]{10,}/, "no project id");
  assert.doesNotMatch(code, /team_[A-Za-z0-9]{10,}/, "no team id");
  assert.doesNotMatch(code, /VERCEL_TOKEN|--token/, "no token");
  assert.doesNotMatch(code, /password|secret/i, "no credentials");

  assert.match(script, /To roll back:  scripts\/update-preview-alias\.sh/, "every run must say how to undo itself");
  assert.match(script, /PREVIOUS=/, "which means capturing what the alias pointed at before");
});
