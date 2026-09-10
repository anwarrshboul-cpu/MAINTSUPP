/**
 * `GET|POST /api/overview/contractor-aliases` — Contractors → Resolve names (§3.6).
 *
 * ── WHY THIS IS NOT UNDER `/api/dashboard` ────────────────────────────────
 *
 * `/api/dashboard/*` is READ-ONLY AGGREGATES — one guard, one failure arm, and
 * not one write between them. `/api/overview/*` is the Overview's three WRITE
 * tools and nothing else, so §8's promise ("no change to any job record as a
 * side effect of dashboard work, except the explicit, confirmed, reversible
 * actions in the contractor linking tool and the bulk site-assign view") is a
 * boundary a reviewer can see rather than one they have to trust.
 *
 * ── THE PROBLEM, MEASURED ─────────────────────────────────────────────────
 *
 * §3.6: "Today 12% of recorded cost names a contractor and only £83 resolves to
 * a contractor record… so contractor spend cannot be ranked, compared or
 * scored, and contractor scoring is something Maintsupp sells. Display alone
 * will not fix it."
 *
 * `app/lib/contractor-linking.ts` already finds the strings that resolve to no
 * record — that is `unlinkedContractorNames`, and this route calls it rather
 * than restating the query. What is added here is the second half: a similarity
 * function that proposes which record a string probably means, and four
 * actions that write the answer down.
 *
 * ── FOUR ACTIONS, ALL REVERSIBLE, NONE AUTOMATIC ──────────────────────────
 *
 *   link   — alias + backfill `contractor_id` on the jobs carrying that string
 *   create — a new contractor record from the string, then link
 *   ignore — this string is not a contractor we track; stop listing it
 *   unlink — the reverse of any of the above
 *
 * `mode` DEFAULTS TO `"preview"`. §3.6: "Never auto-links without confirmation
 * — a wrong merge quietly corrupts contractor scoring." A POST that forgets to
 * say what it wants therefore shows the jobs and the spend it would affect and
 * changes nothing, which is the same default `sites/csv` takes with `dryRun`.
 *
 * ── WHAT A LINK WRITES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────
 *
 * It writes `contractor_name_aliases` and sets `maintenance_requests.contractor_id`
 * on jobs where that column is NULL. It does NOT touch `updated_at`, and that is
 * a decision rather than an omission: `loadStuckWork` falls back to `updated_at`
 * for §2.4's "Held for", so bumping it would silently reset the ageing readout
 * on every job an operator tidied the attribution of. Fixing who did the work
 * must not restate when the work last moved. Not touching it also makes `unlink`
 * an exact reversal rather than an approximate one.
 *
 * It also never overwrites an existing `contractor_id`. A job that already names
 * a record was attributed by somebody or something else, and a bulk linking tool
 * is the wrong instrument for changing that.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../../db/init";
import {
  activityLog,
  contractorNameAliases,
  contractors,
  maintenanceRequests,
} from "../../../../db/schema";
import { auditActor, recordAudit } from "../../../lib/audit";
import {
  contractorNameKey,
  unlinkedContractorNames,
} from "../../../lib/contractor-linking";
import { liveWorkOrderCondition } from "../../../lib/dashboard-filters";
import { can, resolvePermissions } from "../../../lib/permissions";
import { chunkIds } from "../../../lib/sql-batching";
import {
  anonymousRefusal,
  busyRefusal,
  scopedDbWithCapability,
  type ScopedDatabase,
} from "../../../lib/tenant-db";

export const dynamic = "force-dynamic";

/* ovt:similarity:start
 *
 * CASE- AND PUNCTUATION-INSENSITIVE FUZZY MATCHING — §3.6's "UK safety" →
 * "UK Safety Ltd" and "Taskrabbit" → "TaskRabbit".
 *
 * Everything between the two markers is self-contained on purpose: it imports
 * nothing, so `tests/overview-tools.test.mjs` can slice this block out of the
 * file, transpile it and exercise it without booting drizzle, the database or
 * the router. A similarity function that cannot be tested in isolation is one
 * whose threshold gets tuned by guesswork, and the cost of guessing wrong here
 * is a wrong merge that quietly corrupts contractor scoring.
 *
 * TWO measures, averaged, because each one alone fails a case the other
 * catches:
 *
 *   · TOKEN overlap answers "UK safety" vs "UK Safety Ltd" — identical word
 *     sets once the legal suffix is dropped — but scores "Taskrabbit" against
 *     "TaskRabbit" purely on the normalisation, and scores two names that share
 *     one common word ("John" vs "John Smith Plumbing") far too generously;
 *   · TRIGRAM Dice answers spelling drift and word-order changes, but rates a
 *     short string against a long one poorly even when the short one is exactly
 *     the long one's distinguishing part.
 *
 * Averaged, "John" vs "John Smith Plumbing" MEASURES 0.45 — token overlap 0.5,
 * trigram Dice 0.4 — and the threshold sits above it, because that pairing is a
 * refusal and not a proposal: linking them would credit one man's invoices to a
 * company. Nothing here ever links on its own; a proposal is a suggestion an
 * operator confirms, and the threshold only decides what is worth showing.
 */

/** Legal forms only. Never a descriptive word: "Services" distinguishes real firms. */
const LEGAL_SUFFIX = new Set([
  "ltd",
  "limited",
  "llp",
  "llc",
  "plc",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "gmbh",
  "bv",
  "srl",
  "sarl",
  "pty",
  "co",
]);

/**
 * Lower-cased, punctuation stripped, whitespace collapsed, legal suffix dropped.
 *
 * `&` becomes "and" before punctuation goes, so "M & S" and "M and S" are one
 * name rather than "m s" and "m and s".
 */
export function normaliseForMatch(value: string | null | undefined): string {
  const flattened = (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!flattened) return "";
  const words = flattened.split(" ").filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIX.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/** Padded 3-grams, the way `pg_trgm` builds them, so word starts count twice. */
export function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    grams.add(padded.slice(index, index + 3));
  }
  return grams;
}

/** Sørensen–Dice over two sets. 1 for two empties, 0 when one side is empty. */
export function diceCoefficient(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * 0 to 1. Identical after normalisation is 1; nothing in common is 0.
 *
 * `SIMILARITY_THRESHOLD` is what turns a score into a proposal. It is exported
 * so the test pins the two examples §3.6 names ABOVE it and a genuine non-match
 * below it, rather than pinning a number nobody can justify.
 *
 * 0.55 rather than 0.45, and the difference is measured rather than felt: at
 * 0.45 the "John" / "John Smith Plumbing" pairing landed EXACTLY on the line and
 * would have been proposed. Real near-misses stay well clear —
 * "Omega Fire" against "Omega Fire and Security" is 0.67, "UK safety" against
 * "UK Safety Services" is 0.76, and any pair identical but for a legal suffix
 * is 1.
 */
export const SIMILARITY_THRESHOLD = 0.55;

export function nameSimilarity(left: string, right: string): number {
  const a = normaliseForMatch(left);
  const b = normaliseForMatch(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const tokens = diceCoefficient(new Set(a.split(" ")), new Set(b.split(" ")));
  const grams = diceCoefficient(trigrams(a), trigrams(b));
  return (tokens + grams) / 2;
}
/* ovt:similarity:end */

/* ── Reading ──────────────────────────────────────────────────────────────── */

/** The prefix an ignored string is filed under in `activity_log`. */
const IGNORE_ENTITY = "contractor_name";
const IGNORED = "contractor_name.ignored";
const UNIGNORED = "contractor_name.unignored";
const LINKED = "contractor_name.linked";
const UNLINKED = "contractor_name.unlinked";

/**
 * WHICH STRINGS AN OPERATOR HAS DISMISSED, DERIVED FROM THE ACTIVITY LOG.
 *
 * There is no `contractor_name_ignores` table and this work is not allowed to
 * add one — schema lives in `db/init.ts` and `db/schema.ts`, which belong to
 * another change. The log is nevertheless a sound place for this: it is already
 * organisation-scoped, already indexed on `(entity_type, entity_id)`, and an
 * ignore is by nature an event rather than a fact. The newest event for a name
 * wins, so ignoring and un-ignoring are both ordinary appends and the history of
 * who dismissed what survives.
 *
 * RECOMMENDATION nonetheless: a real table would let this be one indexed read
 * instead of a scan of two action types. Noted for whoever owns the schema.
 */
async function readIgnored(
  scope: ScopedDatabase,
): Promise<Map<string, { at: string; by: string | null }>> {
  const rows = await scope.db
    .select({
      entityId: activityLog.entityId,
      action: activityLog.action,
      actorEmail: activityLog.actorEmail,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.organisationId, scope.orgId),
        eq(activityLog.entityType, IGNORE_ENTITY),
        inArray(activityLog.action, [IGNORED, UNIGNORED]),
      ),
    )
    .orderBy(activityLog.createdAt);

  const state = new Map<string, { at: string; by: string | null }>();
  for (const row of rows) {
    const key = (row.entityId ?? "").replace(/^name:/, "");
    if (!key) continue;
    if (row.action === IGNORED) state.set(key, { at: row.createdAt, by: row.actorEmail });
    else state.delete(key);
  }
  return state;
}

type JobRow = { id: string; contractor: string | null; cost: number | null; contractorId: string | null };

/**
 * Every live job that names a contractor in free text.
 *
 * Read whole — three narrow columns — and matched in JavaScript, because the
 * comparison key is `contractorNameKey`: trimmed, lower-cased, INTERNAL
 * whitespace collapsed. No portable SQL expression collapses internal
 * whitespace, and the dialect rules here forbid the ones that come close. The
 * alternative — matching on `lower(trim(contractor))` — would agree with
 * `contractor-attribution.ts` on almost every row and disagree on exactly the
 * rows this tool exists to fix, which is the worst possible place to be
 * approximately right.
 *
 * Bounded: one row per live work order (776 on the largest estate), three
 * columns, on an action an operator initiated.
 */
async function readNamedJobs(scope: ScopedDatabase): Promise<JobRow[]> {
  return scope.db
    .select({
      id: maintenanceRequests.id,
      contractor: maintenanceRequests.contractor,
      cost: maintenanceRequests.cost,
      contractorId: maintenanceRequests.contractorId,
    })
    .from(maintenanceRequests)
    .where(
      and(
        liveWorkOrderCondition(scope.orgId),
        sql`${maintenanceRequests.contractor} is not null and trim(${maintenanceRequests.contractor}) <> ''`,
      ),
    );
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const guarded = await scopedDbWithCapability(request, "board.view");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const [unlinked, register, aliasRows, ignored, namedJobs, subject] = await Promise.all([
      unlinkedContractorNames(scope.db, scope.orgId),
      scope.db
        .select({ id: contractors.id, name: contractors.name })
        .from(contractors)
        .where(eq(contractors.organisationId, scope.orgId)),
      scope.db
        .select({
          id: contractorNameAliases.id,
          alias: contractorNameAliases.alias,
          normalised: contractorNameAliases.normalised,
          contractorId: contractorNameAliases.contractorId,
          createdAt: contractorNameAliases.createdAt,
          createdBy: contractorNameAliases.createdBy,
        })
        .from(contractorNameAliases)
        .where(eq(contractorNameAliases.organisationId, scope.orgId)),
      readIgnored(scope),
      readNamedJobs(scope),
      resolvePermissions(scope.db, scope.orgId, scope.actor.role),
    ]);

    const contractorName = new Map(register.map((row) => [row.id, row.name]));
    const aliasByKey = new Map(aliasRows.map((row) => [row.normalised, row]));

    /*
     * ATTRIBUTION, BEFORE AND AFTER — §3.6 asks for the percentage to be
     * reported. Three different questions and three different denominators, so
     * all three numbers travel and the screen never prints a percentage whose
     * denominator the reader cannot see (§1.4).
     */
    const uniqueRegisterName = new Map<string, string[]>();
    for (const row of register) {
      const key = contractorNameKey(row.name);
      const list = uniqueRegisterName.get(key);
      if (list) list.push(row.id);
      else uniqueRegisterName.set(key, [row.id]);
    }
    let namedSpend = 0;
    let attributedSpend = 0;
    const spendByKey = new Map<string, number>();
    const jobsByKey = new Map<string, number>();
    for (const job of namedJobs) {
      const spend = Number(job.cost ?? 0);
      namedSpend += spend;
      const key = contractorNameKey(job.contractor);
      spendByKey.set(key, (spendByKey.get(key) ?? 0) + spend);
      jobsByKey.set(key, (jobsByKey.get(key) ?? 0) + 1);
      const byId = Boolean(job.contractorId);
      const byAlias = aliasByKey.has(key);
      const byName = (uniqueRegisterName.get(key) ?? []).length === 1;
      if (byId || byAlias || byName) attributedSpend += spend;
    }

    const names = unlinked.names
      .map((row) => ({
        ...row,
        ignored: ignored.has(row.key),
        ignoredAt: ignored.get(row.key)?.at ?? null,
        suggestions: register
          .map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            score: Number(nameSimilarity(row.name, candidate.name).toFixed(3)),
          }))
          .filter((candidate) => candidate.score >= SIMILARITY_THRESHOLD)
          .sort((left, right) => right.score - left.score)
          .slice(0, 4),
      }))
      /* Highest spend first — §3.6. An operator fixing attribution should meet
         the £4,000 string before the £12 one. */
      .sort((left, right) => right.spend - left.spend || right.jobs - left.jobs);

    return Response.json({
      names,
      aliases: aliasRows
        .map((row) => ({
          id: row.id,
          alias: row.alias,
          normalised: row.normalised,
          contractorId: row.contractorId,
          contractorName: contractorName.get(row.contractorId) ?? "(removed)",
          jobs: jobsByKey.get(row.normalised) ?? 0,
          spend: spendByKey.get(row.normalised) ?? 0,
          createdAt: row.createdAt,
          createdBy: row.createdBy,
        }))
        .sort((left, right) => right.spend - left.spend),
      contractors: register.sort((left, right) => left.name.localeCompare(right.name)),
      totals: {
        totalSpend: unlinked.totalSpend,
        namedSpend,
        attributedSpend,
        unlinkedSpend: unlinked.unlinkedSpend,
        distinctUnlinked: names.filter((row) => !row.ignored).length,
      },
      canEdit: can(subject, "settings.edit"),
    });
  } catch (error) {
    return failure(error, "The contractor names could not be read.");
  }
}

/* ── Writing ──────────────────────────────────────────────────────────────── */

type Action = "link" | "create" | "ignore" | "unlink";

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

function readText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** The jobs one action would touch, with the spend they carry. */
function affected(jobs: JobRow[], key: string, onlyUnattributed: boolean) {
  const rows = jobs.filter(
    (job) =>
      contractorNameKey(job.contractor) === key &&
      (onlyUnattributed ? job.contractorId === null : true),
  );
  return {
    ids: rows.map((row) => row.id),
    jobs: rows.length,
    spend: rows.reduce((sum, row) => sum + Number(row.cost ?? 0), 0),
  };
}

/**
 * The job ids a previous `link` actually changed, out of its own log entry.
 *
 * This is what makes `unlink` an EXACT reversal rather than a best guess. A job
 * that already carried this contractor's id before the link was skipped by the
 * backfill, so clearing it on the way back would destroy an attribution this
 * tool never made. Reading the ids back is the only way to tell the two apart.
 *
 * A missing entry — an alias written before this route existed — falls back to
 * "every job whose name matches and whose id is this contractor's", which is
 * the best available answer and is reported as such in the response.
 */
async function idsFromLastLink(
  scope: ScopedDatabase,
  key: string,
): Promise<string[] | null> {
  const rows = await scope.db
    .select({ action: activityLog.action, detail: activityLog.detail })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.organisationId, scope.orgId),
        eq(activityLog.entityType, IGNORE_ENTITY),
        eq(activityLog.entityId, `name:${key}`),
        inArray(activityLog.action, [LINKED, UNLINKED]),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || row.action !== LINKED || !row.detail) return null;
  try {
    const parsed = JSON.parse(row.detail) as { jobIds?: unknown };
    return Array.isArray(parsed.jobIds) ? parsed.jobIds.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

/**
 * `contractor_id`, written in chunks.
 *
 * D1 binds one variable per element of an `IN` list and refuses a statement past
 * roughly a hundred of them (`app/lib/sql-batching.ts`). The two set values and
 * the organisation take three of the budget, so the ids get 80 and not 90 —
 * `chunkIds`'s default is sized for a bare `IN` list and this statement is not
 * one. Sequential, because D1 serialises on one connection anyway.
 */
const BACKFILL_CHUNK = 80;

async function writeContractorId(
  scope: ScopedDatabase,
  ids: string[],
  contractorId: string | null,
  guard: { onlyNull?: boolean; onlyContractorId?: string } = {},
): Promise<number> {
  let written = 0;
  for (const chunk of chunkIds(ids, BACKFILL_CHUNK)) {
    const clauses = [
      eq(maintenanceRequests.organisationId, scope.orgId),
      inArray(maintenanceRequests.id, chunk),
    ];
    if (guard.onlyNull) clauses.push(isNull(maintenanceRequests.contractorId));
    if (guard.onlyContractorId) {
      clauses.push(eq(maintenanceRequests.contractorId, guard.onlyContractorId));
    }
    /* `updated_at` is deliberately not set. See the module header. */
    const rows = await scope.db
      .update(maintenanceRequests)
      .set({ contractorId })
      .where(and(...clauses))
      .returning({ id: maintenanceRequests.id });
    written += rows.length;
  }
  return written;
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guarded = await scopedDbWithCapability(request, "settings.edit");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const action = readText(body.action, 20) as Action;
    if (!["link", "create", "ignore", "unlink"].includes(action)) {
      return badRequest('`action` must be "link", "create", "ignore" or "unlink".');
    }
    const name = readText(body.name, 160);
    if (!name) return badRequest("Name the contractor string to resolve.");
    const key = contractorNameKey(name);
    if (!key) return badRequest("That name is blank once punctuation is removed.");

    /* Preview unless told otherwise. §3.6: never auto-link without confirmation. */
    const apply = body.mode === "apply";
    const actor = scope.identityEmail.toLowerCase();
    const at = new Date().toISOString();

    const jobs = await readNamedJobs(scope);

    if (action === "ignore" || action === "unlink") {
      const existingAlias = (
        await scope.db
          .select({
            id: contractorNameAliases.id,
            contractorId: contractorNameAliases.contractorId,
            alias: contractorNameAliases.alias,
          })
          .from(contractorNameAliases)
          .where(
            and(
              eq(contractorNameAliases.organisationId, scope.orgId),
              eq(contractorNameAliases.normalised, key),
            ),
          )
      )[0];

      if (action === "ignore") {
        const scope_ = affected(jobs, key, false);
        if (!apply) {
          return Response.json({
            mode: "preview",
            action,
            name,
            jobs: scope_.jobs,
            spend: scope_.spend,
            willChange: "Nothing. The string stops being listed; no job is touched.",
            sample: sample(jobs, key),
          });
        }
        await logActivity(scope, key, IGNORED, at, actor, { name, jobs: scope_.jobs });
        await recordAudit({
          db: scope.db,
          organisationId: scope.orgId,
          actor: auditActor(scope),
          action: "contractor.name_ignored",
          entityType: IGNORE_ENTITY,
          entityId: `name:${key}`,
          summary: `Dismissed the contractor name "${name}" — ${scope_.jobs} job(s).`,
          detail: { name, key, jobs: scope_.jobs, spend: scope_.spend },
          request,
        });
        return Response.json({
          ok: true,
          action,
          name,
          jobsChanged: 0,
          spend: scope_.spend,
          reverse: { action: "unlink", name },
        });
      }

      /* unlink — the reversal of link, create, or ignore. */
      const recorded = await idsFromLastLink(scope, key);
      const exact = recorded !== null;
      const target = existingAlias
        ? exact
          ? recorded
          : affected(jobs, key, false).ids.filter(
              (id) =>
                jobs.find((job) => job.id === id)?.contractorId === existingAlias.contractorId,
            )
        : [];
      const spend = target.reduce(
        (sum, id) => sum + Number(jobs.find((job) => job.id === id)?.cost ?? 0),
        0,
      );

      if (!apply) {
        return Response.json({
          mode: "preview",
          action,
          name,
          jobs: target.length,
          spend,
          exactReversal: exact,
          willChange: existingAlias
            ? `Clears the alias and puts contractor_id back to empty on ${target.length} job(s).`
            : "Stops this string being dismissed. No job is touched.",
          sample: sample(jobs, key),
        });
      }

      let cleared = 0;
      if (existingAlias && target.length) {
        cleared = await writeContractorId(scope, target, null, {
          onlyContractorId: existingAlias.contractorId,
        });
      }
      if (existingAlias) {
        await scope.db
          .delete(contractorNameAliases)
          .where(
            and(
              eq(contractorNameAliases.organisationId, scope.orgId),
              eq(contractorNameAliases.id, existingAlias.id),
            ),
          );
      }
      await logActivity(scope, key, existingAlias ? UNLINKED : UNIGNORED, at, actor, {
        name,
        contractorId: existingAlias?.contractorId ?? null,
        cleared,
        exactReversal: exact,
      });
      await recordAudit({
        db: scope.db,
        organisationId: scope.orgId,
        actor: auditActor(scope),
        action: existingAlias ? "contractor.name_unlinked" : "contractor.name_unignored",
        entityType: IGNORE_ENTITY,
        entityId: `name:${key}`,
        summary: existingAlias
          ? `Unlinked "${name}" — cleared contractor_id on ${cleared} job(s).`
          : `Restored the contractor name "${name}" to the unresolved list.`,
        detail: { name, key, cleared, contractorId: existingAlias?.contractorId ?? null, exactReversal: exact },
        request,
      });
      return Response.json({
        ok: true,
        action,
        name,
        jobsChanged: cleared,
        spend,
        exactReversal: exact,
        reverse: existingAlias
          ? { action: "link", name, contractorId: existingAlias.contractorId }
          : { action: "ignore", name },
      });
    }

    /* link / create — both end in an alias plus a backfill. */
    let contractorId = readText(body.contractorId, 120);
    let contractorLabel = "";

    if (action === "create") {
      const existing = (
        await scope.db
          .select({ id: contractors.id, name: contractors.name })
          .from(contractors)
          .where(eq(contractors.organisationId, scope.orgId))
      ).find((row) => contractorNameKey(row.name) === key);
      if (existing) {
        return badRequest(
          `"${existing.name}" is already in the register. Link to it instead of creating a second record.`,
        );
      }
      contractorLabel = name;
    } else {
      if (!contractorId) return badRequest("Name the contractor record to link to.");
      /* A FOREIGN KEY IS NOT A TENANT CHECK. The id came from a request body,
         so it is re-read against this organisation before anything is written. */
      const found = (
        await scope.db
          .select({ id: contractors.id, name: contractors.name })
          .from(contractors)
          .where(
            and(
              eq(contractors.organisationId, scope.orgId),
              eq(contractors.id, contractorId),
            ),
          )
      )[0];
      if (!found) return badRequest("That contractor does not belong to this workspace.");
      contractorLabel = found.name;
    }

    const target = affected(jobs, key, true);
    const alreadyAttributed = affected(jobs, key, false).jobs - target.jobs;

    if (!apply) {
      return Response.json({
        mode: "preview",
        action,
        name,
        contractorId: action === "create" ? null : contractorId,
        contractorName: contractorLabel,
        jobs: target.jobs,
        spend: target.spend,
        alreadyAttributed,
        willChange:
          action === "create"
            ? `Creates the contractor "${name}", then attributes ${target.jobs} job(s) and ${
                Math.round(target.spend * 100) / 100
              } of spend to it.`
            : `Attributes ${target.jobs} job(s) and ${
                Math.round(target.spend * 100) / 100
              } of spend to ${contractorLabel}.`,
        sample: sample(jobs, key),
      });
    }

    if (action === "create") {
      contractorId = crypto.randomUUID();
      await scope.db.insert(contractors).values({
        id: contractorId,
        organisationId: scope.orgId,
        name,
        active: true,
        createdAt: at,
        updatedAt: at,
      });
    }

    /*
     * ONE JOB-SIDE NAME RESOLVES TO AT MOST ONE RECORD, EVER — the UNIQUE index
     * on (organisation, normalised) says so, and this does not defeat it. A
     * re-link updates the row in place rather than inserting a second one.
     */
    const existingAlias = (
      await scope.db
        .select({ id: contractorNameAliases.id })
        .from(contractorNameAliases)
        .where(
          and(
            eq(contractorNameAliases.organisationId, scope.orgId),
            eq(contractorNameAliases.normalised, key),
          ),
        )
    )[0];
    if (existingAlias) {
      await scope.db
        .update(contractorNameAliases)
        .set({ contractorId, alias: name, createdBy: actor, createdAt: at })
        .where(
          and(
            eq(contractorNameAliases.organisationId, scope.orgId),
            eq(contractorNameAliases.id, existingAlias.id),
          ),
        );
    } else {
      await scope.db.insert(contractorNameAliases).values({
        id: crypto.randomUUID(),
        organisationId: scope.orgId,
        contractorId,
        alias: name,
        normalised: key,
        createdAt: at,
        createdBy: actor,
      });
    }

    const written = await writeContractorId(scope, target.ids, contractorId, { onlyNull: true });

    /* The ids are the reversal record — see `idsFromLastLink`. Capped so a very
       large link cannot write an unreadable log line; the cap is reported. */
    const recorded = target.ids.slice(0, 500);
    await logActivity(scope, key, LINKED, at, actor, {
      name,
      contractorId,
      contractorName: contractorLabel,
      created: action === "create",
      jobsChanged: written,
      jobIds: recorded,
      truncated: target.ids.length > recorded.length,
    });
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: action === "create" ? "contractor.created_from_name" : "contractor.name_linked",
      entityType: "contractor",
      entityId: contractorId,
      summary: `Linked the contractor name "${name}" to ${contractorLabel} — ${written} job(s) attributed.`,
      detail: {
        name,
        key,
        contractorId,
        contractorName: contractorLabel,
        jobsChanged: written,
        spend: target.spend,
        created: action === "create",
      },
      request,
    });

    return Response.json({
      ok: true,
      action,
      name,
      contractorId,
      contractorName: contractorLabel,
      jobsChanged: written,
      spend: target.spend,
      alreadyAttributed,
      reverse: { action: "unlink", name },
    });
  } catch (error) {
    return failure(error, "That contractor name could not be resolved.");
  }
}

/** Up to six of the jobs an action names, so the preview shows work and not a number. */
function sample(jobs: JobRow[], key: string) {
  return jobs
    .filter((job) => contractorNameKey(job.contractor) === key)
    .slice(0, 6)
    .map((job) => ({ id: job.id, contractor: job.contractor, cost: job.cost, contractorId: job.contractorId }));
}

async function logActivity(
  scope: ScopedDatabase,
  key: string,
  action: string,
  at: string,
  actor: string,
  detail: Record<string, unknown>,
) {
  await scope.db.insert(activityLog).values({
    id: crypto.randomUUID(),
    organisationId: scope.orgId,
    entityType: IGNORE_ENTITY,
    entityId: `name:${key}`,
    action,
    actorEmail: actor,
    detail: JSON.stringify(detail),
    createdAt: at,
  });
}

/** See `/api/overview/meter-settings` — the same three arms, for the same reasons. */
function failure(error: unknown, consequence: string): Response {
  const anonymous = anonymousRefusal(error);
  if (anonymous) return anonymous;
  const busy = busyRefusal(error, consequence);
  if (busy) return busy;
  console.error("[/api/overview/contractor-aliases]", error);
  if (error instanceof Error && error.cause) {
    console.error("[/api/overview/contractor-aliases] cause:", error.cause);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json(
    {
      error:
        process.env.NODE_ENV === "development" ? `${consequence} ${message}` : consequence,
    },
    { status: 503 },
  );
}
