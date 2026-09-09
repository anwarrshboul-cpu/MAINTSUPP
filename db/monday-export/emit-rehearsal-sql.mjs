/**
 * Turns the import plan into idempotent SQL, in chunks.
 *
 *   node db/monday-export/emit-rehearsal-sql.mjs \
 *     --export D:/MAINTSUPP-Monday-Export/full-2026-09-09 \
 *     --org org_000000000000000000000003 \
 *     --out D:/MAINTSUPP-Monday-Export/full-2026-09-09/rehearsal-sql
 *
 * Why SQL files rather than a live connection: the importer can drive either,
 * and a file is the transport that works when the direct Postgres credential
 * does not. It is also reviewable before it runs, which a stream of prepared
 * statements is not.
 *
 * Every statement is an upsert keyed on an id derived from the monday id, so
 * running a file twice reconciles rather than duplicating. The files are
 * numbered and must run in order: jobs reference sites, cells and group
 * placements are derived from jobs, compliance references attachments.
 *
 * Chunked at ~40 KB so a single statement never exceeds what a SQL console or
 * an HTTP API will accept.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildPlan, summarise } from "./import-monday-rehearsal.mjs";
import * as T from "./monday-transform.mjs";

const CHUNK_BYTES = 40_000;

/** A SQL string literal. Single quotes doubled; nothing else is interpolated. */
function q(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}
function n(value) {
  return value === null || value === undefined || value === "" ? "NULL" : String(Number(value));
}
/**
 * A string literal for a NOT NULL column.
 *
 * `q` maps "" to NULL, which is right for a nullable column and fatal for one
 * declared NOT NULL — sites.type, .country and .address all are, and the
 * International sites deliberately carry an empty value for each where monday
 * states none.
 */
function qn(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}
function b(value) {
  return value ? "TRUE" : "FALSE";
}
/** A monday timestamp, or NULL. Postgres parses ISO-8601 directly. */
function ts(value) {
  return value ? `'${String(value).replace(/'/g, "''")}'::timestamptz` : "NULL";
}

/**
 * One INSERT per chunk of rows.
 *
 * Split by serialised size rather than row count, because an attachment row
 * with a long filename is several times the size of a compliance row and a
 * fixed count would make some chunks tiny and others too large to send.
 */
function chunkedInsert({ header, rows, conflict, select = false, chunkBytes = CHUNK_BYTES }) {
  const files = [];
  let current = [];
  let size = 0;
  const flush = () => {
    if (!current.length) return;
    const values = current.join(",\n");
    files.push(
      select
        ? `${header.replace("VALUES_PLACEHOLDER", `VALUES\n${values}`)}\n${conflict};\n`
        : `${header}\nVALUES\n${values}\n${conflict};\n`,
    );
    current = [];
    size = 0;
  };
  for (const row of rows) {
    if (size + row.length > chunkBytes && current.length) flush();
    current.push(row);
    size += row.length + 2;
  }
  flush();
  return files;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[(i += 1)];
    if (flag === "--export") args.exportDir = next();
    else if (flag === "--org") args.org = next();
    else if (flag === "--out") args.out = next();
    else throw new Error(`unknown argument ${flag}`);
  }
  for (const required of ["exportDir", "org", "out"]) {
    if (!args[required]) throw new Error(`--${required.replace("Dir", "")} is required`);
  }
  return args;
}

/* ── Site rows, from the Store Documentation board ───────────────────────── */

const STORE_DOC_TEXT = { type: "text9", address: "text1", access: "text3" };

function siteRows(plan, org) {
  const byCanonical = new Map();
  const aliasIndex = plan.aliasIndex;

  for (const entry of T.SITE_REGISTER) {
    const international = (entry.region ?? "UK") === "International";
    byCanonical.set(entry.canonical, {
      canonical: entry.canonical,
      status: entry.status,
      /*
       * Empty, not a guess, where the source does not say.
       *
       * §B is explicit: exact source evidence for address, country and type,
       * and nothing invented. Defaulting a Swedish store to type "Kiosk" and
       * country "United Kingdom" would have put fiction into the two fields a
       * person would most reasonably trust — and neither is recoverable later,
       * because nothing downstream would know it had been guessed. `type` and
       * `country` are NOT NULL, so the honest value is the empty string, and
       * each one is recorded as an anomaly rather than left silent.
       */
      type: entry.type ?? (international ? "" : "Kiosk"),
      region: entry.region ?? "UK",
      country: entry.country ?? (international ? "" : "United Kingdom"),
      address: "",
      access: "",
      international,
      sourceItemIds: [],
      sourceNames: [],
      aliases: new Set([entry.canonical, ...entry.aliases]),
    });
  }

  for (const item of plan.data.storeDoc) {
    const name = item.name ?? "";
    if (T.NOT_A_SITE.has(name)) continue;
    const canonical = aliasIndex.get(T.normalise(name));
    if (!canonical) continue;
    const site = byCanonical.get(canonical);
    const text = (id) =>
      ((item.column_values ?? []).find((c) => c.id === id)?.text ?? "").trim();
    // First row wins for the shared fields; the second Cardiff row contributes
    // its aliases and source id but must not overwrite the surviving address.
    if (!site.address) site.address = text(STORE_DOC_TEXT.address);
    if (!site.access) site.access = text(STORE_DOC_TEXT.access);
    const type = text(STORE_DOC_TEXT.type);
    if (type) site.type = type;
    site.sourceItemIds.push(String(item.id));
    site.sourceNames.push(name);
    site.aliases.add(name);
  }

  const lifecycle = (status) => (status === "Closed" ? "Closed" : "Current");
  const dbStatus = (status) =>
    status === "Closed" ? "closed" : status === "Other" ? "other" : "active";

  const rows = [];
  const aliasRows = [];
  const anomalies = [];
  let position = 0;
  for (const site of byCanonical.values()) {
    const id = `site-${T.siteCode(site.canonical)}`;
    position += 1;
    for (const [field, value] of [["type", site.type], ["country", site.country], ["address", site.address]]) {
      if (!value) {
        anomalies.push({
          kind: "site-field-not-in-source",
          entityType: "site",
          entityId: id,
          sourceName: site.canonical,
          field,
          originalValue: null,
          appliedValue: null,
          detail: `monday states no ${field} for this site; left empty rather than guessed`,
        });
      }
    }
    if (site.sourceItemIds.length > 1) {
      anomalies.push({
        kind: "site-merge",
        entityType: "site",
        entityId: id,
        sourceName: site.canonical,
        field: "monday_item_id",
        originalValue: site.sourceItemIds.join(", "),
        appliedValue: id,
        detail:
          `${site.sourceItemIds.length} Store Documentation rows (${site.sourceNames.join(" | ")}) ` +
          "resolve to this one site. Proved by byte-identical PAT certificates from monday job " +
          "1057752 and by the surviving address, which names the other row's unit reference.",
      });
    }
    rows.push(
      `(${q(id)}, ${q(org)}, ${q("monday-migration-rehearsal")}, ${qn(site.canonical)}, ` +
        `${qn(site.type)}, ${qn(site.region)}, ${qn(lifecycle(site.status))}, ${qn(site.address)}, ` +
        `${qn(dbStatus(site.status))}, ${qn(site.country)}, ${position}, ` +
        `${b(site.status !== "Closed")}, ${q(T.siteCode(site.canonical))}, ` +
        `${q(T.siteCode(site.canonical))}, ${q(site.access)}, ` +
        `${q(site.sourceNames[0] ?? null)}, ${q(site.sourceNames.join(" | ") || null)})`,
    );
    for (const alias of site.aliases) {
      const normalised = T.normalise(alias);
      if (!normalised) continue;
      aliasRows.push(
        `(${q(`alias-${T.siteCode(site.canonical)}-${normalised.replace(/\s+/g, "-").slice(0, 40)}`)}, ` +
          `${q(org)}, ${q(id)}, ${q(alias)}, ${q(normalised)}, ${q("monday-migration")})`,
      );
    }
  }
  return { rows, aliasRows, anomalies, byCanonical };
}

/* ── Emission ────────────────────────────────────────────────────────────── */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan(args.exportDir);
  const summary = summarise(plan);
  const org = args.org;
  const files = [];

  if (existsSync(args.out)) rmSync(args.out, { recursive: true, force: true });
  mkdirSync(args.out, { recursive: true });

  const add = (name, sql) => files.push({ name, sql });

  /* 00 — sites and aliases. Everything else references these. */
  const sites = siteRows(plan, org);
  add("00-sites.sql", chunkedInsert({
    header:
      "INSERT INTO portal.sites (id, organisation_id, client_id, name, type, region, lifecycle, " +
      "address, status, country, position, active, code, slug, access_url, " +
      "monday_compliance_name, notes)",
    rows: sites.rows,
    conflict:
      "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, " +
      "region = EXCLUDED.region, lifecycle = EXCLUDED.lifecycle, address = EXCLUDED.address, " +
      "status = EXCLUDED.status, country = EXCLUDED.country, active = EXCLUDED.active, " +
      "access_url = EXCLUDED.access_url, monday_compliance_name = EXCLUDED.monday_compliance_name, " +
      "notes = EXCLUDED.notes, updated_at = now()",
  }).join("\n"));

  add("01-site-aliases.sql", chunkedInsert({
    header: "INSERT INTO portal.site_aliases (id, organisation_id, site_id, alias, normalised, source)",
    rows: sites.aliasRows,
    conflict: "ON CONFLICT (organisation_id, normalised) DO NOTHING",
  }).join("\n"));

  /* 02 — jobs. */
  const jobRows = plan.jobs.rows.map((job) => {
    const siteId = job.siteCanonical ? `site-${T.siteCode(job.siteCanonical)}` : null;
    return (
      `(${q(`job-${job.externalId}`)}, ${q(org)}, ${q("monday-migration-rehearsal")}, ` +
      `${q(siteId)}, ${qn("monday import")}, ${q(job.externalId)}, ${qn(job.title)}, ` +
      `${n(job.titleRule)}, ${q(job.sourceItemName)}, ${q(job.sourceGroup)}, ` +
      `${q(job.sourceNumber)}, ${q(job.sourceUrl)}, ${qn(job.description)}, ${qn(job.location)}, ` +
      `${qn(job.requester)}, ${qn(job.contact)}, ${qn(job.category)}, ${qn(job.engineer)}, ` +
      `${job.tier === null ? 2 : job.tier}, ${qn(job.priority ?? "Medium")}, ${qn(job.stage)}, ` +
      `${qn(job.status)}, ${q(job.contractor)}, ${q(job.assignee)}, ${q(job.approvedBy)}, ` +
      `${q(job.invoice)}, ${q(job.formUrl)}, ${ts(job.requestedAt)}, ${q(job.completedAt)}, ` +
      `${q(job.dueAt)}, ${q(job.nextUpdateAt)}, ${n(job.cost)}, ${b(job.archived)}, ` +
      `${ts(job.createdAt)}, ${ts(job.updatedAt)})`
    );
  });
  chunkedInsert({
    header:
      "INSERT INTO portal.maintenance_requests (id, organisation_id, client_id, site_id, source, " +
      "external_id, title, title_rule, source_item_name, source_group, source_number, source_url, " +
      "description, location, requester, contact, category, engineer, tier, priority, stage, status, " +
      "contractor, assignee, approved_by, invoice, form_url, requested_at, completed_at, due_at, " +
      "next_update_at, cost, archived, created_at, updated_at)",
    rows: jobRows,
    conflict:
      "ON CONFLICT (id) DO UPDATE SET site_id = EXCLUDED.site_id, title = EXCLUDED.title, " +
      "title_rule = EXCLUDED.title_rule, source_item_name = EXCLUDED.source_item_name, " +
      "source_group = EXCLUDED.source_group, source_number = EXCLUDED.source_number, " +
      "source_url = EXCLUDED.source_url, description = EXCLUDED.description, " +
      "location = EXCLUDED.location, requester = EXCLUDED.requester, contact = EXCLUDED.contact, " +
      "category = EXCLUDED.category, engineer = EXCLUDED.engineer, tier = EXCLUDED.tier, " +
      "priority = EXCLUDED.priority, stage = EXCLUDED.stage, status = EXCLUDED.status, " +
      "contractor = EXCLUDED.contractor, assignee = EXCLUDED.assignee, " +
      "approved_by = EXCLUDED.approved_by, invoice = EXCLUDED.invoice, " +
      "form_url = EXCLUDED.form_url, completed_at = EXCLUDED.completed_at, " +
      "due_at = EXCLUDED.due_at, next_update_at = EXCLUDED.next_update_at, cost = EXCLUDED.cost, " +
      "archived = EXCLUDED.archived, updated_at = now()",
  }).forEach((sql, i) => add(`02-jobs-${String(i + 1).padStart(2, "0")}.sql`, sql));

  /* 03 — group placements, derived from source_group. No data crosses. */
  add("03-group-items.sql",
    "INSERT INTO portal.maintenance_group_items (request_id, organisation_id, client_id, board_id, group_id, position)\n" +
    "SELECT r.id, r.organisation_id, 'monday-migration-rehearsal', 'maintenance', g.id,\n" +
    "       row_number() OVER (PARTITION BY g.id ORDER BY r.requested_at, r.id)\n" +
    `  FROM portal.maintenance_requests r\n` +
    "  JOIN portal.maintenance_groups g\n" +
    "    ON g.organisation_id = r.organisation_id AND g.board_id = 'maintenance'\n" +
    "   AND g.name = r.source_group\n" +
    ` WHERE r.organisation_id = ${q(org)}\n` +
    "ON CONFLICT (request_id) DO UPDATE SET group_id = EXCLUDED.group_id;\n");

  /* 04 — board cells, derived server-side from the row that was just written. */
  const cellSources = [
    ["name", "r.title"], ["location", "r.location"], ["description", "r.description"],
    ["tier", "'Tier ' || r.tier"], ["engineer", "r.engineer"], ["priority", "r.priority"],
    ["label", "r.category"], ["status", "r.status"], ["contractor", "r.contractor"],
    ["assignee", "r.assignee"], ["requested", "to_char(r.requested_at, 'YYYY-MM-DD')"],
    ["completed", "r.completed_at"], ["requester", "r.requester"],
    ["nextUpdate", "r.next_update_at"], ["cost", "r.cost::text"],
    ["approvedBy", "r.approved_by"], ["invoice", "r.invoice"], ["number", "r.source_number"],
    ["formView", "r.form_url"],
  ];
  add("04-cells.sql", cellSources.map(([key, expr]) =>
    "INSERT INTO portal.maintenance_board_cells (id, organisation_id, client_id, board_id, request_id, column_id, value)\n" +
    `SELECT 'cell-' || r.id || '-${key}', r.organisation_id, 'monday-migration-rehearsal', ` +
    `'maintenance', r.id, '${key}', ${expr}\n` +
    `  FROM portal.maintenance_requests r\n` +
    ` WHERE r.organisation_id = ${q(org)} AND ${expr} IS NOT NULL AND ${expr} <> ''\n` +
    "ON CONFLICT (organisation_id, board_id, request_id, column_id)\n" +
    "  DO UPDATE SET value = EXCLUDED.value, updated_at = now();").join("\n"));

  /* 05 — updates and replies. Parents first: a reply references its parent. */
  const updateRow = (u) =>
    `(${q(u.id)}, ${q(org)}, ${q("maintenance")}, ${q(`job-${u.requestExternalId}`)}, ` +
    `${q(u.parentId)}, ${q(u.sourceUpdateId)}, ${qn(u.authorName)}, ${q(u.authorEmail)}, ` +
    `${qn(u.body)}, ${ts(u.createdAt)})`;
  const updateHeader =
    "INSERT INTO portal.item_updates (id, organisation_id, board_id, request_id, parent_id, " +
    "source_update_id, author_name, author_email, body, created_at)";
  const updateConflict =
    "ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, author_name = EXCLUDED.author_name, " +
    "author_email = EXCLUDED.author_email, parent_id = EXCLUDED.parent_id, " +
    "source_update_id = EXCLUDED.source_update_id";
  chunkedInsert({
    header: updateHeader,
    rows: plan.updates.filter((u) => !u.parentId).map(updateRow),
    conflict: updateConflict,
  }).forEach((sql, i) => add(`05-updates-${String(i + 1).padStart(2, "0")}.sql`, sql));
  chunkedInsert({
    header: updateHeader,
    rows: plan.updates.filter((u) => u.parentId).map(updateRow),
    conflict: updateConflict,
  }).forEach((sql, i) => add(`06-replies-${String(i + 1).padStart(2, "0")}.sql`, sql));

  /* 07 — attachment records. Metadata only; the bytes are capacity blocked. */
  const attachmentRows = plan.attachments.map((a) => {
    const requestId = a.requestExternalId ? `job-${a.requestExternalId}` : null;
    const siteCanonical = a.storeDocItemId
      ? plan.aliasIndex.get(
          T.normalise(
            (plan.data.storeDoc.find((s) => String(s.id) === a.storeDocItemId) ?? {}).name ?? "",
          ),
        )
      : null;
    // object_key and client_id are computed by the SELECT below rather than
    // carried per row: the key is a pure function of the organisation, the
    // asset id and the filename, and repeating all three in every row roughly
    // doubled the size of this file for no information.
    return (
      `(${q(a.id)}, ${q(requestId)}, ` +
      `${q(siteCanonical ? `site-${T.siteCode(siteCanonical)}` : null)}, ` +
      `${q(a.updateId ?? null)}, ` +
      `${qn(a.originalName)}, ${qn(a.contentType)}, ${a.byteSize || 0}, ${qn(a.kind)}, ` +
      `${q(a.sourceAssetId)}, ${q(a.sourceColumnId)}, ${q(a.checksum)}, ${q(a.columnKey)}, ` +
      `${ts(a.createdAt)}, ${q(a.uploadedBy)}, ${q(a.slotLabel ?? null)}, ` +
      `${b(a.verifiable === false ? false : true)})`
    );
  });
  chunkedInsert({
    header:
      "INSERT INTO portal.attachments (id, organisation_id, client_id, request_id, site_id, " +
      "update_id, object_key, original_name, content_type, byte_size, kind, source_asset_id, " +
      "source_column_id, checksum_sha256, board_column_id, created_at, uploaded_by_email, " +
      "document_type, pending)\n" +
      `SELECT v.id, ${q(org)}, 'monday-migration-rehearsal', v.request_id, v.site_id, v.update_id,\n` +
      `       'monday/${org}/' || v.source_asset_id || '/' || v.original_name,\n` +
      "       v.original_name, v.content_type, v.byte_size, v.kind, v.source_asset_id,\n" +
      "       v.source_column_id, v.checksum, v.board_column_id, v.created_at, v.uploaded_by,\n" +
      "       v.document_type, v.pending\n" +
      "  FROM (VALUES_PLACEHOLDER) AS v (id, request_id, site_id, update_id, original_name,\n" +
      "       content_type, byte_size, kind, source_asset_id, source_column_id, checksum,\n" +
      "       board_column_id, created_at, uploaded_by, document_type, pending)",
    rows: attachmentRows,
    select: true,
    conflict:
      "ON CONFLICT (id) DO UPDATE SET request_id = EXCLUDED.request_id, site_id = EXCLUDED.site_id, " +
      "update_id = EXCLUDED.update_id, original_name = EXCLUDED.original_name, " +
      "content_type = EXCLUDED.content_type, byte_size = EXCLUDED.byte_size, kind = EXCLUDED.kind, " +
      "source_asset_id = EXCLUDED.source_asset_id, source_column_id = EXCLUDED.source_column_id, " +
      "checksum_sha256 = EXCLUDED.checksum_sha256, board_column_id = EXCLUDED.board_column_id, " +
      "document_type = EXCLUDED.document_type",
  }).forEach((sql, i) => add(`07-attachments-${String(i + 1).padStart(2, "0")}.sql`, sql));

  /* 08 — compliance. */
  const complianceRows = plan.compliance.rows.map((c) => {
    const siteId = `site-${T.siteCode(c.canonical)}`;
    return (
      `(${q(`mcd-${T.siteCode(c.canonical)}-${c.slot}`)}, ${q(org)}, ` +
      `${q("monday-migration-rehearsal")}, ${q(siteId)}, ${qn(c.label)}, ${qn(c.status)}, ` +
      `${q(c.expiry)}, ${q(c.attachmentId)}, FALSE)`
    );
  });
  chunkedInsert({
    header:
      "INSERT INTO portal.compliance_documents (id, organisation_id, client_id, site_id, kind, " +
      "status, expiry_date, attachment_id, not_required)",
    rows: complianceRows,
    conflict:
      "ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, expiry_date = EXCLUDED.expiry_date, " +
      "attachment_id = EXCLUDED.attachment_id, updated_at = now()",
  }).forEach((sql, i) => add(`08-compliance-${String(i + 1).padStart(2, "0")}.sql`, sql));

  /* 09 — anomalies: every correction, conflict and held document. */
  const batch = `monday-rehearsal-${new Date().toISOString().slice(0, 10)}`;
  const anomalyRows = [...sites.anomalies, ...plan.jobs.anomalies, ...plan.compliance.anomalies].map((a, i) => (
    `(${q(`anom-${batch}-${i}`)}, ${q(org)}, ${qn(batch)}, ${qn(a.entityType)}, ${q(a.entityId)}, ` +
    `${q(a.sourceName)}, ${qn(a.kind)}, ${q(a.field ?? null)}, ${q(a.originalValue ?? null)}, ` +
    `${q(a.appliedValue ?? null)}, ${q(a.detail)}, FALSE)`
  ));
  chunkedInsert({
    header:
      "INSERT INTO portal.import_anomalies (id, organisation_id, batch_id, entity_type, entity_id, " +
      "source_name, kind, field, original_value, applied_value, detail, resolved)",
    rows: anomalyRows,
    conflict: "ON CONFLICT (id) DO NOTHING",
  }).forEach((sql, i) => add(`09-anomalies-${String(i + 1).padStart(2, "0")}.sql`, sql));

  /* 10 — denormalised counters, recomputed from what was actually written. */
  add("10-counters.sql",
    "UPDATE portal.maintenance_requests r SET\n" +
    "  comment_count = COALESCE((SELECT count(*) FROM portal.item_updates u\n" +
    "     WHERE u.organisation_id = r.organisation_id AND u.request_id = r.id), 0),\n" +
    "  attachment_count = COALESCE((SELECT count(*) FROM portal.attachments a\n" +
    "     WHERE a.organisation_id = r.organisation_id AND a.request_id = r.id), 0),\n" +
    "  issue_attachment_count = COALESCE((SELECT count(*) FROM portal.attachments a\n" +
    "     WHERE a.organisation_id = r.organisation_id AND a.request_id = r.id AND a.kind = 'issue'), 0),\n" +
    "  completed_attachment_count = COALESCE((SELECT count(*) FROM portal.attachments a\n" +
    "     WHERE a.organisation_id = r.organisation_id AND a.request_id = r.id AND a.kind = 'completion'), 0),\n" +
    "  general_attachment_count = COALESCE((SELECT count(*) FROM portal.attachments a\n" +
    "     WHERE a.organisation_id = r.organisation_id AND a.request_id = r.id AND a.kind = 'general'), 0)\n" +
    `WHERE r.organisation_id = ${q(org)};\n`);

  let bytes = 0;
  for (const file of files) {
    const target = path.join(args.out, file.name);
    writeFileSync(target, file.sql);
    bytes += file.sql.length;
  }

  console.log(`Wrote ${files.length} SQL files (${(bytes / 1024).toFixed(0)} KB) to ${args.out}`);
  console.log(`  sites ${sites.rows.length}  aliases ${sites.aliasRows.length}  jobs ${jobRows.length}`);
  console.log(`  updates ${plan.updates.filter((u) => !u.parentId).length}  replies ${plan.updates.filter((u) => u.parentId).length}`);
  console.log(`  attachments ${attachmentRows.length}  compliance ${complianceRows.length}  anomalies ${anomalyRows.length}`);
  console.log(`  plan: ${JSON.stringify(summary.titleRules)}  unresolved sites ${summary.unresolvedSites}`);
  for (const file of files) console.log(`   ${file.name.padEnd(28)} ${(file.sql.length / 1024).toFixed(1)} KB`);
}

main();
