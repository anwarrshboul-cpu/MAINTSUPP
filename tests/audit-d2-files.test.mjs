import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * AUDIT D2 — the drawer's file count is a count, and the panel that reports it
 * does not set state while rendering.
 *
 * TWO THINGS, ONE CHAIN. The Files tab printed `request.attachmentCount`, the
 * row's stored counter. db/schema.ts:976 already says what is wrong with that
 * class of number — "two writers, no reconciler, and it drifts. The count here
 * is a COUNT" — and the Updates tab beside it had already been moved off
 * `request.commentCount` for the same reason. Verified drifted against the
 * running workspace: MN-1043's tab header read "6 files" while the evidence
 * panel one click away, which actually reads `/api/files`, reported nothing at
 * all in any section.
 *
 * Making the header follow the panel exposed the second one. The panel reported
 * its new length from INSIDE a `setFiles` updater, which React runs during the
 * render pass; a listener that answers with `setState` therefore produced
 * "Cannot update a component (RequestDrawer) while rendering a different
 * component (EvidenceManager)" on the first upload. It had gone unseen because
 * the only listener until now dispatched a window event.
 *
 * Both were verified in Chromium: header "6 files" -> "0 files" agreeing with
 * the panel, "0 files" -> "1 file" live while uploading, back to "0 files" on
 * delete, and no console warning on either path.
 */

const url = (p) => new URL(p, import.meta.url);
// Windows checkout: normalise before matching, or every slice below misses.
const read = (p) => readFileSync(url(p), "utf8").replace(/\r\n/g, "\n");

const PORTAL = read("../app/(app)/portal/portal-app.tsx");
const EVIDENCE = read("../app/(app)/portal/evidence-manager.tsx");

test("the Files tab header shows a counted number, not the row's counter", () => {
  assert.doesNotMatch(
    PORTAL,
    /<span>\{request\.attachmentCount\} files<\/span>/,
    "the tab must not print the drifting stored counter",
  );
  assert.match(
    PORTAL,
    /const shown = fileCount \?\? request\.attachmentCount;/,
    "the counted value wins; the snapshot is only the value shown before it answers",
  );
  assert.match(
    PORTAL,
    /`\$\{shown\} file\$\{shown === 1 \? "" : "s"\}`/,
    "one file is not '1 files'",
  );
});

test("the drawer counts the files itself, and re-counts when the panel closes", () => {
  assert.match(
    PORTAL,
    /const \[fileCount, setFileCount\] = useState<number \| null>\(null\);/,
    "the counted value needs somewhere to live",
  );
  const at = PORTAL.indexOf("`/api/files?requestId=${encodeURIComponent(request.id)}`");
  assert.notEqual(at, -1, "the drawer's own file read went missing");
  const effect = PORTAL.slice(at, at + 700);
  assert.match(
    effect,
    /if \(active && Array\.isArray\(payload\.files\)\) setFileCount\(payload\.files\.length\);/,
    "the count comes from the rows returned, not from a field on the payload",
  );
  assert.match(
    effect,
    /\}, \[request\.id, evidenceRefreshToken\]\);/,
    "closing the evidence panel bumps evidenceRefreshToken, which must re-count",
  );
});

test("a column-scoped evidence panel does not overwrite the job-wide count", () => {
  const at = PORTAL.indexOf("onFileCountChange={(count) => {");
  assert.notEqual(at, -1, "the drawer stopped listening to the panel's count");
  const handler = PORTAL.slice(at, at + 900);
  assert.match(
    handler,
    /if \(evidenceColumn\) \{/,
    "opened for one column, `count` is that column's files only",
  );
  assert.match(
    handler,
    /\} else \{\s*setFileCount\(count\);/,
    "…and only the job-wide panel may set the job-wide number",
  );
  assert.match(
    handler,
    /window\.dispatchEvent\(new Event\("maintsupp:refresh-board"\)\)/,
    "the board refresh for a column upload must survive this change",
  );
});

test("EvidenceManager reports its new length outside the setFiles updater", () => {
  assert.doesNotMatch(
    EVIDENCE,
    /setFiles\(\(current\) => \{[\s\S]{0,200}?onFileCountChange\?\.\(/,
    "calling a parent's setState from inside an updater warns: it runs during render",
  );
  assert.match(
    EVIDENCE,
    /setFiles\(\(current\) => \[payload\.file, \.\.\.current\]\);\s*fileCount \+= 1;\s*onFileCountChange\?\.\(fileCount\);/,
    "the upload path steps a local count and reports it after the state call",
  );
  assert.match(
    EVIDENCE,
    /setFiles\(\(current\) => current\.filter\(\(item\) => item\.id !== file\.id\)\);\s*onFileCountChange\?\.\(Math\.max\(files\.length - 1, 0\)\);/,
    "the delete path does the same, and never reports a negative count",
  );
});
