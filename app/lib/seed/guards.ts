/**
 * THE TWO GUARDS THAT STAND BETWEEN A PURGE AND THE CLIENT'S 744 REAL JOBS.
 *
 * ── AN ARCHITECTURAL DEVIATION FROM MODULE 3, ON THE OWNER'S INSTRUCTION ───
 *
 * Module 3 §1 and §1.1 tell this build to create a SECOND Cloudflare D1
 * database and a second R2 bucket, so that seeded rows physically cannot reach
 * real ones, and to treat every other measure as "belt and braces". That is
 * good advice for a product deployed on D1. This one is not.
 *
 * The owner's instruction is explicit — "use the CURRENT architecture, do not
 * introduce D1/R2" — and the current architecture has no second binding to
 * split. The portal is written against the D1 INTERFACE, but deployed it is
 * Supabase Postgres in the `portal` schema, reached through `db/node-pg-d1.ts`
 * and `db/sqlite-to-postgres.ts`; locally it is Miniflare's SQLite. Creating a
 * `maintsupp-test` D1 database would produce a binding that nothing in the
 * deployed product reads, and the reassurance of "physically separate" would be
 * false in exactly the environment where it matters.
 *
 * So the layers Module 3 calls secondary are promoted to primary, and this file
 * is the last of them:
 *
 *   (a) every seeded row carries `is_seed = 1` and a `seed_batch_id`
 *       (the columns are already on `maintenance_requests`, `calendar_events`,
 *       `compliance_documents`, `sites`, `contractors` and `users`);
 *   (b) every seeded store is named `ZZ-DEMO — …`;
 *   (c) every seeded contact is `@example.com`, a reserved domain that cannot
 *       receive mail;
 *   (d) a purge passes TWO INDEPENDENT PRODUCTION GUARDS, below.
 *
 * Losing the physical boundary means the guards carry weight they would not
 * otherwise have to. They are therefore FAIL-CLOSED throughout: a check that
 * cannot establish the answer refuses, and silence is never taken for consent.
 *
 * ── WHY TWO CHECKS, AND WHY THEY CANNOT SEE EACH OTHER ─────────────────────
 *
 * §5 asks `seed:purge` to check the environment variable AND the database name,
 * "two independent checks, because one will eventually be misconfigured". That
 * is the whole design constraint, so independence is made STRUCTURAL rather
 * than merely intended: `PurgeEnvironment` has two disjoint halves, `vars` and
 * `database`, and each check is handed only its own half. Check 1 cannot read
 * the database identity; check 2 cannot read a variable. A single misconfigured
 * source can therefore never satisfy both, which is the property that makes the
 * pair worth more than either.
 *
 * The two sources are also set by different people at different times: `vars`
 * is the deployment platform's, `database` is whatever the connection actually
 * reached and asked. A copy-pasted preview configuration that still points at
 * the production pooler fails check 2 while check 1 looks fine — and that is
 * the specific accident this exists for.
 *
 * ── PURE ON PURPOSE ────────────────────────────────────────────────────────
 *
 * Nothing here reads `process.env`, opens a connection or runs a query. The
 * facts arrive as arguments, which is what lets the refusal be tested at every
 * edge without a database and without a deployment — the same reason
 * `certificateExpiryBand` takes `daysRemaining` instead of computing "today".
 */

/* -------------------------------------------------------------- the input -- */

/**
 * What the database said about itself when it was ASKED.
 *
 * `name` is `current_database()` on Postgres and the binding or file name on
 * Miniflare D1 — a value that came back over the connection, not one copied
 * out of a settings screen. The distinction matters: a variable saying
 * "staging" is a claim, and a database answering "maintsupp_prod" is a fact.
 */
export type DatabaseIdentity = {
  /** `current_database()`, or the D1 binding / sqlite file name. */
  readonly name?: string | null;
  /** The host the connection actually reached. */
  readonly host?: string | null;
  /** The schema in use. The portal's is `portal`. */
  readonly schema?: string | null;
  /** Which adapter answered. */
  readonly adapter?: "d1-sqlite" | "postgres" | null;
};

/**
 * The two halves, deliberately disjoint.
 *
 * They are separate fields rather than one flat bag so that the type system
 * records which check may read what. Flattening them would make it a one-line
 * mistake for a later edit to have the environment check fall back to the
 * database name, at which point there is one check wearing two hats.
 */
export type PurgeEnvironment = {
  /** The platform's variables. Check 1 reads ONLY this. */
  readonly vars?: Readonly<Record<string, string | undefined>>;
  /** What the database answered. Check 2 reads ONLY this. */
  readonly database?: DatabaseIdentity | null;
};

/* ------------------------------------------------------------- the output -- */

export type PurgeCheckName = "environment" | "database";

export type PurgeCheck = {
  readonly name: PurgeCheckName;
  readonly passed: boolean;
  /** The value the check actually read, quoted back in the refusal. */
  readonly observed: string;
  /** One sentence a human can act on. */
  readonly reason: string;
};

/**
 * A typed refusal, naming WHICH check failed.
 *
 * "Refused" with no reason sends an operator to read this file; "refused by the
 * database check, which read `maintsupp_prod`" sends them to the connection
 * string. `refusedBy` is a list because both can fail at once and hiding the
 * second one behind the first would have them fix it twice.
 */
export type PurgeDecision =
  | { readonly allowed: true; readonly checks: readonly PurgeCheck[] }
  | {
      readonly allowed: false;
      readonly refusedBy: readonly PurgeCheckName[];
      readonly reason: string;
      readonly checks: readonly PurgeCheck[];
    };

/* ------------------------------------------------------------ the markers -- */

/**
 * Words that mean production, and words that mean it does not.
 *
 * PRODUCTION IS TESTED FIRST AND WINS. An identity that says both — a
 * `preview-prod-mirror`, a `staging` host on the production project — is
 * treated as production, because the cost of the two readings is not symmetric:
 * one refuses a purge somebody has to run again, the other deletes the client's
 * estate.
 */
const PRODUCTION_MARKERS = ["production", "prod", "live"] as const;

const NON_PRODUCTION_MARKERS = [
  "preview",
  "staging",
  "stage",
  "development",
  "dev",
  "test",
  "demo",
  "sandbox",
  "local",
] as const;

function normalise(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** The production marker present in a value, or null. */
function productionMarkerIn(value: string): string | null {
  for (const marker of PRODUCTION_MARKERS) {
    if (value.includes(marker)) return marker;
  }
  return null;
}

/** The non-production marker present in a value, or null. */
function nonProductionMarkerIn(value: string): string | null {
  for (const marker of NON_PRODUCTION_MARKERS) {
    if (value.includes(marker)) return marker;
  }
  return null;
}

/* ------------------------------------------------------------- check one -- */

/**
 * The deployment marker.
 *
 * `ENVIRONMENT` first, then `VERCEL_ENV`, and NOTHING ELSE — in particular NOT
 * `NODE_ENV`, which is the trap this ordering exists to avoid. Every built
 * bundle in this repository runs with `NODE_ENV=production`, preview builds
 * included, so reading it here would refuse every legitimate purge and, worse,
 * would teach whoever hit that to add an override that then also covers the
 * real production case.
 *
 * An unset marker REFUSES. That is the whole point of a fail-closed guard: a
 * deployment that has not been told what it is has not been told it is safe,
 * and the failure mode of guessing is unrecoverable.
 */
function checkEnvironment(vars: Readonly<Record<string, string | undefined>>): PurgeCheck {
  const raw = vars["ENVIRONMENT"] ?? vars["VERCEL_ENV"];
  const value = normalise(raw);

  if (!value) {
    return {
      name: "environment",
      passed: false,
      observed: "(unset)",
      reason:
        "Neither ENVIRONMENT nor VERCEL_ENV is set. A deployment that has not " +
        "said what it is has not said it is safe to purge, so this refuses " +
        "rather than guessing. Set ENVIRONMENT=preview (or staging, " +
        "development, test) on the environment you intend to wipe.",
    };
  }

  const production = productionMarkerIn(value);
  if (production) {
    return {
      name: "environment",
      passed: false,
      observed: value,
      reason:
        `The deployment marker reads "${value}", which contains "${production}". ` +
        "A purge deletes every row carrying is_seed = 1 and will not be run " +
        "against production.",
    };
  }

  const nonProduction = nonProductionMarkerIn(value);
  if (!nonProduction) {
    return {
      name: "environment",
      passed: false,
      observed: value,
      reason:
        `The deployment marker reads "${value}", which this guard does not ` +
        "recognise as either production or not. An unrecognised marker is " +
        "treated as production. Use one of: " +
        NON_PRODUCTION_MARKERS.join(", ") +
        ".",
    };
  }

  return {
    name: "environment",
    passed: true,
    observed: value,
    reason: `The deployment marker reads "${value}", which is not production.`,
  };
}

/* ------------------------------------------------------------- check two -- */

/**
 * The database's own identity.
 *
 * Read from `name`, `host` and `schema` together, because a Supabase project
 * reference is opaque — `abcdefgh.pooler.supabase.com/postgres` names nothing a
 * human or this function can classify — and the operator's own naming is
 * usually on one of the three. An identity that carries no marker at all is
 * REFUSED, not waved through: "I could not tell" and "it is safe" are different
 * answers and only one of them is true.
 *
 * `d1-sqlite` passes on the adapter alone. That adapter is Miniflare's local
 * file in `.wrangler/`; no deployed instance of this product uses it, because
 * every deployment goes through `db/node-pg-d1.ts`. Somebody who has restored a
 * copy of live data into a local sqlite file is protected by check 1 instead,
 * which is exactly why there are two.
 */
function checkDatabase(identity: DatabaseIdentity | null | undefined): PurgeCheck {
  if (!identity) {
    return {
      name: "database",
      passed: false,
      observed: "(no identity)",
      reason:
        "The database was not asked who it is. Query current_database() (or " +
        "read the D1 binding name) and pass it in — this check exists " +
        "precisely so that a purge does not depend on a variable somebody " +
        "copied.",
    };
  }

  const adapter = normalise(identity.adapter);
  const name = normalise(identity.name);
  const host = normalise(identity.host);
  const schema = normalise(identity.schema);
  const identityText = [name, host, schema].filter(Boolean).join(" ");
  const observed = identityText
    ? `${identityText}${adapter ? ` (${adapter})` : ""}`
    : adapter || "(empty)";

  /*
   * Production is looked for FIRST and in the whole identity, so a
   * `maintsupp-prod` database reached from a host somebody labelled `staging`
   * still refuses.
   */
  const production = productionMarkerIn(identityText);
  if (production) {
    return {
      name: "database",
      passed: false,
      observed,
      reason:
        `The database identifies itself as "${identityText}", which contains ` +
        `"${production}". This is the client's live estate; a purge will not ` +
        "be run against it.",
    };
  }

  if (adapter === "d1-sqlite") {
    return {
      name: "database",
      passed: true,
      observed,
      reason:
        "The local Miniflare D1 adapter answered. No deployed instance of this " +
        "product uses it — every deployment goes through the Postgres adapter.",
    };
  }

  const nonProduction = nonProductionMarkerIn(identityText);
  if (!nonProduction) {
    return {
      name: "database",
      passed: false,
      observed,
      reason:
        `The database identifies itself as "${observed}", which says nothing ` +
        "about whether it is production. A Supabase project reference is " +
        "opaque, so name the database, the host or the schema with one of: " +
        NON_PRODUCTION_MARKERS.join(", ") +
        ". A database that cannot be identified is treated as production.",
    };
  }

  return {
    name: "database",
    passed: true,
    observed,
    reason: `The database identifies itself as "${identityText}", which is not production.`,
  };
}

/* --------------------------------------------------------- the decision -- */

/**
 * Whether `seed:purge` may run. BOTH checks must pass.
 *
 * Returns rather than throws, so the caller can print both refusals together
 * and so the decision can be rendered on the reconciliation page without a
 * try/catch around it. A caller that wants an exception can throw on
 * `allowed === false` — the reason is already a finished sentence.
 */
export function assertPurgeAllowed(env: PurgeEnvironment): PurgeDecision {
  const checks: readonly PurgeCheck[] = [
    checkEnvironment(env.vars ?? {}),
    checkDatabase(env.database),
  ];

  const refusedBy = checks.filter((check) => !check.passed).map((check) => check.name);
  if (refusedBy.length === 0) {
    return { allowed: true, checks };
  }

  return {
    allowed: false,
    refusedBy,
    reason: checks
      .filter((check) => !check.passed)
      .map((check) => `[${check.name}] ${check.reason}`)
      .join(" "),
    checks,
  };
}

/* -------------------------------------------------------- the kill switch -- */

export type EmailModeDecision =
  | { readonly safe: true; readonly mode: "sink" | "log"; readonly reason: string }
  | { readonly safe: false; readonly mode: string | null; readonly reason: string };

/**
 * Whether an outbound mode is safe to generate mail from SEEDED data in.
 *
 * Module 3 §2.1 requires that a build reading `EMAIL_MODE` as unset must FAIL
 * rather than fall back to `live`. This function is that requirement, expressed
 * where it can be enforced without endangering anything else: an unset mode is
 * refused outright.
 *
 * ── HOW THIS RELATES TO app/lib/notifications.ts, WHICH DIFFERS ────────────
 *
 * `emailMode()` in `app/lib/notifications.ts` DEFAULTS TO `sink` when the
 * variable is unset; it does not fail. Its header explains why, and the
 * reasoning is sound for that module: `sendNotification` is on the path that
 * saves a lead and is documented never to throw, so an unset variable there
 * would turn "nobody was emailed" into "the lead was lost".
 *
 * That satisfies the INTENT of §2.1 — an unset variable can never mean `live` —
 * and contradicts its LETTER, which asks the build to stop. The gap is real and
 * is not this file's to close: `tests/pre-w14-email-mode.test.mjs` pins
 * `return "sink";` deliberately, and changing it would break a test that is
 * protecting a genuine contract.
 *
 * What this function adds is the STRICT reading, for the one caller that should
 * have it: a seeding or purge entry point, which has no lead to lose and every
 * reason to stop. Call it at the top of the seed command, not on the send path.
 */
export function assertEmailModeSafe(mode: string | null | undefined): EmailModeDecision {
  const value = normalise(mode);

  if (!value) {
    return {
      safe: false,
      mode: null,
      reason:
        "EMAIL_MODE is unset. Module 3 §2.1 requires a build that reads it as " +
        "unset to fail rather than fall back to live. Seeded compliance data " +
        "generates reminder mail, so a seed run refuses until the mode is " +
        "stated: set EMAIL_MODE=sink or EMAIL_MODE=log.",
    };
  }

  if (value === "live") {
    return {
      safe: false,
      mode: "live",
      reason:
        "EMAIL_MODE=live. Seeded certificates fire the reminder cascade, and " +
        "in live mode those sends go to whatever address the seed named. Use " +
        "sink (one internal address, intended recipients listed in the body) " +
        "or log (nothing sent, every send recorded as suppressed).",
    };
  }

  if (value !== "sink" && value !== "log") {
    return {
      safe: false,
      mode: value,
      reason:
        `EMAIL_MODE="${value}" is not one of the three words. A typo is not a ` +
        "fourth behaviour — notifications.ts would read it as unset — so this " +
        "refuses rather than proceeding on a mode nobody chose.",
    };
  }

  return {
    safe: true,
    mode: value,
    reason:
      value === "sink"
        ? "EMAIL_MODE=sink — every send is redirected to one internal address."
        : "EMAIL_MODE=log — nothing is sent; every send is recorded as suppressed.",
  };
}
