/**
 * Does the rehearsal tenant hold exactly what the export says it should?
 *
 *   node db/monday-export/reconcile-rehearsal.mjs \
 *     --export D:/MAINTSUPP-Monday-Export/full-2026-09-09
 *
 * Read-only against the database named by STAGING_DATABASE_URL, and refusing
 * to run against the Sunnamusk or Demo tenants. Every line is source count vs
 * destination count vs difference, because a reconciliation that only prints
 * the destination is not a reconciliation.
 *
 * The money row is the reason this is re-run in Phase 3. `SUM(cost)` over the
 * `real` column and `SUM(cost_pence)` over the integer one are compared against
 * the source separately: the whole point of the pence column is that only one
 * of those two can be right, and the report has to show which.
 */

import process from "node:process";
import { buildPlan } from "./import-monday-rehearsal.mjs";
import { SITE_REGISTER, normalise } from "./monday-transform.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
if (!args.export) throw new Error("--export is required");

const ORG = args.org ?? "org_000000000000000000000003";
const PROTECTED = new Set([
  "org_000000000000000000000001", // Sunnamusk Staging
  "org_000000000000000000000002", // Demo
]);
if (PROTECTED.has(ORG)) throw new Error(`refusing to reconcile against ${ORG}`);

const url = process.env.STAGING_DATABASE_URL;
if (!url) throw new Error("STAGING_DATABASE_URL is not set");
if (url.includes(":6543")) throw new Error("refusing the transaction pooler on 6543");

const { default: postgres } = await import("postgres");
const sql = postgres(url, { max: 1, connect_timeout: 25, onnotice: () => {} });

const plan = buildPlan(args.export);

const rows = [];
const line = (what, source, destination) =>
  rows.push({ what, source, destination, difference: destination - source });

try {
  const one = async (query) => (await query)[0];

  const jobs = await one(sql`
    select count(*)::int n,
           count(*) filter (where cost_pence is not null)::int costed,
           coalesce(sum(cost_pence), 0)::bigint pence,
           /*
            * NOT coalesced and NOT cast before summing. Wrapping this in
            * coalesce(..., 0) resolves a common type with the integer zero and
            * quietly widens the accumulator, which HIDES the very error this
            * row exists to show. Summed as the column's own real type, this
            * returns 52408.1 against a true total of 52408.06.
            */
           sum(cost)::text real_sum,
           sum(cost::numeric)::text numeric_sum
      from portal.maintenance_requests where organisation_id = ${ORG}`);

  const sourceSites = SITE_REGISTER.length;
  /*
   * `site_aliases` is unique on (organisation_id, normalised) and the insert
   * says DO NOTHING, so the number that can be stored is the number of DISTINCT
   * normalised forms — not the number of alias strings. Four of them normalise
   * onto a form the same site already contributed ("Westfield Stratford" as
   * both a canonical name and an alias), and collapsing those is the
   * constraint doing its job.
   */
  const aliasForms = new Set();
  for (const entry of SITE_REGISTER) {
    for (const form of [entry.canonical, ...entry.aliases]) {
      const normalised = normalise(form);
      if (normalised) aliasForms.add(normalised);
    }
  }
  const sourceAliases = aliasForms.size;

  line("jobs", plan.jobs.rows.length, jobs.n);
  line("updates", plan.updates.length, (await one(sql`
    select count(*)::int n from portal.item_updates
     where organisation_id = ${ORG}`)).n);
  /*
   * Scoped to rows carrying a `source_asset_id`, which is what this import
   * writes. The tenant also holds files uploaded deliberately during the
   * rehearsal — Phase 2's approved representative Storage sample, and Phase 3's
   * octet-stream probe and upload benchmarks. Counting those as a surplus would
   * be reporting a deliberate act as a discrepancy, so they are reported on
   * their own line instead of inside the reconciliation.
   */
  const attachments = await one(sql`
    select count(*) filter (where source_asset_id is not null)::int imported,
           count(*) filter (where source_asset_id is null)::int other
      from portal.attachments where organisation_id = ${ORG}`);
  line("attachments", plan.attachments.length, attachments.imported);
  line("sites", sourceSites, (await one(sql`
    select count(*)::int n from portal.sites where organisation_id = ${ORG}`)).n);
  line("site aliases", sourceAliases, (await one(sql`
    select count(*)::int n from portal.site_aliases a
      join portal.sites s on s.id = a.site_id
     where s.organisation_id = ${ORG}`)).n);
  line("compliance records", plan.compliance.rows.length, (await one(sql`
    select count(*)::int n from portal.compliance_documents
     where organisation_id = ${ORG}`)).n);

  const sourcePence = plan.jobs.rows.reduce((t, r) => t + (r.costPence ?? 0), 0);
  const sourceCosted = plan.jobs.rows.filter((r) => r.costPence !== null).length;

  console.log("\nROW COUNTS");
  console.table(rows);

  console.log("\nMONEY");
  const gbp = (p) => `£${(Number(p) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  console.table([
    { measure: "costed jobs", source: sourceCosted, destination: jobs.costed, difference: jobs.costed - sourceCosted },
    { measure: "SUM(cost_pence)", source: gbp(sourcePence), destination: gbp(jobs.pence),
      difference: Number(jobs.pence) - sourcePence === 0 ? "exact" : `${Number(jobs.pence) - sourcePence}p` },
    { measure: "SUM(cost) as real", source: gbp(sourcePence), destination: `£${Number(jobs.real_sum).toFixed(2)}`,
      difference: `${Math.round(Number(jobs.real_sum) * 100) - sourcePence}p — why cost_pence exists` },
    { measure: "SUM(cost::numeric)", source: gbp(sourcePence), destination: `£${Number(jobs.numeric_sum).toFixed(2)}`,
      difference: `${Math.round(Number(jobs.numeric_sum) * 100) - sourcePence}p` },
  ]);
  console.log(`
attachments not from this import: ${attachments.other} ` +
    `(rehearsal uploads: the approved Storage sample, plus any QA probe)`);

  const mismatched = rows.filter((r) => r.difference !== 0);
  const moneyExact = Number(jobs.pence) === sourcePence;
  console.log(`\nrow counts   : ${mismatched.length === 0 ? "RECONCILED" : `MISMATCH on ${mismatched.map((m) => m.what).join(", ")}`}`);
  console.log(`money        : ${moneyExact ? "EXACT to the penny" : "MISMATCH"}`);
  process.exitCode = mismatched.length === 0 && moneyExact ? 0 : 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
