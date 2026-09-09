/**
 * ONE WAY IN FOR A FILE.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * CLAUDE.md states the rule plainly — "Always upload via `uploadEvidenceFile()`
 * in `app/lib/client-upload.ts` — it owns the ceiling, the multipart fallback
 * and thumbnail generation. Hand-rolling a `fetch("/api/files")` silently loses
 * all three." The rule was written down because it had already been broken. It
 * was then broken again.
 *
 * Three surfaces have now been corrected one at a time, each carrying its own
 * comment explaining the same failure: the portal's own uploader
 * (`portal-app.tsx`), the contractor job link
 * (`app/(public)/j/[token]/contractor-job-view.tsx`), and the public
 * "report a job" form (`app/(marketing)/_sections/report-job.tsx`). The last of
 * those is the one that mattered most and was found last, because it is the
 * page a member of the public uses and it is anonymous: it posted a bare
 * `FormData` to `/api/files`, which works up to the Workers form parser's
 * ~1 MiB ceiling and then returns a 413 carrying bare text and no JSON `error`.
 * A photograph off any current phone is 2-5 MB, so the ORDINARY case failed,
 * and the only thing the page did with the failure was count it: "N
 * attachment(s) could not be uploaded", no reason, nothing to act on.
 *
 * Fixing the same defect a fourth time is not a plan. The invariant is
 * mechanical, so it is asserted mechanically: NOTHING under `app/` may POST to
 * `/api/files` except the module that owns that call.
 *
 * ── WHY THE EXEMPTION SET CAN ONLY SHRINK ─────────────────────────────────
 *
 * `KNOWN_DIRECT_POSTERS` is empty and is meant to stay that way. It exists so
 * that if a genuinely unavoidable exception ever appears, adding it is a
 * deliberate, reviewable act with a name attached rather than a quiet deletion
 * of this test. Anything listed here is a debt, not a licence.
 *
 * Reads normalise CRLF — this is a Windows checkout.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) =>
  (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

/** The one module allowed to talk to the upload endpoint directly. */
const OWNER = "app/lib/client-upload.ts";

/** Deliberately empty. See the note above: this may shrink, never grow. */
const KNOWN_DIRECT_POSTERS = new Set([]);

/**
 * Comments are stripped before scanning.
 *
 * Every surface already corrected carries a comment quoting the very call it no
 * longer makes — that is the point of those comments — so a naive text search
 * reports three fixed files as broken. Only real code counts.
 */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const walk = async (dir) => {
  const found = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      found.push(...(await walk(rel)));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(rel);
    }
  }
  return found;
};

const sources = await (async () => {
  const files = await walk("app");
  const entries = await Promise.all(
    files.map(async (file) => [file, stripComments(await read(file))]),
  );
  return entries;
})();

test("the app is scanned at all, or this file proves nothing", () => {
  /* A guard against the walk silently returning nothing — an empty sweep would
     make every assertion below vacuously true, which is the failure mode this
     whole batch has been most careful about. */
  assert.ok(sources.length > 100, `expected to scan the app tree, saw ${sources.length} files`);
  assert.ok(
    sources.some(([file]) => file === OWNER),
    "the owning module itself must be in the scanned set",
  );
});

test("only client-upload.ts posts a file to /api/files", () => {
  /*
   * Matches a POST to the endpoint however the call is spelled — the method may
   * precede or follow the URL in the options object, and the URL may be quoted
   * either way. A plain GET of `/api/files?…` for listing is untouched, which is
   * correct: reading the register is not uploading.
   */
  const posts = sources.filter(([file, source]) => {
    if (file === OWNER || KNOWN_DIRECT_POSTERS.has(file)) return false;
    return /fetch\(\s*["'`]\/api\/files["'`]\s*,\s*\{[^}]*method\s*:\s*["'`]POST["'`]/.test(
      source,
    );
  });

  assert.deepEqual(
    posts.map(([file]) => file),
    [],
    "these must call uploadEvidenceFile() instead — it owns the 900 KB ceiling, the multipart fallback and the thumbnail",
  );
});

test("the public report-a-job form uses the shared uploader", () => {
  /*
   * The specific regression, pinned by name as well as by the sweep above. This
   * is the anonymous surface with the widest audience and the least ability to
   * work around a failure, so it gets an assertion of its own rather than
   * relying on a rule that could be relaxed.
   */
  const [, source] =
    sources.find(([file]) => file === "app/(marketing)/_sections/report-job.tsx") ?? [];
  assert.ok(source, "the marketing report-a-job section must exist");
  assert.match(
    source,
    /import \{ uploadEvidenceFile \} from "\.\.\/\.\.\/lib\/client-upload"/,
    "it must import the shared uploader",
  );
  assert.match(
    source,
    /await uploadEvidenceFile\(\{/,
    "and actually call it",
  );
  assert.match(
    source,
    /uploadToken: result\.uploadToken/,
    "forwarding the grant the route mints, or an anonymous upload cannot authorise itself",
  );
});

test("a failed attachment says why, because a bare count is what hid this", () => {
  /*
   * The defect survived because its symptom was indistinguishable from a
   * network blip. `uploadEvidenceFile` throws a sentence written for a person —
   * "Files must be 25 MB or smaller", or whatever the API refused with — and
   * that sentence has to reach the screen.
   */
  const [, source] =
    sources.find(([file]) => file === "app/(marketing)/_sections/report-job.tsx") ?? [];
  assert.match(
    source,
    /failures\.push\(/,
    "the reasons must be collected, not merely counted",
  );
  assert.match(
    source,
    /error instanceof Error && error\.message\.trim\(\)/,
    "the helper's own message is preferred over a generic one",
  );
  assert.match(
    source,
    /failures\.join\("; "\)/,
    "and reported to the person who just tried to attach a photograph",
  );
});

test("the surfaces corrected earlier still use the shared uploader", () => {
  /*
   * The sweep proves nobody posts directly; it does not prove these three still
   * upload at all. Somebody deleting the call rather than replacing it would
   * pass the sweep and break the feature, so the positive claim is made too.
   */
  for (const file of [
    "app/(public)/j/[token]/contractor-job-view.tsx",
    "app/(app)/portal/portal-app.tsx",
    "app/(app)/portal/contractor-profile.tsx",
  ]) {
    const [, source] = sources.find(([name]) => name === file) ?? [];
    assert.ok(source, `${file} must exist`);
    assert.match(source, /uploadEvidenceFile\(/, `${file} must still use the shared uploader`);
  }
});
