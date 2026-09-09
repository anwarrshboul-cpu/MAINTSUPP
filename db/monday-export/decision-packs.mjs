/**
 * The two review packs Phase 3 owes a human: unresolved sites, and contractors.
 *
 *   node db/monday-export/decision-packs.mjs \
 *     --export D:/MAINTSUPP-Monday-Export/full-2026-09-09 \
 *     --out    D:/MAINTSUPP-Monday-Export/full-2026-09-09/reports
 *
 * Reads the local export and, when STAGING_DATABASE_URL is set, the rehearsal
 * tenant's existing contractor records so a match can be proposed against
 * something real. Writes CSV outside the repository: every row names a client
 * site, a job description or a contractor.
 *
 * NOTHING HERE DECIDES ANYTHING. Every row carries its evidence and a
 * classification, and the two conflicting-signal jobs are never assigned.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildPlan } from "./import-monday-rehearsal.mjs";
import * as T from "./monday-transform.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}
if (!args.export || !args.out) throw new Error("--export and --out are required");

const csv = (rows, fields) => {
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.join(","), ...rows.map((r) => fields.map((f) => cell(r[f])).join(","))].join("\n") + "\n";
};

const plan = buildPlan(args.export);
mkdirSync(args.out, { recursive: true });

/* ── Site decision pack ──────────────────────────────────────────────────── */

const unresolved = plan.jobs.rows.filter((r) => !r.siteCanonical);

/**
 * Which sites a source string could mean, and why.
 *
 * Reported as evidence for a human, never applied: §D forbids fuzzy writing
 * `site_id`. The useful answer is rarely one site — it is "these two, and here
 * is the word they share", which is precisely the decision a person can make
 * and this code cannot. Only `location_raw` and the group are consulted; a
 * description mentioning a town is not a claim about where the job was.
 */
function candidates(value) {
  const normalised = T.normalise(value);
  if (!normalised) return [];
  const words = new Set(normalised.split(" ").filter(Boolean));
  const hits = new Map();
  for (const entry of T.SITE_REGISTER) {
    for (const form of [entry.canonical, ...entry.aliases]) {
      for (const token of T.normalise(form).split(" ")) {
        if (token.length < 3) continue;
        if (words.has(token)) {
          const seen = hits.get(entry.canonical) ?? new Set();
          seen.add(token);
          hits.set(entry.canonical, seen);
        }
      }
    }
  }
  return [...hits.entries()].map(([site, tokens]) => ({ site, tokens: [...tokens].join("+") }));
}

/**
 * A near-miss on a single word — the `Westfiled` case.
 *
 * A typo is not a token match, so the exact test above finds nothing and would
 * report "no site matches" for ten jobs that plainly belong to a Westfield.
 */
function nearMiss(value) {
  const word = T.normalise(value);
  if (!word || word.includes(" ")) return [];
  const nearby = [];
  for (const entry of T.SITE_REGISTER) {
    for (const form of [entry.canonical, ...entry.aliases]) {
      for (const token of T.normalise(form).split(" ")) {
        if (token.length < 5) continue;
        let same = 0;
        for (let i = 0; i < Math.min(token.length, word.length); i += 1) {
          if (token[i] === word[i]) same += 1;
        }
        const ratio = same / Math.max(token.length, word.length);
        if (ratio >= 0.7 && !nearby.some((c) => c.site === entry.canonical)) {
          nearby.push({ site: entry.canonical, tokens: `~${token}` });
        }
      }
    }
  }
  return nearby;
}

const siteRows = unresolved.map((job) => {
  const conflict = job.siteMethod === "conflict";
  // Only the two fields that assert a place. Never the description.
  const signal = job.location || (T.isSiteGroup(job.sourceGroup) ? job.sourceGroup : "");
  const exact = candidates(signal);
  const near = exact.length ? [] : nearMiss(signal);
  const found = exact.length ? exact : near;

  let classification;
  if (conflict) classification = "CONFLICT — USER DECISION";
  else if (found.length === 1 && exact.length) classification = "SAFE EXACT/ALIAS FIX";
  else if (found.length >= 1) classification = "LIKELY MATCH — USER REVIEW";
  else classification = "GENUINELY UNASSIGNED";

  return {
    source_item_id: job.externalId,
    source_group: job.sourceGroup,
    store_location_name: "",
    location_raw: job.location,
    description: job.description.slice(0, 160),
    generated_title: job.title,
    proposed_site: conflict || found.length !== 1 ? "" : found[0].site,
    candidate_sites: conflict ? "" : found.map((f) => f.site).join(" | "),
    confidence: conflict ? "" : found.length === 1 && exact.length ? "high" : found.length ? "needs a person" : "none",
    evidence: conflict
      ? "signals disagree — see conflict_detail"
      : found.length
        ? `${signal ? `"${signal}"` : "(no location)"} shares ${found.map((f) => f.tokens).join(", ")}`
        : signal
          ? `"${signal}" matches no site name in the register`
          : "no location and no site-shaped group on the source item",
    conflict_detail: conflict ? job.siteMethod : "",
    classification,
    cost_pence: job.costPence ?? "",
    cost_gbp: job.costPence === null ? "" : (job.costPence / 100).toFixed(2),
  };
});

// The conflicts carry both signals verbatim, from the anomaly the import wrote.
for (const anomaly of plan.jobs.anomalies) {
  if (anomaly.kind !== "site-conflict") continue;
  const row = siteRows.find((r) => r.source_item_id === String(anomaly.entityId));
  if (row) {
    row.conflict_detail = anomaly.detail;
    row.store_location_name = (() => {
      try { return JSON.parse(anomaly.originalValue).storeLocation ?? ""; } catch { return ""; }
    })();
  }
}

writeFileSync(
  path.join(args.out, "site-decision-pack.csv"),
  csv(siteRows, [
    "source_item_id", "source_group", "store_location_name", "location_raw",
    "description", "generated_title", "proposed_site", "candidate_sites", "confidence", "evidence",
    "conflict_detail", "classification", "cost_pence", "cost_gbp",
  ]),
);

/* ── Contractor decision pack ────────────────────────────────────────────── */

const byRaw = new Map();
for (const job of plan.jobs.rows) {
  const raw = job.contractor;
  if (!raw) continue;
  const entry = byRaw.get(raw) ?? { jobs: 0, pence: 0 };
  entry.jobs += 1;
  entry.pence += job.costPence ?? 0;
  byRaw.set(raw, entry);
}

const normalisedGroups = new Map();
for (const raw of byRaw.keys()) {
  const key = T.normalise(raw);
  normalisedGroups.set(key, [...(normalisedGroups.get(key) ?? []), raw]);
}

let existing = [];
if (process.env.STAGING_DATABASE_URL) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.STAGING_DATABASE_URL, { max: 1, connect_timeout: 20, onnotice: () => {} });
  try {
    existing = await sql`select id, name, organisation_id from portal.contractors`;
  } finally {
    await sql.end({ timeout: 3 }).catch(() => {});
  }
}
const existingByNormalised = new Map(existing.map((c) => [T.normalise(c.name), c]));

const contractorRows = [...byRaw.entries()]
  .sort((a, b) => b[1].jobs - a[1].jobs)
  .map(([raw, stats]) => {
    const normalised = T.normalise(raw);
    const variants = (normalisedGroups.get(normalised) ?? []).filter((v) => v !== raw);
    const match = existingByNormalised.get(normalised);
    const canonical = variants.length
      ? [raw, ...variants].sort((a, b) => (byRaw.get(b).jobs - byRaw.get(a).jobs))[0]
      : raw;

    let classification;
    let recommendation;
    if (match) {
      classification = "EXISTING CONTRACTOR MATCH";
      recommendation = `link to existing contractor ${match.id}`;
    } else if (variants.length) {
      classification = "SAFE ALIAS";
      recommendation = `same contractor as ${variants.join(", ")}; canonical "${canonical}"`;
    } else if (normalised.split(" ").length === 1 && normalised.length <= 6) {
      // "John", "lcs" — a bare first name or initialism names a person, maybe,
      // and matching it to a company would be a guess with a client's money
      // attached.
      classification = "AMBIGUOUS";
      recommendation = "too little to identify a company — confirm with the client";
    } else {
      classification = "NEW CONTRACTOR CANDIDATE";
      recommendation = "create as a new contractor record if the client confirms";
    }

    return {
      contractor_raw: raw,
      normalised,
      jobs: stats.jobs,
      cost_pence: stats.pence,
      cost_gbp: (stats.pence / 100).toFixed(2),
      variants: variants.join(" | "),
      existing_candidate: match ? `${match.name} (${match.id})` : "",
      proposed_canonical: canonical,
      confidence: match ? "exact (normalised)" : variants.length ? "exact (normalised variant)" : "none",
      classification,
      recommendation,
    };
  });

writeFileSync(
  path.join(args.out, "contractor-decision-pack.csv"),
  csv(contractorRows, [
    "contractor_raw", "normalised", "jobs", "cost_pence", "cost_gbp", "variants",
    "existing_candidate", "proposed_canonical", "confidence", "classification",
    "recommendation",
  ]),
);

/* ── Summary to stdout ───────────────────────────────────────────────────── */

const tally = (rows, field) =>
  rows.reduce((acc, r) => ({ ...acc, [r[field]]: (acc[r[field]] ?? 0) + 1 }), {});

console.log(`site decision pack   : ${siteRows.length} rows -> ${path.join(args.out, "site-decision-pack.csv")}`);
console.log(`  ${JSON.stringify(tally(siteRows, "classification"))}`);
console.log(`contractor pack      : ${contractorRows.length} rows -> ${path.join(args.out, "contractor-decision-pack.csv")}`);
console.log(`  ${JSON.stringify(tally(contractorRows, "classification"))}`);
console.log(`  attributed spend   : £${(contractorRows.reduce((s, r) => s + r.cost_pence, 0) / 100).toFixed(2)}`);
