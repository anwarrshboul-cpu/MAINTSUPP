/**
 * The portal's own CSV exports (Reports "Export spend", the documents export)
 * quoted cells but did not neutralise formula starters. Job titles come from the
 * public request form, so "=HYPERLINK(...)" reached Excel as a live formula.
 * Found in QA on 2026-10-01; both now use `csvCell`, the finance exports' cell.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("portal CSV exports neutralise formulas through csvCell", async () => {
  const app = await readFile(new URL("../app/(app)/portal/portal-app.tsx", import.meta.url), "utf8");
  assert.match(app, /import \{ csvCell \} from "\.\.\/\.\.\/lib\/finance\/exports";/);
  assert.equal(app.match(/const escapeCell = csvCell;/g)?.length, 2);
  assert.doesNotMatch(app, /const escapeCell = \(value: unknown\) =>/);

  const exports = await readFile(new URL("../app/lib/finance/exports.ts", import.meta.url), "utf8");
  assert.match(exports, /const FORMULA_STARTERS = \["=", "\+", "-", "@", "\\t", "\\r"\];/);
  assert.match(exports, /export function csvCell\(value: unknown\): string \{[\s\S]*?neutraliseCsvCell\(raw\)/);
});
