import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = "db/monday-export/build-maintenance-csv.mjs";

/**
 * Where `build-maintenance-csv.mjs` writes its CSV.
 *
 * THE BUG THIS LOCKS
 *
 * The output directory was `path.dirname(new URL(import.meta.url).pathname)`.
 * A URL's pathname is not a filesystem path, in two ways:
 *
 *   - on Windows it keeps a separator in front of the drive, `/C:/Users/…`,
 *     which Node reads as a root-relative path and resolves against the
 *     CURRENT drive — a checkout on C: opened `C:\C:\…`;
 *   - it stays percent-encoded, so a folder named `my repo` became
 *     `my%20repo` — wrong on POSIX too, for any path with a space.
 *
 * Either one is ENOENT before a byte is written. `fileURLToPath` is the
 * conversion Node provides for exactly this, on every platform.
 */

test("the output directory comes from fileURLToPath, never from URL.pathname", () => {
  const script = readFileSync(path.join(root, SCRIPT), "utf8");
  assert.match(script, /import \{ fileURLToPath \} from "node:url";/);
  assert.match(
    script,
    /path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/,
    "the script's own directory must be converted with fileURLToPath",
  );
  assert.doesNotMatch(script, /\.pathname\b/, "a URL pathname is not a filesystem path");
});

test("the two conversions differ exactly where the old one broke", () => {
  // Deterministic on any OS: the win32/posix rules are chosen explicitly.
  const windowsUrl = "file:///C:/Users/dev/my%20repo/db/monday-export/build-maintenance-csv.mjs";
  const oldWindows = path.win32.join(
    path.win32.dirname(new URL(windowsUrl).pathname),
    "maintenance-full.csv",
  );
  assert.match(oldWindows, /^[\\/][A-Za-z]:/, "a separator before the drive resolves to a second drive");
  assert.match(oldWindows, /%20/, "and the percent-encoding survives");
  assert.equal(
    path.win32.join(path.win32.dirname(fileURLToPath(windowsUrl, { windows: true })), "maintenance-full.csv"),
    "C:\\Users\\dev\\my repo\\db\\monday-export\\maintenance-full.csv",
  );

  const posixUrl = "file:///home/dev/my%20repo/db/monday-export/build-maintenance-csv.mjs";
  assert.equal(
    path.posix.join(path.posix.dirname(new URL(posixUrl).pathname), "maintenance-full.csv"),
    "/home/dev/my%20repo/db/monday-export/maintenance-full.csv",
    "on POSIX the old form only lost the space",
  );
  assert.equal(
    path.posix.join(path.posix.dirname(fileURLToPath(posixUrl, { windows: false })), "maintenance-full.csv"),
    "/home/dev/my repo/db/monday-export/maintenance-full.csv",
  );
});

test("run from a directory with a space in it, it writes beside itself", (t) => {
  // A copy, never the checkout: a real run writes a gitignored CSV into
  // db/monday-export, and this test must leave the repository untouched.
  const base = mkdtempSync(path.join(tmpdir(), "monday export "));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, "db", "monday-export");
  mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, "build-maintenance-csv.mjs");
  copyFileSync(path.join(root, SCRIPT), copy);

  // A synthetic items page: one invented row, no monday data.
  const page = path.join(base, "items-page.json");
  writeFileSync(
    page,
    JSON.stringify({
      items: [{ id: "900000001", name: "Synthetic path test item", group: { title: "Jobs Booked" }, column_values: {} }],
    }),
  );

  const run = spawnSync(process.execPath, [copy, page], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);

  // Node loads the main module through its real path, so compare against that.
  const expected = path.join(realpathSync(dir), "maintenance-full.csv");
  assert.ok(existsSync(expected), `the CSV belongs beside the script, at ${expected}`);
  assert.match(readFileSync(expected, "utf8"), /^Maintenance\n\nJobs Booked\nItem ID,Name,/);
  assert.ok(run.stdout.includes(expected), "the path it reports is the path it wrote");
  assert.doesNotMatch(run.stdout, /[A-Za-z]:[\\/][^\n]*[A-Za-z]:[\\/]/, "no second drive in the path");
});
