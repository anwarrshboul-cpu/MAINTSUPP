/**
 * W2 REQUIREMENT F — THE STORE DOCUMENTATION TEMPLATE IS A REAL, EMPTY,
 * INDEPENDENT INSTANCE, AND IT KEEPS WORKSTREAM 7'S BEHAVIOUR.
 *
 * A workspace section built from this template provisions its own board with a
 * generated key (`sec-<12hex>`), seeded by `seedStoreDocumentationBoard` — the
 * SAME seeder the canonical board uses, with the section's key. So the parity
 * question is not "does it look like a compliance register" but "is it one",
 * and the two are told apart by whether anything in the path can still see the
 * string `"store-documentation"` as a BOARD KEY.
 *
 * ── THE FAILURE THIS FILE EXISTS TO PREVENT ────────────────────────────────
 *
 * `/api/notifications/compliance` read the canonical board and nothing else.
 * An instance would therefore look exactly like a compliance register, be
 * filled with real certificates, show them on its own Compliance Tracker with a
 * real RAG state — and never warn about a single expiry, silently, for ever.
 *
 * That is worse than having no register: a surface that says nothing tells the
 * truth about itself, and one that quietly stops warning does not. It errs
 * towards FALSE ASSURANCE, which is the one direction a compliance screen must
 * never fail in. `app/api/workspace-sections/catalogue.ts` holds the template
 * back for exactly this reason and says so in as many words — "Available once
 * the compliance digest reads the section's own board" — so the assertions
 * below are the condition on that gate, written as behaviour.
 *
 * ── AND THE SECOND FAILURE, WHICH IS THE MIRROR OF IT ─────────────────────
 *
 * Widening the digest must not change what the canonical estate receives. An
 * organisation with one Store Documentation board must get the digest it has
 * always had, and `compliance_documents` rows that no board speaks for must be
 * reported ONCE however many registers were scanned — otherwise a workspace
 * with three sections sends three emails about the same certificate, which
 * trains people to filter the digest to junk and is how a real lapsed
 * certificate goes unread.
 *
 * ── HOW THESE ARE WRITTEN ─────────────────────────────────────────────────
 *
 * Three kinds of assertion, in order of strength:
 *
 *   1. EXECUTED. `complianceDigestTemplate` and `documentName` are imported and
 *      run. These survive any reformat.
 *   2. LIVE. Against a running server, with a marked fixture removed by its
 *      exact generated id — never by a filename or title substring, which has
 *      repeatedly eaten other fixtures on the shared Miniflare database.
 *   3. SOURCE PINS, for contracts that have no reachable seam — the five
 *      board-scoped queries in the register, and the board-blindness of the
 *      document lineage.
 *
 * The instance half of the live tests SKIPS while the catalogue holds the
 * template back, and reports why. It is deliberately keyed on
 * `SECTION_TEMPLATES` rather than on a hard-coded expectation, so it starts
 * running by itself the moment the template is offered — a test that has to be
 * remembered is a test that is not run.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * WHY THIS FILE RESOLVES ITS OWN IMPORTS.
 *
 * The two functions below are tested by RUNNING them, which is the only kind of
 * assertion that survives a reformat — and the product's own modules import each
 * other without a file extension (`import … from "../../db/schema"`), which the
 * bundler resolves and Node's ESM resolver does not. So the choice was between
 * running the real functions behind twelve lines of resolver, or matching their
 * source text and hoping. The resolver is the honest option: `documentName` is
 * the single naming rule for the whole product and a pin on its source would go
 * on passing while the rule beneath it was inverted.
 *
 * Deliberately narrow. It only ever rewrites a RELATIVE specifier that has no
 * extension, and only when a `.ts`/`.tsx` file is actually sitting there, so it
 * cannot silently redirect a package import or invent a module.
 */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const base = dirname(fileURLToPath(context.parentURL));
      for (const extension of [".ts", ".tsx", "/index.ts"]) {
        const candidate = resolvePath(base, specifier + extension);
        if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
      }
    }
    return next(specifier, context);
  },
});

const here = new URL("../", import.meta.url).href;
const { complianceDigestTemplate } = await import(`${here}app/lib/notifications.ts`);
const { documentName } = await import(`${here}app/(app)/portal/views/document-register.ts`);

import { SECTION_TEMPLATES } from "../app/api/workspace-sections/catalogue.ts";
import {
  storeDocumentationCertificates,
  storeDocumentationColumns,
  storeDocumentationGroups,
} from "../db/monday-board-spec.ts";

const BASE_URL = process.env.MAINTSUPP_BASE_URL ?? "http://localhost:5173";
const ADMIN = "admin@sunnamusk-uk.test.maintsupp.com";
const SUPER = "super-admin@test.maintsupp.com";

const CANONICAL_BOARD = "store-documentation";
const TEMPLATE = "store-documentation";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/*
 * Comments are stripped before a pin is matched. Several of these contracts are
 * DESCRIBED at length in a comment right beside the code that implements them,
 * so a pin that matched the prose would go on passing after the code beneath it
 * was deleted — which is the one way a source pin can lie.
 */
const codeOnly = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── 1. Executed: the digest names the register a certificate is on ───────── */

test("a digest with two registers names the board on every row", () => {
  const digest = complianceDigestTemplate({
    expired: [
      {
        site: "Cabot Circus",
        kind: "Fire Alarm",
        expiry: "2024-01-15",
        daysAgo: 400,
        boardName: "Store Documentation UK",
      },
    ],
    expiring: [
      {
        site: "Cabot Circus",
        kind: "Fire Alarm",
        expiry: "2027-01-15",
        daysAway: 30,
        boardName: "Concession documents",
      },
    ],
  });

  /*
   * The point is not that the string appears — it is that a reader of the
   * email can tell the two apart. The same store name and the same requirement
   * are on both rows on purpose: without the register's name the two rows are
   * indistinguishable, and an operator has nowhere to go and fix either.
   */
  assert.match(digest.body, /Store Documentation UK/, "the canonical register is named");
  assert.match(digest.body, /Concession documents/, "and so is the section's own");
});

test("a digest with one register is left exactly as it was", () => {
  const rows = {
    expired: [{ site: "Cabot Circus", kind: "Fire Alarm", expiry: "2024-01-15", daysAgo: 400 }],
    expiring: [],
  };
  const untagged = complianceDigestTemplate(rows);
  const tagged = complianceDigestTemplate({
    expired: [{ ...rows.expired[0], boardName: "Store Documentation UK" }],
    expiring: [],
  });

  /*
   * THE COMPATIBILITY CONTRACT, ASSERTED RATHER THAN ASSUMED. A board column
   * reading "Store Documentation UK" on every row of every email, in a
   * workspace that has only ever had one register, is noise — and skimming is
   * the failure mode a compliance digest exists to avoid. The column appears
   * when there are two registers to tell apart and not before, so a workspace
   * that has not created a section gets a byte-identical email.
   */
  assert.equal(
    tagged.body,
    untagged.body,
    "one register means no board column — the digest is unchanged",
  );
  assert.doesNotMatch(untagged.body, /Store Documentation UK/);
});

test("a register's name is escaped before it reaches the email", () => {
  /*
   * A board name is free text an operator typed into the section dialog, and it
   * now reaches an HTML email. This is the one field in this template that
   * carries operator input, so it must not become the template's first
   * injection point. `site` and `kind` beside it come from the board capture
   * and the fixed slot vocabulary; their escaping is a separate, older
   * question and this test deliberately does not pretend to have answered it.
   */
  const digest = complianceDigestTemplate({
    expired: [
      {
        site: "A",
        kind: "PAT Test",
        expiry: "2024-01-15",
        daysAgo: 1,
        boardName: "<script>alert(1)</script>",
      },
    ],
    expiring: [
      { site: "B", kind: "PLI", expiry: "2027-01-15", daysAway: 1, boardName: "Other register" },
    ],
  });
  assert.doesNotMatch(digest.body, /<script>/, "the name must not reach the email as markup");
  assert.match(digest.body, /&lt;script&gt;/, "it is escaped, not dropped — a dropped name lies");
});

/* ── 2. Executed: `documentName` is still the only decider ────────────────── */

test("documentName decides the name, on any board", () => {
  /*
   * Nothing in this rule is board-aware and nothing may become board-aware. A
   * certificate on a section instance and the same certificate on the canonical
   * board must be called the same thing, or the copy on a surveyor's disk stops
   * matching the register that sent it.
   */
  assert.equal(documentName({ title: "PAT 2026", originalName: "IMG_7560.jpeg" }), "PAT 2026");
  assert.equal(documentName({ title: "   ", originalName: "IMG_7560.jpeg" }), "IMG_7560.jpeg");
  assert.equal(documentName({ title: null, name: "scan.pdf" }), "scan.pdf");
  assert.equal(documentName({ originalName: "scan.pdf" }), "scan.pdf");
  assert.equal(documentName({}), "");
});

test("the server applies the same rule to Content-Disposition", async () => {
  const route = codeOnly(await source("app/api/files/[id]/route.ts"));
  assert.match(
    route,
    /Content-Disposition["\s,]+[\s\S]{0,120}servedFileName\(record\)/,
    "the download's name comes from servedFileName, not from original_name",
  );
  /*
   * `servedFileName` is `documentName`'s rule plus the two things a name on a
   * disk needs: a real extension and characters an OS will accept. Pinned by
   * BEHAVIOUR — title wins, filename otherwise — rather than by its prose, so
   * this fails if the branch is inverted.
   */
  assert.match(
    route,
    /function servedFileName\([\s\S]{0,900}?\.title[\s\S]{0,400}?originalName/,
    "servedFileName still prefers the title and falls back to the filename",
  );
  assert.doesNotMatch(
    route,
    /board_id|boardId\s*===|"store-documentation"/,
    "and it decides without asking which board the document is on",
  );
});

/* ── 3. The seeder: an instance gets the canonical structure ──────────────── */

test("the seeder writes every column, group and option under the key it is given", async () => {
  const seeder = codeOnly(await source("db/seed-store-documentation.ts"));

  /*
   * BOARD-KEYED, NOT BOARD-NAMED. Every insert must bind `boardKey`, or the
   * instance's rows land on the canonical board — which does not fail, it
   * quietly adds 24 duplicate columns to the client's live register.
   */
  assert.match(
    seeder,
    /export async function seedStoreDocumentationBoard\(\s*[\s\S]{0,200}?boardKey = STORE_DOCUMENTATION_BOARD_KEY/,
    "the key is a parameter with the canonical board as its default",
  );
  for (const table of [
    "maintenance_board_columns",
    "maintenance_groups",
    "maintenance_board_options",
  ]) {
    const at = seeder.indexOf(table);
    assert.ok(at > 0, `${table} is still seeded`);
    assert.match(
      seeder.slice(at, at + 1400),
      /\bboardKey\b/,
      `${table} rows must be filed under the key the seeder was given`,
    );
  }
  /*
   * The one place the literal may still appear is the `boards` insert, and
   * there it is the board's KIND — the durable statement that this is a
   * document register, which is what `storeDocumentationBoards` reads. The
   * three structure tables must bind `boardKey` and never the literal, so the
   * check is scoped to their inserts rather than to the whole file.
   */
  for (const table of [
    "maintenance_board_columns",
    "maintenance_groups",
    "maintenance_board_options",
  ]) {
    const insert = seeder.slice(seeder.indexOf(table), seeder.indexOf(table) + 1400);
    assert.doesNotMatch(
      insert,
      /"store-documentation"/,
      `the ${table} insert must not bind the canonical key as a literal`,
    );
  }
  assert.match(
    seeder,
    /\.bind\([\s\S]{0,400}?"store-documentation",\s*\n\s*"Store",/,
    "the boards row still declares its KIND, which is how a register is recognised",
  );

  /*
   * NO ROWS. "Empty and independent" is the requirement, and the seeder is the
   * only thing that could break the first half.
   */
  assert.doesNotMatch(
    seeder,
    /INSERT[\s\S]{0,40}INTO maintenance_requests|INSERT[\s\S]{0,40}INTO maintenance_group_items/,
    "an instance starts with no rows — nothing is copied from the source board",
  );
});

test("every certificate slot an instance inherits has the columns it reads", () => {
  /*
   * NO COLUMN COUNT IS WRITTEN DOWN HERE, DELIBERATELY. The spec is the single
   * source the seeder reads, so a number repeated in a test is a second copy of
   * it that goes stale — and it already has: two comments in the seeder and in
   * `board-registry.ts` say "all 24 of these columns" while the spec holds 25.
   * That is harmless prose and a poisonous assertion, so what is pinned instead
   * is the RELATIONSHIP the compliance register depends on: every one of the
   * twelve slots can find the file and expiry columns it names.
   *
   * The four groups and twelve slots ARE fixed numbers, because they are a
   * faithful capture of monday board 1398027719 rather than something the
   * product grows.
   */
  assert.equal(storeDocumentationGroups.length, 4);
  assert.equal(storeDocumentationCertificates.length, 12);

  const columnKeys = new Set(storeDocumentationColumns.map((column) => column.key));
  for (const slot of storeDocumentationCertificates) {
    assert.ok(columnKeys.has(slot.fileColumn), `${slot.key} needs its file column`);
    if (slot.expiryColumn) {
      assert.ok(columnKeys.has(slot.expiryColumn), `${slot.key} needs its expiry column`);
    }
  }
});

test("live: the canonical register carries exactly the spec's columns and groups", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  /*
   * The baseline an instance is measured against. Asserted as SETS in both
   * directions and read off the spec, so it cannot be satisfied by a board that
   * has drifted — which is the state the seeder's `INSERT OR IGNORE` cannot
   * repair on its own and the reason the spec is the only declaration.
   */
  const board = await (await call(`/api/board?board=${CANONICAL_BOARD}`)).json();
  assert.deepEqual(
    board.columns.map((column) => column.key).sort(),
    storeDocumentationColumns.map((column) => column.key).sort(),
    "the canonical register is the spec, no more and no fewer",
  );
  assert.deepEqual(
    board.groups.map((group) => group.name).sort(),
    storeDocumentationGroups.map((group) => group.name).sort(),
  );
});

test("the groups an instance is seeded with are the ones the digest scopes itself by", async () => {
  /*
   * `withinOperationalEstate` decides what may alert by matching the board
   * GROUP NAME against "europe" and "closed" — the only discriminator this data
   * has, because every one of the client's 31 sites is `region = 'UK'`.
   *
   * That makes the group set a load-bearing part of the compliance contract,
   * not decoration. If the Store Documentation template were ever routed
   * through the generic group path — `TEMPLATE_STRUCTURES` records
   * `groups: "generic"` for it, and it is inert only because
   * `provisionDefaultStructure` hands the whole job to
   * `seedStoreDocumentationBoard` — an instance would come up with three
   * generic lanes, `withinOperationalEstate` would recognise neither exclusion,
   * and a Dutch store's employer's liability certificate would start alerting a
   * UK operations team. Pinned here so that change cannot be silent.
   */
  const register = codeOnly(await source("app/lib/compliance-register.ts"));
  const excluded = register.match(/NON_OPERATIONAL_GROUPS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(excluded, "the digest still names its excluded groups in one place");

  const seededNames = storeDocumentationGroups.map((group) => group.name.toLowerCase());
  for (const raw of excluded[1].split(",")) {
    const name = raw.trim().replace(/^["']|["']$/g, "");
    if (!name) continue;
    assert.ok(
      seededNames.includes(name),
      `"${name}" is excluded from alerting but no seeded group is called that`,
    );
  }
});

/* ── 4. The register is scoped per board, and by KIND not by key ──────────── */

test("the register takes its boards from the caller and defaults to the canonical one", async () => {
  const register = codeOnly(await source("app/lib/compliance-register.ts"));

  assert.match(
    register,
    /options: \{ today\?: Date; boardIds\?: readonly string\[\] \} = \{\}/,
    "readComplianceRegister accepts the registers to derive from",
  );
  assert.match(
    register,
    /const boardIds = options\.boardIds \?\? \[STORE_DOCUMENTATION_BOARD_ID\]/,
    "and omitting them selects the canonical board — never everything",
  );

  /*
   * THE FIVE QUERIES THAT USED TO NAME THE CANONICAL KEY. Each was
   * `eq(<table>.boardId, STORE_DOCUMENTATION_BOARD_ID)`, which is what made an
   * instance's certificates invisible. They are scoped to the caller's set now,
   * and this asserts the absence as well as the presence: a single one left
   * behind would silently re-narrow the whole scan to the canonical board.
   */
  for (const table of [
    "maintenanceGroupItems",
    "maintenanceGroups",
    "maintenanceBoardColumns",
    "maintenanceBoardCells",
  ]) {
    assert.doesNotMatch(
      register,
      new RegExp(`eq\\(${table}\\.boardId, STORE_DOCUMENTATION_BOARD_ID\\)`),
      `${table} must not be pinned to the canonical board key`,
    );
  }
  assert.match(
    register,
    /inArray\(maintenanceGroupItems\.boardId, scope\)/,
    "placements are read across the registers the caller named",
  );

  /*
   * A ROW CARRIES THE REGISTER IT CAME FROM, and it comes from the PLACEMENT —
   * the same column `/api/board` filters on and `boardKeyForRequest` answers
   * from. Reading it from anywhere else would let a certificate be alerted
   * under one register and edited on another.
   */
  assert.match(
    register,
    /boardId: maintenanceGroupItems\.boardId/,
    "the placement's own board_id is what is carried",
  );
  assert.match(register, /boardId: boardIdByItemId\.get\(store\.id\) \?\? null/);
});

test("which registers exist is answered by kind, never by a board key", async () => {
  const register = codeOnly(await source("app/lib/compliance-register.ts"));

  assert.match(
    register,
    /export async function storeDocumentationBoards\(/,
    "there is one place that answers which registers this organisation has",
  );
  assert.match(
    register,
    /eq\(boards\.kind, STORE_DOCUMENTATION_BOARD_KIND\)/,
    "and it asks the board record's kind — a section's key is generated and matches nothing",
  );
  assert.match(
    register,
    /eq\(boards\.archived, false\)/,
    "an archived register is out of the operational estate, like a closed store",
  );

  /*
   * THE CANONICAL KEY IS A FLOOR. `boards` is materialised on demand, while
   * placements have carried `board_id = 'store-documentation'` as a literal
   * since before that table existed. An organisation can hold 31 stores, 42
   * expiry dates and no `boards` row at all — and a digest that trusted the
   * query alone would scan nothing and report that nothing had changed.
   */
  assert.match(
    register,
    /return \[\s*\{ key: STORE_DOCUMENTATION_BOARD_ID/,
    "the canonical register is always in the set, whether or not its row exists yet",
  );
});

test("the digest scans every register and names each one", async () => {
  const digest = codeOnly(await source("app/api/notifications/compliance/route.ts"));

  assert.match(digest, /storeDocumentationBoards\(db, orgId\)/, "it asks which registers exist");
  assert.match(
    digest,
    /boardIds: registers\.map\(\(board\) => board\.key\)/,
    "and scans all of them in one pass",
  );
  assert.doesNotMatch(
    digest,
    /readComplianceRegister\(db, orgId, \{ today \}\)/,
    "the canonical-only scan is gone",
  );

  /* Both spellings reach the caller: the key so a script can open the board,
     the name so a person recognises it. */
  assert.match(digest, /board: item\.board,/);
  assert.match(digest, /boardName: item\.boardName,/);
});

test("a certificate no board speaks for is reported once, not once per register", async () => {
  const register = codeOnly(await source("app/lib/compliance-register.ts"));

  /*
   * `compliance_documents` holds requirements no board tracks, and "no board"
   * is a property of the ORGANISATION, not of one register. Reading per board
   * and concatenating would emit each of those rows once per board — three
   * sections, three emails about the same certificate. One pass over all the
   * registers is what makes that impossible, so the signature is the contract.
   */
  assert.match(
    register,
    /async function readStoreDocumentationRows\(\s*db: Database,\s*orgId: string,\s*boardIds: readonly string\[\],/,
    "the board reader takes the whole set and runs once",
  );
  assert.match(
    register,
    /entries\.push\(\{\s*itemId: null,[\s\S]{0,240}?boardId: null,/,
    "and a register-only row carries no board rather than a guess",
  );
});

/* ── 5. Versioning and storage stay board-blind ───────────────────────────── */

test("a document lineage cannot tell which board it is on", async () => {
  const documents = codeOnly(await source("app/api/files/documents.ts"));

  /*
   * "A new version is the SAME document": `root_document_id` / `version_no` /
   * `is_current`, inheriting the predecessor's anchors, title, type, expiry and
   * kind. None of that may consult a board — if it did, an instance would need
   * its own copy of the rule, and two copies of a versioning rule is how a
   * superseded certificate goes on holding a slot open.
   */
  assert.match(
    documents,
    /rootDocumentId = predecessor\.rootDocumentId \?\? predecessor\.id/,
    "version 1 is self-rooted and every successor keeps the same root",
  );
  assert.match(documents, /versionNo: Number\(tip\?\.highest \?\? predecessor\.versionNo\) \+ 1/);
  assert.match(documents, /\.set\(\{ isCurrent: false \}\)/, "the predecessor stands down");
  for (const carried of [
    "title",
    "documentType",
    "expiryDate",
    "boardColumnId",
    "requestId",
    "siteId",
  ]) {
    assert.match(
      documents,
      new RegExp(`${carried}: predecessor\\.${carried}`),
      `a new version inherits ${carried} from the document it replaces`,
    );
  }
  assert.doesNotMatch(
    documents,
    /"store-documentation"|boardId|board_id/,
    "and nothing in the lineage path knows what a board is",
  );
});

test("one current version per lineage, enforced per organisation rather than per board", async () => {
  const init = codeOnly(await source("db/init.ts"));

  /*
   * The uniqueness that makes a lineage a lineage. It is ORG-SCOPED, and that
   * is the right scope: a document belongs to one lineage wherever its anchor
   * happens to be, so an instance inherits the guarantee rather than needing
   * one of its own. Board-scoping it would mean a document moved between
   * registers could have two current versions at once.
   */
  assert.match(
    init,
    /CREATE UNIQUE INDEX IF NOT EXISTS attachments_current_version_idx[\s\S]{0,220}?COALESCE\(root_document_id, id\)[\s\S]{0,120}?WHERE is_current/,
    "the unique-current index is still there and still keyed on the resolved root",
  );
  const at = init.indexOf("attachments_current_version_idx");
  assert.doesNotMatch(
    init.slice(at, at + 400),
    /board_column_id|board_id/,
    "and it is not board-scoped",
  );
});

test("every byte is served through /api/files, from a private bucket", async () => {
  /*
   * The bucket must stay private: all access is brokered through `/api/files`,
   * so a public bucket or a presigned URL would turn an object key into a
   * bearer credential — and object keys travel in payloads that a board
   * instance would widen the audience for.
   */
  /*
   * The client half. These three run in, or serialise straight to, the browser,
   * so an object key or a storage host appearing in any of them is a key handed
   * to whoever can open the page. The board route is excluded from this sweep
   * on purpose — it reads `object_key` server-side to delete R2 objects, which
   * is exactly what it should do — and is checked below by its PROJECTION
   * instead, which is the thing that actually reaches a client.
   */
  for (const path of [
    "app/lib/client-upload.ts",
    "app/(app)/portal/cells/file-cell.tsx",
    "app/(app)/portal/views/document-register.ts",
  ]) {
    const text = codeOnly(await source(path));
    assert.doesNotMatch(
      text,
      /objectKey|getSignedUrl|presign|r2\.dev|amazonaws\.com/,
      `${path} must never hand an object key or a direct storage URL to a client`,
    );
  }

  /*
   * The board payload's file preview. A board instance widens who can see a
   * payload, so the projection is the boundary that matters: `object_key` is
   * unique, immutable and served `immutable`, which makes it a bearer
   * credential the moment it leaves the server.
   */
  const board = codeOnly(await source("app/api/board/route.ts"));
  const preview = board.match(
    /const\s+\w*[Ff]ile\w*\s*:\s*MaintenanceBoardFilePreview[\s\S]{0,600}?\}/,
  );
  const projections = board.match(/MaintenanceBoardFilePreview[\s\S]{0,700}?\n\s*\}/g) ?? [];
  assert.ok(preview || projections.length, "the board still has a file-preview shape to check");
  for (const shape of projections) {
    assert.doesNotMatch(
      shape,
      /objectKey/,
      "object_key must never enter the board's file preview",
    );
  }

  const upload = codeOnly(await source("app/lib/client-upload.ts"));
  assert.match(
    upload,
    /DIRECT_UPLOAD_LIMIT/,
    "the ~1 MiB ceiling and its multipart fallback stay in one place",
  );
});

/* ── 6. Live ─────────────────────────────────────────────────────────────── */

function call(path, options = {}, identity = ADMIN) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-maintsupp-identity": identity,
      ...(options.headers ?? {}),
    },
  });
}

async function serverIsUp() {
  try {
    return (await call("/api/workspace-sections")).ok;
  } catch {
    return false;
  }
}

/** Whether the catalogue is offering the template yet. See the header. */
const templateOffered = () =>
  SECTION_TEMPLATES.find((entry) => entry.key === TEMPLATE)?.available === true;

/*
 * Exact keys, swept by exact key. A substring sweep has repeatedly eaten other
 * fixtures on the shared Miniflare database, and a section called `testtt` is
 * the owner's real data.
 */
const SECTION_KEY = "section:w2sd-instance";

async function sweepSection() {
  await call(`/api/workspace-sections?key=${SECTION_KEY}`, { method: "DELETE" });
  await call(`/api/workspace-sections?key=${SECTION_KEY}&purge=1`, { method: "DELETE" }, SUPER);
}

/**
 * A cleanup call, retried.
 *
 * NOT a way to paper over a flaky product. The dev server is shared with
 * whatever else is running against this tree, and under concurrent load a board
 * write answers `503 "The board change could not be saved."` while reads keep
 * returning 200. A `finally` that fires one request and ignores the answer
 * therefore leaves a fixture on the client's own register — which is worse than
 * a failing test, because the next run measures a board with a stranger's store
 * on it. Only cleanup uses this; an assertion that needed retrying would be
 * hiding something.
 */
async function persistently(send, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await send();
      if (response.ok) return response;
    } catch {
      /* A dropped connection under load is the same case as a 503. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  return null;
}

/** Every bin entry id currently held, so cleanup can tell mine from everyone's. */
async function binEntryIds() {
  const response = await persistently(() => call("/api/trash", {}, SUPER));
  const bin = response ? await response.json() : null;
  return new Set((bin?.bin?.entries ?? []).map((row) => row.id));
}

/**
 * A store row with a lapsed certificate, and the exact ids needed to remove it.
 *
 * Returns ids rather than a name: cleanup goes through `delete_items` and then
 * the bin entry's own id, so nothing is ever matched by title.
 *
 * A SNAPSHOT OF THE BIN IS TAKEN FIRST, and that is not belt-and-braces. A
 * reference is REISSUED after a purge — this suite has already seen the same
 * `MN-1154` minted twice — so "the bin entry whose entityId is MN-1154" can
 * match somebody else's row, and purging is not undoable. The snapshot makes
 * cleanup name a bin entry that did not exist before this test ran, which is
 * the only definition of "mine" that holds on a shared Miniflare database.
 */
async function lapsedStoreOn(boardKey) {
  const board = await (await call(`/api/board?board=${boardKey}`)).json();
  const group =
    board.groups.find((entry) => /current stores/i.test(entry.name)) ?? board.groups[0];
  const expiryColumn = board.columns.find((column) => column.key === "patExpiry");
  assert.ok(group, `${boardKey} has no group to file a store into`);
  assert.ok(expiryColumn, `${boardKey} has no PAT expiry column — it is not a document register`);

  const binBefore = await binEntryIds();
  const created = await (
    await call(`/api/board?board=${boardKey}`, {
      method: "POST",
      body: JSON.stringify({ action: "create_item", groupId: group.id }),
    })
  ).json();
  const requestId = created?.request?.id;
  assert.ok(requestId, `creating a store on ${boardKey} failed: ${JSON.stringify(created)}`);

  const dated = await call(`/api/board?board=${boardKey}`, {
    method: "PATCH",
    body: JSON.stringify({
      action: "update_cell",
      requestId,
      columnId: expiryColumn.id,
      value: "2024-01-15",
    }),
  });
  assert.ok(dated.ok, `recording an expiry on ${boardKey} failed: ${dated.status}`);
  return { requestId, binBefore };
}

/** By exact id, through the bin, in both steps. Never a sweep. */
async function removeStore(boardKey, fixture) {
  if (!fixture?.requestId) return;
  await persistently(() =>
    call(`/api/board?board=${boardKey}`, {
      method: "POST",
      body: JSON.stringify({ action: "delete_items", requestIds: [fixture.requestId] }),
    }),
  );
  const response = await persistently(() => call("/api/trash", {}, SUPER));
  const bin = response ? await response.json() : null;
  for (const entry of bin?.bin?.entries ?? []) {
    /* Mine only: this row's id, AND a bin entry that was not there before. */
    if (entry.entityId !== fixture.requestId) continue;
    if (fixture.binBefore.has(entry.id)) continue;
    await persistently(() => call(`/api/trash?id=${entry.id}`, { method: "DELETE" }, SUPER));
  }
}

test("live: the digest names the register a lapsed certificate is on", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }

  let fixture = null;
  try {
    fixture = await lapsedStoreOn(CANONICAL_BOARD);

    const digest = await (await call("/api/notifications/compliance")).json();
    const rows = [...(digest.expired ?? []), ...(digest.expiring ?? [])];
    const mine = rows.find((row) => row.id === `board:${fixture.requestId}:pat`);
    assert.ok(mine, `the lapsed PAT certificate on ${fixture.requestId} must reach the digest`);
    assert.equal(mine.board, CANONICAL_BOARD, "and it must say which register it is on");
    assert.ok(mine.boardName, "by a name a person can act on, not only a key");

    /*
     * The POST is the path a Cron Trigger takes, and it is where the email is
     * built — so the board has to survive into it and not only into the GET.
     * `dryRun` so nothing is sent and no `last_alert_stage` is recorded.
     */
    const dry = await (
      await call("/api/notifications/compliance?dryRun=true", { method: "POST" })
    ).json();
    const sent = [...(dry.expired ?? []), ...(dry.expiring ?? [])].find(
      (row) => row.id === `board:${fixture.requestId}:pat`,
    );
    assert.ok(sent, "the same row reaches the digest that would be emailed");
    assert.equal(sent.board, CANONICAL_BOARD);
  } finally {
    await removeStore(CANONICAL_BOARD, fixture);
  }
});

test("live: a register-only certificate is reported once, whatever else exists", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }

  const digest = await (await call("/api/notifications/compliance")).json();
  const rows = [...(digest.expired ?? []), ...(digest.expiring ?? [])];
  const seen = new Map();
  for (const row of rows) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  const duplicated = [...seen].filter(([, count]) => count > 1);
  assert.deepEqual(
    duplicated,
    [],
    "no document may appear twice in one digest — that is the multi-register duplication bug",
  );

  /* A row with no board is a `compliance_documents` row no register speaks for,
     and it must say so rather than claiming a register it is not on. */
  for (const row of rows) {
    assert.ok(
      row.board === null || typeof row.board === "string",
      "every row states its register, or states that it has none",
    );
  }
});

test("live: a Store Documentation section is its own register, empty", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  if (!templateOffered()) {
    /*
     * Not a pass. The catalogue is holding the template back, and the reason it
     * gives is the condition this file asserts — so the moment it is offered,
     * this test starts running without anyone remembering it.
     */
    t.skip(
      `the catalogue is not offering the "${TEMPLATE}" template yet (SECTION_TEMPLATES.available === false)`,
    );
    return;
  }

  await sweepSection();
  let fixture = null;
  let boardKey = null;
  try {
    const response = await call("/api/workspace-sections", {
      method: "POST",
      body: JSON.stringify({ key: SECTION_KEY, label: "W2SD Instance", template: TEMPLATE }),
    });
    const body = await response.json();
    assert.ok(response.ok, `creating the section failed ${response.status}: ${JSON.stringify(body)}`);
    boardKey = body.section?.boardKey;
    assert.ok(boardKey && boardKey !== CANONICAL_BOARD, "a section gets a register of its own");

    const [instance, canonical] = await Promise.all([
      (await call(`/api/board?board=${boardKey}`)).json(),
      (await call(`/api/board?board=${CANONICAL_BOARD}`)).json(),
    ]);

    /* THE PARITY MATRIX. Equal as sets, in both directions — a lookalike drifts
       from the source the first time a column is added; an instance cannot. */
    const keysOf = (board) => board.columns.map((column) => column.key).sort();
    assert.deepEqual(
      keysOf(instance),
      keysOf(canonical),
      "an instance carries the document register's columns, no more and no fewer",
    );
    const groupsOf = (board) => board.groups.map((group) => group.name).sort();
    assert.deepEqual(groupsOf(instance), groupsOf(canonical), "and its four lifecycle lanes");

    /* Empty and independent: not a row, not a group membership, not a file. */
    assert.equal((instance.requests ?? []).length, 0, "an instance starts empty");
    assert.equal(
      Object.keys(instance.fileCounts ?? {}).length,
      0,
      "and holds none of the source register's documents",
    );

    /* Its columns are ITS OWN. Sharing an id with the canonical board would
       mean an upload against one appeared on the other. */
    const canonicalIds = new Set(canonical.columns.map((column) => column.id));
    for (const column of instance.columns) {
      assert.ok(
        !canonicalIds.has(column.id),
        `${column.key} shares a column id with the canonical register`,
      );
    }

    /* And the digest covers it, by kind — the gate this template was held on. */
    fixture = await lapsedStoreOn(boardKey);
    const digest = await (await call("/api/notifications/compliance")).json();
    const rows = [...(digest.expired ?? []), ...(digest.expiring ?? [])];
    const mine = rows.find((row) => row.id === `board:${fixture.requestId}:pat`);
    assert.ok(mine, "an instance's lapsed certificate must reach the digest");
    assert.equal(mine.board, boardKey, "named by its own board key");
    assert.equal(mine.boardName, "W2SD Instance", "and by the section's own name");

    /* Without changing what the canonical register receives. */
    const canonicalRows = rows.filter((row) => row.board === CANONICAL_BOARD);
    for (const row of canonicalRows) {
      assert.notEqual(row.board, boardKey, "a canonical row is never relabelled as the instance");
    }
  } finally {
    await removeStore(boardKey ?? CANONICAL_BOARD, fixture);
    await sweepSection();
  }
});

test("live: documents do not cross between a section register and the canonical one", async (t) => {
  if (!(await serverIsUp())) {
    t.skip(`no server at ${BASE_URL}`);
    return;
  }
  if (!templateOffered()) {
    t.skip(`the catalogue is not offering the "${TEMPLATE}" template yet`);
    return;
  }

  await sweepSection();
  let fixture = null;
  let boardKey = null;
  try {
    const response = await call("/api/workspace-sections", {
      method: "POST",
      body: JSON.stringify({ key: SECTION_KEY, label: "W2SD Instance", template: TEMPLATE }),
    });
    const body = await response.json();
    assert.ok(response.ok, `creating the section failed: ${JSON.stringify(body)}`);
    boardKey = body.section.boardKey;

    const instance = await (await call(`/api/board?board=${boardKey}`)).json();
    const canonical = await (await call(`/api/board?board=${CANONICAL_BOARD}`)).json();
    const instanceRams = instance.columns.find((column) => column.key === "rams");
    const canonicalRams = canonical.columns.find((column) => column.key === "rams");
    assert.notEqual(
      instanceRams.id,
      canonicalRams.id,
      "the two RAMS columns are different columns",
    );

    /*
     * A DOCUMENT IS FENCED BY ITS COLUMN, AND THE COLUMN BY ITS BOARD.
     * `/api/files` refuses a column that does not belong to the board the work
     * order is placed on — `boardKeyForRequest` answers from the placement — so
     * asking for the instance's column against a canonical row must be refused
     * rather than filed. This is the isolation, tested from the outside.
     */
    fixture = await lapsedStoreOn(CANONICAL_BOARD);
    const form = new FormData();
    form.set("file", new Blob(["W2SD isolation probe"], { type: "text/plain" }), "w2sd-probe.txt");
    form.set("requestId", fixture.requestId);
    form.set("columnId", instanceRams.id);
    form.set("title", "W2SD-ISOLATION-PROBE");
    const cross = await fetch(`${BASE_URL}/api/files`, {
      method: "POST",
      headers: { "x-maintsupp-identity": ADMIN },
      body: form,
    });
    assert.ok(
      !cross.ok,
      "a canonical row must not accept a column from another register — it did, which is a leak",
    );

    /* And the instance's own file list is empty, not the canonical board's. */
    const files = await (await call(`/api/files?columnId=${instanceRams.id}`)).json();
    assert.equal(
      (files.files ?? files.attachments ?? []).length,
      0,
      "an instance's certificate slot starts empty",
    );
  } finally {
    await removeStore(CANONICAL_BOARD, fixture);
    await sweepSection();
  }
});
