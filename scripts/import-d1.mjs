/**
 * Moves the real client portfolio out of the legacy Cloudflare D1 (SQLite)
 * database and into the new Postgres schema.
 *
 *   node scripts/import-d1.mjs              # dry run — reports, writes nothing
 *   node scripts/import-d1.mjs --commit     # the real thing
 *
 * Note: PGlite is SINGLE-PROCESS. Stop the API server before running this
 *       against `.pglite`, or it will fail to acquire the data directory.
 *
 * ---------------------------------------------------------------------------
 * The defect this exists to fix
 * ---------------------------------------------------------------------------
 * 744 of the 775 legacy jobs carry `site_id = 'store-aldgate'` and the other 31
 * carry an empty string. The column is not wrong in an interesting way — it is
 * wrong in the same way for almost every row, which is why every per-site figure
 * the legacy product ever showed was fiction. The `site_aliases` table that was
 * supposed to resolve this is empty.
 *
 * The only honest signal left is `location`, a free-text field with 79 distinct
 * spellings of roughly 30 real places. So:
 *
 *   - every job is matched to a site on its location TEXT, by rules written down
 *     below rather than by eyeballing a spreadsheet;
 *   - a job whose location does not resolve to exactly ONE site is imported with
 *     `site_id = NULL` and named in the report, for the owner to decide on.
 *
 * That asymmetry is deliberate and is the single most important thing in this
 * file. An unattributed job is visibly missing — it shows up in "no site" and
 * somebody asks about it. A MISATTRIBUTED job is invisible: it silently inflates
 * one store's numbers and deflates another's, and nothing ever surfaces it.
 * Guessing is therefore never the safe default, and there is no code path here
 * that picks a "best" site when more than one is plausible.
 */
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createDb } from "../packages/db/src/client.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ args -- */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

// Dry run is the DEFAULT and committing is an explicit choice, not the other
// way round. This script rewrites a client's entire operational history; the
// version of it that does nothing is the one that should be easy to reach.
const COMMIT = has("--commit");
const SOURCE = path.resolve(
  ROOT,
  value("--source", "db/backups/d1-export-snapshot.sqlite"),
);
const REPORT = path.resolve(ROOT, value("--report", "import-d1-report.txt"));
const BATCH = Number(value("--batch", "100"));

/*
 * `.pglite` by default, not whatever PGLITE_DIR happens to be.
 *
 * `createDb()` treats an unset PGLITE_DIR as "in-memory", which is right for
 * tests and catastrophic here: the import would report 775 rows written and
 * then throw the database away when the process exited, leaving nothing behind
 * and no error to explain it. An importer's default target has to be a database
 * that still exists afterwards.
 */
const PGLITE_DIR = path.resolve(ROOT, process.env.PGLITE_DIR?.trim() || ".pglite");

/*
 * Local by default; remote only when asked for in words.
 *
 * `createDb()` picks Postgres the moment DATABASE_URL is set, so a stray export
 * in a shell profile is all it would take to point this at Supabase and rewrite
 * production. The guard therefore refuses that combination unless the caller
 * ALSO passes `--allow-remote`, which nobody types by accident and which does
 * not survive being copied out of a runbook without being noticed.
 *
 * Loading the real portfolio into the hosted database is a legitimate,
 * deliberate act — it is just not something a forgotten environment variable
 * should be able to do on its own.
 */
const ALLOW_REMOTE = process.argv.includes("--allow-remote");
const REMOTE = Boolean(process.env.DATABASE_URL?.trim());

if (REMOTE && !ALLOW_REMOTE) {
  console.error(
    "DATABASE_URL is set, so this would write to a REMOTE database.\n" +
      "Add --allow-remote if that is what you intend, or unset DATABASE_URL\n" +
      "to import into the local PGlite database instead.",
  );
  process.exit(1);
}
if (REMOTE && ALLOW_REMOTE) {
  const host = (process.env.DATABASE_URL.match(/@([^/:]+)/) ?? [])[1] ?? "unknown host";
  console.log(`\n  ⚠ REMOTE TARGET: ${host}\n`);
}

/* ----------------------------------------------------------- normalising -- */

/*
 * One normaliser, used for site names, for job locations and for contractor
 * names alike.
 *
 * It has to be one function: if names were normalised differently from
 * locations, a phrase derived from a site name could stop matching the very
 * string it was derived from, and the failure would look like missing data
 * rather than a bug.
 */
const STOP_WORDS = new Set(["the", "shopping", "centre", "center", "of", "at", "and"]);

/*
 * Spellings the legacy board actually contains. Each one is a real string from
 * the source, not a precaution:
 *   westfiled   — monday typo, 9 jobs
 *   commerical  — monday typo, 1 job
 *   bourough    — monday typo, 1 job
 * Fixing them does not by itself attribute anything: "Westfiled" still resolves
 * to two different Westfield stores and is still reported as ambiguous. It is
 * done so the report names the right candidates instead of shrugging.
 */
const TYPOS = new Map([
  ["westfiled", "westfield"],
  ["commerical", "commercial"],
  ["bourough", "borough"],
]);

/*
 * U+2010..U+2015 covers HYPHEN through HORIZONTAL BAR — crucially the EN DASH
 * the client's own store list uses ("Birmingham – Bullring"), which is not the
 * hyphen anybody types, plus the EM DASH the legacy site records use
 * ("HQ — The Loom"). U+2212 is MINUS SIGN, which spreadsheets produce. Treating
 * them all as one separator is what lets a name written one way find a location
 * written the other.
 */
const DASHES = /[-‐-―−]/g;

function normalise(raw) {
  const tokens = String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(DASHES, " ")
    // Apostrophes join rather than separate: "Gower's" -> "gowers".
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((t) => TYPOS.get(t) ?? t)
    // "Centre"/"Center" and friends carry no identity — "Victoria Centre" and
    // "Victoria" are the same store, and "Metro Centre" must not become
    // matchable just because it ends in the same word as four of the sites.
    .filter((t) => !STOP_WORDS.has(t));
  return tokens.join(" ");
}

/** Word-boundary containment, without regex escaping. */
const contains = (haystack, phrase) =>
  ` ${haystack} `.includes(` ${phrase} `);

/* --------------------------------------------------------- site matching -- */

/*
 * Every site gets two kinds of key, and they are treated very differently.
 *
 *   VENUE — the thing that identifies the store: "bullring", "cabot circus",
 *           "silverburn". Matched anywhere inside the location string, because
 *           the venue name survives being buried in a full postal address.
 *
 *   PLACE — the town: "bristol", "manchester", "westfield". Matched ONLY when
 *           it is the whole location string.
 *
 * The asymmetry is the guard against the worst class of false positive in this
 * data. One legacy location reads:
 *
 *   "KIOSK UNIT UM05 … AT THE MALL AT CRIBBS CAUSEWAY … Bristol BS34 5DG"
 *
 * That is Cribbs Causeway — a store that is not in the portfolio at all — and
 * "Bristol" appears in it only as the postal town. If place names matched
 * anywhere in the string it would be filed under Bristol – Cabot Circus, the
 * Bristol figures would be quietly wrong, and nobody would ever find out.
 * Requiring a venue for anything longer than a bare town name refuses it.
 *
 * A bare "Bristol" (5 jobs) still matches, because a location that is nothing
 * but a town name is a town name, not an address.
 */

/*
 * Spelling variants that the derived keys do not produce. Each is a form that
 * appears in the legacy locations; nothing here invents a store.
 */
const VENUE_VARIANTS = new Map([
  ["Westfield – White City", ["whitecity"]], //       "Bespoke whitecity"
  ["Sheffield – Meadow Hall", ["meadowhall"]], //     "Meadowhall Sheffield"
  ["Brent Cross – Shopping Centre", ["brentcross"]],
  ["Dudley – Merry Hill", ["merryhill"]],
  // The store's own name is a stronger venue key than "High Road" for the one
  // location that spells the street "High Rd".
  ["Wood Green – High Road", ["wood green", "woodgreen"]],
  ["Aldgate – Whitechapel Road", ["whitechapel"]],
]);

/** Splits "Place – Venue" into its two halves on any dash. */
function splitName(name) {
  const parts = String(name).split(DASHES);
  return parts.length > 1
    ? { place: parts[0], venue: parts.slice(1).join(" ") }
    : { place: name, venue: name };
}

function buildKeys(name) {
  const { place, venue } = splitName(name);
  const placeKey = normalise(place);
  let venueKey = normalise(venue);
  // "Brent Cross – Shopping Centre" and "Milton Keynes – The Centre" have
  // nothing left after the stop words; for those the town IS the venue.
  if (!venueKey) venueKey = placeKey;
  const venues = new Set([venueKey, ...(VENUE_VARIANTS.get(name) ?? [])]);
  return { placeKey, venues: [...venues].filter(Boolean) };
}

/**
 * Resolves one location string to at most one site.
 *
 * Returns `{ siteId, how }` on a match, or `{ siteId: null, reason, candidates }`
 * when it will not commit to one. There is deliberately no third outcome where
 * it picks a favourite.
 */
function matchSite(location, sites) {
  const norm = normalise(location);
  if (!norm) return { siteId: null, reason: "blank", candidates: [] };

  const exact = sites.filter((s) => s.norm === norm);
  if (exact.length === 1) return { siteId: exact[0].id, how: "exact" };

  const byVenue = sites.filter((s) => s.venues.some((v) => contains(norm, v)));
  if (byVenue.length === 1) return { siteId: byVenue[0].id, how: "venue" };
  if (byVenue.length > 1) {
    return {
      siteId: null,
      reason: "ambiguous",
      candidates: byVenue.map((s) => s.name),
    };
  }

  const byPlace = sites.filter((s) => s.placeKey === norm);
  if (byPlace.length === 1) return { siteId: byPlace[0].id, how: "place" };
  if (byPlace.length > 1) {
    return {
      siteId: null,
      reason: "ambiguous",
      candidates: byPlace.map((s) => s.name),
    };
  }

  return { siteId: null, reason: "no-match", candidates: [] };
}

/* ------------------------------------------------------------ similarity -- */

/** Levenshtein distance, two-row variant. Only ever runs on unmatched strings. */
function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The candidate hint shown against an unmatched string.
 *
 * Advisory only — it is never fed back into matching, and it deliberately does
 * not print a similarity score. A number next to a store name reads as
 * confidence, and the whole point of this report is that the script has none:
 * it is the owner deciding, and "Metro Centre — 0.36 Brent Cross" is an
 * invitation to accept a wrong answer because it came with a decimal point.
 *
 * Two hints, and only two, because only two are actionable:
 *   - the string shares a whole word with a site, so it may be that site
 *     written as a postal address;
 *   - the string is within a couple of edits of a site name, so it may be a
 *     misspelling.
 * Anything else says nothing, and says so.
 */
/*
 * Words that appear in a site name but identify nothing on their own. Without
 * this, "Wantz Road, Dagenham" is reported as sharing wording with
 * "Aldgate – Whitechapel Road", which is noise dressed up as a lead.
 */
const GENERIC = new Set([
  "road", "street", "lane", "way", "square", "park", "mall", "high", "london",
  "north", "south", "east", "west",
]);

function candidates(location, sites) {
  const norm = normalise(location);
  if (!norm) return { kind: "none", names: [] };
  const tokens = new Set(norm.split(" "));

  const shares = sites.filter((s) =>
    s.norm.split(" ").some((t) => tokens.has(t) && !GENERIC.has(t)),
  );
  if (shares.length) return { kind: "shares-wording", names: shares.map((s) => s.name) };

  // A short string within a couple of edits is a typo; a long one that happens
  // to be numerically close is a coincidence, so length-gate it.
  const typos = sites
    .filter((s) => norm.length <= 24 && distance(norm, s.norm) <= 3)
    .map((s) => s.name);
  return typos.length
    ? { kind: "possible-misspelling", names: typos }
    : { kind: "none", names: [] };
}

/* ---------------------------------------------------------------- source -- */

/*
 * The snapshot is opened read-only. `db/backups/*.sqlite` is an evidential
 * artifact — it is the only surviving copy of what the legacy system held — and
 * a script that reads it must not be able to change its bytes even by accident.
 */
const src = new DatabaseSync(SOURCE, { readOnly: true });
const all = (sql, ...params) => src.prepare(sql).all(...params);
const clean = (v) => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

/*
 * SQLite stores these as "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS", written by
 * SQLite's CURRENT_TIMESTAMP, which is UTC. Postgres would otherwise read the
 * bare form in the server's timezone, shifting every date by an hour for half
 * the year — enough to move a completion across a month boundary in a report.
 */
function toTimestamp(v) {
  const s = clean(v);
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return /(Z|[+-]\d{2}:?\d{2})$/.test(iso)
    ? iso
    : `${iso.length === 10 ? `${iso}T00:00:00` : iso}Z`;
}
const toDate = (v) => clean(v)?.slice(0, 10) ?? null;

/* ---------------------------------------------------------------- target -- */

/*
 * PGlite is single-process, and losing that race is not a readable error: the
 * WASM build aborts with `RuntimeError: Aborted()` and several hundred
 * kilobytes of minified bundle, which looks like a broken install rather than
 * "something else has the database open". Saying so is the difference between a
 * five-second fix and an afternoon.
 */
let db;
try {
  // Remote when DATABASE_URL is set AND --allow-remote was passed (the guard
  // above has already refused every other combination); local PGlite otherwise.
  db = REMOTE
    ? await createDb(process.env.DATABASE_URL)
    : await createDb(undefined, PGLITE_DIR);
} catch (error) {
  if (REMOTE) {
    console.error(
      `Could not connect to the remote database.\n\nunderlying error: ${
        (error instanceof Error ? error.message : String(error)).slice(0, 200)
      }`,
    );
    process.exit(1);
  }
  console.error(
    `Could not open ${path.relative(ROOT, PGLITE_DIR)}.\n\n` +
      "PGlite is SINGLE-PROCESS. If the API server is running it holds the data\n" +
      "directory and nothing else can open it. Stop it and run this again:\n\n" +
      "    pkill -f 'node apps/api/src/server.ts'\n\n" +
      "If it is already stopped, the lock is stale — PGlite writes a synthetic\n" +
      "pid (-42) into postmaster.pid, so a process killed with SIGTERM leaves a\n" +
      "file it cannot tell apart from a live one. With nothing in `ps` and\n" +
      "nothing in `lsof +D .pglite`, it is safe to remove:\n\n" +
      `    rm ${path.relative(ROOT, PGLITE_DIR)}/postmaster.pid\n\n` +
      `underlying error: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
  );
  process.exit(1);
}

/*
 * The backend must match what the caller asked for.
 *
 * Belt and braces with the DATABASE_URL guard above: that one reads the
 * environment, this one reads what we actually connected to. They can only
 * disagree if `createDb` resolves a target neither of them expected, which is
 * exactly the case worth refusing.
 */
if (!REMOTE && db.backend !== "pglite") {
  console.error(`Refusing to run against ${db.backend} without --allow-remote.`);
  process.exit(1);
}
if (REMOTE && db.backend !== "postgres") {
  console.error(`--allow-remote was passed but the target is ${db.backend}.`);
  process.exit(1);
}

/*
 * The enums are read out of the database rather than restated here.
 *
 * The brief is that the new enums are the authority. A copy of them in this file
 * would be a second authority, and the day somebody adds a status to
 * 0001_extensions_and_enums.sql it would silently become the wrong one — every
 * job carrying the new label would be reported as unmappable by a script that
 * looks like it is checking against the schema.
 */
const enumValues = async (type) =>
  new Set(
    (
      await db.query(
        `select unnest(enum_range(null::${type}))::text as v`,
      )
    ).map((r) => r.v),
  );

const STATUSES = await enumValues("job_status");
const PRIORITIES = await enumValues("job_priority");
const ENGINEERS = await enumValues("engineer_required");
const FAULTS = await enumValues("job_fault_label");

/* status -> stage, straight from `job_stage_for()`. Same reasoning. */
const STAGE_OF = new Map(
  (
    await db.query(
      `select s::text as status, job_stage_for(s)::text as stage
         from unnest(enum_range(null::job_status)) s`,
    )
  ).map((r) => [r.status, r.stage]),
);

const STAGE_COLUMN = {
  New: "stage_new_at",
  Scheduling: "stage_scheduling_at",
  "In Progress": "stage_in_progress_at",
  Quotes: "stage_quotes_at",
  "On Hold": "stage_on_hold_at",
  Payment: "stage_payment_at",
  Done: "stage_done_at",
};

/*
 * The 31 rows the legacy board left with a blank status still carry a legacy
 * `stage`, which is real recorded data rather than an assumption. This maps that
 * stage onto the one status in the new enum that means the same thing, and the
 * report says exactly how many rows went through it.
 *
 * It is used ONLY when `status` is blank. It is not a fallback for an
 * unrecognised status — an unrecognised status is reported and the row is
 * skipped, because inventing workflow state is how a completed job reappears on
 * somebody's queue.
 */
const STAGE_TO_STATUS = {
  Incoming: "Pending Approval",
  Booked: "Job Scheduled",
  Attention: "Escalated",
  Completed: "Job Completed",
};

/* ------------------------------------------------------- read the source -- */

const [legacyOrg] = all(
  "select id, name, slug from organisations where slug = 'sunnamusk-uk'",
);
if (!legacyOrg) throw new Error("No 'sunnamusk-uk' organisation in the snapshot.");

const legacySites = all(
  `select id, name, address, postcode, access_notes, site_type_value, type, active
     from sites where organisation_id = ? order by name`,
  legacyOrg.id,
);

/*
 * The site register is built from BOTH legacy sources, because neither is
 * complete on its own:
 *
 *   `option_values` / set-store-location — the client's own canonical list,
 *      described in the source as "The 21 UK store locations". This is where the
 *      NAMES come from, EN DASH and all. It has no addresses.
 *
 *   `sites` — 10 rows carrying the real address and store type, but named
 *      loosely ("Aldgate", "Sheffield Meadowhall") in a way that does not match
 *      the board.
 *
 * Nine of the ten `sites` rows are the same stores as nine of the twenty-one
 * options; HQ — The Loom is a real site that is not on the store list. They are
 * merged by the same matcher the jobs use, so a store contributes ONE row.
 *
 * Creating both would be worse than creating neither: `sites_org_name_unique` is
 * per-name, so "Aldgate" and "Aldgate – Whitechapel Road" would both be accepted
 * as separate sites and the portfolio would split down the middle — which is
 * precisely the "Brent Cross"/"Brentcross" disease the schema comment warns
 * about, reintroduced by the import that was supposed to end it.
 */
const storeOptions = all(
  `select v.value as name
     from option_values v join option_sets s on s.id = v.option_set_id
    where s.key = 'store_location' and s.organisation_id = ? and v.active = 1
    order by v.position`,
  legacyOrg.id,
);

/*
 * The register's `id` is the site NAME. The real UUIDs do not exist until the
 * rows are written, and matching has to work identically in a dry run, which
 * writes nothing — so the name is the key throughout and is exchanged for a
 * UUID once, at insert time.
 */
const entry = (name, row) => ({
  id: name,
  name,
  norm: normalise(name),
  ...buildKeys(name),
  address: clean(row?.address),
  postcode: clean(row?.postcode),
  accessNotes: clean(row?.access_notes),
  storeType: clean(row?.site_type_value) ?? clean(row?.type),
});

const register = storeOptions.map((o) => entry(o.name, null));

let sitesMerged = 0;
for (const row of legacySites) {
  const hit = matchSite(row.name, register);
  const target = register.find((s) => s.id === hit.siteId);
  if (target) {
    // The store list names it; the sites table describes it.
    Object.assign(target, {
      address: clean(row.address),
      postcode: clean(row.postcode),
      accessNotes: clean(row.access_notes),
      storeType: clean(row.site_type_value) ?? clean(row.type),
    });
    sitesMerged += 1;
  } else {
    register.push(entry(row.name, row));
  }
}

const legacyContractors = all(
  "select id, name, email, phone, active from contractors where organisation_id = ?",
  legacyOrg.id,
);

const jobs = all(
  `select id, title, description, location, requester, contact, category,
          engineer, tier, priority, stage, status, contractor, assignee,
          requested_at, completed_at, next_update_at, cost, approved_by,
          invoice, created_at
     from maintenance_requests where organisation_id = ? order by id`,
  legacyOrg.id,
);

/* ------------------------------------------------------------- transform -- */

const stats = {
  total: jobs.length,
  matched: 0,
  unmatched: 0,
  byHow: { exact: 0, venue: 0, place: 0 },
  statusFromStage: 0,
  stageDateFallback: 0,
  blankDescription: 0,
};
const perSite = new Map(register.map((s) => [s.name, 0]));
const unmatched = new Map(); // raw location -> { n, reason, candidates }
const unmappable = new Map(); // "field=value" -> n
const skipped = [];

const noteUnmappable = (field, raw) => {
  const key = `${field} = ${JSON.stringify(raw ?? "")}`;
  unmappable.set(key, (unmappable.get(key) ?? 0) + 1);
};

const rows = [];
for (const job of jobs) {
  /* --- status: the one column that cannot be left null --- */
  let status = clean(job.status);
  if (!status) {
    status = STAGE_TO_STATUS[clean(job.stage) ?? ""] ?? null;
    if (status) stats.statusFromStage += 1;
  }
  if (!status || !STATUSES.has(status)) {
    // `jobs.status` is NOT NULL and every value in the enum means something
    // specific to a coordinator looking at a queue. There is no honest default,
    // so the row is skipped and named rather than filed under a guess.
    noteUnmappable("status", clean(job.status) ?? clean(job.stage));
    skipped.push(job.id);
    continue;
  }

  /* --- site: NULL unless exactly one site matches --- */
  const match = matchSite(job.location, register);
  if (match.siteId) {
    stats.matched += 1;
    stats.byHow[match.how] += 1;
    perSite.set(match.siteId, perSite.get(match.siteId) + 1);
  } else {
    stats.unmatched += 1;
    const raw = job.location ?? "";
    const seen = unmatched.get(raw) ?? {
      n: 0,
      reason: match.reason,
      candidates: match.candidates,
    };
    seen.n += 1;
    unmatched.set(raw, seen);
  }

  /*
   * The nullable enums. Anything the new enum does not contain becomes NULL and
   * is counted — never coerced to the nearest-looking member and never left to
   * a column default. `[object Object]` appears 25 times across these three
   * columns: a serialisation bug in the legacy monday import that turned a
   * label object into a string. Defaulting those to "Medium" would invent a
   * priority the client never set.
   */
  const mapEnum = (field, allowed, raw) => {
    const v = clean(raw);
    if (v !== null && allowed.has(v)) return v;
    noteUnmappable(field, raw);
    return null;
  };
  const priority = mapEnum("priority", PRIORITIES, job.priority);
  const engineer = mapEnum("engineer_required", ENGINEERS, job.engineer);
  const fault = mapEnum("fault_label", FAULTS, job.category);

  // `tier_level` is CHECK (between 1 and 4). The legacy default of 0 is not a
  // tier, it is "nobody set one", and writing it would fail the constraint.
  const tier = Number(job.tier) >= 1 && Number(job.tier) <= 4 ? Number(job.tier) : null;
  if (tier === null) noteUnmappable("tier_level", job.tier);

  const requestedAt = toTimestamp(job.requested_at) ?? toTimestamp(job.created_at);
  const completedAt = toTimestamp(job.completed_at);

  /*
   * Stage entry timestamps.
   *
   * Left to itself the `stamp_job_stage` trigger stamps now() on insert, which
   * would tell every ageing and SLA figure in the product that all 775 jobs
   * entered their current stage on the day of the import — the oldest of them
   * was raised in 2015. The trigger coalesces, so a value supplied here wins.
   *
   * Only what the source actually knows is written: a job was New when it was
   * raised, and Done when it was completed.
   *
   * Where the source has no date for the stage the job is currently in — 259 of
   * them, including 182 marked complete with no completion date — the fallback
   * is `date_requested`, not now(). The choice matters and it is not arbitrary:
   * date_requested is the EARLIEST the job could possibly have entered any
   * stage, so the resulting time-in-stage is the widest it could be. It errs
   * towards "this has been sitting here a long time", which surfaces work; now()
   * errs towards "this just happened", which buries a ten-year-old job in this
   * week's throughput figures. The count is in the report either way.
   */
  const stage = STAGE_OF.get(status);
  const stamps = { stage_new_at: requestedAt };
  if (completedAt) stamps.stage_done_at = completedAt;
  const column = STAGE_COLUMN[stage];
  if (!stamps[column]) {
    stamps[column] = completedAt ?? requestedAt;
    if (stage !== "New") stats.stageDateFallback += 1;
  }

  const description = clean(job.description);
  if (!description) stats.blankDescription += 1;

  // `cost` is a float in pounds. Money is integer pence everywhere in the new
  // schema, so it is rounded once, here, rather than drifting through joins.
  const cost = job.cost == null ? null : Math.round(Number(job.cost) * 100);

  rows.push({
    legacyId: `d1:req:${job.id}`,
    siteName: match.siteId,
    title: clean(job.title) ?? "(untitled)",
    // NOT NULL in the new schema; 32 legacy rows have no description at all.
    // The empty string is honest — it says nobody wrote one — where a
    // placeholder would read like content.
    description: description ?? "",
    location: clean(job.location),
    engineer,
    priority,
    fault,
    tier,
    contractorName: clean(job.contractor),
    assignedToName: clean(job.assignee),
    dateRequested: requestedAt,
    dateCompleted: completedAt,
    nextUpdate: toDate(job.next_update_at),
    requestedBy: clean(job.requester),
    contactNumber: clean(job.contact),
    cost: Number.isFinite(cost) ? cost : null,
    approvedBy: clean(job.approved_by),
    invoiceRef: clean(job.invoice),
    status,
    stamps,
    createdAt: toTimestamp(job.created_at) ?? requestedAt,
  });
}

/* ---------------------------------------------------------------- report -- */

const lines = [];
const say = (line = "") => {
  lines.push(line);
  console.log(line);
};

const pct = (n) => `${((n / (stats.total || 1)) * 100).toFixed(1)}%`;

say();
say("=".repeat(78));
say(`MAINTSUPP — legacy D1 import ${COMMIT ? "(COMMIT)" : "(DRY RUN — nothing written)"}`);
say("=".repeat(78));
say(`source        ${path.relative(ROOT, SOURCE)}`);
say(`target        local PGlite (${path.relative(ROOT, PGLITE_DIR)})`);
say(`generated     ${new Date().toISOString()}`);
say();
say(`organisation  ${legacyOrg.name} (${legacyOrg.slug})`);
say(
  `sites         ${register.length} — ${storeOptions.length} from the client's store list ` +
    `(${sitesMerged} of them merged with a site record carrying the address), ` +
    `plus ${register.length - storeOptions.length} site record(s) not on the store list`,
);
say(`contractors   ${legacyContractors.length}`);
say(`jobs read     ${stats.total}`);
say();
say("SITE ATTRIBUTION");
say(`  matched          ${String(stats.matched).padStart(4)}  ${pct(stats.matched)}`);
say(`    exact name     ${String(stats.byHow.exact).padStart(4)}`);
say(`    venue phrase   ${String(stats.byHow.venue).padStart(4)}`);
say(`    place, whole   ${String(stats.byHow.place).padStart(4)}`);
say(`  NOT matched      ${String(stats.unmatched).padStart(4)}  ${pct(stats.unmatched)}  -> site_id = NULL`);
say();

/*
 * The whole reason this importer exists: 744 of these jobs said "store-aldgate"
 * yesterday. This is what they say now.
 */
say("JOBS PER SITE");
say("-".repeat(78));
for (const [name, n] of [...perSite.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
  say(`  ${String(n).padStart(4)}  ${name}`);
}
say(`  ${String(stats.unmatched).padStart(4)}  (no site — see below)`);
say();

say("UNMATCHED LOCATION STRINGS — for the owner to decide on");
say("-".repeat(78));
if (unmatched.size === 0) {
  say("  (none)");
} else {
  const sorted = [...unmatched.entries()].sort(
    (a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]),
  );
  say(`  ${"jobs".padStart(4)}  location string`);
  say(`  ${" ".repeat(4)}  why it was not attributed, and any candidate worth looking at`);
  say();
  for (const [raw, info] of sorted) {
    const label = raw === "" ? "(blank)" : JSON.stringify(raw);
    say(`  ${String(info.n).padStart(4)}  ${label}`);
    if (info.reason === "ambiguous") {
      say(`        AMBIGUOUS — matches ${info.candidates.length}: ${info.candidates.join(" | ")}`);
      say("        not attributed: picking one would be a guess");
    } else if (info.reason === "blank") {
      say("        no location recorded on the legacy row");
    } else {
      const hint = candidates(raw, register);
      if (hint.kind === "shares-wording") {
        say(`        shares wording with: ${hint.names.join(" | ")}`);
        say("        no store name in the string, only a shared word — not attributed");
      } else if (hint.kind === "possible-misspelling") {
        say(`        possible misspelling of: ${hint.names.join(" | ")}`);
      } else {
        say("        no candidate — looks like a store outside the portfolio");
      }
    }
  }
  say();
  say(`  ${unmatched.size} distinct strings, ${stats.unmatched} jobs.`);
}
say();

say("VALUES THAT DID NOT MAP ONTO THE NEW ENUMS");
say("-".repeat(78));
if (unmappable.size === 0) {
  say("  (none)");
} else {
  for (const [key, n] of [...unmappable.entries()].sort((a, b) => b[1] - a[1])) {
    say(`  ${String(n).padStart(4)}  ${key}  -> NULL`);
  }
}
say();
say("DERIVED AND DROPPED");
say("-".repeat(78));
say(`  ${String(stats.statusFromStage).padStart(4)}  jobs had a blank status; taken from the legacy stage column`);
say(`  ${String(skipped.length).padStart(4)}  jobs skipped — status neither recorded nor derivable`);
say(`  ${String(stats.blankDescription).padStart(4)}  jobs have no description in the source (imported as empty)`);
say(`  ${String(stats.stageDateFallback).padStart(4)}  jobs carry no date for the stage they are in; date_requested stands in,`);
say("           so their time-in-stage is the widest it could be, never narrower");
say("     -  legacy `due_at` (67 rows) has no column in the new schema — dropped");
say("     -  legacy users/profiles are NOT imported: credentials do not transfer");
say();

/* ----------------------------------------------------------------- write -- */

if (!COMMIT) {
  say("DRY RUN — nothing was written. Re-run with --commit to apply.");
} else {
  const result = await db.transaction(async (tx) => {
    /* -- organisation: real client data, so never is_demo -- */
    const [org] = await tx.query(
      `insert into organisations (name, slug, legacy_id, is_demo)
       values ($1, $2, $3, false)
       on conflict (slug) do update set name = excluded.name,
                                        legacy_id = excluded.legacy_id
       returning id::text`,
      [legacyOrg.name, legacyOrg.slug, `d1:org:${legacyOrg.id}`],
    );

    /*
     * Everything below upserts on a stable natural key, so a re-run after
     * fixing one column updates in place. 776 rows is exactly the size of job
     * somebody re-runs; a script that could only ever insert would double the
     * portfolio the second time it was used.
     */
    /* `is_demo` is written false explicitly, not left to the column default:
     * this is a real client's portfolio, and `delete from organisations where
     * is_demo` is a statement somebody will run one day. */
    await upsert(
      tx,
      "sites",
      ["legacy_id", "organisation_id", "name", "address", "postcode", "access_notes", "store_type", "is_demo"],
      register.map((s) => [
        `d1:site:${normalise(s.name)}`,
        org.id,
        s.name,
        s.address,
        s.postcode,
        s.accessNotes,
        s.storeType,
        false,
      ]),
      "legacy_id",
      ["name", "address", "postcode", "access_notes", "store_type", "is_demo"],
    );

    const siteIds = new Map(
      (
        await tx.query(
          "select id::text, name from sites where organisation_id = $1",
          [org.id],
        )
      ).map((r) => [r.name, r.id]),
    );

    await upsert(
      tx,
      "contractors",
      ["legacy_id", "organisation_id", "name", "email", "phone", "active", "is_demo"],
      legacyContractors.map((c) => [
        `d1:contractor:${c.id}`,
        org.id,
        c.name,
        clean(c.email),
        clean(c.phone),
        Number(c.active) === 1,
        false,
      ]),
      "legacy_id",
      ["name", "email", "phone", "active", "is_demo"],
    );

    /*
     * Contractors are linked only on an exact normalised name match. The legacy
     * job column is free text ("Saed", "UK safety", "John") and the register
     * holds full trading names; "Saed" is probably "Saed Electrical" but
     * probably is not good enough to put a company's name against a client's
     * invoice. The free text is always kept in `contractor_name`, so nothing is
     * lost either way.
     */
    const contractorIds = new Map(
      (
        await tx.query(
          "select id::text, name from contractors where organisation_id = $1",
          [org.id],
        )
      ).map((r) => [normalise(r.name), r.id]),
    );

    const jobColumns = [
      "legacy_id", "organisation_id", "site_id", "title", "description", "location",
      "engineer_required", "priority", "fault_label", "tier_level",
      "contractor_id", "contractor_name", "assigned_to_name",
      "date_requested", "date_completed", "next_update",
      "job_requested_by", "contact_number", "cost_of_works_pence",
      "approved_by", "invoice_ref", "status",
      "stage_new_at", "stage_scheduling_at", "stage_in_progress_at",
      "stage_quotes_at", "stage_on_hold_at", "stage_payment_at", "stage_done_at",
      "created_at", "is_demo",
    ];
    const casts = {
      site_id: "uuid", engineer_required: "engineer_required", priority: "job_priority",
      fault_label: "job_fault_label", contractor_id: "uuid", status: "job_status",
      date_requested: "timestamptz", date_completed: "timestamptz", next_update: "date",
      stage_new_at: "timestamptz", stage_scheduling_at: "timestamptz",
      stage_in_progress_at: "timestamptz", stage_quotes_at: "timestamptz",
      stage_on_hold_at: "timestamptz", stage_payment_at: "timestamptz",
      stage_done_at: "timestamptz", created_at: "timestamptz",
    };

    const before = Number(
      (await tx.query("select count(*)::int as n from jobs where legacy_id like 'd1:req:%'"))[0].n,
    );

    const jobValues = rows.map((r) => [
      r.legacyId, org.id, r.siteName ? siteIds.get(r.siteName) : null,
      r.title, r.description, r.location,
      r.engineer, r.priority, r.fault, r.tier,
      r.contractorName ? (contractorIds.get(normalise(r.contractorName)) ?? null) : null,
      r.contractorName, r.assignedToName,
      r.dateRequested, r.dateCompleted, r.nextUpdate,
      r.requestedBy, r.contactNumber, r.cost,
      r.approvedBy, r.invoiceRef, r.status,
      r.stamps.stage_new_at ?? null, r.stamps.stage_scheduling_at ?? null,
      r.stamps.stage_in_progress_at ?? null, r.stamps.stage_quotes_at ?? null,
      r.stamps.stage_on_hold_at ?? null, r.stamps.stage_payment_at ?? null,
      r.stamps.stage_done_at ?? null,
      r.createdAt, false,
    ]);

    /*
     * `stage` is a GENERATED column and is never in this list. Writing it is
     * refused by Postgres, and the whole point of it being generated is that a
     * status can never be filed under the wrong stage by a caller who forgot
     * the mapping — an importer very much included.
     */
    await upsert(
      tx,
      "jobs",
      jobColumns,
      jobValues,
      "legacy_id",
      jobColumns.filter((c) => c !== "legacy_id" && c !== "organisation_id"),
      casts,
    );

    /*
     * `status_changed_at` is forced to now() by the stage trigger on INSERT and
     * cannot be supplied inline. This second pass sets it to the same date the
     * stage stamp used, and deliberately does not mention `status` — the trigger
     * is `before update of status`, so leaving that column out keeps it quiet
     * and stops the stage timestamps being rewritten.
     */
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const params = [];
      const tuples = chunk.map((r) => {
        const ts = r.stamps[STAGE_COLUMN[STAGE_OF.get(r.status)]] ?? r.dateRequested;
        params.push(r.legacyId, ts);
        // Both sides cast: a bare parameter inside a VALUES list in a FROM
        // clause has no column to infer its type from.
        return `($${params.length - 1}::text, $${params.length}::timestamptz)`;
      });
      await tx.query(
        `update jobs j set status_changed_at = v.ts
           from (values ${tuples.join(",")}) as v(legacy_id, ts)
          where j.legacy_id = v.legacy_id and j.status_changed_at is distinct from v.ts`,
        params,
      );
    }

    const after = Number(
      (await tx.query("select count(*)::int as n from jobs where legacy_id like 'd1:req:%'"))[0].n,
    );
    return { created: after - before, updated: rows.length - (after - before), sites: register.length };
  });

  say("WRITTEN");
  say("-".repeat(78));
  say("  organisations  1");
  say(`  sites          ${result.sites}`);
  say(`  contractors    ${legacyContractors.length}`);
  say(`  jobs created   ${result.created}`);
  say(`  jobs updated   ${result.updated}`);
  say(`  jobs skipped   ${skipped.length}`);
  say();
  say("  job comments   0 — the legacy `item_updates` table is empty and every");
  say("                 `maintenance_requests.comment_count` is 0. There is");
  say("                 nothing to import, rather than nothing that mapped.");
}

await writeFile(REPORT, `${lines.join("\n")}\n`, "utf8");
say(`report written to ${path.relative(ROOT, REPORT)}`);
await db.close();
src.close();

/* ------------------------------------------------------------ upsert help -- */

/**
 * One multi-row INSERT … ON CONFLICT per batch.
 *
 * 775 individual round trips through PGlite is slow enough that people stop
 * re-running the import, and an import nobody re-runs is an import nobody fixes.
 */
async function upsert(tx, table, columns, values, conflict, updateColumns, casts = {}) {
  if (values.length === 0) return;
  for (let i = 0; i < values.length; i += BATCH) {
    const chunk = values.slice(i, i + BATCH);
    const params = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((v, j) => {
        params.push(v);
        const cast = casts[columns[j]];
        return cast ? `$${params.length}::${cast}` : `$${params.length}`;
      });
      return `(${placeholders.join(",")})`;
    });
    const sets = updateColumns.map((c) => `${c} = excluded.${c}`).join(", ");
    await tx.query(
      `insert into ${table} (${columns.join(",")}) values ${tuples.join(",")}
       on conflict (${conflict}) do update set ${sets}`,
      params,
    );
  }
}
