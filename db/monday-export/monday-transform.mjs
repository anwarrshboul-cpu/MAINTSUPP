/**
 * The migration's decisions, as pure functions.
 *
 * Every rule that turns a monday row into a MAINTSUPP row lives here and
 * touches nothing — no database, no filesystem, no clock. `import-monday-
 * rehearsal.mjs` does the I/O and calls into this; `tests/monday-transform.test.mjs`
 * calls into it with fixtures. The two cannot disagree about what the migration
 * does, because there is only one copy of it.
 *
 * Authority: `docs/MONDAY-MIGRATION-PLAN.md`, which was written from the Phase 1
 * export and the live Staging schema. Where the original migration brief and
 * Phase 1's evidence disagree, the evidence wins and the reason is written down
 * beside the rule.
 */

/* ── Canonical site register ─────────────────────────────────────────────── */

/**
 * One entry per real shop. `aliases` is every string either board uses for it.
 *
 * Cardiff is ONE entry, not two. Phase 1 proved by checksum that "Cardiff St
 * Davids" and "Grand Arcade - Cardiff" are the same shop: two PAT files
 * byte-identical across both rows, both from job 1057752, and Grand Arcade's
 * own address reads "(FORMERLY KNOWN AS UNIT LG24)" — which is what the other
 * row is named after. Both source item ids are preserved on the entry, and the
 * historical Closed representation of the second row is recorded as an anomaly
 * rather than as a second site.
 */
export const SITE_REGISTER = [
  site("Aldgate – Whitechapel Road", "Active", ["Aldgate", "Aldgate completed"]),
  site("Birmingham – Bullring", "Active", ["Bullring - Birmingham", "Bullring completed", "Bullring"]),
  site("Brent Cross", "Active", ["Brentcross", "Brent Cross – Shopping Centre", "Brent Cross completed"]),
  site("Brighton – Churchill Square", "Active", ["Churchill Square - Brighton", "Brighton completed"]),
  site("Bristol – Cabot Circus", "Active", ["Cabot Circus - Bristol", "Bristol Cabot Circus completed"]),
  site("Cardiff – Grand Arcade", "Active", [
    "Grand Arcade - Cardiff",
    "Cardiff completed",
    // The merge. Both namings resolve here; neither becomes a second site.
    "Cardiff St Davids",
    "UNIT LG24",
    "10 Grand Arcade",
  ]),
  site("Dudley – Merry Hill", "Active", ["Merry Hill", "Merry Hill completed"]),
  site("Glasgow – Silverburn", "Active", ["Silverburn - Glasgow", "Glasgow Silverburn completed", "Silverburn"]),
  site("Greenhithe – Bluewater", "Active", ["Bluewater", "Bluewater completed"]),
  site("Manchester – Arndale", "Active", ["Manchester Arndale", "Arndale completed", "Arndale"]),
  site("Manchester – Trafford Centre", "Active", ["Trafford Centre - Manchester", "Trafford centre completed", "Trafford"]),
  site("Milton Keynes – The Centre", "Active", ["The Centre:MK", "Milton Keynes completed"]),
  site("Nottingham – Victoria Centre", "Active", ["Victoria Centre - Nottingham", "Nottingham complited", "Nottingham completed"]),
  site("Reading – The Oracle", "Active", ["The Oracle Centre - Reading", "Reading completed", "The Oracle"]),
  site("Sheffield – Meadowhall", "Active", ["Meadowhall", "Sheffield – Meadow Hall", "Meadowhall Sheffield completed", "Sheffield"]),
  site("Solihull – Touchwood", "Active", ["Touchwood - Solihull", "Solihull completed"]),
  site("Southall – The Broadway", "Active", ["Southall", "Southall completed"]),
  site("Watford – Atria", "Active", ["Atria Watford", "Watford completed"]),
  site("Westfield – Stratford", "Active", ["Westfield Stratford", "Westfield Stratford  completed", "Stratford"]),
  site("Westfield – White City", "Active", ["Westfield White City Original", "White City completed"]),
  site("Wood Green – High Road", "Active", ["Woodgreen", "Wood Green completed", "Wood Green"]),

  site("Westfield White City Bespoke", "Closed", ["Bespoke whitecity completed"]),
  site("Cribbs Causeway – Bristol", "Closed", ["Cribbs Causeway - Bristol", "Cribbs completed"]),
  site("Highcross Leicester", "Closed", ["Highcross Leicester completed"]),
  site("Metrocentre – Gateshead", "Closed", ["Metrocentre - Gateshead (Newcastle)", "Metro Centre completed"]),
  // Former sites with completed-job groups and no Store Documentation row.
  // Without these their history is orphaned.
  site("Cambridge", "Closed", ["Cambridge completed"]),
  site("Derby", "Closed", ["Derby completed"]),
  site("SJQ Edinburgh", "Closed", ["SJQ Edinburgh completed"]),

  site("HQ – The Loom", "Other", ["HQ - The Loom"], { type: "Office" }),
  site("Warehouse 1", "Other", [], { type: "Warehouse" }),
  site("Warehouse 2", "Other", [], { type: "Warehouse" }),

  site("Mall of Netherlands", "International", [], { region: "International" }),
  // The four Phase 1 found on the Maintenance board with no canonical site.
  // Distinct International sites, never fuzzy-merged into a UK one. `country`
  // only where the source says it; no address is invented.
  site("Mall of Scandinavia", "International", [], { region: "International" }),
  site("Nacka", "International", ["Nacka / Sweden"], { region: "International", country: "Sweden" }),
  site("Solna", "International", [], { region: "International" }),
  site("Täby", "International", ["Taby/ Sweden", "Taby", "Täby / Sweden"], { region: "International", country: "Sweden" }),
];

function site(canonical, status, aliases = [], extra = {}) {
  return { canonical, status, aliases, ...extra };
}

/** Rows the Store Documentation board carries that are not sites. */
export const NOT_A_SITE = new Set(["Item 5"]);

/** Groups that describe a stage of work rather than a place. */
export const STAGE_GROUPS = new Set([
  "Incoming requests", "recently", "Jobs Booked", "Needs attention",
  "On Hold", "Access Requests", "International",
]);

const MONTHLY_GROUP =
  /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\s+recently\s+completed$/i;

/**
 * Whether a group title names a place.
 *
 * The monthly groups are a growing family, not a fixed list: `September  2026
 * Recently completed` appeared on the live board after the repository's August
 * capture, and a literal list sent "September" to the site resolver as though
 * it were a shop.
 */
export function isSiteGroup(title) {
  const text = String(title ?? "").trim();
  if (!text || STAGE_GROUPS.has(text)) return false;
  return !MONTHLY_GROUP.test(text.replace(/\s+/g, " "));
}

/** Casefolded, dash-flattened, punctuation-stripped tokens. */
export function normalise(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[‐-―]/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "Bullring completed" -> "Bullring". monday's own typo is handled too. */
export function stripGroupSuffix(title) {
  return String(title ?? "").replace(/\s+(completed|complited)\s*$/i, "").trim();
}

/** A stable, readable site code — also the importer's idempotency key. */
export function siteCode(canonical) {
  return `mnd-${normalise(canonical).replace(/\s+/g, "-").slice(0, 40)}`;
}

/**
 * Every approved lookup string, normalised, to its canonical site.
 *
 * Approved means: the canonical name itself, or an alias written down in the
 * register above. Fuzzy matching never contributes to this map — §D of the
 * brief is explicit that fuzzy may not write `site_id`, and the way to honour
 * that is for the write path to have no fuzzy in it at all.
 */
export function buildAliasIndex(register = SITE_REGISTER) {
  const index = new Map();
  for (const entry of register) {
    for (const alias of [entry.canonical, ...entry.aliases]) {
      if (!alias) continue;
      index.set(normalise(alias), entry.canonical);
      const stripped = stripGroupSuffix(alias);
      if (stripped && stripped !== alias) index.set(normalise(stripped), entry.canonical);
    }
  }
  return index;
}

/**
 * Which site a job belongs to, and how we know.
 *
 * Deterministic and ordered. Every method here is an exact match against an
 * approved string; nothing guesses. A job whose signals disagree resolves to
 * nothing and is held for review, because picking one of two contradicting
 * sources is how one shop's history ends up under another's name.
 */
export function resolveSite(signals, aliasIndex) {
  const attempts = [
    ["store-location-label", signals.storeLocation],
    ["group", isSiteGroup(signals.group) ? signals.group : ""],
    ["location-raw", signals.locationRaw],
  ];

  const found = [];
  for (const [method, raw] of attempts) {
    if (!raw || !String(raw).trim()) continue;
    const canonical =
      aliasIndex.get(normalise(raw)) ?? aliasIndex.get(normalise(stripGroupSuffix(raw)));
    if (canonical) found.push({ method, canonical, raw });
  }

  if (found.length === 0) {
    const attempted = attempts.filter(([, raw]) => raw && String(raw).trim());
    return {
      canonical: null,
      method: "unresolved",
      review: attempted.length > 0,
      detail: attempted.length
        ? `no approved alias for ${attempted.map(([m, r]) => `${m}=${JSON.stringify(r)}`).join(", ")}`
        : "no site signal on the item",
    };
  }

  const distinct = [...new Set(found.map((f) => f.canonical))];
  if (distinct.length > 1) {
    return {
      canonical: null,
      method: "conflict",
      review: true,
      detail: `signals disagree: ${found.map((f) => `${f.method}=${f.canonical}`).join(" vs ")}`,
    };
  }
  return { canonical: distinct[0], method: found[0].method, review: false, detail: "" };
}

/* ── Job fields ──────────────────────────────────────────────────────────── */

/** Trimmed, whitespace-collapsed. "   " is not content. */
export function useful(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The job title, by the first rule that yields content.
 *
 * Rules 4 and 6 are Phase 2 additions and both exist because of measured facts.
 * Phase 1 found two items reaching the old last resort, and neither had a
 * Number — so `Job {source_number}` produced "Job " against a NOT NULL column.
 * One of the two had a perfectly good description that no rule could reach.
 */
export function jobTitle({ site, label, description, locationRaw, sourceNumber, sourceItemId }) {
  const desc = useful(description).slice(0, 60);
  const siteName = useful(site);
  const lbl = useful(label);
  const loc = useful(locationRaw);
  const num = useful(sourceNumber);

  if (siteName && lbl) return { title: `${siteName} — ${lbl}`, rule: 1 };
  if (siteName && desc) return { title: `${siteName} — ${desc}`, rule: 2 };
  if (loc && desc) return { title: `${loc} — ${desc}`, rule: 3 };
  if (desc) return { title: desc, rule: 4 };
  if (num) return { title: `Job ${num}`, rule: 5 };
  return { title: `Monday Job ${useful(sourceItemId)}`, rule: 6 };
}

/** "Tier 3" -> 3. Anything else -> null, so the column default stands. */
export function tierNumber(text) {
  const match = /(\d+)/.exec(useful(text));
  return match ? Number(match[1]) : null;
}

/**
 * A blank monday label is its "no value" chip, not a category.
 *
 * Priority and Label both carry one. Stored as "" it becomes a category named
 * nothing, which then appears in every group-by and every filter.
 */
export function blankToNull(text) {
  const value = useful(text);
  return value === "" ? null : value;
}

/**
 * monday spells it "Plummer". The trade is a plumber.
 *
 * The corrected value is what the board stores and what a filter matches; the
 * raw string is preserved by the caller as an import anomaly, so the correction
 * is visible rather than silent.
 */
export const ENGINEER_CORRECTIONS = new Map([["plummer", "Plumber"]]);

export function engineerValue(text) {
  const raw = useful(text);
  const corrected = ENGINEER_CORRECTIONS.get(raw.toLowerCase());
  return { value: corrected ?? (raw || null), raw: raw || null, corrected: Boolean(corrected) };
}

/** Zero and null are different costs and both must survive. */
export function costValue(text) {
  const raw = useful(text);
  if (raw === "") return null;
  const numeric = Number(raw.replace(/[£$€,\s]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

/** monday dates are already ISO; anything else is kept verbatim to be seen. */
export function dateValue(text) {
  const raw = useful(text);
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(raw);
  return iso ? iso[0] : raw;
}

/**
 * A timeline cell is "start - end"; `due_at` takes the end.
 *
 * Found by its dates rather than by splitting on the separator: an ISO date
 * contains the same hyphen the range uses, so `"2026-01-01 - 2026-02-03"`
 * split on `-` yields six fragments ending in "03". The first version of this
 * did exactly that and would have written "03" into every due date.
 */
export function timelineEnd(text) {
  const raw = useful(text);
  if (!raw) return null;
  const dates = raw.match(/\d{4}-\d{2}-\d{2}/g);
  if (dates && dates.length) return dates[dates.length - 1];
  const parts = raw.split(/\s+[-–—]\s+/).filter(Boolean);
  return parts.length ? dateValue(parts[parts.length - 1]) : null;
}

/** Statuses monday flags as done, for the board's own lifecycle column. */
export const DONE_STATUSES = new Set(["Job Completed"]);

export function stageFor({ groupStageKey, status, completedAt }) {
  if (groupStageKey) return groupStageKey;
  if (completedAt || DONE_STATUSES.has(useful(status))) return "Completed";
  return "Incoming";
}

/* ── Attachments ─────────────────────────────────────────────────────────── */

/** monday file column id -> the MAINTSUPP board column key and attachment kind. */
export const MAINTENANCE_FILE_COLUMNS = new Map([
  ["upload_file", { columnKey: "issuePictures", kind: "issue" }],
  ["dup__of_upload_pictures_of_work_needed", { columnKey: "completedPictures", kind: "completion" }],
  ["file_mm44swj6", { columnKey: "files", kind: "general" }],
]);

/**
 * Store Documentation file column id -> the compliance slot it evidences.
 *
 * Keys match `storeDocumentationCertificates` in `db/monday-board-spec.ts`,
 * which is the vocabulary the Compliance Tracker already reads. Inventing a
 * second list here is what the plan says not to do.
 */
export const STORE_DOC_FILE_COLUMNS = new Map([
  ["files45", { slot: "rams", label: "RAMS", columnKey: "rams", expiry: null }],
  ["file_mm425qb4", { slot: "fire-risk-assessment", label: "Fire Risk Assessment", columnKey: "fireRiskAssessment", expiry: null }],
  ["file", { slot: "pli", label: "PLI", columnKey: "pliDocument", expiry: "date4" }],
  ["files0", { slot: "pat", label: "PAT Test", columnKey: "patCertificate", expiry: "date0" }],
  ["files4", { slot: "electrical", label: "Electrical Wiring", columnKey: "electricalCertificate", expiry: "date6" }],
  ["file_mm42tmw1", { slot: "fire-extinguisher", label: "Fire Extinguisher", columnKey: "fireExtinguisher", expiry: "date_mm4220hb" }],
  ["file_mm42tzf3", { slot: "fire-alarm", label: "Fire Alarm", columnKey: "fireAlarmReport", expiry: "date_mm424d2v" }],
  ["file_mm42nn8e", { slot: "emergency-lighting", label: "Emergency Lighting", columnKey: "emergencyLighting", expiry: "date_mm42994m" }],
  ["file_mm42pa4c", { slot: "sprinkler", label: "Sprinkler", columnKey: "sprinklerReport", expiry: "date_mm42a4j6" }],
  ["file_mm42zvqa", { slot: "water-hygiene", label: "Water Hygiene", columnKey: "waterHygiene", expiry: "date_mm42hzrv" }],
  ["file_mm42a2x1", { slot: "fire-door", label: "Fire Door", columnKey: "fireDoorTest", expiry: "date_mm426nzh" }],
  ["file_mm43gd6", { slot: "drawing", label: "Drawing", columnKey: "drawing", expiry: null }],
]);

/** Requirements monday tracks with no expiry column at all. */
export const UNDATED_SLOTS = new Set(["rams", "fire-risk-assessment", "drawing"]);

/** Landlord- or centre-controlled in a mall; never auto-assigned to the client. */
export const NEVER_AUTO_ASSIGNED = new Set(["sprinkler"]);

/** Recorded once against the organisation, not as a gap on every site. */
export const ORGANISATION_LEVEL_SLOTS = new Set(["pli"]);

/**
 * Files whose name says one site while they are filed against another.
 *
 * Phase 1 found these two by checking a filename's distinctive tokens against
 * the site register, and they are carried here as explicit asset ids rather
 * than re-derived, because the migration must not depend on a heuristic
 * re-running the same way. A third case found later is added here deliberately.
 */
export const SUSPICIOUS_ASSET_NAMES = new Map([
  ["RAMS Watfrod Atria .docx", { filedAgainst: "Greenhithe – Bluewater", suggests: "Watford – Atria" }],
  ["Water_Hygiene_and_Legionella_Risk_Assessment_Meadowhall.docx", { filedAgainst: "Bristol – Cabot Circus", suggests: "Sheffield – Meadowhall" }],
]);

/**
 * Whether a document may stand as evidence for its compliance requirement.
 *
 * A suspicious file still imports — bytes, checksum, filename, source item,
 * source column and site association all preserved — it simply does not become
 * the certificate. The distinction is the whole point of §E: preserved is not
 * the same as verified.
 */
export function isVerifiableEvidence(filename) {
  return !SUSPICIOUS_ASSET_NAMES.has(useful(filename));
}

/**
 * The compliance state of one requirement on one site.
 *
 * Reuses the app's own vocabulary — `compliance_documents.status` is
 * Valid / Received / Expired / Missing — rather than inventing a parallel one.
 */
export function complianceState({ slot, hasCertificate, expiry, today }) {
  if (NEVER_AUTO_ASSIGNED.has(slot) && !hasCertificate) {
    return { status: "Missing", flag: "responsibility-unconfirmed", confirmed: false };
  }
  if (!hasCertificate && !expiry) {
    return { status: "Missing", flag: "responsibility-unconfirmed", confirmed: false };
  }
  if (!hasCertificate && expiry) {
    return { status: "Missing", flag: "certificate-missing", confirmed: false };
  }
  if (hasCertificate && !expiry) {
    return {
      status: "Received",
      flag: UNDATED_SLOTS.has(slot) ? null : "expiry-missing",
      confirmed: true,
    };
  }
  const expired = today && expiry < today;
  return { status: expired ? "Expired" : "Valid", flag: null, confirmed: true };
}
