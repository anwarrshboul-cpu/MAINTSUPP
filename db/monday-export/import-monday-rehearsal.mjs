/**
 * Imports the Phase 1 monday export into an isolated MAINTSUPP tenant.
 *
 * Reads ONLY the local export. It never calls monday: a board that has moved on
 * mid-import is how two runs of the same migration produce two different
 * databases, and Phase 1 already captured every byte with a checksum.
 *
 * Deterministic, idempotent and resumable. Every row's id is derived from its
 * monday id, so a second run finds the row and reconciles it rather than
 * inserting a twin — there is no bookkeeping table to fall out of step.
 *
 *   STAGING_DATABASE_URL=... node db/monday-export/import-monday-rehearsal.mjs \
 *     --export D:/MAINTSUPP-Monday-Export/full-2026-09-09 \
 *     --org org_monday_rehearsal \
 *     --phase all
 *
 *   --phase   preflight|sites|jobs|updates|attachments|compliance|counters|all
 *   --batch   rows per statement          (default 100)
 *   --pool    max postgres connections    (default 2)
 *   --dry-run plan and report, write nothing
 *   --rollback delete everything this importer wrote for --org, and stop
 *
 * SAFETY. It refuses to run against the Sunnamusk or Demo organisation ids, and
 * refuses a transaction-pooler URL. Every statement carries organisation_id;
 * nothing reads or writes another tenant's rows.
 *
 * See docs/MONDAY-MIGRATION-PLAN.md for why each mapping is what it is. The
 * rules themselves live in ./monday-transform.mjs, which is pure and tested.
 */

import postgres from "postgres";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import * as T from "./monday-transform.mjs";
import { resolveStoredMime } from "../../app/lib/attachment-mime.ts";

/* Tenants this importer must never write to. */
const PROTECTED_ORGS = new Set([
  "org_000000000000000000000001", // Sunnamusk UK
  "org_000000000000000000000002", // Demo Client Ltd
]);

const MAINTENANCE_BOARD = "maintenance";
const STORE_DOC_BOARD = "store-documentation";

/* ── CLI ─────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { phase: "all", batch: 100, pool: 2, dryRun: false, rollback: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[(i += 1)];
    if (flag === "--export") args.exportDir = next();
    else if (flag === "--org") args.org = next();
    else if (flag === "--phase") args.phase = next();
    else if (flag === "--batch") args.batch = Number(next());
    else if (flag === "--pool") args.pool = Number(next());
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--rollback") args.rollback = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.exportDir) throw new Error("--export is required");
  if (!args.org) throw new Error("--org is required");
  return args;
}

function connect(poolMax) {
  const url = process.env.STAGING_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "STAGING_DATABASE_URL is not set.\n" +
        "  bash:       export STAGING_DATABASE_URL='postgresql://postgres.<ref>:<pw>@<region>.pooler.supabase.com:5432/postgres'\n" +
        "  PowerShell: $env:STAGING_DATABASE_URL = '...'\n" +
        "Use the SESSION pooler on port 5432.",
    );
  }
  if (/:6543\//.test(url)) {
    // db/node-pg-d1.ts documents a measured deadlock on the transaction pooler.
    // An importer that holds a connection across a batch is exactly the shape
    // that hits it.
    throw new Error("refusing port 6543 (transaction pooler); use the session pooler on 5432");
  }
  return postgres(url, {
    max: poolMax,
    idle_timeout: 20,
    connect_timeout: 30,
    prepare: true,
    onnotice: () => {},
  });
}

/* ── Checkpoints ─────────────────────────────────────────────────────────── */

function checkpointPath(exportDir, org) {
  return path.join(exportDir, `rehearsal-checkpoint-${org}.json`);
}

function readCheckpoint(file) {
  if (!existsSync(file)) return { phases: {}, batches: {} };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { phases: {}, batches: {} };
  }
}

function writeCheckpoint(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/* ── Export readers ──────────────────────────────────────────────────────── */

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function loadExport(dir) {
  const read = (slug, name) => {
    const file = path.join(dir, slug, name);
    return existsSync(file) ? loadJson(file) : null;
  };
  return {
    maintenance: read("maintenance", "items.json") ?? [],
    maintenanceSchema: read("maintenance", "schema.json") ?? {},
    storeDoc: read("store-documentation-uk", "items.json") ?? [],
    storeDocSchema: read("store-documentation-uk", "schema.json") ?? {},
    summary: existsSync(path.join(dir, "export-summary.json"))
      ? loadJson(path.join(dir, "export-summary.json"))
      : {},
  };
}

const cell = (item, id) => (item.column_values ?? []).find((c) => c.id === id) ?? {};
const cellText = (item, id) => (cell(item, id).text ?? "").trim();

/** monday column ids, from §6 of the plan. */
const COL = {
  location: "short_text6",
  description: "short_text",
  tier: "dropdown_mm51wmh0",
  engineer: "single_select",
  priority: "status",
  label: "color_mm0ahrtb",
  status: "status1",
  contractor: "text_mm51zcqg",
  assignee: "person",
  requested: "date",
  completed: "date2",
  timeline: "timeline",
  requester: "short_text64",
  nextUpdate: "date_mkmts6wz",
  cost: "numbers",
  approvedBy: "text",
  invoice: "text6",
  number: "numbertb4g1z46",
  storeLocation: "single_selecty9rcyhe",
  formView: "form_view_19b7dd3b",
};

/* ── Row builders (pure, given the export) ───────────────────────────────── */

/**
 * Every job, transformed. Returns rows plus the anomalies the transform found,
 * so nothing is corrected silently.
 */
export function planJobs(items, aliasIndex, groupStageByName) {
  const rows = [];
  const anomalies = [];
  for (const item of items) {
    const groupTitle = (item.group ?? {}).title ?? "";
    const signals = {
      storeLocation: cellText(item, COL.storeLocation),
      group: groupTitle,
      locationRaw: cellText(item, COL.location),
    };
    const site = T.resolveSite(signals, aliasIndex);
    const label = T.blankToNull(cellText(item, COL.label));
    const engineer = T.engineerValue(cellText(item, COL.engineer));
    const description = cellText(item, COL.description);
    const sourceNumber = cellText(item, COL.number);
    const status = cellText(item, COL.status);
    const completedAt = T.dateValue(cellText(item, COL.completed));

    const { title, rule } = T.jobTitle({
      site: site.canonical,
      label,
      description,
      locationRaw: signals.locationRaw,
      sourceNumber,
      sourceItemId: item.id,
    });

    if (site.review) {
      anomalies.push({
        kind: site.method === "conflict" ? "site-conflict" : "site-unresolved",
        entityType: "job",
        entityId: item.id,
        sourceName: item.name ?? "",
        field: "site_id",
        originalValue: JSON.stringify(signals),
        appliedValue: null,
        detail: site.detail,
      });
    }
    if (engineer.corrected) {
      anomalies.push({
        kind: "spelling-corrected",
        entityType: "job",
        entityId: item.id,
        sourceName: item.name ?? "",
        field: "engineer",
        originalValue: engineer.raw,
        appliedValue: engineer.value,
        detail: "monday's option is spelled Plummer; the trade is a plumber",
      });
    }

    rows.push({
      externalId: String(item.id),
      siteCanonical: site.canonical,
      siteMethod: site.method,
      title,
      titleRule: rule,
      sourceItemName: item.name ?? "",
      sourceGroup: groupTitle,
      sourceNumber: sourceNumber || null,
      sourceUrl: item.url ?? null,
      description,
      location: signals.locationRaw,
      requester: cellText(item, COL.requester),
      contact: sourceNumber,
      category: label ?? "",
      engineer: engineer.value ?? "",
      tier: T.tierNumber(cellText(item, COL.tier)),
      priority: T.blankToNull(cellText(item, COL.priority)),
      status: status || "Pending Approval",
      stage: T.stageFor({
        groupStageKey: groupStageByName.get(groupTitle) ?? null,
        status,
        completedAt,
      }),
      contractor: T.blankToNull(cellText(item, COL.contractor)),
      assignee: T.blankToNull(cellText(item, COL.assignee)),
      approvedBy: T.blankToNull(cellText(item, COL.approvedBy)),
      invoice: T.blankToNull(cellText(item, COL.invoice)),
      formUrl: T.blankToNull(cellText(item, COL.formView)),
      requestedAt: T.dateValue(cellText(item, COL.requested)) ?? item.created_at ?? null,
      completedAt,
      dueAt: T.timelineEnd(cellText(item, COL.timeline)),
      nextUpdateAt: T.dateValue(cellText(item, COL.nextUpdate)),
      cost: T.costValue(cellText(item, COL.cost)),
      archived: (item.state ?? "active") !== "active",
      createdAt: item.created_at ?? null,
      updatedAt: item.updated_at ?? null,
      timeline: cellText(item, COL.timeline),
      label,
    });
  }
  return { rows, anomalies };
}

/** Every update and reply, flattened with threading preserved. */
export function planUpdates(items) {
  const rows = [];
  for (const item of items) {
    for (const update of item.updates ?? []) {
      rows.push({
        id: `mu-${update.id}`,
        sourceUpdateId: String(update.id),
        parentId: null,
        requestExternalId: String(item.id),
        authorName: (update.creator ?? {}).name || "Imported from monday",
        authorEmail: (update.creator ?? {}).email || null,
        body: update.text_body ?? "",
        createdAt: update.created_at ?? null,
      });
      for (const reply of update.replies ?? []) {
        rows.push({
          id: `mr-${reply.id}`,
          sourceUpdateId: String(reply.id),
          parentId: `mu-${update.id}`,
          requestExternalId: String(item.id),
          authorName: (reply.creator ?? {}).name || "Imported from monday",
          authorEmail: (reply.creator ?? {}).email || null,
          body: reply.text_body ?? "",
          createdAt: reply.created_at ?? null,
        });
      }
    }
  }
  return rows;
}

/** Which file column an asset came from — the raw cell value, never the text. */
function assetColumnIndex(item) {
  const index = new Map();
  for (const cv of item.column_values ?? []) {
    if (cv.type !== "file" || !cv.value || cv.value === "null") continue;
    let parsed;
    try {
      parsed = JSON.parse(cv.value);
    } catch {
      continue;
    }
    for (const file of parsed.files ?? []) {
      if (file.assetId != null) index.set(String(file.assetId), cv.id);
    }
  }
  return index;
}

/**
 * One attachment row per (item, asset), from both boards.
 *
 * `manifest` supplies the checksum and the local path — the export already
 * hashed every byte, so nothing is re-read here.
 */
export function planAttachments({ maintenance, storeDoc }, manifestByAsset) {
  const rows = [];
  const push = (item, asset, board, source, columnId, extra) => {
    const manifest = manifestByAsset.get(String(asset.id)) ?? {};
    const mime = resolveStoredMime({
      declaredType: manifest.content_type,
      filename: asset.name ?? manifest.name ?? "",
    });
    rows.push({
      id: `ma-${asset.id}`,
      sourceAssetId: String(asset.id),
      board,
      source,
      requestExternalId: board === MAINTENANCE_BOARD ? String(item.id) : null,
      storeDocItemId: board === STORE_DOC_BOARD ? String(item.id) : null,
      sourceColumnId: columnId ?? null,
      originalName: asset.name ?? `asset_${asset.id}`,
      // monday's CDN returned no Content-Type for 200 of the 3,107 assets. The
      // first pass stored the fallback as if it were a fact, which both failed
      // the upload validator and would have filed 123 photographs as
      // undisplayable. One helper decides it, shared with the app's own routes.
      contentType: mime.mime ?? "application/octet-stream",
      contentTypeSource: mime.source,
      sourceContentType: manifest.content_type ?? "",
      byteSize: Number(manifest.downloaded_size ?? asset.file_size ?? 0),
      checksum: manifest.sha256 ?? null,
      localPath: manifest.path ?? null,
      createdAt: asset.created_at ?? null,
      uploadedBy: (asset.uploaded_by ?? {}).email ?? null,
      ...extra,
    });
  };

  for (const item of maintenance) {
    const columns = assetColumnIndex(item);
    for (const asset of item.assets ?? []) {
      const columnId = columns.get(String(asset.id)) ?? null;
      const mapped = columnId ? T.MAINTENANCE_FILE_COLUMNS.get(columnId) : null;
      push(item, asset, MAINTENANCE_BOARD, "item", columnId, {
        columnKey: mapped?.columnKey ?? null,
        kind: mapped?.kind ?? "general",
      });
    }
    for (const update of item.updates ?? []) {
      for (const asset of update.assets ?? []) {
        push(item, asset, MAINTENANCE_BOARD, `update:${update.id}`, null, {
          columnKey: null, kind: "general", updateId: `mu-${update.id}`,
        });
      }
      for (const reply of update.replies ?? []) {
        for (const asset of reply.assets ?? []) {
          push(item, asset, MAINTENANCE_BOARD, `reply:${reply.id}`, null, {
            columnKey: null, kind: "general", updateId: `mr-${reply.id}`,
          });
        }
      }
    }
  }

  for (const item of storeDoc) {
    const columns = assetColumnIndex(item);
    for (const asset of item.assets ?? []) {
      const columnId = columns.get(String(asset.id)) ?? null;
      const slot = columnId ? T.STORE_DOC_FILE_COLUMNS.get(columnId) : null;
      push(item, asset, STORE_DOC_BOARD, "item", columnId, {
        columnKey: slot?.columnKey ?? null,
        kind: "general",
        slot: slot?.slot ?? null,
        slotLabel: slot?.label ?? null,
        verifiable: T.isVerifiableEvidence(asset.name ?? ""),
      });
    }
  }
  return rows;
}

/**
 * The compliance register, one row per site per requirement the source knows
 * about — plus the anomalies that say why a requirement is not evidenced.
 */
export function planCompliance(storeDocItems, aliasIndex, attachments, today) {
  /*
   * Keyed on (site, requirement), not on (source row, requirement).
   *
   * Cardiff is one site built from two Store Documentation rows, so iterating
   * the source rows emits twelve requirements twice and Postgres refuses the
   * upsert outright — "ON CONFLICT DO UPDATE command cannot affect row a second
   * time". It was right to: two rows claiming to be the same requirement on the
   * same site is a question about which one is true, not something to resolve by
   * whichever happened to sort last.
   *
   * The merge rule is evidence-first. A requirement with a usable certificate
   * beats one without; an expiry beats no expiry. So Cardiff's PAT ends up
   * carrying the certificate and date that actually exist, from whichever of the
   * two source rows held them.
   */
  const merged = new Map();
  const rows = [];
  const anomalies = [];
  const bySite = new Map();
  for (const attachment of attachments) {
    if (attachment.board !== STORE_DOC_BOARD) continue;
    const list = bySite.get(attachment.storeDocItemId) ?? [];
    list.push(attachment);
    bySite.set(attachment.storeDocItemId, list);
  }

  for (const item of storeDocItems) {
    const name = item.name ?? "";
    if (T.NOT_A_SITE.has(name)) {
      anomalies.push({
        kind: "row-skipped",
        entityType: "store-doc",
        entityId: String(item.id),
        sourceName: name,
        detail: "empty placeholder — not imported as a site",
      });
      continue;
    }
    const canonical = aliasIndex.get(T.normalise(name));
    if (!canonical) continue;

    const files = bySite.get(String(item.id)) ?? [];
    for (const [, slot] of T.STORE_DOC_FILE_COLUMNS) {
      const forSlot = files.filter((f) => f.slot === slot.slot);
      const usable = forSlot.filter((f) => f.verifiable);
      const expiry = slot.expiry ? T.dateValue(cellText(item, slot.expiry)) : null;
      const key = `${canonical}::${slot.slot}`;
      const previous = merged.get(key);
      const state = T.complianceState({
        slot: slot.slot, hasCertificate: usable.length > 0, expiry, today,
      });
      const candidate = {
        canonical, slot: slot.slot, label: slot.label, status: state.status, expiry,
        attachmentId: usable.length ? usable[0].id : null,
        organisationLevel: T.ORGANISATION_LEVEL_SLOTS.has(slot.slot),
        flag: state.flag,
        sourceName: name,
      };
      // Evidence-first: a certificate beats none, then an expiry beats none.
      const score = (row) => (row.attachmentId ? 2 : 0) + (row.expiry ? 1 : 0);
      if (!previous || score(candidate) > score(previous)) merged.set(key, candidate);
      for (const held of forSlot.filter((f) => !f.verifiable)) {
        const suspicion = T.SUSPICIOUS_ASSET_NAMES.get(held.originalName) ?? {};
        anomalies.push({
          kind: "document-site-mismatch",
          entityType: "attachment",
          entityId: held.id,
          sourceName: held.originalName,
          field: slot.label,
          originalValue: `filed against ${suspicion.filedAgainst ?? canonical}`,
          appliedValue: `filename names ${suspicion.suggests ?? "another site"}`,
          detail:
            "preserved with its bytes and checksum, but NOT accepted as evidence for this requirement",
        });
      }
    }
  }

  for (const row of merged.values()) {
    rows.push(row);
    if (row.flag) {
      anomalies.push({
        kind: row.flag, entityType: "compliance",
        entityId: `${row.canonical}:${row.slot}`, sourceName: row.sourceName,
        detail: `${row.label}: ${row.flag}`,
      });
    }
  }
  return { rows, anomalies };
}

/* ── Database ────────────────────────────────────────────────────────────── */

async function preflight(sql, org) {
  if (PROTECTED_ORGS.has(org)) {
    throw new Error(`refusing to write to protected organisation ${org}`);
  }
  const [organisation] = await sql`
    select id, name, slug, status from portal.organisations where id = ${org}`;
  if (!organisation) {
    throw new Error(
      `organisation ${org} does not exist. Create the rehearsal tenant first — ` +
        "see docs/MONDAY-MIGRATION-PLAN.md.",
    );
  }
  if (!/rehearsal/i.test(organisation.name) && !/rehearsal/i.test(organisation.slug)) {
    throw new Error(
      `organisation ${org} is named ${JSON.stringify(organisation.name)}, which does not ` +
        "read as a rehearsal tenant. Refusing, so a mistyped id cannot land in a real one.",
    );
  }

  const columns = await sql`
    select table_name, column_name from information_schema.columns
     where table_schema = 'portal'
       and (table_name, column_name) in (
         ('maintenance_requests','source_item_name'), ('maintenance_requests','source_group'),
         ('maintenance_requests','source_number'), ('maintenance_requests','source_url'),
         ('maintenance_requests','title_rule'), ('attachments','source_asset_id'),
         ('attachments','checksum_sha256'), ('attachments','source_column_id'),
         ('item_updates','source_update_id'))`;
  const missing = 9 - columns.length;
  if (missing > 0) {
    throw new Error(
      `${missing} additive column(s) are absent. Boot the app against this database once so ` +
        "db/init.ts reconciles them, then re-run.",
    );
  }
  return organisation;
}

async function chunked(rows, size, run) {
  for (let i = 0; i < rows.length; i += size) {
    await run(rows.slice(i, i + size), i);
  }
}

/** Retries a transient connection failure; anything else is a real error. */
async function withRetry(label, fn, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const transient =
        /ECONNRESET|ETIMEDOUT|EPIPE|Connection terminated|connection closed|too many clients|EMAXCONNSESSION/i.test(
          String(error?.message ?? error),
        );
      if (!transient || attempt >= attempts) throw error;
      const wait = 500 * 2 ** attempt;
      console.log(`    ${label}: transient error, retrying in ${wait}ms (${attempt}/${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function rollback(sql, org) {
  if (PROTECTED_ORGS.has(org)) throw new Error(`refusing to delete from ${org}`);
  const tables = [
    "item_update_likes", "item_updates", "attachments", "compliance_documents",
    "maintenance_board_cells", "maintenance_group_items", "maintenance_requests",
    "site_aliases", "sites", "contractor_name_aliases", "contractors", "import_anomalies",
  ];
  const removed = {};
  for (const table of tables) {
    const result = await sql.unsafe(
      `delete from portal.${table} where organisation_id = $1`, [org],
    );
    removed[table] = result.count ?? 0;
  }
  return removed;
}

export { parseArgs, connect, preflight, rollback, chunked, withRetry, loadExport, COL };

/* ── Orchestration ───────────────────────────────────────────────────────── */

function readManifest(exportDir) {
  const file = path.join(exportDir, "file-manifest.csv");
  const byAsset = new Map();
  if (!existsSync(file)) return byAsset;
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(lines[0]);
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    if (row.asset_id) byAsset.set(row.asset_id, row);
  }
  return byAsset;
}

/** A CSV line, respecting quotes — filenames contain commas. */
function splitCsvLine(line) {
  const out = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { value += '"'; i += 1; } else quoted = false;
      } else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { out.push(value); value = ""; }
    else value += char;
  }
  out.push(value);
  return out;
}

/** Group title -> the board's own lifecycle key, from the seeded groups. */
function groupStageMap(schema) {
  const map = new Map();
  for (const group of schema.groups ?? []) {
    const title = group.title ?? "";
    if (/(completed|complited)\s*$/i.test(title.trim())) map.set(title, "Completed");
    else if (/^jobs booked$/i.test(title.trim())) map.set(title, "Booked");
  }
  return map;
}

export function buildPlan(exportDir, today = new Date().toISOString().slice(0, 10)) {
  const data = loadExport(exportDir);
  const aliasIndex = T.buildAliasIndex();
  const manifest = readManifest(exportDir);
  const jobs = planJobs(data.maintenance, aliasIndex, groupStageMap(data.maintenanceSchema));
  const updates = planUpdates(data.maintenance);
  const attachments = planAttachments(
    { maintenance: data.maintenance, storeDoc: data.storeDoc }, manifest,
  );
  const compliance = planCompliance(data.storeDoc, aliasIndex, attachments, today);
  return { data, aliasIndex, jobs, updates, attachments, compliance, manifest };
}

export function summarise(plan) {
  const { jobs, updates, attachments, compliance, data } = plan;
  const byRule = {};
  for (const row of jobs.rows) byRule[row.titleRule] = (byRule[row.titleRule] ?? 0) + 1;
  const byMethod = {};
  for (const row of jobs.rows) byMethod[row.siteMethod] = (byMethod[row.siteMethod] ?? 0) + 1;
  const costed = jobs.rows.filter((r) => r.cost !== null);
  return {
    sourceItems: data.maintenance.length,
    jobs: jobs.rows.length,
    blankTitles: jobs.rows.filter((r) => !r.title.trim()).length,
    titleRules: byRule,
    siteMethods: byMethod,
    unresolvedSites: jobs.rows.filter((r) => !r.siteCanonical).length,
    costedJobs: costed.length,
    zeroCostJobs: costed.filter((r) => r.cost === 0).length,
    totalCost: Math.round(costed.reduce((sum, r) => sum + r.cost, 0) * 100) / 100,
    updates: updates.filter((u) => !u.parentId).length,
    replies: updates.filter((u) => u.parentId).length,
    attachments: attachments.length,
    attachmentsWithChecksum: attachments.filter((a) => a.checksum).length,
    attachmentBytes: attachments.reduce((sum, a) => sum + (a.byteSize || 0), 0),
    storeDocRows: data.storeDoc.length,
    complianceRecords: compliance.rows.length,
    anomalies: jobs.anomalies.length + compliance.anomalies.length,
    distinctStatuses: new Set(jobs.rows.map((r) => r.status)).size,
    distinctLabels: new Set(jobs.rows.map((r) => r.label).filter(Boolean)).size,
    distinctGroups: new Set(jobs.rows.map((r) => r.sourceGroup)).size,
    distinctSites: new Set(jobs.rows.map((r) => r.siteCanonical).filter(Boolean)).size,
  };
}

/**
 * A short, stable digest of the plan's shape.
 *
 * Counts rather than content: it has to change when the export changes and stay
 * identical when the same export is re-planned, and it must not carry client
 * data into a file that sits beside the export.
 */
function planFingerprint(summary) {
  const canonical = JSON.stringify(summary, Object.keys(summary).sort());
  let hash = 0;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = (Math.imul(31, hash) + canonical.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan(args.exportDir);
  const summary = summarise(plan);

  console.log("MONDAY -> MAINTSUPP rehearsal import");
  console.log(`  export      : ${args.exportDir}`);
  console.log(`  organisation: ${args.org}`);
  console.log(`  phase       : ${args.phase}   batch ${args.batch}   pool ${args.pool}`);
  console.log("");
  for (const [key, value] of Object.entries(summary)) {
    console.log(`  ${key.padEnd(24)} ${typeof value === "object" ? JSON.stringify(value) : value}`);
  }

  /*
   * The checkpoint records what the plan WAS, not only how far the run got.
   *
   * Resuming against a different plan is worse than starting again: the second
   * half of one migration written on top of the first half of another produces
   * a database that reconciles against neither. The fingerprint is what lets a
   * resume refuse rather than quietly interleave two exports.
   */
  const checkpointFile = checkpointPath(args.exportDir, args.org);
  const checkpoint = readCheckpoint(checkpointFile);
  const fingerprint = planFingerprint(summary);
  if (checkpoint.fingerprint && checkpoint.fingerprint !== fingerprint) {
    throw new Error(
      `checkpoint ${checkpointFile} was written for a different plan ` +
        `(${checkpoint.fingerprint} vs ${fingerprint}). Delete it to start again, ` +
        "or restore the export it was made from.",
    );
  }
  checkpoint.fingerprint = fingerprint;
  checkpoint.export = args.exportDir;
  checkpoint.organisation = args.org;

  if (args.dryRun) {
    console.log("\nDRY RUN — nothing was written.");
    const out = path.join(args.exportDir, "reports", "import-plan.json");
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ summary, anomalies: [...plan.jobs.anomalies, ...plan.compliance.anomalies] }, null, 2)}\n`);
    checkpoint.phases.plan = new Date().toISOString();
    writeCheckpoint(checkpointFile, checkpoint);
    console.log(`Plan written to ${out}`);
    console.log(`Checkpoint  ${checkpointFile}  (fingerprint ${fingerprint})`);
    return;
  }

  const sql = connect(args.pool);
  try {
    const organisation = await preflight(sql, args.org);
    console.log(`\npreflight OK — ${organisation.name} (${organisation.slug})`);
    if (args.rollback) {
      const removed = await rollback(sql, args.org);
      console.log("rollback:", JSON.stringify(removed));
      return;
    }
    console.log(
      "\nWrite phases are not enabled in this build. The plan above is what would be written;\n" +
      "run with --dry-run to persist it, or --rollback to clear a previous run.",
    );
    checkpoint.phases.preflight = new Date().toISOString();
    writeCheckpoint(checkpointFile, checkpoint);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("import-monday-rehearsal.mjs")) {
  main().catch((error) => {
    console.error(`\nFAILED: ${error.message}`);
    process.exit(1);
  });
}
