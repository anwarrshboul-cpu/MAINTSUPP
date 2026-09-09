/**
 * What an attachment is stored as, and what may be stored at all.
 *
 *   node --test tests/attachment-mime.test.mjs
 *
 * The extensions exercised here are the real ones: monday's CDN returned no
 * Content-Type for 200 of the 3,107 exported assets, and those 200 are .jpeg
 * (123), .jpg (25), .pdf (23), .png (16), .mp4 (10) and .mov (3). Every one is
 * covered below, because a migration that resolves 197 of 200 is a migration
 * that loses three files quietly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  fileExtension,
  isAllowedFile,
  resolveStoredMime,
} from "../app/lib/attachment-mime.ts";

/** The 200 files monday sent no Content-Type for, by extension and count. */
const OCTET_STREAM_POPULATION = [
  ["jpeg", 123, "image/jpeg"],
  ["jpg", 25, "image/jpeg"],
  ["pdf", 23, "application/pdf"],
  ["png", 16, "image/png"],
  ["mp4", 10, "video/mp4"],
  ["mov", 3, "video/quicktime"],
];

test("every extension among the 200 unheadered assets resolves", () => {
  let covered = 0;
  for (const [ext, count, expected] of OCTET_STREAM_POPULATION) {
    for (const declared of ["", null, undefined, "application/octet-stream"]) {
      const r = resolveStoredMime({ declaredType: declared, filename: `evidence.${ext}` });
      assert.equal(r.mime, expected, `.${ext} with ${JSON.stringify(declared)}`);
      assert.equal(r.source, "derived");
    }
    covered += count;
  }
  assert.equal(covered, 200, "the population must add up to the 200 measured files");
});

test("the source header is preserved whatever is stored", () => {
  const r = resolveStoredMime({ declaredType: "application/octet-stream", filename: "a.jpeg" });
  assert.equal(r.mime, "image/jpeg");
  assert.equal(r.declared, "application/octet-stream");
});

test("a useful declared type is kept, not second-guessed", () => {
  const r = resolveStoredMime({ declaredType: "application/pdf", filename: "invoice.pdf" });
  assert.equal(r.mime, "application/pdf");
  assert.equal(r.source, "declared");
});

test("a declared type that disagrees with its extension is still kept", () => {
  // Both halves are on the allow-list, so the source's own assertion wins. The
  // extension is a fallback for silence, not a correction service.
  const r = resolveStoredMime({ declaredType: "application/pdf", filename: "photo.jpeg" });
  assert.equal(r.mime, "application/pdf");
  assert.equal(r.source, "declared");
});

test("an explicit type outside the allow-list is never overridden by the extension", () => {
  // The trap this helper must not become. `text/html` named `evil.png` is an
  // assertion, not silence; answering it with image/png would be the confusion
  // the upload validator's AND rule exists to prevent.
  for (const filename of ["evil.png", "evil.jpeg", "evil.pdf"]) {
    const r = resolveStoredMime({ declaredType: "text/html", filename });
    assert.equal(r.mime, null, filename);
    assert.equal(r.source, "unresolved");
    assert.equal(r.declared, "text/html");
  }
});

test("silence with an unknown extension is unresolved, never guessed", () => {
  for (const filename of ["thing.weird", "thing.exe", "thing.svg", "noextension"]) {
    const r = resolveStoredMime({ declaredType: "", filename });
    assert.equal(r.mime, null, filename);
    assert.equal(r.source, "unresolved");
  }
});

test("SVG is refused from both directions", () => {
  // A script container. Absent from the type list and the extension list.
  assert.equal(ALLOWED_MIME_TYPES.has("image/svg+xml"), false);
  assert.equal(ALLOWED_EXTENSIONS.has("svg"), false);
  assert.equal(isAllowedFile({ name: "logo.svg", type: "image/svg+xml" }), false);
  assert.equal(isAllowedFile({ name: "logo.svg", type: "" }), false);
});

/* ── The validator's AND rule, which the consolidation must not weaken ────── */

test("a mismatched declaration is refused however the file is named", () => {
  assert.equal(isAllowedFile({ name: "poc.png", type: "text/html" }), false);
  assert.equal(isAllowedFile({ name: "poc.png", type: "image/svg+xml" }), false);
});

test("a disallowed extension is refused however it is declared", () => {
  assert.equal(isAllowedFile({ name: "poc.exe", type: "image/png" }), false);
  assert.equal(isAllowedFile({ name: "poc.svg", type: "image/png" }), false);
});

test("an absent declared type still falls through to the extension", () => {
  // A browser that declines to guess must not cost somebody a real upload.
  for (const type of ["", "   ", undefined]) {
    assert.equal(isAllowedFile({ name: "photo.jpeg", type }), true, JSON.stringify(type));
  }
});

test("an uninformative but present type is treated as silence, not as a claim", () => {
  // This is the behaviour change. Before, `application/octet-stream` was a
  // declared type outside the allow-list and the upload was refused 415 — which
  // is how the migration's own attachment rows became unuploadable.
  for (const type of ["application/octet-stream", "binary/octet-stream", "APPLICATION/OCTET-STREAM"]) {
    assert.equal(isAllowedFile({ name: "photo.jpeg", type }), true, type);
  }
  assert.equal(isAllowedFile({ name: "photo.exe", type: "application/octet-stream" }), false);
});

test("a legitimate upload of every allowed extension is admitted", () => {
  for (const ext of ALLOWED_EXTENSIONS) {
    assert.equal(isAllowedFile({ name: `file.${ext}`, type: "" }), true, ext);
  }
});

test("every allowed extension resolves to an allowed type", () => {
  for (const ext of ALLOWED_EXTENSIONS) {
    const r = resolveStoredMime({ declaredType: "", filename: `file.${ext}` });
    assert.ok(r.mime, `.${ext} resolved to nothing`);
    assert.ok(ALLOWED_MIME_TYPES.has(r.mime), `.${ext} -> ${r.mime} is not storable`);
  }
});

test("fileExtension reads the last segment, and nothing from a bare name", () => {
  assert.equal(fileExtension("a.b.JPEG"), "jpeg");
  assert.equal(fileExtension("noextension"), "");
  assert.equal(fileExtension(""), "");
});
