import { and, count, desc, eq, inArray, isNotNull, isNull, not, sql } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import {
  activityLog,
  attachments,
  complianceDocuments,
  contractorCertifications,
  contractors,
  maintenanceBoardColumns,
  maintenanceRequests,
  memberships,
  plannedMaintenance,
  sites,
  units,
  users,
  workspaceSettings,
} from "../../../db/schema";
// The one table of Store Documentation slots. The register keys off it too; a
// second copy here is how the calendar and the board would drift apart.
import { storeDocumentationCertificates } from "../../../db/monday-board-spec";
import {
  STORE_DOCUMENTATION_BOARD_ID,
  readComplianceRegister,
} from "../../lib/compliance-register";
/*
 * The "finished" vocabulary, taken from the browser's own copy of it.
 *
 * `dashboard-meters.ts` is where `isClosedRequest` builds the client-side
 * predicate out of these same two values, so this is one list read by two
 * languages rather than two lists that happen to agree — see
 * `completedJobPredicate` below.
 *
 * A route importing from `app/(app)/portal/` is unusual and is the deliberate
 * direction. That module has NO runtime imports of its own, by design: seven
 * test suites transpile it alone and load it from a `data:` URL, where any
 * relative specifier fails with `ERR_INVALID_URL`. Moving the vocabulary out to
 * a neutral `app/lib` module and importing it back into the meters was tried and
 * broke all of them, so the definition stays in the file that is already
 * checkable in isolation and the SQL comes to it. It is plain TypeScript —
 * no React, no hooks, no component — which is the property those suites rely on.
 */
import { COMPLETED_STAGE, completedStatuses } from "../../(app)/portal/dashboard-meters";
import { PRIMARY_ORGANISATION_ID, anonymousRefusal, scopedDb } from "../../lib/tenant-db";
import { getContractor, listContractors } from "../../lib/contractor-repository";
import {
  CANONICAL_REGISTER,
  registerScopeFilter,
  resolveRegisterScope,
  scopeRefusal,
  type RegisterScope,
} from "../../lib/register-scope";
import { sampleSeedingAllowed } from "../../lib/tenant-access";
import {
  maintenanceRequests as sampleRequests,
  stores as sampleStores,
} from "../../lib/mock-data";
import { dateOnlyValue, expiryStatus, isRealCalendarDate } from "../../lib/expiry-status";
/*
 * W06-06 and W06-09 — the two contractor vocabularies live in `option_values`,
 * not in a literal here.
 *
 * `contractor_trade` exists so an applicant filling in the public form and a
 * coordinator reading the register mean the same thing by "Glazing"; the eleven
 * trades are seeded from the form's own list. `contractor_payment_terms` is the
 * approved half of "payment details". Both are read the same way every other
 * controlled column on this platform is read — `app/api/sites/route.ts` calls
 * exactly this for `site_type` — so an admin can add a term in Settings without
 * a deploy and without either screen disagreeing about what is legal.
 */
import { listOptionValues } from "../../lib/options-repository";
/*
 * W05-07 — the site state rules. Both write paths into `sites` reconcile the
 * status/lifecycle/active trio through one function rather than each projecting
 * two of the columns out of the third; the long note lives with the rule.
 */
import {
  normaliseSiteLifecycle,
  reconcileSiteState,
  siteLifecycleRefusal,
} from "../../lib/site-state";
import type { ComplianceState, StoreRecord } from "../../lib/types";
import {
  defaultWorkspaceSettings,
  type WorkspaceActivity,
  type WorkspaceCertification,
  type WorkspaceComplianceRecord,
  type WorkspaceContractor,
  type WorkspaceEntity,
  type WorkspaceMember,
  type WorkspacePlannedItem,
  type WorkspaceSettings,
  type WorkspaceSnapshot,
  type WorkspaceUnit,
} from "../../lib/workspace-data";
import {
  type Capability,
  requireCapability,
  resolvePermissions,
} from "../../lib/permissions";
import type { WorkspaceRole } from "../../lib/workspace-actor";

function text(value: unknown, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max = 240) {
  const result = text(value, max);
  return result || null;
}

/* ── Text that is actually text ───────────────────────────────────────────── */

/*
 * Characters that are invisible on screen, and therefore invisible in review.
 *
 * Whitespace matching does not cover them. U+200B ZERO WIDTH SPACE is a format
 * character, not whitespace, so an address carrying one satisfies an email
 * shape check, prints in the register with the character absent, and bounces
 * every time anybody mails it with no visible reason why. The bidi overrides
 * are worse: they can make a stored value READ as a different value than the
 * one that will be used. Refusing them is the only way the operator ever finds
 * out they are there.
 *
 * This lived further down beside `contractorEmailRefusal`, its first caller. It
 * is up here now because it turned out not to be an email rule at all: the same
 * hole let a compliance requirement be named three zero-width spaces, which the
 * register then drew as a blank row nobody could search for, describe, or tell
 * apart from the row above it. One definition of "characters that are not
 * really there", shared by the address check and by `visibleText` below.
 */
const INVISIBLE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;

/** The same set, for stripping rather than detecting. `.replace` needs the flag. */
const INVISIBLE_CHARACTERS_GLOBAL = new RegExp(INVISIBLE_CHARACTERS.source, "g");

/**
 * `text()`, but a string of invisible characters counts as empty.
 *
 * WHY THIS EXISTS. `text()` is `value.trim().slice(0, max)`, and
 * `String.prototype.trim` strips whitespace as Unicode defines it — which does
 * NOT include the zero-width characters above. So a `kind` of three U+200B
 * spaces walked straight through `if (!text(data.kind, 120))`, and a compliance
 * requirement was created whose name rendered as nothing at all: an invisible
 * row in the register, un-findable by search, impossible to tell from the row
 * above it, and impossible to describe to support over the phone.
 *
 * The invisible characters are removed for the emptiness TEST and the cleaned
 * value is what gets stored, because a name that is partly invisible is a name
 * that cannot be typed back in by whoever has to find it later.
 */
function visibleText(value: unknown, max = 240) {
  if (typeof value !== "string") return "";
  return value.replace(INVISIBLE_CHARACTERS_GLOBAL, "").trim().slice(0, max);
}

/* ── The compliance vocabulary and the compliance date ───────────────────── */

/**
 * The five words a compliance row's state may be, and nothing else.
 *
 * `ComplianceState` (app/lib/types.ts) is a compile-time union, which does
 * nothing at all for a value arriving in a JSON body. This route used to take
 * `text(data.state, 40) || "Missing"` and write it straight into
 * `compliance_documents.status`, so the column accepted any string a caller
 * cared to send — and `notRequired` was then derived from it by an equality test
 * against one exact spelling, meaning "not required" or "Not Required" set the
 * status word while silently leaving the flag false.
 *
 * The list is the same one the register CRUD panel already offers in its own
 * select (app/(app)/portal/workspace-data-manager.tsx:171), so this enforces
 * what the UI has always assumed rather than narrowing anything a user can do.
 */
const COMPLIANCE_STATES: readonly ComplianceState[] = [
  "Compliant",
  "Expiring soon",
  "Expired",
  "Missing",
  "Not required",
];

function isComplianceState(value: string): value is ComplianceState {
  return (COMPLIANCE_STATES as readonly string[]).includes(value);
}

/**
 * A day rate, in pence.
 *
 * The form asks for pounds because that is what a rate card says, and the
 * column stores pence because that is what every other money column here
 * stores. An empty box is not a rate of zero — it means nobody has recorded
 * one — so it stays null and the register prints a dash rather than "£0.00",
 * which would read as "they work for free".
 */
function ratePence(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const pounds = Number(value);
  if (!Number.isFinite(pounds) || pounds < 0) return null;
  return Math.round(pounds * 100);
}

/**
 * A contractor's rating, or the absence of one.
 *
 * `rating` is the one number on this record that is somebody's OPINION, and
 * `numeric(value, 0, 0, 5)` had no way to say it had not been formed. The
 * manage form's empty box posts `""`, `Number("")` is `0`, and `0` is finite —
 * so an untouched field stored a flat **0 out of 5** against a contractor
 * nobody had assessed. The form's own default hid it by pre-filling `"4"`,
 * which is worse still: every contractor created through the UI was stored
 * rated four fifths by a person who never rated them, and both staging rows
 * carry exactly that 4.
 *
 * The column is nullable precisely so "not rated" can be said out loud. Empty,
 * absent, null and unparseable all become NULL — none of them are a score —
 * and only a real number is clamped and kept. Nothing is invented in either
 * direction, which is the whole point: a made-up 4 flatters and a made-up 0
 * libels, and the register should assert neither on a contractor's behalf.
 */
function optionalRating(value: unknown): number | null {
  /*
   * A number, or a string somebody typed into a number box. Nothing else gets
   * to `Number()`, because `Number()` says yes to things that are not scores:
   * `[]` and `" "` and `false` all come back 0, `true` comes back 1, and `[3]`
   * comes back 3. Each of those would have written a rating onto a contractor
   * from a request that never carried one — the same invention this function
   * was added to stop, arriving through a different door.
   */
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, 0), 5);
}

function numeric(value: unknown, fallback: number, min = 0, max = 1_000_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, min), max)
    : fallback;
}

function booleanValue(value: unknown, fallback = true) {
  if (typeof value === "boolean") return value;
  if (value === "false" || value === 0) return false;
  if (value === "true" || value === 1) return true;
  return fallback;
}

function stringArray(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return values
    .map((item) => text(item, 80))
    .filter(Boolean)
    .slice(0, 20);
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseObject<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 52) || "record";
}

function newId(prefix: string, label: string) {
  return `${prefix}-${slug(label)}-${crypto.randomUUID().slice(0, 8)}`;
}

function databaseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return process.env.NODE_ENV === "development"
    ? `Preview database error: ${message}`
    : "The shared workspace is temporarily unavailable.";
}

type WorkspaceDb = Awaited<ReturnType<typeof scopedDb>>["db"];

async function seedWorkspaceIfEmpty(db: WorkspaceDb, orgId: string) {
  await ensureDatabase();
  if (orgId !== PRIMARY_ORGANISATION_ID) return;
  if (!sampleSeedingAllowed()) return;
  const [siteCount] = await db
    .select({ value: count() })
    .from(sites)
    .where(eq(sites.organisationId, orgId));

  if (siteCount.value === 0) {
    for (const store of sampleStores) {
      // The Stage-2 fields are written here rather than left to the
      // `UPDATE sites SET manager_name = manager WHERE manager_name IS NULL`
      // backfill in db/init.ts. That backfill runs during `ensureDatabase()`,
      // which completes before this lazy seed ever inserts a row — so on a
      // freshly provisioned workspace every seeded site had a null
      // `manager_name`, `site_type_value`, `address_line1` and `slug`, and the
      // Sites screen (which reads the Stage-2 names) showed a dash in the
      // Manager column for every store.
      await db.insert(sites).values({
        id: store.id,
        organisationId: orgId,
        name: store.name,
        type: store.type,
        region: store.region,
        lifecycle: store.lifecycle,
        address: store.address,
        manager: store.manager,
        slug: slug(store.name),
        siteTypeValue: store.type,
        addressLine1: store.address,
        managerName: store.manager,
        status: store.lifecycle === "Current" ? "active" : "closed",
      }).onConflictDoNothing();

      for (const item of store.compliance) {
        await db.insert(complianceDocuments).values({
          id: `compliance-${slug(store.id)}-${slug(item.kind)}`,
          organisationId: orgId,
          siteId: store.id,
          kind: item.kind,
          status: item.state,
          expiryDate: item.expiry,
          attachmentId: null,
          notRequired: item.state === "Not required",
        }).onConflictDoNothing();
      }

      await db.insert(units).values([
        {
          id: `${store.id}-retail`,
          organisationId: orgId,
          siteId: store.id,
          name: `${store.name} — trading unit`,
          category: store.type,
          status: store.lifecycle === "Current" ? "Active" : "Inactive",
          notes: "Customer-facing operational unit",
        },
        {
          id: `${store.id}-services`,
          organisationId: orgId,
          siteId: store.id,
          name: `${store.name} — service assets`,
          category: "Asset group",
          status: store.lifecycle === "Current" ? "Active" : "Inactive",
          notes: "Shared mechanical, electrical and safety assets",
        },
      ]).onConflictDoNothing();
    }
  }

  const [contractorCount] = await db
    .select({ value: count() })
    .from(contractors)
    .where(eq(contractors.organisationId, orgId));
  if (contractorCount.value === 0) {
    const categoriesByContractor = new Map<string, Set<string>>();
    for (const request of sampleRequests) {
      if (!request.contractor) continue;
      const current = categoriesByContractor.get(request.contractor) ?? new Set<string>();
      current.add(request.category);
      categoriesByContractor.set(request.contractor, current);
    }
    for (const [name, categories] of categoriesByContractor) {
      await db.insert(contractors).values({
        id: `contractor-${slug(name)}`,
        organisationId: orgId,
        name,
        email: `ops@${slug(name)}.example`,
        serviceCategories: JSON.stringify(Array.from(categories)),
        coverageAreas: JSON.stringify(["UK"]),
        certifications: JSON.stringify(["Public liability verified"]),
        availability: "Available",
        rating: 4.5,
        active: true,
      }).onConflictDoNothing();
    }
  }

  const [plannedCount] = await db
    .select({ value: count() })
    .from(plannedMaintenance)
    .where(eq(plannedMaintenance.organisationId, orgId));
  if (plannedCount.value === 0) {
    const contractorRows = await db
      .select()
      .from(contractors)
      .where(eq(contractors.organisationId, orgId));
    const contractorIds = new Map(contractorRows.map((row) => [row.name, row.id]));
    for (const request of sampleRequests.filter((item) => item.dueAt && item.stage !== "Completed")) {
      await db.insert(plannedMaintenance).values({
        id: `planned-${request.id.toLowerCase()}`,
        organisationId: orgId,
        siteId: request.siteId,
        unitId: `${request.siteId}-services`,
        contractorId: request.contractor ? contractorIds.get(request.contractor) ?? null : null,
        title: request.title,
        category: request.category,
        frequency: "One-off",
        nextDueAt: request.dueAt!,
        lastCompletedAt: null,
        status: request.stage === "Booked" ? "Booked" : "Scheduled",
        reminderDays: request.priority === "Urgent" ? 1 : 7,
      }).onConflictDoNothing();
    }
  }

  const [userCount] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.organisationId, orgId));
  if (userCount.value === 0) {
    for (const member of [
      { name: "Workspace Super Admin", email: "superadmin@test.maintsupp.com", role: "Super Admin" },
      { name: "Sample Admin", email: "sample-admin@maintsupp.local", role: "Admin" },
      { name: "Sample Client User", email: "sample-client@maintsupp.local", role: "Client" },
    ]) {
      await db.insert(users).values({
        id: `user-${slug(member.email)}`,
        organisationId: orgId,
        fullName: member.name,
        email: member.email,
        role: member.role,
        active: true,
      }).onConflictDoNothing();
    }
  }
  const memberRows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.organisationId, orgId));
  for (const member of memberRows) {
    const role = member.role.toLowerCase() === "super admin"
      ? "super_admin"
      : member.role.toLowerCase() === "admin"
        ? "admin"
        : "client";
    await db.insert(memberships).values({
      id: `membership-${member.id}-${orgId}`,
      userId: member.id,
      organisationId: orgId,
      role,
      siteScope: null,
      approvalLimitPence: null,
      status: "active",
      acceptedAt: new Date().toISOString(),
    }).onConflictDoNothing();
  }

  await db.insert(workspaceSettings).values({
    legacyClientId: orgId,
    organisationId: orgId,
    settings: JSON.stringify(defaultWorkspaceSettings),
    updatedByEmail: "seed@maintsupp.local",
  }).onConflictDoNothing();
}

/* ── The two rules every job figure in this file is measured by ──────────── */

/**
 * "COMPLETED", IN SQL, MEANING EXACTLY WHAT IT MEANS IN THE BROWSER.
 *
 * These aggregates tested `stage = 'Completed'` and nothing else, while the
 * screens that print their numbers ask `isClosedRequest`
 * (app/(app)/portal/dashboard-meters.ts) — the UNION of the lifecycle stage and
 * monday's own `is_done` Status label. The two are not the same set on this
 * data: the imported rows sit in monday's "… Recently completed" groups, which
 * carry no lifecycle stage in this app, so their `stage` is "Incoming" while
 * their `status` says "Job Completed". Measured on a fixture — one job,
 * `status = 'Job Completed'`, `stage = 'Incoming'` — this route reported
 * `completed: 0` for a contractor whose own Contractors page reported
 * `completed: 1`.
 *
 * Built FROM `COMPLETED_STAGE` and `completedStatuses` in
 * `dashboard-meters.ts` itself — the same two values `isClosedRequest` is built
 * from, three lines below where they are declared. The server is SQL and the
 * client is TypeScript so the FUNCTION cannot be shared, but the VOCABULARY is,
 * and it is the vocabulary that drifted. Adding a label to that array changes
 * this predicate and the browser's in the same edit. (Why the import points
 * that way rather than at a neutral module in `app/lib` is on the import line.)
 *
 * Whole-value equality — `=` on the stage, `IN` over the label list — for the
 * reason the aggregate note below gives: this board carries 23 Status labels
 * and nothing here may match a prefix, a substring or a pattern. The `IN` list
 * is spread FROM the shared array rather than typed out, so it is the array
 * that decides what the database counts.
 *
 * Assembled with `sql` and its own parentheses rather than drizzle's `or()`,
 * for two reasons that both matter here: `or()` is typed `SQL | undefined`
 * because it tolerates being handed nothing, and this expression is embedded
 * inside `case when …` and negated by `not(…)`, where a missing pair of
 * brackets is a silent change of meaning rather than an error. `eq` and
 * `inArray` still supply the bound parameters, so no label is ever
 * interpolated into the statement text.
 */
const completedJobPredicate = sql`(${eq(maintenanceRequests.stage, COMPLETED_STAGE)} or ${inArray(
  maintenanceRequests.status,
  [...completedStatuses],
)})`;

/**
 * WHICH ROWS ARE A WORK ORDER AT ALL — the SQL twin of `countsAsWorkOrder`
 * in `app/(app)/portal/portal-app.tsx`.
 *
 * Three exclusions, and until now this route applied only the first:
 *
 *   • `deleted_at IS NULL` — Stage 23's recycle bin. A binned job is not work.
 *   • `archived = false`   — a row somebody deliberately took off the board.
 *     There is a real `archived` column with an index
 *     (`maintenance_org_archived_created_idx`) and `/api/board/items` has
 *     always honoured it; these aggregates did not. Measured: archive a job
 *     and the contractor's tally here did not move — `{a:4,c:0,u:4,s:1000}`
 *     before and after — while the Contractors page dropped it, so the manage
 *     drawer's "N jobs" subtitle and the table's Assigned column printed two
 *     different numbers for one contractor on one screen.
 *   • `parent_id IS NULL`  — a SUBITEM is a full row of this table whose parent
 *     is another row. The board has always filtered them out before placing
 *     anything ("the same work appeared twice and the group counts were
 *     wrong"); the same fixture proved they were being counted here, and their
 *     `cost` summed alongside the parent's.
 *
 * The rule is the same one the page applies, so the same contractor over the
 * same range now yields the same four numbers on both surfaces. Archived and
 * deleted work is still readable — through `/api/account/archive` and the
 * recycle bin, which is where a row in either state belongs — it just is not
 * counted as live operational work.
 */
const liveWorkOrder = (orgId: string) =>
  and(
    eq(maintenanceRequests.organisationId, orgId),
    isNull(maintenanceRequests.deletedAt),
    eq(maintenanceRequests.archived, false),
    isNull(maintenanceRequests.parentId),
  );

async function readWorkspace(db: WorkspaceDb, orgId: string): Promise<WorkspaceSnapshot> {
  await seedWorkspaceIfEmpty(db, orgId);
  const [
    siteRows,
    unitRows,
    contractorRows,
    plannedRows,
    userRows,
    settingsRows,
    openJobRows,
    contractorJobRows,
    contractorJobRowsById,
    activities,
    register,
    documentationColumnRows,
    contractorDocumentRows,
    certificationRows,
  ] = await Promise.all([
    db.select().from(sites).where(eq(sites.organisationId, orgId)).orderBy(sites.name),
    db.select().from(units).where(eq(units.organisationId, orgId)).orderBy(units.name),
    /*
     * THE CANONICAL ROSTER, not every register — W2.
     *
     * This read the organisation's contractors with no scope at all, which was
     * the whole truth until a section could own a register of its own. From the
     * first Contractors instance it would have put that instance's rows on the
     * workspace's own Contractors screen: a leak in the one direction the owner
     * named, and one nothing else could have caught, because the screen would
     * have looked entirely normal.
     *
     * `listContractors` defaults its scope to the canonical register, so this
     * asks for exactly what the snapshot has always meant. An instance's roster
     * is read through `GET /api/contractors`, which requires a section.
     */
    listContractors(db, orgId, { includeInactive: true }),
    db.select().from(plannedMaintenance).where(eq(plannedMaintenance.organisationId, orgId)).orderBy(plannedMaintenance.nextDueAt),
    db.select().from(users).where(eq(users.organisationId, orgId)).orderBy(users.fullName),
    db.select().from(workspaceSettings).where(eq(workspaceSettings.organisationId, orgId)).limit(1),
    /*
     * ── Two tallies, not the whole job table ────────────────────────────────
     *
     * This was `db.select().from(maintenanceRequests)` — every column of every
     * live job in the workspace, 776 rows and ~950KB out of Postgres — read so
     * that the fourteen lines below it could produce one count per site and
     * four numbers per contractor. The rows were then discarded; they never
     * reached the browser, which is why this route's RESPONSE is 146KB and its
     * cost looked unexplained from the outside.
     *
     * Measured with `PG_D1_TRACE=1` against Supabase: that select was the
     * slowest statement in the request at 512ms of a 798ms total, and the
     * request is on the Dashboard Overview's critical path — the compliance
     * donut, the compliance percentage and "Active units" all wait for it.
     * Postgres answers the same question with two GROUP BYs over an index in a
     * fraction of that, and the aggregates are ~40 rows rather than 776.
     *
     * The grouping is on the WHOLE stored value in both queries, and that is
     * deliberate. This board carries eleven monday status strings — "Waiting
     * for parts", "Quote Received (waiting for Approval)" — and an earlier
     * attempt to match them by substring swallowed 54 of 59 open jobs. Nothing
     * here matches a prefix, a substring or a pattern: `stage` is compared with
     * `=` and `<>` against the exact values the loop used, and `contractor` is
     * grouped by identity, exactly as `request.contractor === contractor.name`
     * compared it.
     *
     * Stage 23 — binned jobs are not open, so both keep the `deletedAt` filter.
     *
     * W6 closure — and neither is an archived row or a subitem, so both now
     * take `liveWorkOrder` rather than spelling the organisation and the bin
     * out again. One lifecycle scope for every job figure this function
     * produces: see the note on that helper.
     */
    db
      .select({ siteId: maintenanceRequests.siteId, open: count() })
      .from(maintenanceRequests)
      .where(
        and(
          liveWorkOrder(orgId),
          /*
           * `not (…)` over the shared predicate, not `stage <> 'Completed'`.
           * Open and completed have to be a partition of the same rows — the
           * meters assert exactly that invariant — and they were not while
           * this asked a narrower question than `completedJobPredicate`
           * answers. A job whose status says "Job Completed" was closed on the
           * board and open at its site.
           */
          not(completedJobPredicate),
        ),
      )
      .groupBy(maintenanceRequests.siteId),
    /*
     * `case when … then 1 else 0 end` and `coalesce`, rather than Postgres'
     * `count(*) filter (where …)`: this application also runs on SQLite when
     * `PG_D1` is unset, `db/sqlite-to-postgres.ts` translates one dialect into
     * the other, and FILTER is not in the SQLite subset it accepts. Both
     * constructs here are spelled identically by both engines, as is the
     * `<>` inequality.
     */
    /*
     * TWO aggregates, over two halves of the same table, and they never
     * overlap.
     *
     * A job belongs to a contractor when `contractor_id` says so, and — only
     * where there is no id — when the raw text carries their name. This was
     * keyed on the NAME alone, which meant RENAMING a contractor silently
     * zeroed their entire history: measured on a QA fixture,
     * `assigned: 1, urgent: 1, spend: 250` became `0, 0, 0` on the next read,
     * with the job's `contractor_id` still pointing straight at the renamed
     * row.
     *
     * The split is `contractor_id IS NULL` against `IS NOT NULL`, so every live
     * job lands in exactly one of these and contributes to exactly one
     * contractor once. Adding an id-keyed map ON TOP of the name-keyed one
     * would have traded the undercount for an overcount, double counting every
     * job whose id and text agree — which is most of them.
     *
     * Nothing else moves: same organisation scope, same `=` predicates on the
     * whole stored `stage`, `status` and `priority` values, for the reasons the
     * note above gives.
     *
     * W6 closure — what DID move, in both halves at once so the partition still
     * holds:
     *
     *   • the lifecycle scope is `liveWorkOrder`, which adds `archived = false`
     *     and `parent_id IS NULL` to the bin filter that was already here;
     *   • "completed" is `completedJobPredicate`, the same union the browser's
     *     `isClosedRequest` applies, instead of the stage alone;
     *   • "urgent" is therefore `priority = 'Urgent' AND NOT completed`, so
     *     open and completed remain a partition of the rows in scope.
     *
     * SPEND'S DATE BASIS, said out loud because two screens report it and they
     * are not asking the same question. There is no cost date in this product:
     * `cost` is monday's "Cost of Works" number and carries no date of its own,
     * the `invoice` column beside it is free text and empty on every row, and
     * the `invoices` table has never been read or written by any code. So the
     * figure here is ALL-TIME — every live work order this contractor holds,
     * unfiltered by date — and that is what the manage drawer prints. The
     * Contractors PAGE re-measures the same rows inside its own reporting
     * period, dating each by `completedAt ?? requestedAt`; Reports dates by
     * `requestedAt`. Under "All records" the page and this route agree exactly,
     * which is the invariant `tests/workstream-six-contractor-scope.test.mjs`
     * asserts.
     */
    db
      .select({
        contractor: maintenanceRequests.contractor,
        assigned: count(),
        completed: sql<number>`sum(case when ${completedJobPredicate} then 1 else 0 end)`,
        urgent: sql<number>`sum(case when ${maintenanceRequests.priority} = ${"Urgent"} and not (${completedJobPredicate}) then 1 else 0 end)`,
        spend: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          liveWorkOrder(orgId),
          isNull(maintenanceRequests.contractorId),
        ),
      )
      .groupBy(maintenanceRequests.contractor),
    db
      .select({
        contractorId: maintenanceRequests.contractorId,
        assigned: count(),
        completed: sql<number>`sum(case when ${completedJobPredicate} then 1 else 0 end)`,
        urgent: sql<number>`sum(case when ${maintenanceRequests.priority} = ${"Urgent"} and not (${completedJobPredicate}) then 1 else 0 end)`,
        spend: sql<number>`coalesce(sum(${maintenanceRequests.cost}), 0)`,
      })
      .from(maintenanceRequests)
      .where(
        and(
          liveWorkOrder(orgId),
          isNotNull(maintenanceRequests.contractorId),
        ),
      )
      .groupBy(maintenanceRequests.contractorId),
    db.select().from(activityLog).where(eq(activityLog.organisationId, orgId)).orderBy(desc(activityLog.createdAt)).limit(60),
    readComplianceRegister(db, orgId),
    /*
     * The Store Documentation board's own columns, id and key only.
     *
     * Two dozen rows on an indexed pair, read so a compliance record can carry
     * the id of the cell its expiry lives in — see `expiryColumnId`. Deleted
     * columns are excluded, so a slot whose column has been removed from the
     * board resolves to null and the calendar refuses the edit honestly instead
     * of posting an id `update_cell` would 404 on.
     */
    db
      .select({
        id: maintenanceBoardColumns.id,
        columnKey: maintenanceBoardColumns.key,
      })
      .from(maintenanceBoardColumns)
      .where(
        and(
          eq(maintenanceBoardColumns.organisationId, orgId),
          eq(maintenanceBoardColumns.boardId, STORE_DOCUMENTATION_BOARD_ID),
          isNull(maintenanceBoardColumns.deletedAt),
        ),
      ),
    /*
     * ── A contractor's documents, counted ──────────────────────────────────
     *
     * W07-07: a document may now be filed against a contractor, and the link has
     * to be reachable from the contractor's side or it is only half a
     * relationship. Counted in SQL and grouped, for the same reason the two job
     * tallies above are: the rows themselves are not wanted here, only how many
     * there are, and this workspace's attachment table is the largest in the
     * schema.
     *
     * Live versions only — `is_current` and no `archived_at` — so a lease
     * replaced four times counts once and a document somebody archived stops
     * counting. That is the same rule the site's Documents tab applies, so
     * "has documents" cannot mean two different things on two screens.
     */
    db
      .select({ contractorId: attachments.contractorId, total: count() })
      .from(attachments)
      .where(
        and(
          eq(attachments.organisationId, orgId),
          isNotNull(attachments.contractorId),
          isNull(attachments.archivedAt),
          eq(attachments.isCurrent, true),
        ),
      )
      .groupBy(attachments.contractorId),
    /*
     * ── W06-08 — certifications that have dates of their own ───────────────
     *
     * The legacy `contractors.certifications` JSON array holds NAMES and
     * nothing else, so "is this contractor's gas ticket still valid" had no
     * answer anywhere in the product: there was one `insurance_expiry` for the
     * whole contractor and none per certificate.
     *
     * The rows themselves rather than a count, because unlike a document tally
     * the point of each one IS its expiry date, and a number cannot carry a
     * date. Small by construction — a handful per contractor — and the legacy
     * array is still read beside them, so a contractor with no rows here
     * behaves exactly as they did before this table existed.
     */
    db
      .select()
      .from(contractorCertifications)
      .where(eq(contractorCertifications.organisationId, orgId))
      .orderBy(contractorCertifications.position, contractorCertifications.name),
  ]);

  /*
   * Keyed by site id, and a job with no site contributes to none of them.
   *
   * `site_id` is nullable now, so this grouped a `null` key alongside the real
   * ones — and every unattached job in the estate would have been counted
   * against whichever site that key happened to reach. An unattached job is not
   * open work at any site; it is work whose site nobody has established yet,
   * and it is surfaced as that rather than folded into a store's figures.
   */
  const openJobsBySite = new Map<string, number>(
    openJobRows
      .filter((row): row is typeof row & { siteId: string } => Boolean(row.siteId))
      .map((row) => [row.siteId, Number(row.open)]),
  );
  /*
   * Keyed by the contractor name exactly as stored on the job, and holding
   * ONLY the jobs that carry no `contractor_id`. Jobs with no contractor at all
   * group under `null`, which no contractor's name can equal — the same rows
   * the old `request.contractor === contractor.name` filter dropped.
   */
  /*
   * A name two contractors share attributes to NEITHER of them.
   *
   * The name fallback is a lookup, so when two rows in the register carry one
   * name they BOTH matched it and the same unlinked job was counted twice —
   * once against each — and the page's Tracked spend tile, which sums the
   * per-contractor figures, reported one GBP 999 job as GBP 1,998. Nothing stops
   * the pair existing: there is no unique index on `contractors.name` and the
   * create has no duplicate check.
   *
   * Refusing to attribute is the same answer `resolveContractorLink` already
   * gives to the same question. A register that cannot say WHICH contractor a
   * name means cannot say whose job it was either, and inventing an answer in
   * the tally while refusing to invent one in the link would be the two halves
   * of this feature disagreeing. Under-counting an ambiguous name is visible
   * and fixable — the operator links the jobs, or renames one of the pair.
   * Double-counting is neither: it inflates a spend figure somebody bills from.
   */
  const contractorsPerName = new Map<string, number>();
  for (const row of contractorRows) {
    contractorsPerName.set(row.name, (contractorsPerName.get(row.name) ?? 0) + 1);
  }
  const jobsByContractorName = new Map(
    contractorJobRows
      .filter((row): row is typeof row & { contractor: string } => row.contractor !== null)
      .filter((row) => (contractorsPerName.get(row.contractor) ?? 0) <= 1)
      .map((row) => [row.contractor, row]),
  );
  /*
   * Keyed by the reference itself, and covering the half of the table the map
   * above cannot see. A renamed contractor keeps these: nothing here depends on
   * what the job's text says.
   */
  const jobsByContractorId = new Map(
    contractorJobRowsById
      .filter((row): row is typeof row & { contractorId: string } => row.contractorId !== null)
      .map((row) => [row.contractorId, row]),
  );
  const siteNameById = new Map(siteRows.map((site) => [site.id, site.name]));
  const contractorNameById = new Map(contractorRows.map((item) => [item.id, item.name]));

  /*
   * ── The compliance register ────────────────────────────────────────────
   *
   * Read off the Store Documentation board, with `compliance_documents` as the
   * override layer. The rules and the reasons are in
   * app/lib/compliance-register.ts, which the compliance digest calls too — one
   * derivation, so a screen and an email cannot disagree about whether a fire
   * alarm certificate has lapsed.
   *
   * `itemId`, `slotKey` and `expiryColumnKey` carry the record's PROVENANCE out
   * with it. The register has always known which board row and which slot a
   * document came from; this payload used to drop that on the floor, which was
   * harmless while every screen only read the register. The calendar writes:
   * moving a certificate expiry there has to reach the same cell the Store
   * Documentation board writes, or the next `readComplianceRegister` recomputes
   * the state from the untouched board cell and the operator watches their edit
   * disappear on the next refresh. So the column key travels WITH the record
   * rather than being re-derived from `kind` by whoever happens to need it.
   */
  const expiryColumnBySlot = new Map(
    storeDocumentationCertificates.map((slot) => [slot.key, slot.expiryColumn]),
  );
  const columnIdByKey = new Map(
    (documentationColumnRows as Array<{ id: string; columnKey: string }>).map(
      (column) => [column.columnKey, column.id],
    ),
  );
  const compliance: WorkspaceComplianceRecord[] = register.entries.map((entry) => {
    const expiryColumnKey = entry.slotKey
      ? (expiryColumnBySlot.get(entry.slotKey) ?? null)
      : null;
    return {
      id: entry.id,
      siteId: entry.siteId,
      siteName: entry.siteName,
      kind: entry.kind,
      state: entry.state,
      expiry: entry.expiry,
      fileCount: entry.fileCount,
      siteType: entry.siteType,
      siteAddress: entry.siteAddress,
      itemId: entry.itemId,
      slotKey: entry.slotKey,
      /*
       * Null for the three slots the board tracks no expiry on — RAMS, the Fire
       * Risk Assessment and the store Drawing — and for a register-only row,
       * which has no slot at all.
       */
      expiryColumnKey,
      /*
       * And null again when that column is not on this organisation's board —
       * a workspace that has never seeded Store Documentation, or one where the
       * column was deleted. The calendar reads this, not the key, to decide
       * whether the expiry is writable.
       */
      expiryColumnId: expiryColumnKey
        ? (columnIdByKey.get(expiryColumnKey) ?? null)
        : null,
    };
  });

  const stores: StoreRecord[] = siteRows.map((site) => ({
    id: site.id,
    name: site.name,
    type: site.siteTypeValue ?? site.type,
    region: site.region,
    status: site.status,
    lifecycle: site.lifecycle,
    address: site.address,
    manager: site.manager ?? "Unassigned",
    openRequests: openJobsBySite.get(site.id) ?? 0,
    annualBudgetPence: site.annualBudgetPence ?? null,
    compliance: register.bySite.get(site.id) ?? [],
  }));

  const unitsPayload: WorkspaceUnit[] = unitRows.map((unit) => {
    const site = stores.find((item) => item.id === unit.siteId);
    return {
      id: unit.id,
      siteId: unit.siteId,
      siteName: siteNameById.get(unit.siteId) ?? "Unknown site",
      name: unit.name,
      category: unit.category,
      manufacturer: unit.manufacturer,
      model: unit.model,
      serialNumber: unit.serialNumber,
      status: unit.status,
      notes: unit.notes,
      openJobs: openJobsBySite.get(unit.siteId) ?? 0,
      compliance: site
        ? getOverallCompliance(site)
        : "Missing",
    };
  });

  const documentsByContractor = new Map(
    (contractorDocumentRows as Array<{ contractorId: string | null; total: number }>)
      .filter((row): row is { contractorId: string; total: number } => Boolean(row.contractorId))
      .map((row) => [row.contractorId, Number(row.total)]),
  );

  /*
   * W06-08 — every certification, grouped by the contractor it belongs to.
   *
   * One instant for the whole loop, exactly as the compliance digest classifies
   * a whole board against one `now`: the alternative is `new Date()` inside the
   * map, which drifts across a long payload and can put two certificates that
   * expire on the same day into two different buckets.
   */
  const classifiedAt = new Date();
  const certificationsByContractor = new Map<string, WorkspaceCertification[]>();
  for (const row of certificationRows) {
    const status = expiryStatus(row.expiresOn, classifiedAt);
    const list = certificationsByContractor.get(row.contractorId) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      reference: row.reference,
      issuedOn: row.issuedOn,
      expiresOn: row.expiresOn,
      notes: row.notes,
      position: row.position,
      /*
       * DERIVED, never stored. There is no `status` column on
       * `contractor_certifications` and there must not be one: a status written
       * down is a status that stops being true the day after it was written,
       * which is exactly how `compliance_documents.status` came to say
       * "Compliant" about a certificate that had expired months earlier. This
       * is `expiryStatus` — the platform's one classifier, at the platform's
       * one 60-day amber threshold — so a contractor's ticket and a store's
       * certificate cannot mean different things by "due soon".
       */
      expiryState: status.state,
      expiryLabel: status.label,
      daysRemaining: status.daysRemaining,
    });
    certificationsByContractor.set(row.contractorId, list);
  }

  const contractorsPayload: WorkspaceContractor[] = contractorRows.map((contractor) => {
    /*
     * Their linked jobs plus their unlinked-by-name jobs. Disjoint sets, so
     * this is a sum and not a union — see the query. No jobs at all is a real
     * answer: zeroes, not an absent row.
     */
    const byId = jobsByContractorId.get(contractor.id);
    const byName = jobsByContractorName.get(contractor.name);
    const insurance = expiryStatus(contractor.insuranceExpiry, classifiedAt);
    return {
      id: contractor.id,
      name: contractor.name,
      email: contractor.email,
      phone: contractor.phone,
      // A second number, and never a copy of the first — see the column note.
      whatsappNumber: contractor.whatsappNumber,
      // The person, the place, what was agreed and what it costs — see the
      // note on the `contractors` table for why the row could not hold them.
      contactName: contractor.contactName,
      address: contractor.address,
      // W06-06. `address` is one free-text line and nothing can search, sort or
      // map on it; a postcode is the field an engineer is actually given.
      postcode: contractor.postcode,
      notes: contractor.notes,
      /*
       * W06-07 — the whole agreed rate card, in pence, read under the same
       * names the PATCH now accepts as write keys. `otherCostLabel` travels
       * with its figure: the number is meaningless without it, so a payload
       * that carried one and not the other would be shipping a mystery.
       */
      dayRatePence: contractor.dayRatePence,
      hourlyRatePence: contractor.hourlyRatePence,
      callOutCostPence: contractor.callOutCostPence,
      otherCostPence: contractor.otherCostPence,
      otherCostLabel: contractor.otherCostLabel,
      /*
       * W06-09 — TERMS and an EXTERNAL reference. No bank detail exists on this
       * record to return; see `contractorPaymentTermsRefusal` for why not.
       */
      paymentTerms: contractor.paymentTerms,
      financeReference: contractor.financeReference,
      serviceCategories: parseStringArray(contractor.serviceCategories),
      coverageAreas: parseStringArray(contractor.coverageAreas),
      certifications: parseStringArray(contractor.certifications),
      /*
       * W06-08 — the structured entries, beside the legacy names array rather
       * than instead of it. A contractor with no rows in the new table gets an
       * empty list here and their old `certifications` array unchanged, which
       * is what "additive" has to mean for a register already in use.
       */
      certificationEntries: certificationsByContractor.get(contractor.id) ?? [],
      insuranceExpiry: contractor.insuranceExpiry,
      /*
       * W06-08 — a date nobody classifies is a date nobody acts on.
       *
       * `insurance_expiry` was stored, shown in one edit box and read by
       * nothing: no register column, no chip, no alert. Classified here rather
       * than in each screen for the reason `expiry-status.ts` exists at all —
       * two surfaces inventing their own answer is how the compliance count
       * came to differ by one between two pages.
       */
      insuranceState: insurance.state,
      insuranceStatusLabel: insurance.label,
      insurerName: contractor.insurerName,
      policyNumber: contractor.policyNumber,
      insuranceNotes: contractor.insuranceNotes,
      availability: contractor.availability,
      rating: contractor.rating,
      active: contractor.active,
      assignedJobs: Number(byId?.assigned ?? 0) + Number(byName?.assigned ?? 0),
      completedJobs: Number(byId?.completed ?? 0) + Number(byName?.completed ?? 0),
      urgentJobs: Number(byId?.urgent ?? 0) + Number(byName?.urgent ?? 0),
      spend: Number(byId?.spend ?? 0) + Number(byName?.spend ?? 0),
      /* Zero is a real answer here, not an absent one — see the type. */
      documentCount: documentsByContractor.get(contractor.id) ?? 0,
    };
  });

  const plannedPayload: WorkspacePlannedItem[] = plannedRows.map((item) => ({
    id: item.id,
    siteId: item.siteId,
    siteName: siteNameById.get(item.siteId) ?? "Unknown site",
    unitId: item.unitId,
    contractorId: item.contractorId,
    contractorName: item.contractorId ? contractorNameById.get(item.contractorId) ?? null : null,
    title: item.title,
    category: item.category,
    frequency: item.frequency,
    nextDueAt: item.nextDueAt,
    lastCompletedAt: item.lastCompletedAt,
    status: item.status,
    reminderDays: item.reminderDays,
  }));

  const team: WorkspaceMember[] = userRows.map((member) => ({
    id: member.id,
    name: member.fullName ?? member.email.split("@")[0],
    email: member.email,
    role: member.role,
    active: member.active,
    lastActive: member.active ? "Shared workspace" : "Access paused",
  }));

  const storedSettings = parseObject<Partial<WorkspaceSettings>>(
    settingsRows[0]?.settings ?? null,
    {},
  );
  const settings: WorkspaceSettings = {
    alerts: { ...defaultWorkspaceSettings.alerts, ...storedSettings.alerts },
    slas: { ...defaultWorkspaceSettings.slas, ...storedSettings.slas },
    /*
     * Filtered to strings rather than spread. This value reaches a WHERE-free
     * comparison in the close gate, and a stored `null` or a number arriving
     * from an older settings row would silently match nothing — a gate that
     * quietly stops gating is worse than one that was never built.
     */
    completionEvidenceCategories: Array.isArray(
      storedSettings.completionEvidenceCategories,
    )
      ? storedSettings.completionEvidenceCategories
          .filter((value): value is string => typeof value === "string" && !!value.trim())
          .map((value) => value.trim())
      : defaultWorkspaceSettings.completionEvidenceCategories,
  };

  const activity: WorkspaceActivity[] = activities.map((item) => ({
    id: item.id,
    entityType: item.entityType,
    entityId: item.entityId,
    action: item.action,
    actorEmail: item.actorEmail,
    detail: parseObject<Record<string, unknown>>(item.detail, {}),
    createdAt: item.createdAt,
  }));

  return { stores, compliance, units: unitsPayload, contractors: contractorsPayload, planned: plannedPayload, team, settings, activity };
}

function getOverallCompliance(store: StoreRecord): ComplianceState {
  const states = store.compliance.map((item) => item.state);
  if (states.includes("Expired")) return "Expired";
  if (states.includes("Missing")) return "Missing";
  if (states.includes("Expiring soon")) return "Expiring soon";
  return "Compliant";
}

async function logChange(db: WorkspaceDb, orgId: string, entity: WorkspaceEntity, id: string, action: string, actorEmail: string, detail: Record<string, unknown>) {
  await db.insert(activityLog).values({
    id: crypto.randomUUID(),
    organisationId: orgId,
    entityType: `workspace_${entity}`,
    entityId: id,
    action,
    actorEmail,
    detail: JSON.stringify(detail),
  });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const { db, orgId } = await scopedDb(request);
    return Response.json({ workspace: await readWorkspace(db, orgId) });
  } catch (error) {
    // A session that has ended is not an outage. See `anonymousRefusal`.
    const refusal = anonymousRefusal(error);
    if (refusal) return refusal;
    return Response.json({ error: databaseError(error) }, { status: 503 });
  }
}


/**
 * The capability each workspace entity demands.
 *
 * This route writes sites, units, contractors, planned work, compliance
 * records, workspace settings AND user membership — including deactivating a
 * colleague, which invalidates their sessions. One blanket capability would
 * therefore either lock admins out of the site register or hand the user table
 * to anyone who can edit a site. The mapping is per entity for that reason.
 */
const WORKSPACE_CAPABILITY: Record<string, Capability> = {
  site: "sites.edit",
  unit: "sites.edit",
  compliance: "sites.edit",
  contractor: "sites.edit",
  planned: "sites.edit",
  settings: "settings.edit",
  member: "users.edit",
};

/**
 * Authorises one workspace write.
 *
 * Returns a Response to send, or null to proceed. Two separate questions, and
 * the order matters: are you anyone at all, and then may you do this.
 *
 * The `authenticated` check is the one that mattered most. In production every
 * identity candidate is dropped for a request with no session, and the actor
 * falls back to the `client` role scoped to the PRIMARY organisation — so an
 * unauthenticated stranger reached this route as a client of the live tenant
 * and these writes answered 200. Deactivating the owner was among them.
 */
async function authoriseWorkspaceWrite(
  db: Awaited<ReturnType<typeof scopedDb>>["db"],
  orgId: string,
  actor: { role: string },
  authenticated: boolean,
  entity: string | undefined,
  intent: "write" | "deactivate" = "write",
): Promise<Response | null> {
  if (!authenticated) {
    return Response.json({ error: "Sign in to make this change." }, { status: 401 });
  }
  const capability =
    intent === "deactivate"
      ? "users.deactivate"
      : WORKSPACE_CAPABILITY[entity ?? ""];
  if (!capability) {
    return Response.json({ error: "Unknown record type." }, { status: 400 });
  }
  const subject = await resolvePermissions(db, orgId, actor.role as WorkspaceRole);
  return requireCapability(subject, capability);
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const { actor, authenticated, db, orgId } = await scopedDb(request);
    await seedWorkspaceIfEmpty(db, orgId);
    const payload = await request.json() as { entity?: WorkspaceEntity; data?: Record<string, unknown> };
    const entity = payload.entity;
    /*
     * An object or nothing. The branches below ask `"key" in data` before
     * writing a column, and `in` throws a TypeError on a primitive, so a body
     * whose `data` was a string or a number answered with a V8 message about
     * the `in` operator instead of a refusal. An array is not a record either.
     */
    const rawData = payload.data;
    const data = rawData && typeof rawData === "object" && !Array.isArray(rawData) ? rawData : {};
    const refusal = await authoriseWorkspaceWrite(db, orgId, actor, authenticated, entity);
    if (refusal) return refusal;
    let id = "";

    if (entity === "site") {
      const name = text(data.name, 120);
      if (!name || !text(data.address, 300)) throw new Error("A site name and address are required.");
      id = newId("store", name);
      /*
       * W05-07 — A NEW SITE CANNOT BE BORN CONTRADICTING ITSELF.
       *
       * This insert named `lifecycle` and neither of the other two state
       * columns, so the row took the schema defaults for them: `status`
       * 'active' and `active` true. Creating a site here with Lifecycle set to
       * Closed — two clicks, New then the select — therefore stored
       * `{ status: 'active', lifecycle: 'Closed', active: true }`: a record the
       * Sites register lists as open and offers in every location picker, filed
       * under Closed by the reporting groups. The PATCH beside this has always
       * written all three together; the create did not, and a route that
       * refuses on edit what it accepts on create just moves the bad row's
       * birthday.
       *
       * The same validation too: an unrecognised lifecycle is a 400 rather than
       * forty characters of whatever arrived.
       */
      if ("lifecycle" in data && !normaliseSiteLifecycle(data.lifecycle)) {
        return Response.json({ error: siteLifecycleRefusal() }, { status: 400 });
      }
      const siteState = reconcileSiteState(
        { ...("lifecycle" in data ? { lifecycle: data.lifecycle } : {}) },
        // The column defaults, stated rather than relied on: a new row's state
        // before anybody has said anything about it.
        { status: "active", lifecycle: "Current", active: true },
      );
      await db.insert(sites).values({ id, organisationId: orgId, name, type: text(data.type, 40) || "Kiosk", region: text(data.region, 40) || "UK", ...siteState, address: text(data.address, 300), manager: optionalText(data.manager, 120) });
    } else if (entity === "compliance") {
      /*
       * The same validation the PATCH does, for the same reasons — see the long
       * note there. A route that refuses on edit what it accepted on create just
       * moves the bad row's birthday: the invisible `kind` and the "not-a-date"
       * expiry both got in through here.
       *
       * `state` and `expiry` are OPTIONAL on create, unlike on the PATCH, and the
       * asymmetry is deliberate rather than an oversight. On create there is no
       * stored value for an omitted key to erase, and a new requirement with
       * nothing recorded yet is exactly what "Missing" and "no expiry date" mean.
       * On update there IS a stored value, and silence must never be read as an
       * instruction to destroy it.
       */
      const siteId = visibleText(data.siteId, 100);
      const kind = visibleText(data.kind, 120);
      if (!siteId || !kind) throw new Error("A site and requirement are required.");
      const state = visibleText(data.state, 40) || "Missing";
      if (!isComplianceState(state)) {
        return Response.json(
          { error: `A status must be one of: ${COMPLIANCE_STATES.join(", ")}.` },
          { status: 400 },
        );
      }
      const rawExpiry = visibleText(data.expiry, 40);
      const expiry = rawExpiry && isRealCalendarDate(rawExpiry) ? dateOnlyValue(rawExpiry) : "";
      if (rawExpiry && !expiry) {
        return Response.json(
          { error: "An expiry date must be a calendar date, as YYYY-MM-DD." },
          { status: 400 },
        );
      }
      // Before the insert, so a refusal writes nothing. See `referenceRefusal`.
      const badReference = await referencesRefusal(db, orgId, [{ kind: "site", value: siteId }]);
      if (badReference) return badReference;
      id = newId("compliance", `${siteId}-${kind}`);
      await db.insert(complianceDocuments).values({ id, organisationId: orgId, siteId, kind, status: state, expiryDate: expiry || null, notRequired: state === "Not required" });
    } else if (entity === "unit") {
      const name = text(data.name, 140);
      const siteId = text(data.siteId, 100);
      if (!name || !siteId) throw new Error("A unit name and site are required.");
      // Before the insert, so a refusal writes nothing. See `referenceRefusal`.
      const badReference = await referencesRefusal(db, orgId, [{ kind: "site", value: siteId }]);
      if (badReference) return badReference;
      id = newId("unit", name);
      await db.insert(units).values({ id, organisationId: orgId, siteId, name, category: text(data.category, 80) || "Asset", manufacturer: optionalText(data.manufacturer, 100), model: optionalText(data.model, 100), serialNumber: optionalText(data.serialNumber, 100), status: text(data.status, 40) || "Active", notes: optionalText(data.notes, 500) });
    } else if (entity === "contractor") {
      const name = text(data.name, 140);
      // `hasVisibleText`, not truthiness: a name of only zero-width spaces is
      // not a name, and JS `trim()` does not remove them.
      if (!hasVisibleText(name)) throw new Error("A contractor name is required.");
      /*
       * Before the insert, so a refusal writes nothing.
       *
       * `active` for the same reason the member create above is guarded:
       * `booleanValue` falls back to TRUE, so `{ "active": null }` created a
       * contractor who is on the register and in the assignment dropdown from
       * a request that never said they should be. A create is where the row
       * gets its first state, so guessing it here is guessing it forever.
       *
       * `email` because a create is the cheapest place to refuse an address
       * nobody can be reached on, and because the edit refusing what the
       * create accepted would mean a row that cannot be saved again.
       */
      const badActive = contractorActiveRefusal(data);
      if (badActive) return badActive;
      const badEmail = contractorEmailRefusal(data);
      if (badEmail) return badEmail;
      const badRate = contractorRateRefusal(data);
      if (badRate) return badRate;
      /*
       * W06-06/07/08 — the same four guards the edit runs, in the same order.
       *
       * A create that accepts what the edit refuses produces a row that cannot
       * be saved a second time, which is the asymmetry `contractorEmailRefusal`
       * was written to avoid; these are here for exactly that reason.
       *
       * `insuranceExpiry` is the one that was genuinely broken rather than
       * merely missing: it went through `optionalText(data.insuranceExpiry, 40)`
       * on BOTH paths, so `2027-13-45` was stored on create and on edit alike,
       * while `compliance` twenty lines up on this very route already ran
       * `isRealCalendarDate` and refused it. One route, two opinions about what
       * a date is.
       */
      const badCost = contractorCostRefusal(data);
      if (badCost) return badCost;
      const badPostcode = contractorPostcodeRefusal(data);
      if (badPostcode) return badPostcode;
      const badExpiry = contractorExpiryRefusal(
        data,
        "insuranceExpiry",
        "A contractor's insurance expiry",
      );
      if (badExpiry) return badExpiry;
      // Before the insert, so a certificate with a nonsense date refuses the
      // whole create rather than leaving a contractor half-made.
      const badCertifications = contractorCertificationsRefusal(data);
      if (badCertifications) return badCertifications;
      /*
       * Same allow-list as the edit. An OMITTED availability still falls to
       * "Available" through the `||` below — that is the create's default and
       * it stays. What is refused is a SUPPLIED value that is not one of the
       * four, so the edit cannot end up stricter than the create and leave a
       * row that will not save again.
       */
      const badAvailability = contractorAvailabilityRefusal(data);
      if (badAvailability) return badAvailability;
      // W06-09. A DB read, so it sits with the other two below rather than up
      // among the cheap checks.
      const badTerms = await contractorPaymentTermsRefusal(db, orgId, data);
      if (badTerms) return badTerms;
      /*
       * Last of the create guards, because it is the only one that has to ask
       * the database a question, and there is no point asking it about a
       * payload the cheap checks have already refused. See
       * `contractorNameConflict`: the register cannot attribute a job to a name
       * two contractors share, so this is where a second one is stopped.
       */
      const scoped = await contractorScope(db, orgId, request);
      if (!scoped.ok) return scoped.refusal;
      const badName = await contractorNameConflict(db, orgId, name, null, scoped.scope);
      if (badName) return badName;
      id = newId("contractor", name);
      /*
       * W06-06 — the trades, folded onto `contractor_trade` before they are
       * stored, so "Electrical", "electrical" and " ElectRical" stop being
       * three trades from the moment the row is created. An unlisted value is
       * kept as typed; see `contractorTradeValues`.
       */
      const trades = await contractorTradeValues(db, orgId, data.serviceCategories);
      await db.insert(contractors).values({ id, organisationId: orgId, boardId: scoped.scope, name, email: optionalText(data.email, 160), phone: optionalText(data.phone, 80), whatsappNumber: optionalText(data.whatsappNumber, 80), contactName: optionalText(data.contactName, 140), address: optionalText(data.address, 240), postcode: contractorPostcode(data.postcode), notes: optionalText(data.notes, 2000), ...contractorCostSet(data), otherCostLabel: optionalText(data.otherCostLabel, 80), paymentTerms: optionalText(data.paymentTerms, 60), financeReference: optionalText(data.financeReference, 80), serviceCategories: JSON.stringify(trades), coverageAreas: JSON.stringify(stringArray(data.coverageAreas)), certifications: JSON.stringify(stringArray(data.certifications)), insuranceExpiry: contractorDate(data.insuranceExpiry), insurerName: optionalText(data.insurerName, 160), policyNumber: optionalText(data.policyNumber, 80), insuranceNotes: optionalText(data.insuranceNotes, 1000), availability: text(data.availability, 60) || "Available", rating: optionalRating(data.rating), active: booleanValue(data.active) });
      // W06-08 — structured certifications, if the create carried any. Absent
      // key writes nothing at all; see `writeContractorCertifications`. Their
      // VALIDATION already ran above, so nothing here can fail after the insert
      // and leave a contractor whose certificates were refused.
      await writeContractorCertifications(db, orgId, id, data);
    } else if (entity === "planned") {
      const title = text(data.title, 160);
      const siteId = text(data.siteId, 100);
      const nextDueAt = text(data.nextDueAt, 40);
      if (!title || !siteId || !nextDueAt) throw new Error("A title, site and next due date are required.");
      /*
       * `unitId` and `contractorId` are optional — `referencesRefusal` skips a
       * null, which is what "No linked unit" and "No contractor" send.
       */
      const unitId = optionalText(data.unitId, 100);
      const contractorId = optionalText(data.contractorId, 100);
      // Before the insert, so a refusal writes nothing. See `referenceRefusal`.
      const badReference = await referencesRefusal(db, orgId, [
        { kind: "site", value: siteId },
        { kind: "unit", value: unitId },
        { kind: "contractor", value: contractorId },
      ]);
      if (badReference) return badReference;
      id = newId("planned", title);
      await db.insert(plannedMaintenance).values({ id, organisationId: orgId, siteId, unitId, contractorId, title, category: text(data.category, 80) || "Planned maintenance", frequency: text(data.frequency, 60) || "Annual", nextDueAt, lastCompletedAt: optionalText(data.lastCompletedAt, 40), status: text(data.status, 40) || "Scheduled", reminderDays: numeric(data.reminderDays, 30, 0, 365) });
    } else if (entity === "member") {
      const name = text(data.name, 120);
      const email = text(data.email, 180).toLowerCase();
      if (!name || !email.includes("@")) throw new Error("A name and valid email are required.");
      /*
       * Before the insert, so a refusal writes nothing. The `|| "Client"` below
       * still covers an omitted role; this refuses a supplied one that is not a
       * role, which on a new member is the value the seed above would otherwise
       * turn into a membership. See `MEMBER_ROLES` for what that does and does
       * not close.
       */
      const badRole = memberRoleRefusal(data);
      if (badRole) return badRole;
      const badAccess = memberActiveRefusal(data);
      if (badAccess) return badAccess;
      id = newId("user", email);
      await db.insert(users).values({ id, organisationId: orgId, fullName: name, email, role: text(data.role, 60) || "Client", active: booleanValue(data.active) });
    } else if (entity === "settings") {
      id = orgId;
      const settings = data as unknown as WorkspaceSettings;
      await db.insert(workspaceSettings).values({ legacyClientId: orgId, organisationId: orgId, settings: JSON.stringify(settings), updatedByEmail: actor.email, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: workspaceSettings.organisationId, set: { settings: JSON.stringify(settings), updatedByEmail: actor.email, updatedAt: new Date().toISOString() } });
    } else {
      return Response.json({ error: "Unsupported workspace record." }, { status: 400 });
    }

    await logChange(db, orgId, entity, id, "created", actor.email, data);
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The record could not be created.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * Include a column in an UPDATE only when the caller actually sent it.
 *
 * THE BUG THIS EXISTS FOR. Every PATCH branch below builds its `set` from
 * `text(data.x)` unconditionally, and `text` turns a missing key into "". The
 * manage form always posts a whole record so the screens never noticed — but
 * anything sending a partial update, which is the obvious way to use a PATCH,
 * silently blanked every field it did not mention. Deactivating a contractor
 * with `{ active: false }` erased their name, email, phone, trades and
 * coverage, leaving a nameless row in the register.
 */
function supplied<T>(
  data: Record<string, unknown>,
  key: string,
  read: (value: unknown) => T,
): Record<string, T> {
  return key in data ? { [key]: read(data[key]) } : {};
}

/**
 * Resolve one reference to a row THIS organisation owns, or refuse.
 *
 * `siteId`, `unitId` and `contractorId` arrived trimmed and length-capped and
 * nothing more, so a caller could file a unit, a compliance record or a
 * planned visit in their OWN tenant against ANOTHER tenant's site, unit or
 * contractor id. The row lands in the actor's organisation and its reference
 * then points across the tenant boundary, which corrupts every site-joined
 * report and every compliance count on both sides of it.
 *
 * The database does not catch this in any configuration. Three of these
 * columns have no foreign key in the runtime DDL at all — `compliance_documents
 * .site_id` (db/init.ts), `planned_maintenance.unit_id` and `.contractor_id` —
 * and SQLite runs with `foreign_keys` OFF, which is its default and is never
 * turned on here. Where the key does exist it only catches an id that exists
 * nowhere; another tenant's real site satisfies it perfectly.
 *
 * Same shape as the site check on `POST /api/board/items`: one
 * organisation-scoped SELECT, 404 on a miss.
 *
 * 404 for BOTH a nonexistent id and one belonging to another organisation, with
 * a byte-identical body. A 403 for the second would be an existence oracle:
 * site ids here are `store-<slug of the store name>-<8 hex>`, so confirming an
 * id exists confirms the STORE NAME to a stranger in another tenant. One query
 * carrying both predicates makes the two cases indistinguishable by
 * construction rather than by policy, so no later edit can re-separate them.
 */
async function referenceRefusal(
  db: WorkspaceDb,
  orgId: string,
  kind: "site" | "unit" | "contractor",
  value: string,
): Promise<Response | null> {
  /*
   * Spelled out per table rather than parameterised over one: drizzle's
   * `.from()` does not take a union of table types, and three explicit selects
   * read more honestly than a cast that hides which table is being asked.
   */
  const rows =
    kind === "site"
      ? await db
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.id, value), eq(sites.organisationId, orgId)))
          .limit(1)
      : kind === "unit"
        ? await db
            .select({ id: units.id })
            .from(units)
            .where(and(eq(units.id, value), eq(units.organisationId, orgId)))
            .limit(1)
        : await db
            .select({ id: contractors.id })
            .from(contractors)
            .where(and(eq(contractors.id, value), eq(contractors.organisationId, orgId)))
            .limit(1);
  if (rows.length > 0) return null;
  const label = kind === "site" ? "Site" : kind === "unit" ? "Unit" : "Contractor";
  return Response.json({ error: `${label} not found.` }, { status: 404 });
}

/**
 * Every reference on one record, checked before anything is written.
 *
 * An absent or empty value is SKIPPED, not refused. `unit_id` and
 * `contractor_id` are nullable and the manage form sends "" for them
 * deliberately — "No linked unit" and "No contractor" are the first option in
 * both selects — so refusing "" would make every planned visit without a
 * contractor unsavable. Required references are non-empty-checked at their own
 * call site, where the message can name the missing field.
 *
 * Sequential rather than `Promise.all` so the first bad reference is the one
 * reported, which is the one the operator has to fix.
 */
async function referencesRefusal(
  db: WorkspaceDb,
  orgId: string,
  references: Array<{ kind: "site" | "unit" | "contractor"; value: string | null }>,
): Promise<Response | null> {
  for (const reference of references) {
    if (!reference.value) continue;
    const refusal = await referenceRefusal(db, orgId, reference.kind, reference.value);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * A NOT NULL text column, refused when the caller explicitly sends it empty.
 *
 * `supplied` fixes omission. It does not fix `{ name: "" }`, and "" satisfies
 * NOT NULL, so an explicit blank still reaches the column. The POST branches
 * already refuse exactly these fields, so this is PATCH agreeing with POST
 * about one rule rather than inventing a new one.
 *
 * A refusal rather than a silent ignore: ignoring would answer 200 and the
 * dashboard would toast "Shared workspace updated" over an edit that did
 * nothing. It is unreachable from the real UI — every one of these fields is
 * `required` in the manage form — so it only ever answers an API caller, which
 * is exactly who should be told.
 */
function requiredTextRefusal(
  data: Record<string, unknown>,
  key: string,
  max: number,
  message: string,
): Response | null {
  if (!(key in data)) return null;
  return hasVisibleText(text(data[key], max))
    ? null
    : Response.json({ error: message }, { status: 400 });
}

/**
 * Whether a string would actually show something to a person.
 *
 * `text()` trims with JS `String.prototype.trim`, which knows the spec's
 * WhiteSpace set — U+00A0 and U+FEFF are in it, so those were already refused.
 * **U+200B ZERO WIDTH SPACE is category Cf, not whitespace**, so it survived
 * the trim, read as truthy, and `{ name: "​" }` answered 200 and put a row
 * in the register whose name renders as nothing. That is precisely the outcome
 * the required-name guard exists to prevent, reached through the one door
 * nobody tried.
 *
 * Format characters and whitespace are stripped and what remains is asked to be
 * non-empty. A name that merely CONTAINS an invisible character is untouched —
 * only one made entirely of them is refused, which is never anybody's name.
 *
 * Shared with the create branches deliberately: PATCH refusing what POST
 * accepted would leave a row that cannot be saved again.
 */
function hasVisibleText(value: string): boolean {
  return value.replace(/[\p{Cf}\s]/gu, "") !== "";
}

/**
 * The roles the Team tab can express, refused when it is sent anything else.
 *
 * `users.role` had no allow-list on either verb, so a caller holding
 * `users.edit` could store any string at all — and the tab prints that string
 * straight back, so "Owner", "" or a paragraph of markup became a role this
 * workspace appears to have. These three are the whole set: the manage form's
 * select offers exactly them, `ROLE_LABEL` in the invitation tokens writes
 * exactly them, and `seedWorkspaceIfEmpty` above maps exactly them onto the
 * three membership roles.
 *
 * The column is a LABEL, not authority. Access comes from `memberships`, and
 * `/api/admin/users` is what changes that — behind a rank check, a
 * no-self-promotion rule and a last-super-admin guard-rail this route has none
 * of. Writing "Super Admin" here renames somebody on a screen.
 *
 * The create is guarded as well as the edit, but be clear about what that does
 * and does not buy. `seedWorkspaceIfEmpty` above derives a membership from this
 * label for a member who has none yet, so on a NEW member the label briefly
 * becomes authority — and "Super Admin" is a legitimate entry here, so this
 * list stops a typo reaching that mapping and does not stop somebody choosing
 * the top of it. Closing that properly means the seed not deriving authority
 * from a display column at all, which is a change to the seed and not to this
 * check. An edit cannot reach the mapping either way: the membership already
 * exists by then and the insert leaves it alone.
 *
 * It is also narrower than it looks. The seed returns early outside the primary
 * organisation and outside development, so in production nothing derives a
 * membership from this column and the label really is only a label.
 */
const MEMBER_ROLES = ["Super Admin", "Admin", "Client"];

function memberRoleRefusal(data: Record<string, unknown>): Response | null {
  if (!("role" in data)) return null;
  return MEMBER_ROLES.includes(text(data.role, 60))
    ? null
    : Response.json(
        { error: `A member's role must be ${MEMBER_ROLES.join(", ")}.` },
        { status: 400 },
      );
}

/**
 * A member's access, refused when it is sent something that is not an answer.
 *
 * `booleanValue` falls back to TRUE for anything it cannot read, so `null`,
 * `"no"`, `[]` and the string `"0"` all RESTORED access to somebody whose
 * access had been withdrawn — while the number `0` correctly withdrew it.
 * Reactivating is a privilege-relevant act: withdrawing access through the
 * archive verb below needs `users.deactivate`, and restoring it on the admin
 * route sits behind a rank check, so it must not happen here by accident under
 * plain `users.edit`.
 *
 * The accepted set is exactly what `booleanValue` can read, so a caller
 * already sending `"true"` or `1` is unaffected and only genuinely ambiguous
 * values are refused — the same treatment `role` and `email` get above rather
 * than a silent guess.
 */
function memberActiveRefusal(data: Record<string, unknown>): Response | null {
  if (!("active" in data)) return null;
  return readableBoolean(data.active)
    ? null
    : Response.json({ error: "A member's access must be true or false." }, { status: 400 });
}

/**
 * Exactly the values `booleanValue` can read, as a predicate.
 *
 * Two guards need this same sentence — a member's access above and a
 * contractor's place on the register below — and both need it to mean
 * precisely what `booleanValue` accepts, because everything OUTSIDE this set
 * is what falls through to that function's TRUE fallback. Written out twice it
 * would drift the first time `booleanValue` learned a new spelling, and the
 * half that drifted would be the half that silently switches somebody back on.
 */
function readableBoolean(value: unknown) {
  return (
    typeof value === "boolean" ||
    value === "true" ||
    value === "false" ||
    value === 0 ||
    value === 1
  );
}

/**
 * A contractor's place on the register, refused when it is sent something that
 * is not an answer.
 *
 * The same hole `memberActiveRefusal` closes, in the branch that never got the
 * guard. `booleanValue` falls back to TRUE, so `{ "active": null }` — and
 * `"no"`, `[]`, `"0"` and `{}` with it — did not leave an archived contractor
 * alone and did not archive them either: it put them BACK on the register, back
 * in the planned-work dropdown, and back in front of a coordinator picking
 * somebody to send to a site. Measured against a running server: archive, then
 * `PATCH { active: null }`, and the row reads `active: true` again, with a 200
 * and no complaint.
 *
 * Refused rather than coerced to false, because both guesses are wrong. The
 * caller sent something that is not a yes and is not a no; inventing either one
 * silently changes who this workspace thinks it can call out to a job.
 *
 * The accepted set is exactly what `booleanValue` reads, so anybody already
 * sending `true`, `"false"` or `1` is unaffected and only genuinely ambiguous
 * values are refused.
 */
function contractorActiveRefusal(data: Record<string, unknown>): Response | null {
  if (!("active" in data)) return null;
  return readableBoolean(data.active)
    ? null
    : Response.json(
        { error: "A contractor's active state must be true or false." },
        { status: 400 },
      );
}

/*
 * What an address has to look like before it is worth storing.
 *
 * Deliberately narrower than the member rule, which asks only for an "@" and
 * therefore accepts "@", "a@" and "@b" — none of which anybody can be written
 * to. The contractor register is where a coordinator goes at 7am to find
 * somebody who will answer, and a junk address there is worse than a blank one:
 * a blank one at least says "we do not have this", while "a@" says "here it is"
 * and then bounces.
 *
 * A local part, an "@", a domain, a dot, and a real label after it. No attempt
 * at RFC 5322 — this is a plausibility check, not a parser, and the only thing
 * it has to guarantee is that what got stored is not obviously unusable.
 */
const CONTRACTOR_EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * A contractor's email, refused when it is a string that cannot be an address.
 *
 * Three cases, and they are not the same case:
 *
 *  - key OMITTED — leave the column alone. `supplied` does that; this returns
 *    null and says nothing.
 *  - `null`, or the empty string the manage form posts for an empty box —
 *    "no email". Accepted, stored NULL. Refusing "" would make every contractor
 *    without an email unsavable, and the create form's blank record IS
 *    `email: ""` (`app/(app)/portal/workspace-data-manager.tsx`).
 *  - a NON-EMPTY string that is not an address — refused. Whitespace-only is in
 *    this half deliberately: an empty box is "no email", but a box somebody
 *    typed a space into is a claim, and " " is not an address.
 *
 * A non-string is left to `optionalText`, which stores NULL, exactly as it does
 * for `phone`, `address` and every other optional text column on this route.
 * Nothing junk is stored either way, and making email the one field that
 * refuses a number would be a rule the rest of the record does not follow.
 */
function contractorEmailRefusal(data: Record<string, unknown>): Response | null {
  if (!("email" in data)) return null;
  const raw = data.email;
  if (typeof raw !== "string" || raw === "") return null;
  const value = text(raw, 160);
  const usable =
    value !== "" && CONTRACTOR_EMAIL_SHAPE.test(value) && !INVISIBLE_CHARACTERS.test(value);
  return usable
    ? null
    : Response.json(
        { error: "A contractor's email must be a working address, or left blank." },
        { status: 400 },
      );
}

/*
 * What `day_rate_pence` can actually hold.
 *
 * The column is a 4-byte integer on Postgres — `information_schema` on the
 * staging database says `integer`, not `bigint` — and SQLite hides that
 * completely: locally, `{ "dayRate": 9e15 }` stored 900000000000000000 pence
 * and answered 200. On the deployed Postgres the same request is a driver
 * error, and the catch at the bottom of these handlers returns
 * `error.message` verbatim, so a mistyped day rate answered with the
 * database's own words instead of the route's.
 *
 * £21,474,836.47 is not a day rate anybody is refusing legitimately.
 */
const MAX_DAY_RATE_PENCE = 2_147_483_647;

/**
 * A day rate too large for the column, refused before the driver has to.
 *
 * Only the overflow. Everything `ratePence` already turns into null — an
 * empty box, a negative, a word — keeps exactly the behaviour it has, because
 * "no rate recorded" is a real answer and the register prints a dash for it.
 * This is containment of a database error, not a new opinion about rates.
 */
function contractorRateRefusal(data: Record<string, unknown>): Response | null {
  if (!("dayRate" in data)) return null;
  const pence = ratePence(data.dayRate);
  if (pence === null) return null;
  return Number.isSafeInteger(pence) && pence <= MAX_DAY_RATE_PENCE
    ? null
    : Response.json(
        { error: "A contractor's day rate is larger than this workspace can record." },
        { status: 400 },
      );
}

/* ── W06-07 — the rest of the agreed rate card ────────────────────────────── */

/**
 * The four money columns on a contractor, and the two names each answers to.
 *
 * WHY TWO NAMES. `GET /api/workspace` returns `dayRatePence`, and
 * `CONTRACTOR_NATIVE_COLUMNS` publishes that same camelCase field as the
 * register column's `nativeField` — which is the key a register cell writes
 * back through (`PATCH /api/workspace { data: { [column.nativeField]: next } }`,
 * see the note in app/lib/register-catalogue.ts). The PATCH accepted only
 * `dayRate`, in POUNDS, so the register could display the day rate and could
 * never write it: the one field whose read name and write name disagreed.
 * Sites met this first and answered it the same way — `PAYLOAD_SOURCES` there
 * takes both `serviceCharge` and `serviceChargePence` — so this is that rule
 * applied to a second register, not a second rule.
 *
 * THE TWO NAMES MEAN DIFFERENT UNITS and are read differently. Pounds is what
 * a rate card says and what the form's box holds, so it is multiplied by 100;
 * pence is already the stored integer and is only rounded. Scaling both was
 * the exact bug that multiplied a site's service charge by a hundred on every
 * ordinary read-edit-save. Pounds wins when a caller sends both, because the
 * pounds key is the form's key and the form is the surface somebody is looking
 * at.
 *
 * `otherCostPence` has `other_cost_label` beside it — a number with no name is
 * not a cost, it is a mystery — and the label is a column of its own rather
 * than a sentence appended to `notes`, because a figure nothing can read back
 * out is a figure no report can ever use.
 *
 * NOTHING SUMS THESE. They are AGREED TERMS, not money spent: spend comes from
 * job cost alone and `app/lib/contractor-attribution.ts` is pinned never to
 * mention a rate column.
 */
const CONTRACTOR_COSTS = [
  { column: "dayRatePence", pounds: "dayRate", pence: "dayRatePence", label: "day rate" },
  { column: "hourlyRatePence", pounds: "hourlyRate", pence: "hourlyRatePence", label: "hourly rate" },
  { column: "callOutCostPence", pounds: "callOutCost", pence: "callOutCostPence", label: "call-out cost" },
  { column: "otherCostPence", pounds: "otherCost", pence: "otherCostPence", label: "other cost" },
] as const;

/**
 * A figure that is ALREADY pence.
 *
 * `ratePence` scales; this only rounds. Same emptiness rule in both, and for
 * the same reason: an empty box is not a cost of zero, it is nobody having
 * recorded one, and the register prints a dash for it rather than "£0.00".
 */
function wholePence(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
}

/**
 * What this request says one cost column should hold, or `undefined` for
 * "the caller did not mention it" — which is what keeps a partial PATCH from
 * erasing a rate nobody touched. Same contract as `supplied`, widened to two
 * possible keys.
 */
function contractorCostValue(
  data: Record<string, unknown>,
  cost: (typeof CONTRACTOR_COSTS)[number],
): number | null | undefined {
  if (cost.pounds in data) return ratePence(data[cost.pounds]);
  if (cost.pence in data) return wholePence(data[cost.pence]);
  return undefined;
}

/** The `set` fragment for every cost column this request actually named. */
function contractorCostSet(data: Record<string, unknown>): Record<string, number | null> {
  const patch: Record<string, number | null> = {};
  for (const cost of CONTRACTOR_COSTS) {
    const value = contractorCostValue(data, cost);
    if (value !== undefined) patch[cost.column] = value;
  }
  return patch;
}

/**
 * A cost that is negative, or larger than the column can hold — refused.
 *
 * THE BOUND IS `MAX_DAY_RATE_PENCE`, deliberately reused rather than restated.
 * All four columns are 4-byte integers on Postgres and SQLite hides that
 * completely, so a second, differently-worded ceiling would only be a second
 * thing to keep in step.
 *
 * THE NEGATIVE HALF IS NEW, AND ONLY ON THE NEW KEYS. `dayRate` in pounds is
 * left exactly as it was — `ratePence` turns a negative, a word and an empty
 * box all into null, and `contractorRateRefusal` above is pinned by
 * `tests/workstream-six-contractor-crud.test.mjs` to keep that behaviour, so
 * widening it here would break a contract this pass has no business changing.
 * Every key that did not exist before this pass — the three new costs in both
 * spellings, and `dayRatePence` — refuses a negative instead, because a
 * call-out that costs minus forty pounds is not a term anybody agreed and
 * silently storing null for it would lose the fact that somebody typed it.
 */
function contractorCostRefusal(data: Record<string, unknown>): Response | null {
  for (const cost of CONTRACTOR_COSTS) {
    // `dayRate` is `contractorRateRefusal`'s, and keeps its own behaviour.
    for (const key of cost.pounds === "dayRate" ? [cost.pence] : [cost.pounds, cost.pence]) {
      if (!(key in data)) continue;
      const raw = data[key];
      if (raw === null || raw === undefined || raw === "") continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed < 0) {
        return Response.json(
          { error: `A contractor's ${cost.label} cannot be negative.` },
          { status: 400 },
        );
      }
      const pence = key === cost.pence ? wholePence(raw) : ratePence(raw);
      if (pence === null) continue;
      if (!Number.isSafeInteger(pence) || pence > MAX_DAY_RATE_PENCE) {
        return Response.json(
          { error: `A contractor's ${cost.label} is larger than this workspace can record.` },
          { status: 400 },
        );
      }
    }
  }
  return null;
}

/* ── W06-06 — where a contractor is ───────────────────────────────────────── */

/**
 * A postcode this register will store, or "" for "no postcode".
 *
 * DELIBERATELY NOT A UK FORMAT CHECK. `sites.country` defaults to United
 * Kingdom but is a free column, `coverage_areas` is filled with things like
 * "Europe", and the public application form asks for regions rather than
 * counties — the product admits non-UK contractors and always has. A
 * `^[A-Z]{1,2}\d…$` regex would refuse "75008", "1012 AB", "K1A 0B1" and
 * "100-0001", every one of which is a real postal code somebody would be
 * entitled to type, and the failure would look like a bug in the form rather
 * than like a policy.
 *
 * So the rule is the one a postal code of ANY country satisfies and a piece of
 * pasted junk does not: letters, digits, spaces and hyphens only, at least one
 * alphanumeric, and short. That refuses "<script>", an email address and a
 * whole street address pasted into the wrong box, which is the entire set of
 * things this can usefully catch.
 *
 * NORMALISED, NOT REWRITTEN. Runs of whitespace collapse to one space and the
 * ends are trimmed, so "SW1A  1AA " and "SW1A 1AA" stop being two postcodes.
 * The CASE is left exactly as typed: `sites.postcode` stores what it was given
 * and a second register quietly upper-casing its own copy would be two rules
 * for one kind of value.
 */
const CONTRACTOR_POSTCODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/;

function contractorPostcode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(INVISIBLE_CHARACTERS_GLOBAL, "").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/**
 * A postcode that is not one — refused.
 *
 * Three cases, the same three `contractorEmailRefusal` separates: an omitted
 * key leaves the column alone, an explicit "" or null is "no postcode" and
 * clears it, and a non-empty string that cannot be a postal code is refused
 * rather than stored. A non-string goes to null, as every other optional text
 * column on this route does.
 */
function contractorPostcodeRefusal(data: Record<string, unknown>): Response | null {
  if (!("postcode" in data)) return null;
  const raw = data.postcode;
  if (typeof raw !== "string" || raw === "") return null;
  const cleaned = contractorPostcode(raw);
  return cleaned && CONTRACTOR_POSTCODE_SHAPE.test(cleaned)
    ? null
    : Response.json(
        {
          error:
            "A contractor's postcode may only contain letters, numbers, spaces and hyphens, or be left blank.",
        },
        { status: 400 },
      );
}

/* ── W06-06 — WHAT a contractor does, said once ───────────────────────────── */

/**
 * The trades on a contractor, folded onto the configured vocabulary.
 *
 * THE PROBLEM. `service_categories` was free text split on commas, so
 * "Electrical", "electrical" and " ElectRical" were three different trades: the
 * register counted three, a filter on one found none of the others, and the
 * public application form — which offers exactly eleven fixed trades — could
 * not be matched against the register at all. `contractor_trade` is seeded in
 * `db/init.ts` with those same eleven, verbatim and in the form's order,
 * precisely so an applicant and the register mean the same thing by "Glazing".
 *
 * WHAT THIS DOES, AND WHAT IT REFUSES TO DO. A value that folds onto a
 * configured trade — case and spacing ignored — is rewritten to the set's own
 * spelling, so the three Electricals become one. A value that folds onto
 * NOTHING in the set is KEPT AS TYPED. It is not dropped and it is not a 400:
 * this column already holds years of imported free text ("Plumbing", "HVAC",
 * "Signage & graphics"), the manage form has always posted whatever was in the
 * box, and a route that started refusing those would make every one of those
 * contractors unsavable. The editor shows an unlisted value as a checked
 * option marked "(not configured)", the same way the compliance Requirement
 * select keeps a requirement recorded under a name the canonical list does not
 * have — one pattern, three screens.
 *
 * DUPLICATES GO, whether or not the set knows the word. Two spellings of one
 * trade are one trade, and this is the only place that can say so.
 */
async function contractorTradeValues(
  db: WorkspaceDb,
  orgId: string,
  value: unknown,
): Promise<string[]> {
  const submitted = stringArray(value);
  if (!submitted.length) return [];
  let configured: string[] = [];
  try {
    configured = (await listOptionValues(db, orgId, "contractor_trade")).map((row) => row.value);
  } catch {
    // No option set yet, or the read failed. Keeping what was typed is the
    // safe direction: this canonicalises, it is not the gate.
    configured = [];
  }
  const fold = (entry: string) => entry.toLowerCase().replace(/\s+/g, " ").trim();
  const canonical = new Map(configured.map((entry) => [fold(entry), entry]));
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of submitted) {
    const folded = fold(entry);
    if (!folded || seen.has(folded)) continue;
    seen.add(folded);
    kept.push(canonical.get(folded) ?? entry);
  }
  return kept;
}

/* ── W06-09 — payment TERMS, and never payment credentials ────────────────── */

/**
 * Payment terms that are not one of the configured terms — refused.
 *
 * Controlled from `contractor_payment_terms` rather than typed, for the reason
 * every other controlled column here is: "30 days", "30 Days" and "Net 30" are
 * one agreement written three ways, and nothing downstream can group them. The
 * list is seeded in `db/init.ts` and editable in Settings, so a workspace that
 * needs a seventh term adds it there — this validates against whatever is
 * configured rather than against a literal, exactly as `validateOption` does
 * for a site's type.
 *
 * "" and null CLEAR it. The column is nullable because "no terms agreed yet" is
 * a real state and the register prints a dash for it.
 *
 * WHAT IS NOT HERE, and never will be. There is no bank account number, no
 * sort code, no IBAN and no card detail on this table or in this route. The
 * approved model is terms plus an EXTERNAL reference — `finance_reference`
 * points at the supplier record in Xero, Sage, QuickBooks or an internal
 * ledger, and the credentials stay in the system that is built to hold them.
 * A maintenance portal that stored payment credentials would be a breach
 * waiting for its first misconfigured backup.
 */
async function contractorPaymentTermsRefusal(
  db: WorkspaceDb,
  orgId: string,
  data: Record<string, unknown>,
): Promise<Response | null> {
  if (!("paymentTerms" in data)) return null;
  const candidate = text(data.paymentTerms, 60);
  if (!candidate) return null;
  const configured = await listOptionValues(db, orgId, "contractor_payment_terms");
  if (configured.some((row) => row.value === candidate)) return null;
  return Response.json(
    {
      error: `"${candidate}" is not a configured payment term. Add it in Settings first.`,
      terms: configured.map((row) => row.value),
    },
    { status: 400 },
  );
}

/* ── W06-08 — an insurance expiry that is a date ──────────────────────────── */

/**
 * An insurance expiry that is not a calendar date — refused.
 *
 * `insurance_expiry` went through `optionalText(data.insuranceExpiry, 40)` on
 * BOTH create and edit, so any forty characters at all were accepted into the
 * column that decides whether a contractor's cover has lapsed. `2027-13-45`
 * stored happily; the compliance branch on this very route already runs
 * `isRealCalendarDate` and 400s on the same string, so one route held two
 * opinions about what a date is.
 *
 * The reason a malformed date is WORSE than a missing one is the whole of
 * `isRealCalendarDate`'s note: `Date.UTC(2027, 12, 45)` does not throw, it
 * rolls forward into February 2028, so a certificate filed with a typo quietly
 * acquires an expiry three months from the one anybody meant and every screen
 * agrees about it. And a date nothing can parse alerts on nothing at all,
 * while still rendering on screen as though it were fine.
 *
 * The stored value is normalised through `dateOnlyValue`, so what the register,
 * the expiry chip and any future digest read is one shape. "" and null clear
 * it, because "no cover recorded" is a real answer and an open finding.
 */
function contractorExpiryRefusal(
  data: Record<string, unknown>,
  key: string,
  subject: string,
): Response | null {
  if (!(key in data)) return null;
  const raw = visibleText(data[key], 40);
  if (!raw) return null;
  return isRealCalendarDate(raw)
    ? null
    : Response.json(
        { error: `${subject} must be a calendar date, as YYYY-MM-DD.` },
        { status: 400 },
      );
}

/** The stored form of a date column on this record: normalised, or null. */
function contractorDate(value: unknown): string | null {
  const raw = visibleText(value, 40);
  if (!raw) return null;
  return dateOnlyValue(raw) || null;
}

/* ── W06-08 — certifications with dates of their own ──────────────────────── */

/**
 * How many certificates one contractor may hold.
 *
 * A ceiling rather than a policy: the write below deletes and reinserts the
 * whole set in one request, and an unbounded list is an unbounded number of
 * statements. Forty is far past any real gas, electrical, asbestos, IPAF and
 * PASMA ticket collection and well inside what a single request should cost.
 */
const MAX_CONTRACTOR_CERTIFICATIONS = 40;

type CertificationInput = {
  id: string;
  name: string;
  reference: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  notes: string | null;
};

/**
 * The certifications this request describes, or null when it does not mention
 * them at all.
 *
 * ABSENT IS NOT EMPTY, and the distinction is the whole of the partial-PATCH
 * contract: a request that never says the word must leave every certificate
 * where it is, while `certificationEntries: []` is somebody deliberately
 * clearing the list. `supplied` makes exactly this distinction for the flat
 * columns; this is the same rule for a collection.
 */
function certificationInputs(data: Record<string, unknown>): CertificationInput[] | null {
  if (!("certificationEntries" in data)) return null;
  const raw = data.certificationEntries;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .slice(0, MAX_CONTRACTOR_CERTIFICATIONS)
    .map((entry) => ({
      // Carried through when the browser is editing a row it already has, so an
      // ordinary save is an UPDATE and the certificate keeps its identity —
      // and with it anything that ever comes to reference the row.
      id: text(entry.id, 120),
      name: visibleText(entry.name, 140),
      reference: optionalText(entry.reference, 120),
      issuedOn: contractorDate(entry.issuedOn),
      expiresOn: contractorDate(entry.expiresOn),
      notes: optionalText(entry.notes, 1000),
    }))
    .filter((entry) => entry.name !== "");
}

/**
 * A certification list this route will not store — refused.
 *
 * The dates go through `isRealCalendarDate` for the reason the insurance
 * expiry now does: a certificate's expiry is the only thing that makes its
 * status derivable, and `2027-13-45` does not fail loudly — `Date.UTC` rolls it
 * forward into February 2028, so the ticket silently acquires an expiry three
 * months from the one anybody meant.
 *
 * A nameless entry is dropped rather than refused, because the editor's own
 * empty row is exactly that and adding a row before typing in it must not be a
 * 400. A LIST that is not a list is refused, because that is a caller error
 * rather than an empty form.
 */
function contractorCertificationsRefusal(data: Record<string, unknown>): Response | null {
  if (!("certificationEntries" in data)) return null;
  const raw = data.certificationEntries;
  if (raw !== null && !Array.isArray(raw)) {
    return Response.json(
      { error: "A contractor's certifications must be a list." },
      { status: 400 },
    );
  }
  if (Array.isArray(raw) && raw.length > MAX_CONTRACTOR_CERTIFICATIONS) {
    return Response.json(
      { error: `A contractor may hold up to ${MAX_CONTRACTOR_CERTIFICATIONS} certifications.` },
      { status: 400 },
    );
  }
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    for (const [key, subject] of [
      ["issuedOn", "A certification's issue date"],
      ["expiresOn", "A certification's expiry date"],
    ] as const) {
      const refusal = contractorExpiryRefusal(record, key, subject);
      if (refusal) return refusal;
    }
  }
  return null;
}

/**
 * Write one contractor's certifications, when this request carried any.
 *
 * DELETE-THEN-WRITE ON THE ROWS THE PAYLOAD KEPT, not a wholesale wipe: an
 * entry that arrives carrying an `id` this contractor already owns is UPDATED
 * in place, so an ordinary save does not give every certificate a new identity
 * and does not reset its `created_at`. Rows the payload no longer names are the
 * ones deleted, which is what removing a line in the editor means.
 *
 * ORGANISATION-SCOPED ON EVERY STATEMENT. The caller supplies these ids, so a
 * payload could name another tenant's certification row; both predicates are on
 * the WHERE rather than trusted from the body.
 *
 * A certification is genuinely deleted rather than archived, unlike the
 * contractor who holds it. It is a claim about a piece of paper, not a party to
 * anything: no job references one, no audit line points at one, and a ticket
 * recorded by mistake should leave no trace once it is removed.
 */
async function writeContractorCertifications(
  db: WorkspaceDb,
  orgId: string,
  contractorId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const inputs = certificationInputs(data);
  if (inputs === null) return;
  const existing = await db
    .select({ id: contractorCertifications.id })
    .from(contractorCertifications)
    .where(
      and(
        eq(contractorCertifications.organisationId, orgId),
        eq(contractorCertifications.contractorId, contractorId),
      ),
    );
  const own = new Set(existing.map((row) => row.id));
  const kept = new Set(inputs.map((entry) => entry.id).filter((id) => own.has(id)));
  const now = new Date().toISOString();
  for (const row of existing) {
    if (kept.has(row.id)) continue;
    await db
      .delete(contractorCertifications)
      .where(
        and(
          eq(contractorCertifications.id, row.id),
          eq(contractorCertifications.organisationId, orgId),
        ),
      );
  }
  for (const [position, entry] of inputs.entries()) {
    const values = {
      name: entry.name,
      reference: entry.reference,
      issuedOn: entry.issuedOn,
      expiresOn: entry.expiresOn,
      notes: entry.notes,
      // The order the editor shows them in, so a list somebody arranged stays
      // arranged. Not a sort key the reader has to guess at.
      position,
      updatedAt: now,
    };
    if (own.has(entry.id)) {
      await db
        .update(contractorCertifications)
        .set(values)
        .where(
          and(
            eq(contractorCertifications.id, entry.id),
            eq(contractorCertifications.organisationId, orgId),
          ),
        );
    } else {
      await db.insert(contractorCertifications).values({
        id: newId("contractor-cert", entry.name),
        organisationId: orgId,
        contractorId,
        ...values,
      });
    }
  }
}

/**
 * The contractor this request names, as this organisation can see it — or a
 * refusal.
 *
 * TWO jobs, one SELECT, and neither is optional.
 *
 * THE TENANCY HALF. `.where(and(eq(id), eq(organisationId, orgId)))` on the
 * UPDATE already means another tenant's contractor cannot be written. What it
 * does NOT mean is that the caller is told: the statement matches no rows,
 * drizzle reports no error, and the route answered 200 `{ ok: true }` and then
 * wrote an activity row into the ACTOR's own organisation recording an update
 * that never happened, carrying the caller's payload as its detail. Measured
 * against a running server with a second tenant: a `PATCH` of another
 * organisation's contractor with `{ name: "HACKED", notes: "pwned" }` answered
 * 200, changed nothing, and put "HACKED" in the primary organisation's activity
 * feed. Zero mutation was already true. A truthful answer was not.
 *
 * 404 for both a nonexistent id and another organisation's, in the same words
 * `referenceRefusal` uses, because telling those two apart tells a caller which
 * ids exist inside a tenant they are not allowed to read.
 *
 * THE STATE HALF. The archive verb writes `active: false` AND
 * `availability: 'Inactive'` together, so the stored row is what
 * `contractorResurrectionRefusal` has to compare against. Reading it here
 * rather than in a second query keeps both checks on the same snapshot.
 */
async function contractorTarget(
  db: WorkspaceDb,
  orgId: string,
  id: string,
): Promise<
  { row: { active: boolean; availability: string }; refusal?: undefined } | { refusal: Response }
> {
  const [row] = await db
    .select({ active: contractors.active, availability: contractors.availability })
    .from(contractors)
    .where(and(eq(contractors.id, id), eq(contractors.organisationId, orgId)))
    .limit(1);
  if (!row) return { refusal: Response.json({ error: "Contractor not found." }, { status: 404 }) };
  return { row };
}

/**
 * A name that would belong to TWO contractors in one organisation — refused.
 *
 * WHY THE REGISTER NEEDS THIS, and why it is not a tidiness rule.
 *
 * A contractor's name is not a display label here; it is the JOIN KEY on the
 * only assignment surface the product has. There is no picker for a job's
 * contractor — `portal-app.tsx` edits that column as free TEXT and
 * `PATCH /api/maintenance { fields: { contractor: "<name>" } }` is the whole
 * verb — and `contractor_id` is then DERIVED from that text by
 * `resolveContractorLink`, which links only where EXACTLY ONE contractor in the
 * organisation carries the name. The tallies on both surfaces apply the same
 * rule: an ambiguous name attributes to NEITHER contractor.
 *
 * So a duplicate name does not produce a tidy register with two similar rows.
 * It produces a register that cannot say who did the work, and says nothing
 * about it. Measured against a running server: two contractors both called
 * `ZZQA-CLOSURE-C1-dup` (two 200s, no complaint), then one job assigned to that
 * name at a cost of GBP 999 — `contractor_id` came back NULL and BOTH rows read
 * `assigned 0, completed 0, urgent 0, spend 0`. A thousand pounds of work
 * vanished from the register, silently, with every request answering 200.
 *
 * ── Why the NAME and not the email ────────────────────────────────────────
 *
 * `email` is nullable, absent on most rows, and NOTHING in the product resolves
 * a contractor by it — no link, no tally, no dedup. One office address shared
 * by several trades ("info@") is an ordinary arrangement, and the monday data
 * this register was built from carries no contractor email at all. A uniqueness
 * rule there would be an invented restriction with no product behind it, so
 * there is none. Duplicate emails are accepted, exactly as they are today.
 *
 * ── Why here and not a UNIQUE INDEX ───────────────────────────────────────
 *
 * A constraint applies to every writer, including the boot seeder and the
 * importer, and to rows that already exist. There is no unique index on either
 * dialect today (`pg_constraint` on staging: pkey and the organisation FK, and
 * nothing else), a migration that fails on data somebody already has is worse
 * than no migration, and legacy pairs must stay editable rather than becoming
 * unsavable. This refuses the HUMAN path — the manage form — and leaves the
 * data alone.
 *
 * Being a check-then-insert it is not a mutual exclusion: two simultaneous
 * creates of the same name can still both land. That is why the READ side keeps
 * its ambiguity rule (`contractorsPerName` above, `nameIsUnique` in
 * `portal-app.tsx`) rather than being deleted as unreachable.
 *
 * ── Narrow on purpose, like the resurrection guard below ───────────────────
 *
 * It fires only on the TRANSITION into ambiguity. A row that already carries
 * the name is not introducing anything — the manage form posts the WHOLE record
 * on every save, so a rule that refused an unchanged name would refuse every
 * ordinary edit — and two rows that already share one stay editable rather than
 * being stranded there. The comparison is `resolveContractorLink`'s, exactly:
 * organisation-scoped, `lower(trim())` performed BY THE DATABASE, and `active`
 * deliberately not consulted, because an archived contractor still answers to
 * their name when a job is being resolved.
 */
/**
 * WHICH CONTRACTOR REGISTER A WRITE IS AIMED AT — W2.
 *
 * The three contractor verbs in this file (create, edit, archive) are the one
 * implementation of what a contractor row may contain, and they stay that way;
 * they are simply told which register they are working in. The organisation
 * comes from the session and the register from the `boards` row behind the
 * section — never from a label, a route string or anything else the caller
 * sent.
 *
 * ABSENT MEANS CANONICAL, and here that is intentional rather than a fallback:
 * `/api/workspace` IS the workspace's own registers, and every one of its
 * thirteen consumers means the canonical roster when it names no section. The
 * refusal path is what makes that safe — a section that does not exist, is
 * archived, belongs to another organisation, or holds a Jobs register is a
 * refusal with the reason, never a quiet write into the canonical roster.
 */
async function contractorScope(
  db: WorkspaceDb,
  orgId: string,
  request: Request,
): Promise<{ ok: true; scope: RegisterScope } | { ok: false; refusal: Response }> {
  const url = new URL(request.url);
  const resolved = await resolveRegisterScope(db, orgId, url, "contractors");
  const refusal = scopeRefusal(resolved);
  if (refusal) return { ok: false, refusal };
  if (!resolved.ok) {
    return { ok: false, refusal: Response.json({ error: "Unknown register." }, { status: 404 }) };
  }
  return { ok: true, scope: resolved.scope };
}

async function contractorNameConflict(
  db: WorkspaceDb,
  orgId: string,
  name: string,
  selfId: string | null,
  scope: RegisterScope = CANONICAL_REGISTER,
): Promise<Response | null> {
  const carriesName = sql`lower(trim(${contractors.name})) = lower(trim(${name}))`;
  if (selfId) {
    // Asked in SQL rather than compared in JS, so "is this the same name" is
    // answered by the same folding that will decide the link. See the module.
    const [unchanged] = await db
      .select({ id: contractors.id })
      .from(contractors)
      .where(and(eq(contractors.id, selfId), carriesName))
      .limit(1);
    if (unchanged) return null;
  }
  /*
   * WITHIN ONE REGISTER — see `contractorNameHolder`, which states the whole
   * argument. The refusal exists because `resolveContractorLink` attributes a
   * job's free-text contractor to a row by name and cannot choose between two;
   * that reasoning is entirely about one roster, and the resolver now searches
   * within one. Refusing across registers would forbid something that is safe,
   * for a reason that had stopped being true: an instance created for a
   * subcontractor network could not hold "Apex Electrical" because the
   * canonical roster does.
   */
  const [clash] = await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(
      and(
        eq(contractors.organisationId, orgId),
        registerScopeFilter(contractors.boardId, scope),
        carriesName,
        ...(selfId ? [not(eq(contractors.id, selfId))] : []),
      ),
    )
    .limit(1);
  return clash
    ? Response.json(
        {
          error:
            "Another contractor on this register is already called that. Give this one a name that tells them apart — a job assigned to a name two contractors share is counted against neither of them.",
        },
        { status: 409 },
      )
    : null;
}

/** What the archive verb writes into `availability`. Not a day-to-day state. */
const ARCHIVED_AVAILABILITY = "Inactive";

/**
 * The four states a contractor's availability can be in.
 *
 * These existed ONLY in the browser (`workspace-data-manager.tsx`, the select's
 * options). The column is plain TEXT with a default and no CHECK constraint on
 * either dialect, and the server checked only that the value was non-empty —
 * while answering a refusal that read "must be one of the offered states",
 * which was a promise nothing kept. `"Bananas"`, a 200-character string and
 * `"<script>alert(1)</script>"` all stored, and the register printed them.
 *
 * Worse, it made `contractorResurrectionRefusal` below decorative. That guard
 * asks whether the resulting availability is still `'Inactive'` — a question
 * with no force when the answer can be any string at all. `{ active: true,
 * availability: "inactive" }` differs from the marker by one capital letter,
 * was accepted, and put an archived contractor straight back on the register
 * and back into the assignment dropdown, which filters on `active` alone. So
 * the allow-list is not tidiness: it is what makes the archive guard mean
 * anything.
 *
 * Exact, case-sensitive matches, the same treatment `MEMBER_ROLES` gets, and
 * the same four strings the select offers — so every existing client is
 * unaffected and only values no screen can produce are refused.
 */
const CONTRACTOR_AVAILABILITY = ["Available", "Limited", "Unavailable", "Inactive"];

function contractorAvailabilityRefusal(data: Record<string, unknown>): Response | null {
  if (!("availability" in data)) return null;
  return CONTRACTOR_AVAILABILITY.includes(text(data.availability, 60))
    ? null
    : Response.json(
        { error: `A contractor's availability must be ${CONTRACTOR_AVAILABILITY.join(", ")}.` },
        { status: 400 },
      );
}

/**
 * An archived contractor put back on the register while still carrying the
 * marker the archive left behind — refused.
 *
 * THE CASE THIS IS FOR, found in `activity_log` rather than reasoned about:
 * contractor `contractor-test-c6cfce01` was archived on the 26th, and on the
 * 29th an ORDINARY save carrying `{ …, "availability": "Inactive",
 * "active": true }` put it back. The row still sits at `active = true,
 * availability = 'Inactive'`. Nobody decided to un-archive it; a whole-record
 * form posted the `active` it happened to be holding, and the archive was
 * undone as a side effect of editing something else on the same screen.
 *
 * The server cannot tell a stale echo from a deliberate tick — the two payloads
 * are byte-identical, and separating them needs a version token this form does
 * not send. What it CAN see is that the RESULT contradicts itself: on the
 * register, and wearing the availability that only archiving writes.
 *
 * So the rule is narrow on purpose. It fires ONLY on the transition — a stored
 * `active: false` becoming true — and only while the resulting availability is
 * still `'Inactive'`. Three things it deliberately does not do:
 *
 *  - It does not touch a row ALREADY sitting in the contradictory state. Those
 *    rows exist, and making them unsavable would strand them there.
 *  - It does not stop an operator marking an ACTIVE contractor's availability
 *    'Inactive'. That is one of the four states the Availability select offers
 *    and it is a day-to-day answer, not an archive.
 *  - It does not heal the pair by writing 'Available' itself. The Active
 *    checkbox's own hint promises availability "is not changed by ticking this
 *    box", and a guess that quietly rewrites a second column is the failure
 *    mode this whole family of fixes exists to stop. Restoring somebody to the
 *    register is a decision; this asks for it rather than making it.
 */
function contractorResurrectionRefusal(
  data: Record<string, unknown>,
  stored: { active: boolean; availability: string },
): Response | null {
  if (!("active" in data)) return null;
  if (stored.active) return null;
  if (booleanValue(data.active) !== true) return null;
  const availability =
    "availability" in data ? text(data.availability, 60) : stored.availability;
  return availability === ARCHIVED_AVAILABILITY
    ? Response.json(
        {
          error:
            "Restoring an archived contractor needs an availability. Set it to something other than 'Inactive' in the same save.",
        },
        { status: 409 },
      )
    : null;
}

export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const { actor, authenticated, db, orgId } = await scopedDb(request);
    await seedWorkspaceIfEmpty(db, orgId);
    const payload = await request.json() as { entity?: WorkspaceEntity; id?: string; data?: Record<string, unknown> };
    const entity = payload.entity;
    const id = text(payload.id, 120);
    /*
     * An object or nothing. The branches below ask `"key" in data` before
     * writing a column, and `in` throws a TypeError on a primitive, so a body
     * whose `data` was a string or a number answered with a V8 message about
     * the `in` operator instead of a refusal. An array is not a record either.
     */
    const rawData = payload.data;
    const data = rawData && typeof rawData === "object" && !Array.isArray(rawData) ? rawData : {};
    if (!entity || !id) return Response.json({ error: "A record type and ID are required." }, { status: 400 });
    const refusal = await authoriseWorkspaceWrite(db, orgId, actor, authenticated, entity);
    if (refusal) return refusal;
    if (entity === "site") {
      /*
       * Only what was sent — see `supplied`. `name`, `type`, `region`,
       * `lifecycle` and `address` are all NOT NULL on `sites`, and "" satisfies
       * NOT NULL, so the unconditional `text(data.x)` this replaces turned any
       * partial PATCH into a blanked row: a caller sending `{ lifecycle:
       * "Closed" }` erased the site's name, type, region and address and left a
       * nameless entry in the register — the one identifier `resolveSiteByName`,
       * the importer's index, Report-a-Job and the shared-form submit path all
       * key on. The manage form posts every field of the record, so nothing on
       * screen changes.
       *
       * `type`, `region` and `lifecycle` deliberately get no fallback even
       * though they are NOT NULL: the code this replaces wrote whatever arrived
       * including "", all three are fixed-option selects, and adding a default
       * would change behaviour for the full payloads the form sends.
       */
      const badName = requiredTextRefusal(data, "name", 120, "A site name is required.");
      if (badName) return badName;
      const badAddress = requiredTextRefusal(data, "address", 300, "A site address is required.");
      if (badAddress) return badAddress;
      /*
       * W05-07 — `lifecycle` IS VALIDATED, AND THE TRIO IS RECONCILED, NOT
       * PROJECTED.
       *
       * `lifecycle` is the only closed/open control this form has, and archiving
       * writes all three state columns, so writing `lifecycle` alone would leave
       * a site the Sites screen still calls closed and this tab could never
       * reopen. That much was already true. Two things were not:
       *
       *  1. NOTHING CHECKED THE VALUE. The write below used to end in
       *     `supplied(data, "lifecycle", (value) => text(value, 40))`, which
       *     stores whatever forty characters arrive. A body carrying
       *     `lifecycle: "closed"` — lower case, so it matched no branch above —
       *     was written verbatim onto a row whose `status` stayed 'active' and
       *     whose `active` stayed true. The register lists that site as open,
       *     the lifecycle column says it is shut, and nothing in the product
       *     ever disagreed out loud. `lifecycle: ""` did the same to a NOT NULL
       *     column. It is now one of two words or a 400.
       *
       *  2. CLOSING FLATTENED THE CLASSIFICATION. Choosing Closed wrote
       *     `status = 'closed'` unconditionally, so an unverified 'other' row
       *     closed from this tab lost the one column that recorded the register
       *     could not vouch for it, and moved reporting group on the way past.
       *
       * `reconcileSiteState` owns both directions now — see the long note in
       * app/lib/site-state.ts. It is handed the STORED trio, not just the
       * status, because the three columns are three separate facts and deriving
       * two of them from the third is what produced the contradiction.
       */
      let lifecycleState = {};
      if ("lifecycle" in data || "active" in data) {
        if ("lifecycle" in data && !normaliseSiteLifecycle(data.lifecycle)) {
          return Response.json({ error: siteLifecycleRefusal() }, { status: 400 });
        }
        const [current] = await db
          .select({ status: sites.status, lifecycle: sites.lifecycle, active: sites.active })
          .from(sites)
          .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)))
          .limit(1);
        if (current) {
          lifecycleState = reconcileSiteState(
            {
              ...("lifecycle" in data ? { lifecycle: data.lifecycle } : {}),
              ...("active" in data ? { active: data.active } : {}),
            },
            {
              status: current.status,
              lifecycle: current.lifecycle,
              active: Boolean(current.active),
            },
          );
        }
      }
      await db.update(sites).set({
        ...supplied(data, "name", (value) => text(value, 120)),
        ...supplied(data, "type", (value) => text(value, 40)),
        ...supplied(data, "region", (value) => text(value, 40)),
        /*
         * `lifecycleState` carries the reconciled `lifecycle` itself, so there
         * is no `supplied(data, "lifecycle", …)` here any more. Spreading the
         * raw text first and the reconciled trio second would have worked by
         * ordering alone, and a rule that holds because of the order two object
         * spreads happen to be written in is one refactor from being false.
         */
        ...lifecycleState,
        ...supplied(data, "address", (value) => text(value, 300)),
        ...supplied(data, "manager", (value) => optionalText(value, 120)),
        updatedAt: new Date().toISOString(),
      }).where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));
    } else if (entity === "compliance") {
      /*
       * THE FULL REPLACE IS DELIBERATE AND IS KEPT. The UPDATE at the end of
       * this branch names every column unconditionally, because the calendar's
       * compliance PATCH depends on it: dragging a certificate to a new date
       * sends site, requirement, state and expiry together
       * (app/(app)/portal/portal-app.tsx and `CalendarWriteTarget` in
       * calendar-model.ts, which documents why). Manage register sends the same
       * four. So the fix is NOT to make the statement partial — it is to refuse
       * the partial REQUEST, because with a full-replace statement an omitted
       * key is not a no-op, it is an erasure.
       *
       * Every key is therefore required, and every value is validated before
       * anything is written:
       *
       *  - `siteId` and `kind` were already required (a `{state}` -only PATCH
       *    used to answer 200 while blanking both).
       *  - `state` was `text(data.state, 40) || "Missing"`, so omitting it
       *    SILENTLY DOWNGRADED a Compliant document to Missing, and any string
       *    at all was accepted into the column.
       *  - `expiry` was `optionalText(data.expiry, 40)`, so omitting it CLEARED
       *    the expiry date, and "not-a-date" was stored happily — after which
       *    the compliance digest's date parser rejected it and `continue`d, so
       *    the document silently never alerted again while still rendering on
       *    screen. A malformed date is worse than a missing one.
       *  - `kind` went through `text()`, whose `trim()` does not strip
       *    zero-width characters, so a requirement named U+200B U+200B U+200B
       *    was created and rendered as nothing.
       *
       * An EXPLICIT null or "" for `expiry` still clears it. Clearing on purpose
       * is legitimate; clearing because a key was left out of a JSON body is not.
       */
      const siteId = visibleText(data.siteId, 100);
      if (!siteId) {
        return Response.json({ error: "A site is required." }, { status: 400 });
      }
      const kind = visibleText(data.kind, 120);
      if (!kind) {
        return Response.json({ error: "A requirement is required." }, { status: 400 });
      }
      if (!("state" in data)) {
        return Response.json(
          { error: "A status is required. Send the document's current status to leave it unchanged." },
          { status: 400 },
        );
      }
      const state = visibleText(data.state, 40);
      if (!isComplianceState(state)) {
        return Response.json(
          { error: `A status must be one of: ${COMPLIANCE_STATES.join(", ")}.` },
          { status: 400 },
        );
      }
      if (!("expiry" in data)) {
        return Response.json(
          { error: "An expiry date is required. Send null to clear it." },
          { status: 400 },
        );
      }
      const rawExpiry = visibleText(data.expiry, 40);
      /*
       * Normalised through the platform's own parser, so what is stored is what
       * every reader — the register, the digest, the calendar, the board cells —
       * will agree it is. `dateOnlyValue` returns "" for anything it cannot read.
       */
      const expiry = rawExpiry && isRealCalendarDate(rawExpiry) ? dateOnlyValue(rawExpiry) : "";
      if (rawExpiry && !expiry) {
        return Response.json(
          { error: "An expiry date must be a calendar date, as YYYY-MM-DD." },
          { status: 400 },
        );
      }
      const badReference = await referencesRefusal(db, orgId, [
        { kind: "site", value: siteId },
      ]);
      if (badReference) return badReference;
      await db.update(complianceDocuments).set({ siteId, kind, status: state, expiryDate: expiry || null, notRequired: state === "Not required", updatedAt: new Date().toISOString() }).where(and(eq(complianceDocuments.id, id), eq(complianceDocuments.organisationId, orgId)));
    } else if (entity === "unit") {
      /*
       * Only what was sent — see `supplied`. `siteId`, `name`, `category` and
       * `status` are NOT NULL, so a partial PATCH used to blank them, and a
       * blanked `site_id` detaches the unit from its site entirely. Validating
       * the site while the same statement could silently empty it would be
       * incoherent, so both land together.
       */
      const badName = requiredTextRefusal(data, "name", 140, "A unit name is required.");
      if (badName) return badName;
      const badSite = requiredTextRefusal(data, "siteId", 100, "A site is required.");
      if (badSite) return badSite;
      // Before the update, so a refusal writes nothing. See `referenceRefusal`.
      const badReference = await referencesRefusal(db, orgId, [
        { kind: "site", value: "siteId" in data ? text(data.siteId, 100) : null },
      ]);
      if (badReference) return badReference;
      await db.update(units).set({
        ...supplied(data, "siteId", (value) => text(value, 100)),
        ...supplied(data, "name", (value) => text(value, 140)),
        ...supplied(data, "category", (value) => text(value, 80)),
        ...supplied(data, "manufacturer", (value) => optionalText(value, 100)),
        ...supplied(data, "model", (value) => optionalText(value, 100)),
        ...supplied(data, "serialNumber", (value) => optionalText(value, 100)),
        ...supplied(data, "status", (value) => text(value, 40)),
        ...supplied(data, "notes", (value) => optionalText(value, 500)),
        updatedAt: new Date().toISOString(),
      }).where(and(eq(units.id, id), eq(units.organisationId, orgId)));
    } else if (entity === "contractor") {
      /* The register this edit is aimed at, resolved before anything is read
         or written — so a refusal changes nothing, and an id belonging to
         another register is simply not found. */
      const editScope = await contractorScope(db, orgId, request);
      if (!editScope.ok) return editScope.refusal;
      /*
       * NOT IN THIS REGISTER IS A 404, NOT A QUIET NO-OP.
       *
       * The register is in the UPDATE's predicate below, so a row belonging to
       * another register was already safe from being written — but the request
       * answered 200 having changed nothing, which tells a caller its edit
       * landed. Asked here instead, so the answer is the truth: this register
       * does not have that contractor.
       */
      const editable = await getContractor(db, orgId, id, editScope.scope);
      if (!editable) {
        /* THE SAME WORDS AS THE TENANCY REFUSAL, deliberately. Both are 404, and
           saying "not on this register" where the other says "not found" would
           tell a caller which boundary it hit — that the id exists in their
           organisation but in a register they were not asking about. The
           surrounding code already refuses to answer a cross-tenant id with a
           fact about somebody else's workspace; this is the same rule one level
           in. */
        return Response.json({ error: "Contractor not found." }, { status: 404 });
      }
      /*
       * `supplied` fixed omission. It does not fix a key that was SENT
       * carrying nothing, and three of these columns are NOT NULL, so the
       * five guards below are what stops a 200 writing a row the register
       * cannot use. Every one of them was measured against a running server
       * before it was written; see the note on each function.
       *
       * `name` is the same rule site, unit, planned and member already apply,
       * and it matters more here than the wording suggests: the workspace GET
       * tallies jobs by contractor NAME, not by id, so a blanked name does
       * not just leave a nameless row — it detaches every job that contractor
       * has ever been sent to.
       *
       * `availability` is NOT NULL with a four-label select behind it, and
       * `text(null, 60)` is "", so `{ availability: null }` wrote an empty
       * string into a column whose whole purpose is to say which of four
       * states this is. "" is none of them, and the register prints it as a
       * blank beside the name. Refused rather than defaulted to "Available",
       * because a contractor who cannot take work this week must not be
       * silently advertised as free.
       */
      const badName = requiredTextRefusal(data, "name", 140, "A contractor name is required.");
      if (badName) return badName;
      // The allow-list, not a non-empty check. The old refusal SAID "one of the
      // offered states" and enforced no such thing — see CONTRACTOR_AVAILABILITY.
      const badAvailability = contractorAvailabilityRefusal(data);
      if (badAvailability) return badAvailability;
      const badActive = contractorActiveRefusal(data);
      if (badActive) return badActive;
      const badEmail = contractorEmailRefusal(data);
      if (badEmail) return badEmail;
      const badRate = contractorRateRefusal(data);
      if (badRate) return badRate;
      /*
       * W06-06/07/08 — the four guards the create runs, run here too and in the
       * same order, so neither path can end up stricter than the other.
       *
       * `contractorExpiryRefusal` is the one that closes a hole rather than
       * adding a rule: `insurance_expiry` was `optionalText(…, 40)` here, so
       * any forty characters were accepted into the column that says whether a
       * contractor's cover has lapsed — and a date nothing can parse alerts on
       * nothing while still rendering on screen as though it were fine.
       */
      const badCost = contractorCostRefusal(data);
      if (badCost) return badCost;
      const badPostcode = contractorPostcodeRefusal(data);
      if (badPostcode) return badPostcode;
      const badExpiry = contractorExpiryRefusal(
        data,
        "insuranceExpiry",
        "A contractor's insurance expiry",
      );
      if (badExpiry) return badExpiry;
      const badCertifications = contractorCertificationsRefusal(data);
      if (badCertifications) return badCertifications;
      // The row as this organisation can see it, or a 404. Before the update,
      // so a cross-tenant id refuses instead of answering 200 and logging a
      // change that never happened. See `contractorTarget`.
      const target = await contractorTarget(db, orgId, id);
      if (target.refusal) return target.refusal;
      const badRestore = contractorResurrectionRefusal(data, target.row);
      if (badRestore) return badRestore;
      /*
       * AFTER the 404, deliberately. Asking about a name before establishing
       * that the caller may see this row at all would answer a cross-tenant id
       * with a 409 about a name in the ACTOR's organisation, which is a fact
       * about somebody else's workspace leaking through the wrong door.
       *
       * Only when `name` is part of the write, and `contractorNameConflict`
       * then does nothing when the row already carries it — the manage form
       * posts the whole record, so every ordinary save arrives with a name.
       */
      if ("name" in data) {
        const badRename = await contractorNameConflict(
          db,
          orgId,
          text(data.name, 140),
          id,
          editScope.scope,
        );
        if (badRename) return badRename;
      }
      /*
       * W06-09 — the payment term is checked against the CONFIGURED list, so it
       * needs a read. After the 404 for the same reason the rename check is:
       * answering a cross-tenant id with a list of this organisation's terms is
       * a fact about somebody else's workspace leaking through the wrong door.
       */
      const badTerms = await contractorPaymentTermsRefusal(db, orgId, data);
      if (badTerms) return badTerms;
      /*
       * The canonical trades, read before the statement rather than inside it:
       * `supplied` is synchronous by design and this needs the option list. An
       * absent `serviceCategories` yields an empty fragment, so a PATCH that
       * never mentions trades still leaves them alone.
       */
      const tradePatch = "serviceCategories" in data
        ? {
            serviceCategories: JSON.stringify(
              await contractorTradeValues(db, orgId, data.serviceCategories),
            ),
          }
        : {};
      await db.update(contractors).set({
        // Only what was sent — see `supplied`. A partial PATCH used to blank
        // every column it did not mention.
        ...supplied(data, "name", (value) => text(value, 140)),
        ...supplied(data, "email", (value) => optionalText(value, 160)),
        ...supplied(data, "phone", (value) => optionalText(value, 80)),
        /*
         * Capped like `phone`, and behind `supplied` like everything else here:
         * a PATCH that never mentions the WhatsApp number must not blank one
         * somebody recorded. Stored exactly as typed — the decision about
         * whether it can be turned into a wa.me link belongs to
         * `app/lib/contact-links.ts` at render time, which refuses rather than
         * inventing a country code. Nothing copies `phone` in here.
         */
        ...supplied(data, "whatsappNumber", (value) => optionalText(value, 80)),
        ...supplied(data, "contactName", (value) => optionalText(value, 140)),
        ...supplied(data, "address", (value) => optionalText(value, 240)),
        /*
         * W06-06 — the postcode `address` could not hold. Behind `supplied`
         * like everything else: an absent key preserves what is stored, and an
         * explicit "" clears it, which is how a contractor who moves and has
         * not said where yet is recorded honestly.
         */
        ...supplied(data, "postcode", contractorPostcode),
        ...supplied(data, "notes", (value) => optionalText(value, 2000)),
        /*
         * W06-07 — all four agreed costs, each from whichever of its two
         * spellings the caller sent. `dayRate` (pounds) is still accepted and
         * still wins; `dayRatePence` now works too, which is what makes
         * `nativeField` usable as a write key from the register.
         *
         * This replaces `...("dayRate" in data ? { dayRatePence: ratePence(…) } : {})`
         * — one column's special case grown into the rule for all four. See
         * `CONTRACTOR_COSTS`.
         */
        ...contractorCostSet(data),
        // The name that makes the figure above legible. Never `notes`: a cost
        // whose label is buried in prose is a cost no report can read back.
        ...supplied(data, "otherCostLabel", (value) => optionalText(value, 80)),
        /*
         * W06-09 — terms, and a pointer at the ledger that holds the rest.
         * `paymentTerms` has already been checked against the configured set;
         * "" clears it, because "no terms agreed" is a real state.
         */
        ...supplied(data, "paymentTerms", (value) => optionalText(value, 60)),
        ...supplied(data, "financeReference", (value) => optionalText(value, 80)),
        // W06-06 — folded onto `contractor_trade` before storage. Awaited above
        // the statement because `supplied` is synchronous and this is a read.
        ...tradePatch,
        ...supplied(data, "coverageAreas", (value) => JSON.stringify(stringArray(value))),
        ...supplied(data, "certifications", (value) => JSON.stringify(stringArray(value))),
        // Normalised through `dateOnlyValue` rather than stored as typed, so
        // every reader of this column sees one shape. Validated above.
        ...supplied(data, "insuranceExpiry", contractorDate),
        /*
         * W06-08 — who the cover is with, and under which policy. A date on its
         * own can say when something ends and never what ended, which is why
         * chasing a lapsed certificate used to begin with a phone call asking
         * who the broker was.
         */
        ...supplied(data, "insurerName", (value) => optionalText(value, 160)),
        ...supplied(data, "policyNumber", (value) => optionalText(value, 80)),
        ...supplied(data, "insuranceNotes", (value) => optionalText(value, 1000)),
        ...supplied(data, "availability", (value) => text(value, 60)),
        ...supplied(data, "rating", optionalRating),
        // `booleanValue` still falls back to TRUE, and that fallback is now
        // unreachable: `contractorActiveRefusal` above has already refused
        // everything this cannot read. Same arrangement as the member branch.
        ...supplied(data, "active", booleanValue),
        updatedAt: new Date().toISOString(),
      }).where(
        and(
          eq(contractors.id, id),
          eq(contractors.organisationId, orgId),
          /* AN ID IS AN ADDRESS, NOT A CREDENTIAL. Without the register in the
             predicate, an id seen once on an instance could be edited through
             the canonical screen by anyone who remembered it. */
          registerScopeFilter(contractors.boardId, editScope.scope),
        ),
      );
      /*
       * W06-08 — the certifications, after the row and inside the same 404.
       * `contractorTarget` above has already established that this contractor
       * belongs to the caller's organisation, so this cannot write rows against
       * somebody else's id; every statement carries the organisation anyway.
       * An absent `certificationEntries` writes nothing at all.
       */
      await writeContractorCertifications(db, orgId, id, data);
    } else if (entity === "planned") {
      /*
       * Only what was sent — see `supplied`. Every column here except `unitId`,
       * `contractorId` and `lastCompletedAt` is NOT NULL, so a partial PATCH
       * used to strip a scheduled visit of its title, category, frequency AND
       * next due date, which takes it off the calendar entirely. As with units,
       * validating the references while the same statement could silently empty
       * them would be incoherent, so both land together.
       */
      const badTitle = requiredTextRefusal(data, "title", 160, "A planned task title is required.");
      if (badTitle) return badTitle;
      const badSite = requiredTextRefusal(data, "siteId", 100, "A site is required.");
      if (badSite) return badSite;
      const badDue = requiredTextRefusal(data, "nextDueAt", 40, "A next due date is required.");
      if (badDue) return badDue;
      /*
       * `unitId` and `contractorId` are nullable and "" is how the form says
       * "none", so `referencesRefusal` skips an empty value — clearing a
       * contractor still works.
       */
      const badReference = await referencesRefusal(db, orgId, [
        { kind: "site", value: "siteId" in data ? text(data.siteId, 100) : null },
        { kind: "unit", value: "unitId" in data ? optionalText(data.unitId, 100) : null },
        { kind: "contractor", value: "contractorId" in data ? optionalText(data.contractorId, 100) : null },
      ]);
      if (badReference) return badReference;
      await db.update(plannedMaintenance).set({
        ...supplied(data, "siteId", (value) => text(value, 100)),
        ...supplied(data, "unitId", (value) => optionalText(value, 100)),
        ...supplied(data, "contractorId", (value) => optionalText(value, 100)),
        ...supplied(data, "title", (value) => text(value, 160)),
        ...supplied(data, "category", (value) => text(value, 80)),
        ...supplied(data, "frequency", (value) => text(value, 60)),
        ...supplied(data, "nextDueAt", (value) => text(value, 40)),
        ...supplied(data, "lastCompletedAt", (value) => optionalText(value, 40)),
        ...supplied(data, "status", (value) => text(value, 40)),
        ...supplied(data, "reminderDays", (value) => numeric(value, 30, 0, 365)),
        updatedAt: new Date().toISOString(),
      }).where(and(eq(plannedMaintenance.id, id), eq(plannedMaintenance.organisationId, orgId)));
    } else if (entity === "member") {
      /*
       * Only what was sent — see `supplied`. `users.email` is NOT NULL and
       * UNIQUE and `users.role` is NOT NULL, so the unconditional
       * `text(data.x)` this replaces turned any partial PATCH into a wrecked
       * account: pausing somebody with `{ active: false }` blanked their email
       * to "", which the unique index accepts exactly once — so the SECOND
       * member paused that way answered 400 with a raw constraint error — and
       * blanked their role and their name alongside it.
       *
       * `active` was worse than the text columns rather than better.
       * `booleanValue` falls back to TRUE, so a PATCH that mentioned only the
       * name silently RESTORED access to somebody whose access had been
       * withdrawn. It is the one field here where the fallback is the opposite
       * of what the caller asked for.
       *
       * The payload key is `name` and the column is `fullName`, so that one
       * cannot go through `supplied`, which spreads the key it is given — the
       * same reason `dayRate` is spelled out in the contractor branch above.
       */
      const badName = requiredTextRefusal(data, "name", 120, "A member name is required.");
      if (badName) return badName;
      /*
       * The rule the create above already applies. A member with no working
       * address is one nobody can invite, notify or send a reset to, and the
       * column is this workspace's only unique handle on a person. Conditional
       * on the key being present, because an omitted `email` now means "leave
       * it" rather than ""; "" fails `includes("@")` too, so one check covers
       * the blank and the malformed alike.
       */
      if ("email" in data && !text(data.email, 180).includes("@")) {
        return Response.json({ error: "A valid email is required." }, { status: 400 });
      }
      // Before the update, so a refusal writes nothing. See `memberRoleRefusal`.
      const badRole = memberRoleRefusal(data);
      if (badRole) return badRole;
      const badAccess = memberActiveRefusal(data);
      if (badAccess) return badAccess;
      await db.update(users).set({
        ...("name" in data ? { fullName: text(data.name, 120) } : {}),
        ...supplied(data, "email", (value) => text(value, 180).toLowerCase()),
        ...supplied(data, "role", (value) => text(value, 60)),
        ...supplied(data, "active", booleanValue),
        updatedAt: new Date().toISOString(),
      }).where(and(eq(users.id, id), eq(users.organisationId, orgId)));
    } else if (entity === "settings") {
      const settings = data as unknown as WorkspaceSettings;
      await db.insert(workspaceSettings).values({ legacyClientId: orgId, organisationId: orgId, settings: JSON.stringify(settings), updatedByEmail: actor.email, updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: workspaceSettings.organisationId, set: { settings: JSON.stringify(settings), updatedByEmail: actor.email, updatedAt: new Date().toISOString() } });
    } else {
      return Response.json({ error: "Unsupported workspace record." }, { status: 400 });
    }

    await logChange(db, orgId, entity, id, "updated", actor.email, data);
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The record could not be updated.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const { actor, authenticated, db, orgId } = await scopedDb(request);
    await seedWorkspaceIfEmpty(db, orgId);
    const payload = await request.json() as { entity?: WorkspaceEntity; id?: string };
    const entity = payload.entity;
    const id = text(payload.id, 120);
    if (!entity || !id) return Response.json({ error: "A record type and ID are required." }, { status: 400 });
    const refusal = await authoriseWorkspaceWrite(
      db,
      orgId,
      actor,
      authenticated,
      entity,
      entity === "member" ? "deactivate" : "write",
    );
    if (refusal) return refusal;
    /*
     * Archiving somebody else's contractor answered 200 `{ ok: true }`.
     *
     * The UPDATE below is organisation-scoped, so it changed nothing — proved
     * against a running server with a second tenant, the row came back
     * byte-identical. But the caller was told it worked, and `logChange` at
     * the bottom then filed an "archived" entry against another tenant's id in
     * THIS organisation's activity feed. An audit trail that records archives
     * that did not happen is worse than one that records nothing.
     *
     * Contractors only. The same silent 200 is true of every branch here and
     * closing it everywhere is a change to five other screens' error handling;
     * this is the register that was audited. See `contractorTarget`.
     */
    if (entity === "contractor") {
      const target = await contractorTarget(db, orgId, id);
      if (target.refusal) return target.refusal;
    }
    /*
     * All three state columns, in the order `DELETE /api/sites` writes them.
     * Archiving here used to set `lifecycle` alone, leaving `status` at
     * 'active' and `active` at true, so an archived site stayed in every
     * surface that filters on those two — `app/lib/form-options.ts` offers it
     * on the public Location dropdown, the Sites screen files it under Active
     * and still shows a Close button, and the options tally counts it against
     * 'active'. 'closed' is the seeded site_status option, and this is the
     * literal `app/api/sites/route.ts` already writes.
     */
    /*
     * W05-07 — the closure goes through the same reconciliation as every other
     * one, so a row the register cannot vouch for keeps saying so.
     *
     * The literal `status: "closed"` this replaces was right for the case it
     * was written for and wrong for 'other': archiving an unverified legacy row
     * rewrote the only column recording that it WAS unverified, and moved it
     * from the Other reporting group into Closed on the way. `reconcileSiteState`
     * still writes `{ closed, Closed, false }` for an active or international
     * site — that behaviour is unchanged and asserted — and writes
     * `{ other, Closed, false }` for an 'other' one.
     */
    if (entity === "site") {
      const [current] = await db
        .select({ status: sites.status, lifecycle: sites.lifecycle, active: sites.active })
        .from(sites)
        .where(and(eq(sites.id, id), eq(sites.organisationId, orgId)))
        .limit(1);
      const closed = reconcileSiteState(
        { lifecycle: "Closed" },
        current
          ? { status: current.status, lifecycle: current.lifecycle, active: Boolean(current.active) }
          : { status: "active", lifecycle: "Current", active: true },
      );
      await db.update(sites).set({ ...closed, updatedAt: new Date().toISOString() }).where(and(eq(sites.id, id), eq(sites.organisationId, orgId)));
    } else if (entity === "compliance") await db.update(complianceDocuments).set({ status: "Not required", notRequired: true, updatedAt: new Date().toISOString() }).where(and(eq(complianceDocuments.id, id), eq(complianceDocuments.organisationId, orgId)));
    else if (entity === "unit") await db.update(units).set({ status: "Retired", updatedAt: new Date().toISOString() }).where(and(eq(units.id, id), eq(units.organisationId, orgId)));
    else if (entity === "contractor") {
      /* Same register check as the edit, and for the same reason: inactivating
         somebody else's contractor through this screen would be a write across
         registers, which is the isolation this workstream exists to hold. */
      const archiveScope = await contractorScope(db, orgId, request);
      if (!archiveScope.ok) return archiveScope.refusal;
      /* Same as the edit: a contractor this register does not hold is a 404
         rather than a 200 that archived nothing. */
      const archivable = await getContractor(db, orgId, id, archiveScope.scope);
      if (!archivable) {
        /* THE SAME WORDS AS THE TENANCY REFUSAL, deliberately. Both are 404, and
           saying "not on this register" where the other says "not found" would
           tell a caller which boundary it hit — that the id exists in their
           organisation but in a register they were not asking about. The
           surrounding code already refuses to answer a cross-tenant id with a
           fact about somebody else's workspace; this is the same rule one level
           in. */
        return Response.json({ error: "Contractor not found." }, { status: 404 });
      }
      await db
        .update(contractors)
        .set({ active: false, availability: "Inactive", updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(contractors.id, id),
            eq(contractors.organisationId, orgId),
            registerScopeFilter(contractors.boardId, archiveScope.scope),
          ),
        );
    }
    else if (entity === "planned") await db.update(plannedMaintenance).set({ status: "Cancelled", updatedAt: new Date().toISOString() }).where(and(eq(plannedMaintenance.id, id), eq(plannedMaintenance.organisationId, orgId)));
    else if (entity === "member") await db.update(users).set({ active: false, updatedAt: new Date().toISOString() }).where(and(eq(users.id, id), eq(users.organisationId, orgId)));
    else return Response.json({ error: "This record cannot be archived." }, { status: 400 });

    await logChange(db, orgId, entity, id, "archived", actor.email, {});
    return Response.json({ ok: true, id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The record could not be archived.";
    return Response.json({ error: message }, { status: 400 });
  }
}
