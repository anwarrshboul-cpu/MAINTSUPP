import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The Documents register can open the files it lists.
 *
 * WHAT WAS WRONG. `/api/files` has always answered with `contentType`,
 * `inlineUrl` and `downloadUrl` for every row — `attachmentPayload` in
 * app/api/files/route.ts builds all three. `loadDocuments` in portal-app.tsx
 * mapped that payload into a `FileRecord` and kept eight fields, dropping
 * exactly those three; `FileRecord` had no place to put them. So the page whose
 * entire purpose is to be a searchable evidence register drew a dashed box with
 * an icon, the kind and the size, and offered no way to preview or download the
 * document — on a local workspace holding 33 real files.
 *
 * The drawer was also not a dialog: no `role`, no `aria-modal`, focus left on
 * the row that opened it, and Escape doing nothing, measured closed in 0 of 20
 * openings across ten widths and both themes. The request drawer in the same
 * file had already been given all of that, with its reasoning written out; this
 * one was simply missed.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

test("the register keeps the three fields that say where the bytes are", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const types = await read("app/lib/types.ts");

  // The record has somewhere to put them...
  const record = types.slice(
    types.indexOf("export interface FileRecord {"),
    types.indexOf("}", types.indexOf("export interface FileRecord {")),
  );
  for (const field of ["inlineUrl", "downloadUrl", "contentType"]) {
    assert.match(record, new RegExp(`${field}\\?: string;`), `FileRecord must carry ${field}`);
  }

  // ...and the live mapping actually carries them across.
  const mapping = portal.slice(
    portal.indexOf("const liveFiles: FileRecord[] = payload.files.map"),
    portal.indexOf("setDocuments(liveFiles)"),
  );
  assert.ok(mapping.length > 0, "loadDocuments mapping not found");
  for (const field of ["inlineUrl", "downloadUrl", "contentType"]) {
    assert.match(
      mapping,
      new RegExp(`${field}: file\\.${field}`),
      `loadDocuments must carry ${field} through, not drop it`,
    );
  }
});

test("what the drawer previews is exactly what the server serves inline", async () => {
  /*
   * The whole point of this assertion. `app/api/files/[id]/route.ts` serves
   * INLINE_SAFE_TYPES with their real content type and everything else as
   * application/octet-stream, which a browser downloads rather than renders.
   * If the drawer's list ever grows past the server's it embeds a frame the
   * server refuses to fill; if it shrinks it refuses a file the server would
   * have shown. Two lists, one fact — so they are compared, not eyeballed.
   */
  const server = await read("app/api/files/[id]/route.ts");
  const portal = await read("app/(app)/portal/portal-app.tsx");

  const block = server.slice(
    server.indexOf("const INLINE_SAFE_TYPES = new Set(["),
    server.indexOf("]);", server.indexOf("const INLINE_SAFE_TYPES = new Set([")),
  );
  const serverTypes = [...block.matchAll(/"([a-z]+\/[a-z0-9.+-]+)"/g)].map((m) => m[1]).sort();
  assert.ok(serverTypes.length >= 10, `expected the server's inline list, read ${serverTypes.length}`);

  const client = portal.slice(
    portal.indexOf("function previewKindFor("),
    portal.indexOf("function FileDetailDrawer("),
  );
  assert.ok(client.length > 0, "previewKindFor not found");
  const clientTypes = [...client.matchAll(/"([a-z]+\/[a-z0-9.+-]+)"/g)].map((m) => m[1]).sort();

  assert.deepEqual(
    clientTypes,
    serverTypes,
    "the drawer's previewable types must be the server's INLINE_SAFE_TYPES, exactly",
  );
});

test("the file drawer is a dialog, and Escape gets out of it", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const drawer = portal.slice(
    portal.indexOf("function FileDetailDrawer("),
    portal.indexOf("interface CreateRequestDraft"),
  );
  assert.ok(drawer.length > 0, "FileDetailDrawer not found");

  assert.match(drawer, /role="dialog"/, "a surface that covers the page is a dialog");
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-label=\{`File details: \$\{file\.name\}`\}/, "it must say which file");
  assert.match(drawer, /tabIndex=\{-1\}/, "the container has to be focusable to be focused");

  // Escape closes it, and does NOT steal the key from a field or a popover.
  assert.match(drawer, /event\.key !== "Escape"/);
  assert.match(drawer, /onClose\(\);/);
  assert.match(
    drawer,
    /closest\("input, textarea, select, \[contenteditable='true'\]"\)/,
    "Escape in a box abandons what is being typed, everywhere else in this app",
  );
  assert.match(
    drawer,
    /querySelector\("\.ms-layer \.ms-popover"\)/,
    "an open anchored popover owns the press",
  );

  // Focus moves in on open and goes back on close.
  assert.match(drawer, /surface\.focus\(\{ preventScroll: true \}\)/);
  assert.match(drawer, /opener\.focus\(\{ preventScroll: true \}\)/);
});

test("a file that cannot be previewed says so, and can still be downloaded", async () => {
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const drawer = portal.slice(
    portal.indexOf("function FileDetailDrawer("),
    portal.indexOf("interface CreateRequestDraft"),
  );

  assert.match(
    drawer,
    /This file type cannot be previewed\. Download it to open\./,
    "an icon with no explanation reads as a preview that failed to load",
  );
  assert.match(
    drawer,
    /No stored file for this record\./,
    "a record with no bytes behind it is a different thing again",
  );
  assert.match(drawer, /Open in new tab/);
  assert.match(drawer, /download=\{file\.name\}/, "the download keeps the original filename");
  assert.match(
    drawer,
    /href=\{file\.downloadUrl \?\? `\$\{file\.inlineUrl\}\?download=1`\}/,
    "the server's own download url is preferred over a reconstructed one",
  );
});

test("the register's CSV export does not leak storage urls", async () => {
  /*
   * `downloadFileRegister` builds its columns from `keyof FileRecord`. Widening
   * that interface is exactly how three storage urls would end up in a
   * spreadsheet the client opens, so the column list stays explicit.
   */
  const portal = await read("app/(app)/portal/portal-app.tsx");
  const columns = portal.slice(
    portal.indexOf("const columns: (keyof FileRecord)[] = ["),
    portal.indexOf("];", portal.indexOf("const columns: (keyof FileRecord)[] = [")),
  );
  assert.ok(columns.length > 0, "the export column list was not found");
  for (const field of ["inlineUrl", "downloadUrl", "contentType"]) {
    assert.ok(!columns.includes(field), `${field} must not be exported to CSV`);
  }
});
