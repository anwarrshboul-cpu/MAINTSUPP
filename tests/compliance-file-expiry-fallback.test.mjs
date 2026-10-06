/**
 * A certificate uploaded in the portal with its own expiry date is read by the
 * compliance register (dashboard accuracy pass, 2026-10-06).
 *
 * The register used to read a slot's expiry from the Store Documentation board
 * cell only. A file uploaded with an "Expiry date" of its own, with that cell
 * left empty, therefore read "Missing date" on the Overview, the Compliance
 * dashboard and the reports, while the file itself said it was valid. The cell
 * remains the record and wins whenever it holds a date; the file's date only
 * fills an empty cell.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

const formatDateUrl = asModule(transpile(await read("app/lib/format-date.ts")));
const expiryUrl = asModule(
  transpile(await read("app/lib/expiry-status.ts")).replace(
    /from ["']\.\/format-date["']/g,
    `from "${formatDateUrl}"`,
  ),
);
const specUrl = asModule(transpile(await read("db/monday-board-spec.ts")));
const register = await import(
  asModule(
    transpile(await read("app/lib/store-documentation-register.ts"))
      .replace(/from ["']\.\.\/\.\.\/db\/monday-board-spec["']/g, `from "${specUrl}"`)
      .replace(/from ["']\.\/expiry-status["']/g, `from "${expiryUrl}"`),
  )
);

const columns = [
  { id: "c-pat-file", key: "patCertificate" },
  { id: "c-pat-expiry", key: "patExpiry" },
];
const today = new Date("2026-10-06T12:00:00Z");
const pat = (rows) =>
  register
    .storeDocumentationRegister(rows, { today })[0]
    .documents.find((document) => document.slotKey === "pat");

test("an empty expiry cell takes the date recorded on the certificate itself", () => {
  const rows = register.boardRowsFrom({
    requests: [{ id: "sd-1", title: "Store One" }],
    columns,
    cells: [],
    fileCounts: [{ requestId: "sd-1", columnId: "c-pat-file", count: 1, expiry: "2027-09-01" }],
  });
  const document = pat(rows);
  assert.equal(document.expiry, "2027-09-01");
  assert.equal(document.state, "Compliant");
});

test("the board cell still wins when it holds a date", () => {
  const rows = register.boardRowsFrom({
    requests: [{ id: "sd-1", title: "Store One" }],
    columns,
    cells: [{ requestId: "sd-1", columnId: "c-pat-expiry", value: "2026-01-01" }],
    fileCounts: [{ requestId: "sd-1", columnId: "c-pat-file", count: 1, expiry: "2027-09-01" }],
  });
  const document = pat(rows);
  assert.equal(document.expiry, "2026-01-01");
  assert.equal(document.state, "Expired");
});

test("with no file there is nothing to borrow a date from", () => {
  const rows = register.boardRowsFrom({
    requests: [{ id: "sd-1", title: "Store One" }],
    columns,
    cells: [],
    fileCounts: [],
  });
  assert.equal(pat(rows).expiry, null);
});

test("the server reader selects the latest live file expiry per slot", async () => {
  const source = await read("app/lib/compliance-register.ts");
  assert.match(source, /expiry: max\(attachments\.expiryDate\)/);
});
