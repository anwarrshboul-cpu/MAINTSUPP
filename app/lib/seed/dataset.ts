/**
 * THE SEED DATASET, AS DATA — never as inserts.
 *
 * ── AN ARCHITECTURAL DEVIATION FROM MODULE 3, ON THE OWNER'S INSTRUCTION ───
 *
 * Module 3 §1/§1.1 asks for a second Cloudflare D1 database and a second R2
 * bucket so that seeded rows physically cannot reach real ones. This build does
 * NOT do that, on the owner's explicit instruction: "use the CURRENT
 * architecture, do not introduce D1/R2". The portal is written against the D1
 * interface but deployed it is Supabase Postgres in the `portal` schema, via
 * `db/node-pg-d1.ts` and `db/sqlite-to-postgres.ts`; locally it is Miniflare
 * SQLite. There is no second binding to split, and creating one would produce a
 * boundary that nothing deployed reads — reassurance without protection.
 *
 * The isolation Module 3 calls "belt and braces" is therefore PRIMARY, and this
 * file is where three of the four layers are made true by construction:
 *
 *   (a) every row carries `is_seed = 1` and a `seed_batch_id`;
 *   (b) every store is named `ZZ-DEMO — …`;
 *   (c) every contact is `@example.com`;
 *   (d) the two production guards live in `./guards.ts`.
 *
 * Every id is additionally prefixed `zzdemo-`, which is not in the
 * specification and costs nothing: it gives a purge a third net that works on a
 * table whose seed columns somebody forgot to add.
 *
 * ── WHY THIS MODULE PRODUCES DATA AND NOT SQL ──────────────────────────────
 *
 * Nothing here inserts anything, opens a connection or imports from `db/`. The
 * dataset is a value, which is what makes it testable at the exact boundaries
 * with no database at all, and what lets `./expected.ts` count it without ever
 * running the application's queries. A generator that wrote rows as it invented
 * them would leave the harness with nothing to check against except the
 * database it had just written.
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 *
 * `Math.random` appears nowhere. The generator is mulberry32 — a 32-bit
 * counter-based PRNG, one multiply-xorshift round per draw — seeded from an
 * FNV-1a hash of the batch id, which is itself derived from `today`. Same day,
 * byte-identical dataset; §7's "npm run seed produces byte-identical data on
 * two consecutive runs" is then a property of the code rather than a habit.
 * Draws are consumed in straight-line order for the same reason: reordering two
 * blocks below changes every value after them.
 *
 * ── EVERY DATE IS RELATIVE ─────────────────────────────────────────────────
 *
 * There is not one hardcoded calendar date in the fixtures. Seed data with a
 * fixed expiry stops being a boundary test the day after it is written, and
 * then quietly stops being anything. Even the two dates §3.4 names literally —
 * 29 February 2028 and the October clock change — are COMPUTED: the next leap
 * day at or after `today`, and the last Sunday in October at or after `today`.
 * For any `today` between 1 March 2024 and 29 February 2028 the first resolves
 * to 2028-02-29, which is what the specification asked for, and it keeps
 * resolving to a real leap day afterwards instead of to a date in the past.
 *
 * ── THE BOUNDARY MATRIX IS THE POINT ───────────────────────────────────────
 *
 * §3.3 is reproduced below EXACTLY, offsets and counts. It is the highest-value
 * data in the module: an off-by-one at 90 moves every reminder in the system by
 * a day without a single screen looking wrong. `expected.ts` deliberately does
 * NOT read the offsets back off these rows — it re-derives them from the stored
 * date string, so an error in the date arithmetic here shows up as a band count
 * that does not match rather than cancelling itself out.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 *
 * No real job reference. The `MN-` series is the client's live numbering, one
 * of those numbers has been used as a QA fixture before and is now forbidden as
 * one, and a seeded row that reused it would put demo data under a real record.
 * Nothing seeded uses that shape at all: certificates are `ZZD-nnnn` and jobs
 * are `zzdemo-job-nnn`. The suite asserts it.
 */

/* ------------------------------------------------------------ primitives -- */

/** `YYYY-MM-DD`, UTC, which is the only date shape this product stores. */
export type IsoDate = string;

export const SEED_DATASET_VERSION = "v1";
export const SEED_STORE_PREFIX = "ZZ-DEMO — ";
export const SEED_ID_PREFIX = "zzdemo-";
/** Reserved by RFC 2606. It cannot receive mail, which is the entire point. */
export const SEED_EMAIL_DOMAIN = "example.com";

const MS_PER_DAY = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict UTC parse.
 *
 * Round-trips the formatted result so `2026-02-30` is rejected rather than
 * silently rolling into March — a rolled date would land a boundary
 * certificate one day out, which is the exact failure this whole module exists
 * to detect.
 */
function toUtcMs(iso: IsoDate): number {
  if (!ISO_DATE.test(iso)) {
    throw new Error(`seed: "${iso}" is not a YYYY-MM-DD date`);
  }
  const [year, month, day] = iso.split("-").map((part) => Number(part));
  const ms = Date.UTC(year, month - 1, day);
  if (formatUtc(ms) !== iso) {
    throw new Error(`seed: "${iso}" is not a real date`);
  }
  return ms;
}

function formatUtc(ms: number): IsoDate {
  const date = new Date(ms);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Whole days added in UTC, so no clock change can turn 90 into 89. */
export function addDays(iso: IsoDate, days: number): IsoDate {
  return formatUtc(toUtcMs(iso) + days * MS_PER_DAY);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

/** The Monday of the ISO week containing `iso`. */
function mondayOfWeek(iso: IsoDate): IsoDate {
  const weekday = new Date(toUtcMs(iso)).getUTCDay(); /* 0 = Sunday */
  return addDays(iso, -((weekday + 6) % 7));
}

/** The first day of the month after the one containing `iso`. */
function firstOfNextMonth(iso: IsoDate): IsoDate {
  const date = new Date(toUtcMs(iso));
  return formatUtc(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The next 29 February at or after `today`.
 *
 * §3.4 asks for jobs on 29 February 2028. Hardcoding it would make the fixture
 * expire on 1 March 2028 and, worse, would make it meaningless for the two
 * years before that, when the date is so far out that no arithmetic near it is
 * being exercised. Computing it keeps the fixture honest in both directions.
 */
export function nextLeapDay(today: IsoDate): IsoDate {
  let year = new Date(toUtcMs(today)).getUTCFullYear();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (isLeapYear(year)) {
      const candidate = `${String(year).padStart(4, "0")}-02-29`;
      if (candidate >= today) return candidate;
    }
    year += 1;
  }
  /* Unreachable: a leap year occurs at least every eight years. */
  throw new Error("seed: no leap day found");
}

/**
 * The next end of British Summer Time at or after `today`: the last Sunday in
 * October, when local clocks go back an hour and a naive local-time day
 * subtraction returns 0.958333 of a day.
 */
export function nextOctoberClockChange(today: IsoDate): IsoDate {
  let year = new Date(toUtcMs(today)).getUTCFullYear();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lastOctober = formatUtc(Date.UTC(year, 9, 31));
    const candidate = addDays(lastOctober, -new Date(toUtcMs(lastOctober)).getUTCDay());
    if (candidate >= today) return candidate;
    year += 1;
  }
  throw new Error("seed: no October clock change found");
}

/* --------------------------------------------------------------- the PRNG -- */

/** FNV-1a, 32-bit. Turns the batch id into a seed without a dependency. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32. Thirty-two bits of state, one multiply-xorshift round per draw,
 * period 2^32, and — the property that matters here — identical output for
 * identical seeds on every engine, which `Math.random` explicitly does not
 * promise.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function intBetween(rng: Rng, low: number, high: number): number {
  return low + Math.floor(rng() * (high - low + 1));
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** Fisher-Yates, out of place, so the caller's list is untouched. */
function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const held = copy[index];
    copy[index] = copy[swap];
    copy[swap] = held;
  }
  return copy;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/* ------------------------------------------------------- the row shapes -- */

/** Carried on every row. The (a) layer of the isolation, in the type system. */
export type SeedMarked = {
  readonly isSeed: 1;
  readonly seedBatchId: string;
};

export type SeedStore = SeedMarked & {
  readonly id: string;
  /** Always begins `ZZ-DEMO — `. Sorts to the bottom, greppable in an export. */
  readonly name: string;
  readonly type: "Store" | "Kiosk" | "Concession";
  readonly city: string;
  readonly region: string;
  readonly address: string;
  readonly manager: string;
};

export type SeedUserRole = "admin" | "staff" | "client_user";

export type SeedUser = SeedMarked & {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: SeedUserRole;
};

export type SeedContact = SeedMarked & {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly kind: "site" | "client";
  readonly storeId: string | null;
};

export type SeedContractor = SeedMarked & {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly trade: string;
};

export type SeedCertificate = SeedMarked & {
  readonly id: string;
  readonly storeId: string;
  /** `compliance_documents.kind`. */
  readonly kind: string;
  readonly isMandatoryType: boolean;
  readonly reference: string;
  readonly issuedBy: string;
  readonly issueDate: IsoDate;
  /** Null for a document filed with no expiry — a real and untested state. */
  readonly expiryDate: IsoDate | null;
  /**
   * The offset the matrix asked for, carried for provenance ONLY.
   *
   * `expected.ts` must not read it — it re-derives the offset from
   * `expiryDate`, which is what makes the two independent. It is here so a
   * failing row can be traced back to the matrix line that produced it.
   */
  readonly matrixOffsetDays: number | null;
  readonly renewalStatus: "current" | "superseded";
  readonly supersededById: string | null;
  readonly renewalOwnerEmail: string;
  readonly escalationEmail: string;
  readonly costPence: number;
  readonly remedialsRequired: boolean;
};

export type SeedJob = SeedMarked & {
  readonly id: string;
  readonly storeId: string;
  readonly title: string;
  readonly category: string;
  readonly priority: string;
  readonly status: string;
  /** False for the three statuses §3.4 asks to be absent from the map. */
  readonly statusIsMapped: boolean;
  readonly raisedAt: IsoDate;
  /** The SLA deadline. Null only where the job carries none. */
  readonly dueAt: IsoDate | null;
  readonly scheduledDate: IsoDate | null;
  readonly completedAt: IsoDate | null;
  readonly lastStatusChangeAt: IsoDate;
  readonly assignee: string | null;
  readonly contact: string;
  /** Which §3.4 clause put this row here. Empty for the baseline fill. */
  readonly edgeCases: readonly string[];
};

export type SeedCalendarItem = SeedMarked & {
  readonly id: string;
  readonly storeId: string;
  readonly category: "Note" | "Planned visit";
  readonly title: string;
  readonly notes: string;
  readonly startsOn: IsoDate;
  readonly endsOn: IsoDate | null;
  readonly assignedTo: string | null;
  readonly contractorId: string | null;
  readonly visitType: string | null;
};

/**
 * An attachment DESCRIPTOR, not a file.
 *
 * §3.2 asks for 40 generated PDFs and images "in the test R2 bucket". There is
 * no test bucket — see the deviation at the top — and materialising bytes is
 * not this module's job in any case, because it must stay pure. What is
 * deterministic and worth pinning is the manifest: what is attached to what,
 * how big, and of what type. Whoever writes the loader generates the bytes from
 * `contentSeed` and uploads through `uploadEvidenceFile()` in
 * `app/lib/client-upload.ts`, which owns the ~1 MiB direct-path ceiling — every
 * size below is well under it on purpose.
 */
export type SeedAttachment = SeedMarked & {
  readonly id: string;
  readonly subjectType: "job" | "certificate" | "visit";
  readonly subjectId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly contentSeed: number;
};

export type CertificateBoundaryRow = {
  readonly offsetDays: number;
  readonly count: number;
  /** The word §3.3 uses. Restated in `expected.ts` and again in the test. */
  readonly expectedColour: string;
  readonly expectedState: string;
};

export type SeedDataset = {
  readonly version: string;
  readonly seedBatchId: string;
  readonly today: IsoDate;
  readonly generator: string;
  readonly stores: readonly SeedStore[];
  readonly users: readonly SeedUser[];
  readonly contacts: readonly SeedContact[];
  readonly contractors: readonly SeedContractor[];
  readonly certificates: readonly SeedCertificate[];
  readonly jobs: readonly SeedJob[];
  readonly notes: readonly SeedCalendarItem[];
  readonly plannedVisits: readonly SeedCalendarItem[];
  readonly attachments: readonly SeedAttachment[];
  readonly mandatoryCertificateTypes: readonly string[];
  readonly optionalCertificateTypes: readonly string[];
  /** The statuses this dataset believes the map holds, and the three it does not. */
  readonly jobStatusCatalogue: {
    readonly mapped: readonly { readonly label: string; readonly countsAsOpen: boolean }[];
    readonly unmapped: readonly string[];
  };
  /** The reminder ladder the seeded cascade uses, as offsets from expiry. */
  readonly reminderSteps: readonly { readonly key: string; readonly offsetDays: number }[];
  readonly boundaryMatrix: readonly CertificateBoundaryRow[];
};

/* ------------------------------------------------------ the fixed tables -- */

/**
 * §3.3, transcribed. Do not tidy the order and do not round the counts: this
 * table is compared line by line against a second copy in `expected.ts` and a
 * third in `tests/pre-w14-seed-reconcile.test.mjs`, and three copies that agree
 * are the only evidence that the arithmetic between them is right.
 */
export const CERTIFICATE_BOUNDARY_MATRIX: readonly CertificateBoundaryRow[] = [
  { offsetDays: 200, count: 3, expectedColour: "Grey", expectedState: "Valid, no reminders fired" },
  { offsetDays: 91, count: 2, expectedColour: "Grey", expectedState: "Valid — one day before the 90 window" },
  { offsetDays: 90, count: 3, expectedColour: "Yellow", expectedState: "90-day reminder fires today" },
  { offsetDays: 75, count: 3, expectedColour: "Yellow", expectedState: "Inside the 90 window" },
  { offsetDays: 61, count: 2, expectedColour: "Yellow", expectedState: "One day before the 60 window" },
  { offsetDays: 60, count: 3, expectedColour: "Orange", expectedState: "60-day reminder fires today" },
  { offsetDays: 45, count: 3, expectedColour: "Orange", expectedState: "Inside the 60 window" },
  { offsetDays: 31, count: 2, expectedColour: "Orange", expectedState: "One day before the 30 window" },
  { offsetDays: 30, count: 3, expectedColour: "Red", expectedState: "30-day reminder fires today" },
  { offsetDays: 22, count: 3, expectedColour: "Red", expectedState: "Inside the 30 window" },
  { offsetDays: 15, count: 2, expectedColour: "Red", expectedState: "One day before the 14 window" },
  { offsetDays: 14, count: 3, expectedColour: "Dark red", expectedState: "14-day reminder fires, repeat enabled" },
  { offsetDays: 7, count: 3, expectedColour: "Dark red", expectedState: "Repeat cycle mid-flight" },
  { offsetDays: 1, count: 2, expectedColour: "Dark red", expectedState: "One day before expiry" },
  { offsetDays: 0, count: 3, expectedColour: "Dark red", expectedState: "Expiry-day reminder fires" },
  { offsetDays: -1, count: 3, expectedColour: "Expired", expectedState: "Overdue escalation begins" },
  { offsetDays: -14, count: 3, expectedColour: "Expired", expectedState: "Overdue, 2 escalations sent" },
  { offsetDays: -60, count: 2, expectedColour: "Expired", expectedState: "Overdue, cap reached, flagged for review" },
  { offsetDays: -120, count: 2, expectedColour: "Superseded", expectedState: "Renewed, cascade cancelled" },
];

/**
 * The matrix totals 50 certificates; §3.2 asks for 60.
 *
 * The two numbers in the specification do not agree, and the matrix wins,
 * because §4.3 calls the band counts "the single highest-value assertion in the
 * whole harness" and adding ten more dated certificates would move them. The
 * remaining ten are seeded with NO EXPIRY DATE, which reaches the stated volume
 * without touching a single band and covers a state nothing else in the seed
 * reaches: a compliance document filed without an expiry, which the register
 * must not colour as expiring today. The discrepancy is recorded in the
 * handover rather than resolved silently.
 */
export const UNDATED_CERTIFICATE_COUNT = 10;

/**
 * The statuses §4.2's default map holds, with `counts_as_open`.
 *
 * This is the HARNESS'S OWN copy of `JOB_STATUS_MAP_SEED` in `db/init.ts`, and
 * it is a copy on purpose: the harness must be able to say "the map and the
 * data disagree", which it cannot do if it reads the map it is checking. The
 * test asserts the two agree, so a drift is a red test rather than a silent
 * one — see `tests/pre-w14-seed-reconcile.test.mjs`.
 */
export const MAPPED_JOB_STATUSES: readonly { label: string; countsAsOpen: boolean }[] = [
  { label: "New", countsAsOpen: true },
  { label: "Reported", countsAsOpen: true },
  { label: "Quote required", countsAsOpen: true },
  { label: "Awaiting approval", countsAsOpen: true },
  { label: "Scheduled", countsAsOpen: true },
  { label: "Booked", countsAsOpen: true },
  { label: "In progress", countsAsOpen: true },
  { label: "On hold", countsAsOpen: true },
  { label: "Awaiting parts", countsAsOpen: true },
  { label: "No access", countsAsOpen: true },
  { label: "Completed", countsAsOpen: false },
  { label: "Cancelled", countsAsOpen: false },
];

/**
 * §3.4's three statuses that are DELIBERATELY absent from `job_status_map`.
 *
 * They exist to prove the fallback: an unmapped status must render grey with
 * its raw label and raise the admin notice, not disappear. They are phrased the
 * way a monday board actually drifts — somebody adds a column value one
 * afternoon and nobody tells the portal.
 */
export const UNMAPPED_JOB_STATUSES: readonly string[] = [
  "Awaiting subcontractor quote",
  "Deferred to capex programme",
  "Parked — landlord approval",
];

/**
 * The certificate cascade, as offsets from the expiry date.
 *
 * The same ladder `REMINDER_DEFAULTS_SEED` in `db/init.ts` seeds — 90, 60, 30
 * and 14 days before, on the day, and 7 days after — restated here for the
 * same reason the status map is: the harness has to be able to disagree with
 * the application.
 */
export const REMINDER_STEPS: readonly { key: string; offsetDays: number }[] = [
  { key: "90", offsetDays: -90 },
  { key: "60", offsetDays: -60 },
  { key: "30", offsetDays: -30 },
  { key: "14", offsetDays: -14 },
  { key: "expiry", offsetDays: 0 },
  { key: "overdue", offsetDays: 7 },
];

/** The overdue step repeats weekly to a cap of 8, per `REMINDER_DEFAULTS_SEED`. */
export const OVERDUE_REPEAT_INTERVAL_DAYS = 7;
export const OVERDUE_REPEAT_CAP = 8;

/**
 * The four types every store must hold. §3.3 asks for three stores missing one
 * of these outright, to prove the coverage-gap detection fires.
 */
export const MANDATORY_CERTIFICATE_TYPES: readonly string[] = [
  "Fire risk assessment",
  "Electrical installation condition report",
  "Emergency lighting certificate",
  "Legionella risk assessment",
];

/** Real, but not mandatory, so an absence here is not a gap. */
export const OPTIONAL_CERTIFICATE_TYPES: readonly string[] = [
  "Gas safety certificate",
  "PAT testing certificate",
  "Fire alarm service certificate",
  "Air conditioning inspection report",
];

const STORE_SITES: readonly { name: string; type: SeedStore["type"]; city: string; region: string }[] = [
  { name: "Manchester Arndale", type: "Store", city: "Manchester", region: "North West" },
  { name: "Birmingham Bullring", type: "Store", city: "Birmingham", region: "West Midlands" },
  { name: "Leeds Trinity", type: "Store", city: "Leeds", region: "Yorkshire" },
  { name: "Glasgow Buchanan Galleries", type: "Store", city: "Glasgow", region: "Scotland" },
  { name: "Cardiff St Davids", type: "Store", city: "Cardiff", region: "Wales" },
  { name: "Bristol Cabot Circus", type: "Store", city: "Bristol", region: "South West" },
  { name: "Nottingham Victoria Centre", type: "Store", city: "Nottingham", region: "East Midlands" },
  { name: "Liverpool ONE", type: "Store", city: "Liverpool", region: "North West" },
  { name: "Sheffield Meadowhall Kiosk", type: "Kiosk", city: "Sheffield", region: "Yorkshire" },
  { name: "Newcastle Eldon Square Kiosk", type: "Kiosk", city: "Newcastle", region: "North East" },
  { name: "Edinburgh St James Concession", type: "Concession", city: "Edinburgh", region: "Scotland" },
  { name: "Southampton Westquay Concession", type: "Concession", city: "Southampton", region: "South East" },
];

const USER_ROSTER: readonly { name: string; role: SeedUserRole }[] = [
  { name: "Ada Fenwick", role: "admin" },
  { name: "Marcus Bell", role: "admin" },
  { name: "Priya Raman", role: "staff" },
  { name: "Tomasz Nowak", role: "staff" },
  { name: "Ruth Okonjo", role: "staff" },
  { name: "Callum Hendry", role: "staff" },
  { name: "Sofia Marchetti", role: "client_user" },
  { name: "Daniel Whitcombe", role: "client_user" },
];

const CONTRACTOR_ROSTER: readonly { name: string; trade: string }[] = [
  { name: "Halden Electrical Services", trade: "Electrical" },
  { name: "Northgate Gas & Heating", trade: "Gas" },
  { name: "Sentinel Fire Protection", trade: "Fire" },
  { name: "Clearwater Hygiene", trade: "Water hygiene" },
  { name: "Brayford Climate Systems", trade: "HVAC" },
  { name: "Ridgeway Facilities", trade: "General" },
];

const JOB_CATEGORIES: readonly string[] = [
  "Electrical",
  "Plumbing",
  "HVAC",
  "Fabric",
  "Fire safety",
  "Security",
  "Refrigeration",
  "Cleaning",
];

const JOB_TITLES: readonly string[] = [
  "Shopfront lighting circuit tripping",
  "Stockroom radiator not heating",
  "Air conditioning noisy over the till",
  "Fire door closer failing",
  "Water ingress at the rear entrance",
  "Till point socket loose",
  "Emergency light failing its flick test",
  "Extract fan vibrating in the back office",
  "Roller shutter sticking on close",
  "Sink waste blocked in the staff kitchen",
  "Ceiling tile stained above the fitting room",
  "Card terminal power supply intermittent",
];

const NOTE_TITLES: readonly string[] = [
  "Landlord fit-out window confirmed",
  "Access badge reissued to the duty manager",
  "Quarterly compliance walk booked",
  "Stock delivery blocks the fire exit route",
  "Meter reading taken for the service charge",
];

const VISIT_TYPES: readonly string[] = [
  "Planned preventative maintenance",
  "Statutory inspection",
  "Remedial works",
  "Survey",
  "Reactive attendance",
];

/** Where the deliberate coverage gaps go: three stores, three different types. */
const COVERAGE_GAP_PLAN: readonly { storeIndex: number; typeIndex: number }[] = [
  { storeIndex: 2, typeIndex: 0 },
  { storeIndex: 6, typeIndex: 2 },
  { storeIndex: 10, typeIndex: 3 },
];

/* ------------------------------------------------------------ the builder -- */

function emailFor(fullName: string): string {
  const local = fullName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
  return `${local}@${SEED_EMAIL_DOMAIN}`;
}

/**
 * The whole dataset for one day.
 *
 * `today` is an argument and not `new Date()` so that a run is reproducible and
 * so the harness can be pointed at any day — which is also what `seed:travel`
 * needs: shifting time is rebuilding at a different `today`, not mutating rows.
 */
export function buildSeedDataset(today: IsoDate): SeedDataset {
  toUtcMs(today); /* Validate before anything derives from it. */

  const seedBatchId = `${SEED_ID_PREFIX}${today.replace(/-/g, "")}-${SEED_DATASET_VERSION}`;
  const mark: SeedMarked = { isSeed: 1, seedBatchId };
  const rng = mulberry32(fnv1a32(seedBatchId));

  /* -- stores ------------------------------------------------------------ */

  const stores: SeedStore[] = STORE_SITES.map((site, index) => ({
    ...mark,
    id: `${SEED_ID_PREFIX}store-${pad(index + 1, 2)}`,
    name: `${SEED_STORE_PREFIX}${site.name}`,
    type: site.type,
    city: site.city,
    region: site.region,
    address: `Unit ${intBetween(rng, 1, 180)}, ${site.name}, ${site.city}`,
    manager: USER_ROSTER[index % USER_ROSTER.length].name,
  }));

  /* -- users ------------------------------------------------------------- */

  const users: SeedUser[] = USER_ROSTER.map((person, index) => ({
    ...mark,
    id: `${SEED_ID_PREFIX}user-${pad(index + 1, 2)}`,
    email: emailFor(person.name),
    fullName: person.name,
    role: person.role,
  }));

  const admins = users.filter((user) => user.role === "admin");
  const engineers = users.filter((user) => user.role === "staff");

  /* -- contacts ---------------------------------------------------------- */

  /*
   * Twenty: one site contact per store, then eight client-side contacts. There
   * is no `contacts` table in this schema — a site's contact is `sites.manager`
   * and a job's is `maintenance_requests.contact` — so these are carried as
   * data and denormalised by the loader. That absence is in the handover.
   */
  const contactSurnames = [
    "Ashby", "Boateng", "Chowdhury", "Delaney", "Eriksen", "Ferreira",
    "Gallagher", "Haruna", "Ivanov", "Jaffrey", "Kowalski", "Lindqvist",
    "Mahmood", "Nkemelu", "Ortega", "Pemberton", "Quigley", "Rasmussen",
    "Sandoval", "Thackeray",
  ];
  const contacts: SeedContact[] = contactSurnames.map((surname, index) => {
    const isSite = index < stores.length;
    const fullName = `${["Alex", "Sam", "Jo", "Nia", "Rae", "Kit"][index % 6]} ${surname}`;
    return {
      ...mark,
      id: `${SEED_ID_PREFIX}contact-${pad(index + 1, 2)}`,
      email: emailFor(`${fullName} ${index + 1}`),
      fullName,
      kind: isSite ? "site" : "client",
      storeId: isSite ? stores[index].id : null,
    };
  });

  /* -- contractors ------------------------------------------------------- */

  const contractors: SeedContractor[] = CONTRACTOR_ROSTER.map((firm, index) => ({
    ...mark,
    id: `${SEED_ID_PREFIX}contractor-${pad(index + 1, 2)}`,
    /* Prefixed like a store: a contractor name is client-facing too, and the
       point of the prefix is that no seeded name reads as real anywhere. */
    name: `${SEED_STORE_PREFIX}${firm.name}`,
    email: emailFor(`accounts ${firm.name}`),
    trade: firm.trade,
  }));

  /* -- certificates ------------------------------------------------------ */

  /*
   * The (store, type) pairs, and the three that are deliberately left empty.
   *
   * Every mandatory pair except those three receives exactly one dated,
   * non-superseded certificate, so `coverage_gaps` is exactly three rows and
   * not "three plus whatever the shuffle happened to miss". Exactness is worth
   * more than realism in a fixture whose job is to be counted.
   */
  const gapPairs = COVERAGE_GAP_PLAN.map((gap) => ({
    storeId: stores[gap.storeIndex].id,
    kind: MANDATORY_CERTIFICATE_TYPES[gap.typeIndex],
  }));
  const isGap = (storeId: string, kind: string) =>
    gapPairs.some((gap) => gap.storeId === storeId && gap.kind === kind);

  const mandatoryPairs: { storeId: string; kind: string }[] = [];
  for (const store of stores) {
    for (const kind of MANDATORY_CERTIFICATE_TYPES) {
      if (!isGap(store.id, kind)) mandatoryPairs.push({ storeId: store.id, kind });
    }
  }
  const coveredPairs = shuffled(rng, mandatoryPairs);

  const optionalPairs: { storeId: string; kind: string }[] = [];
  for (const store of stores) {
    for (const kind of OPTIONAL_CERTIFICATE_TYPES) {
      optionalPairs.push({ storeId: store.id, kind });
    }
  }
  const extraPairs = shuffled(rng, optionalPairs);

  /* The matrix, expanded into one slot per certificate, superseded held back. */
  const datedOffsets: number[] = [];
  const supersededOffsets: number[] = [];
  for (const row of CERTIFICATE_BOUNDARY_MATRIX) {
    for (let copy = 0; copy < row.count; copy += 1) {
      if (row.expectedColour === "Superseded") supersededOffsets.push(row.offsetDays);
      else datedOffsets.push(row.offsetDays);
    }
  }

  const certificates: SeedCertificate[] = [];
  const certificateSlots: { storeId: string; kind: string; offsetDays: number | null }[] = [];

  /* Slots 0..n-1 cover the mandatory pairs one for one; the rest are extras. */
  const allSlotOffsets: (number | null)[] = datedOffsets.slice();
  for (let index = 0; index < UNDATED_CERTIFICATE_COUNT; index += 1) allSlotOffsets.push(null);

  for (let index = 0; index < allSlotOffsets.length; index += 1) {
    const pair =
      index < coveredPairs.length
        ? coveredPairs[index]
        : extraPairs[(index - coveredPairs.length) % extraPairs.length];
    certificateSlots.push({ storeId: pair.storeId, kind: pair.kind, offsetDays: allSlotOffsets[index] });
  }

  for (let index = 0; index < certificateSlots.length; index += 1) {
    const slot = certificateSlots[index];
    const expiryDate = slot.offsetDays === null ? null : addDays(today, slot.offsetDays);
    const issuedBy = pick(rng, contractors);
    certificates.push({
      ...mark,
      id: `${SEED_ID_PREFIX}cert-${pad(index + 1, 3)}`,
      storeId: slot.storeId,
      kind: slot.kind,
      isMandatoryType: MANDATORY_CERTIFICATE_TYPES.includes(slot.kind),
      reference: `ZZD-${pad(index + 1, 4)}`,
      issuedBy: issuedBy.name,
      issueDate: expiryDate ? addDays(expiryDate, -365) : addDays(today, -intBetween(rng, 30, 300)),
      expiryDate,
      matrixOffsetDays: slot.offsetDays,
      renewalStatus: "current",
      supersededById: null,
      renewalOwnerEmail: pick(rng, engineers).email,
      escalationEmail: pick(rng, admins).email,
      costPence: intBetween(rng, 120, 480) * 100,
      remedialsRequired: rng() < 0.18,
    });
  }

  /*
   * The two superseded certificates.
   *
   * §3.3 calls them "renewed, cascade cancelled", so each is the PREDECESSOR of
   * a certificate that already exists — one of the +200 rows, on the same store
   * and the same type. Inventing a fresh successor for each would have added
   * two certificates the matrix does not contain, and the successor's presence
   * is also what keeps the pair covered: a superseded certificate does not
   * satisfy a mandatory type on its own.
   */
  const renewalTargets = certificates.filter((certificate) => certificate.matrixOffsetDays === 200);
  supersededOffsets.forEach((offsetDays, index) => {
    const successor = renewalTargets[index % renewalTargets.length];
    const expiryDate = addDays(today, offsetDays);
    certificates.push({
      ...mark,
      id: `${SEED_ID_PREFIX}cert-${pad(certificates.length + 1, 3)}`,
      storeId: successor.storeId,
      kind: successor.kind,
      isMandatoryType: successor.isMandatoryType,
      reference: `ZZD-${pad(certificates.length + 1, 4)}`,
      issuedBy: successor.issuedBy,
      issueDate: addDays(expiryDate, -365),
      expiryDate,
      matrixOffsetDays: offsetDays,
      renewalStatus: "superseded",
      supersededById: successor.id,
      renewalOwnerEmail: successor.renewalOwnerEmail,
      escalationEmail: successor.escalationEmail,
      costPence: intBetween(rng, 120, 480) * 100,
      remedialsRequired: false,
    });
  });

  /* -- jobs -------------------------------------------------------------- */

  const jobs: SeedJob[] = [];
  const engineerNames = engineers.map((user) => user.fullName);
  const siteContacts = contacts.filter((contact) => contact.kind === "site");

  let jobCounter = 0;
  const nextJob = (
    fields: {
      status: string;
      statusIsMapped?: boolean;
      raisedAt: IsoDate;
      dueAt: IsoDate | null;
      scheduledDate: IsoDate | null;
      completedAt?: IsoDate | null;
      lastStatusChangeAt: IsoDate;
      assignee: string | null;
      edgeCases?: readonly string[];
    },
  ): SeedJob => {
    jobCounter += 1;
    const store = stores[jobCounter % stores.length];
    const contact = siteContacts[jobCounter % siteContacts.length];
    return {
      ...mark,
      id: `${SEED_ID_PREFIX}job-${pad(jobCounter, 3)}`,
      storeId: store.id,
      title: JOB_TITLES[jobCounter % JOB_TITLES.length],
      category: JOB_CATEGORIES[jobCounter % JOB_CATEGORIES.length],
      priority: ["Low", "Medium", "High"][jobCounter % 3],
      status: fields.status,
      statusIsMapped: fields.statusIsMapped !== false,
      raisedAt: fields.raisedAt,
      dueAt: fields.dueAt,
      scheduledDate: fields.scheduledDate,
      completedAt: fields.completedAt ?? null,
      lastStatusChangeAt: fields.lastStatusChangeAt,
      assignee: fields.assignee,
      contact: contact.email,
      edgeCases: fields.edgeCases ?? [],
    };
  };

  /*
   * §3.4's edge cases, built FIRST and kept disjoint.
   *
   * Disjoint because every one of them is a number the reconciliation page
   * compares: if a job were both "unscheduled" and "breached", the two rows
   * would have to explain their overlap and the harness would be arguing with
   * itself. The baseline fill afterwards is deliberately constructed so it can
   * never wander into one of these buckets — see the comment on it.
   */

  /* 8 open jobs with no scheduled date. */
  for (let index = 0; index < 8; index += 1) {
    jobs.push(
      nextJob({
        status: ["New", "Reported", "Quote required", "Awaiting approval"][index % 4],
        raisedAt: addDays(today, -(index + 1)),
        dueAt: addDays(today, 45 + index),
        scheduledDate: null,
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: engineerNames[index % engineerNames.length],
        edgeCases: ["unscheduled"],
      }),
    );
  }

  /* 6 jobs with a breached SLA and still open. */
  for (let index = 0; index < 6; index += 1) {
    const dueAt = addDays(today, -(index + 1));
    jobs.push(
      nextJob({
        status: ["Scheduled", "Booked", "In progress", "No access", "New", "Reported"][index],
        raisedAt: addDays(dueAt, -20),
        dueAt,
        scheduledDate: addDays(dueAt, -2),
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: engineerNames[index % engineerNames.length],
        edgeCases: ["sla-breached"],
      }),
    );
  }

  /*
   * 4 jobs at EXACTLY 25% of the SLA window remaining.
   *
   * Written as (window, remaining) pairs whose ratio is exactly a quarter, so
   * the trigger is tested on its edge rather than near it. 8/2 is included
   * because a short window is where an integer division rounds.
   */
  const quarterWindows: readonly [number, number][] = [
    [20, 5],
    [40, 10],
    [8, 2],
    [28, 7],
  ];
  quarterWindows.forEach(([window, remaining], index) => {
    jobs.push(
      nextJob({
        status: ["Scheduled", "Booked", "In progress", "Awaiting approval"][index],
        raisedAt: addDays(today, -(window - remaining)),
        dueAt: addDays(today, remaining),
        scheduledDate: addDays(today, Math.max(0, remaining - 1)),
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: engineerNames[index % engineerNames.length],
        edgeCases: ["sla-quarter-remaining"],
      }),
    );
  });

  /* 5 unassigned jobs raised over 24 hours ago. */
  for (let index = 0; index < 5; index += 1) {
    jobs.push(
      nextJob({
        status: ["New", "Reported", "New", "Reported", "Quote required"][index],
        raisedAt: addDays(today, -(2 + index)),
        dueAt: addDays(today, 28 + index),
        scheduledDate: addDays(today, 21 + index),
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: null,
        edgeCases: ["unassigned"],
      }),
    );
  }

  /* 5 jobs with no status change for 14+ days. */
  for (let index = 0; index < 5; index += 1) {
    jobs.push(
      nextJob({
        status: ["On hold", "Awaiting parts", "No access", "Quote required", "Awaiting approval"][index],
        raisedAt: addDays(today, -(40 + index)),
        dueAt: addDays(today, 60),
        scheduledDate: addDays(today, 30),
        lastStatusChangeAt: addDays(today, -(14 + index * 2)),
        assignee: engineerNames[index % engineerNames.length],
        edgeCases: ["stale"],
      }),
    );
  }

  /* 3 jobs with a status deliberately not in `job_status_map`. */
  UNMAPPED_JOB_STATUSES.forEach((status, index) => {
    jobs.push(
      nextJob({
        status,
        statusIsMapped: false,
        raisedAt: addDays(today, -(5 + index)),
        dueAt: addDays(today, 20 + index),
        scheduledDate: addDays(today, 10 + index),
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: engineerNames[index % engineerNames.length],
        edgeCases: ["unmapped-status"],
      }),
    );
  });

  /*
   * 4 jobs whose scheduled date and SLA deadline fall on DIFFERENT DAYS in the
   * SAME WEEK — the case the calendar draws a connector line for. Tuesday and
   * Thursday of four consecutive future weeks, computed from the Monday so the
   * pair cannot straddle a week boundary whatever day `today` is.
   */
  for (let index = 0; index < 4; index += 1) {
    const monday = mondayOfWeek(addDays(today, 21 + index * 7));
    jobs.push(
      nextJob({
        status: ["Scheduled", "Booked", "Scheduled", "Booked"][index],
        raisedAt: addDays(today, -6),
        dueAt: addDays(monday, 3),
        scheduledDate: addDays(monday, 1),
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: engineerNames[index % engineerNames.length],
        edgeCases: ["same-week-split"],
      }),
    );
  }

  /* 3 jobs spanning a month boundary — raised before it, due after it. */
  const monthBoundary = firstOfNextMonth(today);
  for (let index = 0; index < 3; index += 1) {
    jobs.push(
      nextJob({
        status: ["Scheduled", "Booked", "In progress"][index],
        raisedAt: addDays(today, -10),
        dueAt: addDays(monthBoundary, 5),
        scheduledDate: addDays(monthBoundary, index - 1),
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: engineerNames[index % engineerNames.length],
        edgeCases: ["month-boundary"],
      }),
    );
  }

  /*
   * 2 jobs on the next 29 February, and 2 either side of the October clock
   * change.
   *
   * §3.4 phrases these as one line of two jobs. Read literally that is one job
   * for the leap day and one for a clock change that has two sides, so it is
   * built as two pairs: the leap day is a date that does not exist in three
   * years out of four, and the clock change is where a local-time subtraction
   * returns 0.958333 of a day and rounds a 90 into an 89. Both are date
   * arithmetic, and both need a row on either side to be worth anything.
   */
  const leapDay = nextLeapDay(today);
  for (let index = 0; index < 2; index += 1) {
    jobs.push(
      nextJob({
        status: ["Scheduled", "Booked"][index],
        raisedAt: addDays(today, -2),
        dueAt: addDays(leapDay, 3),
        scheduledDate: leapDay,
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: engineerNames[index % engineerNames.length],
        edgeCases: ["leap-day"],
      }),
    );
  }

  const clockChange = nextOctoberClockChange(today);
  for (let index = 0; index < 2; index += 1) {
    jobs.push(
      nextJob({
        status: ["Scheduled", "Booked"][index],
        raisedAt: addDays(today, -3),
        dueAt: addDays(clockChange, 7),
        scheduledDate: addDays(clockChange, index === 0 ? -1 : 1),
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: engineerNames[index % engineerNames.length],
        edgeCases: ["clock-change"],
      }),
    );
  }

  /*
   * The baseline fill, to 180.
   *
   * Round-robin over the twelve mapped statuses, so every one of them holds far
   * more than §3.4's "at least 5" without a distribution that has to be
   * checked. The date arithmetic is constrained rather than random:
   *
   *  · an OPEN baseline job is raised within 90 days and given 40-180 days of
   *    remaining window, so the smallest possible ratio is 40/130 = 30.7% and
   *    no baseline row can drift into the 25% bucket or past its deadline. The
   *    six breached jobs and the four at a quarter remaining stay exactly six
   *    and exactly four, which is what makes them assertable;
   *  · every open baseline job has a scheduled date, so the unscheduled tray
   *    holds exactly the eight §3.4 asked for;
   *  · an open baseline job's last status change is within 13 days, so the five
   *    stale jobs stay exactly five however long ago the job was raised. An old
   *    job that is still being worked is realistic; an old job nobody has
   *    touched is the fixture, and the two must not be confused;
   *  · a CLOSED job is spread across the full 18 months §3.2 asks for, since
   *    nothing measures it against today.
   */
  const statusOrder = MAPPED_JOB_STATUSES.map((entry) => entry.label);
  const closedStatuses = new Set(
    MAPPED_JOB_STATUSES.filter((entry) => !entry.countsAsOpen).map((entry) => entry.label),
  );
  const targetJobs = 180;
  for (let index = 0; jobs.length < targetJobs; index += 1) {
    const status = statusOrder[index % statusOrder.length];
    if (closedStatuses.has(status)) {
      const age = intBetween(rng, 30, 540);
      const raisedAt = addDays(today, -age);
      const duration = intBetween(rng, 1, Math.min(45, age));
      const closedOn = addDays(raisedAt, duration);
      jobs.push(
        nextJob({
          status,
          raisedAt,
          dueAt: addDays(raisedAt, intBetween(rng, 7, 60)),
          scheduledDate: addDays(raisedAt, intBetween(rng, 0, duration)),
          completedAt: status === "Completed" ? closedOn : null,
          lastStatusChangeAt: closedOn,
          assignee: engineerNames[index % engineerNames.length],
        }),
      );
      continue;
    }
    const age = intBetween(rng, 0, 90);
    const remaining = intBetween(rng, 40, 180);
    jobs.push(
      nextJob({
        status,
        raisedAt: addDays(today, -age),
        dueAt: addDays(today, remaining),
        scheduledDate: addDays(today, intBetween(rng, 1, remaining - 1)),
        lastStatusChangeAt: addDays(today, -intBetween(rng, 0, 13)),
        assignee: engineerNames[index % engineerNames.length],
      }),
    );
  }

  /* -- calendar items ---------------------------------------------------- */

  const notes: SeedCalendarItem[] = [];
  for (let index = 0; index < 25; index += 1) {
    const startsOn = addDays(today, intBetween(rng, -60, 60));
    const spans = rng() < 0.3;
    notes.push({
      ...mark,
      id: `${SEED_ID_PREFIX}note-${pad(index + 1, 2)}`,
      storeId: stores[index % stores.length].id,
      category: "Note",
      title: NOTE_TITLES[index % NOTE_TITLES.length],
      notes: `Seeded note ${index + 1}. Not a real record.`,
      startsOn,
      endsOn: spans ? addDays(startsOn, intBetween(rng, 1, 4)) : null,
      assignedTo: null,
      contractorId: null,
      visitType: null,
    });
  }

  const plannedVisits: SeedCalendarItem[] = [];
  for (let index = 0; index < 30; index += 1) {
    const startsOn = addDays(today, intBetween(rng, -30, 90));
    plannedVisits.push({
      ...mark,
      id: `${SEED_ID_PREFIX}visit-${pad(index + 1, 2)}`,
      storeId: stores[index % stores.length].id,
      category: "Planned visit",
      title: `${VISIT_TYPES[index % VISIT_TYPES.length]} — ${stores[index % stores.length].name}`,
      notes: `Seeded visit ${index + 1}. Not a real record.`,
      startsOn,
      endsOn: null,
      assignedTo: engineerNames[index % engineerNames.length],
      contractorId: contractors[index % contractors.length].id,
      visitType: VISIT_TYPES[index % VISIT_TYPES.length],
    });
  }

  /* -- attachments ------------------------------------------------------- */

  const attachments: SeedAttachment[] = [];
  const attachmentPlan: readonly { subjectType: SeedAttachment["subjectType"]; count: number }[] = [
    { subjectType: "job", count: 20 },
    { subjectType: "certificate", count: 12 },
    { subjectType: "visit", count: 8 },
  ];
  for (const plan of attachmentPlan) {
    for (let index = 0; index < plan.count; index += 1) {
      const subjectId =
        plan.subjectType === "job"
          ? jobs[index % jobs.length].id
          : plan.subjectType === "certificate"
            ? certificates[index % certificates.length].id
            : plannedVisits[index % plannedVisits.length].id;
      const isPdf = plan.subjectType !== "job" || index % 2 === 0;
      attachments.push({
        ...mark,
        id: `${SEED_ID_PREFIX}file-${pad(attachments.length + 1, 2)}`,
        subjectType: plan.subjectType,
        subjectId,
        filename: `ZZ-DEMO-${plan.subjectType}-${pad(index + 1, 2)}.${isPdf ? "pdf" : "jpg"}`,
        mimeType: isPdf ? "application/pdf" : "image/jpeg",
        /* Comfortably under DIRECT_UPLOAD_LIMIT (900 KB), so the loader never
           needs the multipart route to place a fixture. */
        byteLength: intBetween(rng, 8, 400) * 1024,
        contentSeed: intBetween(rng, 1, 999_999),
      });
    }
  }

  return {
    version: SEED_DATASET_VERSION,
    seedBatchId,
    today,
    generator: "mulberry32/fnv1a32",
    stores,
    users,
    contacts,
    contractors,
    certificates,
    jobs,
    notes,
    plannedVisits,
    attachments,
    mandatoryCertificateTypes: MANDATORY_CERTIFICATE_TYPES,
    optionalCertificateTypes: OPTIONAL_CERTIFICATE_TYPES,
    jobStatusCatalogue: { mapped: MAPPED_JOB_STATUSES, unmapped: UNMAPPED_JOB_STATUSES },
    reminderSteps: REMINDER_STEPS,
    boundaryMatrix: CERTIFICATE_BOUNDARY_MATRIX,
  };
}
