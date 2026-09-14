/**
 * `GET|POST|PATCH /api/job-types` — an organisation's job types, and the only
 * door through which they change.
 *
 * The shapes are `job-type-contract.ts`; the table and its seed are
 * `job_type_config` and `seedJobTypes` in `db/init.ts`; reading and resolving a
 * job's type are `app/lib/job-types.ts`. This route is the administration half:
 * Settings → Job types reads it and writes through it, and nothing else writes
 * `job_type_config` after the seed.
 *
 * ── WHO MAY DO WHAT ───────────────────────────────────────────────────────
 *
 * GET is `board.view`, because every screen that shows a job has to be able to
 * name its type — a retired one included, which is why GET returns deactivated
 * types too. Creating, renaming, recolouring, deactivating and reordering are
 * `settings.edit`: a rename changes the words on every job, every Reports
 * figure and every export at once, which is an administrative act rather than a
 * per-record edit — the same line `/api/calendar/status-map` draws.
 *
 * ── WHAT A WRITE CAN NEVER DO ─────────────────────────────────────────────
 *
 *   · DELETE A TYPE. There is no DELETE handler. A job filed under a type keeps
 *     it for ever; deactivation (`deactivated_at`) hides a type from NEW
 *     selection and nothing else, so a retired type still names its jobs and
 *     still counts in Reports.
 *   · CHANGE A CODE. `code` is the stable meaning of the three defaults —
 *     Reports' Reactive / Planned / Projects KPIs group by it — so "Project"
 *     may be renamed "Capital works" and every figure stays where it was. A
 *     request that names a `code` is refused rather than ignored, so nobody is
 *     told a change happened that did not.
 *   · TOUCH A JOB. Not one statement here writes `maintenance_requests`. A job
 *     stores the type's id, and the id survives every rename.
 *   · CROSS A TENANT. Every read names the organisation, and every write is
 *     `WHERE organisation_id = <caller's org> AND id = ?`, so an id from another
 *     workspace matches nothing and is answered exactly like an unknown one.
 *
 * Every write is recorded twice over: `updated_by_email` on the row, and one
 * `recordAudit` event with the actor, the request and the before/after.
 */

import { and, eq } from "drizzle-orm";
import { ensureDatabase } from "../../../db/init";
import { jobTypeConfig } from "../../../db/schema";
import { auditActor, changeDetail, recordAudit } from "../../lib/audit";
import type { JobType } from "../../lib/job-type-contract";
import { listJobTypes } from "../../lib/job-types";
import {
  anonymousRefusal,
  busyRefusal,
  scopedDbWithCapability,
  type ScopedDatabase,
} from "../../lib/tenant-db";

export const dynamic = "force-dynamic";

/* jt:validate:start
 *
 * THE RULES A NAME, A COLOUR AND AN ORDER MUST MEET.
 *
 * Self-contained on purpose — nothing between the two markers imports
 * anything — so `tests/job-types.test.mjs` can slice this block out of the
 * file, transpile it and exercise it without booting drizzle or the database.
 * The same arrangement as `ovt:similarity` in `/api/overview/contractor-aliases`.
 */

/** Longest a job type's name may be. Refused on write, never truncated. */
export const JOB_TYPE_LABEL_LIMIT = 60;

/**
 * How many types one organisation may hold, deactivated ones included.
 *
 * Types are never deleted, so without a ceiling the list only grows. Fifty is
 * far past any real classification and small enough that the Settings card, the
 * pickers and a reorder (one statement per row) stay cheap.
 */
export const JOB_TYPE_LIMIT = 50;

/** The "is this name taken" key: trimmed, lower-cased, inner whitespace collapsed. */
export function jobTypeLabelKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A name as it will be stored — trimmed, inner whitespace collapsed — or why not. */
export function readJobTypeLabel(
  value: unknown,
): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "Give the job type a name." };
  const label = value.trim().replace(/\s+/g, " ");
  if (!label) return { ok: false, error: "Give the job type a name." };
  if (label.length > JOB_TYPE_LABEL_LIMIT) {
    return {
      ok: false,
      error: `A job type's name can be at most ${JOB_TYPE_LABEL_LIMIT} characters.`,
    };
  }
  return { ok: true, label };
}

/**
 * `#RRGGBB`, or null to clear. A colour is written into inline style wherever a
 * chip is drawn, so it is validated here rather than trusted there.
 */
export function readJobTypeColour(
  value: unknown,
): { ok: true; colourHex: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") return { ok: true, colourHex: null };
  const raw = typeof value === "string" ? value.trim() : "";
  if (!/^#[0-9a-fA-F]{6}$/.test(raw)) {
    return { ok: false, error: "Use a #RRGGBB colour, or leave it empty." };
  }
  return { ok: true, colourHex: raw.toUpperCase() };
}

/**
 * Whether `label` already names another ACTIVE type.
 *
 * Active only: a retired "Emergency" does not stop somebody creating a new one,
 * because only one of the two can ever be offered. Reactivating the retired one
 * is then refused until one of them is renamed — see the route.
 */
export function jobTypeLabelTaken(
  types: ReadonlyArray<{ id: string; label: string; active: boolean }>,
  label: string,
  exceptId: string | null,
): boolean {
  const key = jobTypeLabelKey(label);
  return types.some((type) => type.active && type.id !== exceptId && jobTypeLabelKey(type.label) === key);
}

/**
 * The organisation's whole order after `{ order: [id, …] }`.
 *
 * The ids named come first, in the order named; every type NOT named keeps its
 * place relative to the others after them — so a screen that lists only the
 * active types can reorder those without scattering the retired ones. An id this
 * organisation does not hold is refused (404, the same answer as an unknown id
 * anywhere else here), never skipped: a reorder that silently dropped half its
 * list would save something nobody asked for.
 */
export function planJobTypeOrder(
  current: ReadonlyArray<{ id: string }>,
  requested: unknown,
): { ok: true; order: string[] } | { ok: false; error: string; status: number } {
  if (!Array.isArray(requested) || requested.length === 0) {
    return { ok: false, error: "Send the job type ids in the order they should appear.", status: 400 };
  }
  if (requested.length > 200) {
    return { ok: false, error: "That order names more job types than a workspace can hold.", status: 400 };
  }
  const known = new Set(current.map((type) => type.id));
  const named: string[] = [];
  const seen = new Set<string>();
  for (const entry of requested) {
    const id = typeof entry === "string" ? entry.trim() : "";
    if (!id) return { ok: false, error: "Every entry in the order must be a job type id.", status: 400 };
    if (seen.has(id)) return { ok: false, error: "The order names one job type twice.", status: 400 };
    if (!known.has(id)) return { ok: false, error: "That job type does not exist in this workspace.", status: 404 };
    seen.add(id);
    named.push(id);
  }
  return { ok: true, order: [...named, ...current.map((type) => type.id).filter((id) => !seen.has(id))] };
}
/* jt:validate:end */

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

function notFound() {
  /* One answer for "no such type" and "another tenant's type" — the same rule
     `resolveJobTypeWrite` follows, and for the same reason: a different message
     would confirm that another workspace's id exists. */
  return Response.json({ error: "That job type does not exist in this workspace." }, { status: 404 });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** What a type looks like in an audit diff — the facts a reader cares about, not the row. */
function auditShape(type: JobType) {
  return {
    label: type.label,
    colourHex: type.colourHex,
    active: type.active,
    sortOrder: type.sortOrder,
  };
}

function writerEmail(scope: ScopedDatabase) {
  return scope.identityEmail ? scope.identityEmail.toLowerCase() : null;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    /* Read-only. No seeding here: `ensureDatabase` seeds every active
       organisation at boot and `/api/context` seeds a client when it is
       created, so a GET never has a reason to write. */
    const guarded = await scopedDbWithCapability(request, "board.view");
    if (guarded.denied) return guarded.denied;
    const { db, orgId } = guarded.scope;
    return Response.json({ jobTypes: await listJobTypes(db, orgId) });
  } catch (error) {
    return failure(error, "The job types could not be read.");
  }
}

/** Add a custom type: a name, optionally a colour. Custom types have no code. */
export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const guarded = await scopedDbWithCapability(request, "settings.edit");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const body = await readBody(request);
    if (!body) return badRequest("Send a JSON body.");
    if ("code" in body) {
      return badRequest("A new job type has no code — the three defaults own theirs.");
    }
    const label = readJobTypeLabel(body.label);
    if (!label.ok) return badRequest(label.error);
    const colour = readJobTypeColour(body.colourHex);
    if (!colour.ok) return badRequest(colour.error);

    const types = await listJobTypes(scope.db, scope.orgId);
    if (types.length >= JOB_TYPE_LIMIT) {
      return Response.json(
        {
          error: `A workspace can hold ${JOB_TYPE_LIMIT} job types. Rename or reactivate one you already have.`,
        },
        { status: 409 },
      );
    }
    if (jobTypeLabelTaken(types, label.label, null)) {
      return Response.json({ error: `"${label.label}" is already a job type here.` }, { status: 409 });
    }

    const id = `jt_${crypto.randomUUID().replace(/-/g, "")}`;
    const at = new Date().toISOString();
    /* After the last, deactivated types included, so a new type never lands in
       the middle of the list somebody arranged. */
    const sortOrder = types.reduce((highest, type) => Math.max(highest, type.sortOrder), 0) + 10;
    await scope.db.insert(jobTypeConfig).values({
      id,
      organisationId: scope.orgId,
      code: null,
      label: label.label,
      colourHex: colour.colourHex,
      sortOrder,
      createdAt: at,
      updatedAt: at,
      updatedByEmail: writerEmail(scope),
    });

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "job_type.created",
      entityType: "job_type",
      entityId: id,
      summary: `Added the job type "${label.label}".`,
      detail: { label: label.label, colourHex: colour.colourHex, sortOrder },
      request,
    });

    const jobTypes = await listJobTypes(scope.db, scope.orgId);
    return Response.json(
      { ok: true, jobType: jobTypes.find((type) => type.id === id) ?? null, jobTypes },
      { status: 201 },
    );
  } catch (error) {
    return failure(error, "The job type could not be added.");
  }
}

/**
 * Change one type — `{ id, label?, colourHex?, active?, sortOrder? }` — or the
 * whole order — `{ order: [id, …] }`. Omitted is unchanged, the convention every
 * write path here follows.
 */
export async function PATCH(request: Request) {
  try {
    await ensureDatabase();
    const guarded = await scopedDbWithCapability(request, "settings.edit");
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;

    const body = await readBody(request);
    if (!body) return badRequest("Send a JSON body.");
    if ("code" in body) {
      return badRequest("A job type's code never changes. Rename it instead — its figures follow the code.");
    }

    const types = await listJobTypes(scope.db, scope.orgId);
    if ("order" in body) return reorder(request, scope, types, body.order);

    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return badRequest("Name the job type to change.");
    const current = types.find((type) => type.id === id);
    if (!current) return notFound();

    const at = new Date().toISOString();
    const next: JobType = { ...current };
    const patch: Partial<typeof jobTypeConfig.$inferInsert> = {};
    let recognised = false;

    if ("label" in body) {
      recognised = true;
      const label = readJobTypeLabel(body.label);
      if (!label.ok) return badRequest(label.error);
      if (label.label !== current.label) {
        next.label = label.label;
        patch.label = label.label;
      }
    }
    if ("colourHex" in body) {
      recognised = true;
      const colour = readJobTypeColour(body.colourHex);
      if (!colour.ok) return badRequest(colour.error);
      if (colour.colourHex !== current.colourHex) {
        next.colourHex = colour.colourHex;
        patch.colourHex = colour.colourHex;
      }
    }
    if ("active" in body) {
      recognised = true;
      if (typeof body.active !== "boolean") return badRequest("`active` must be true or false.");
      if (body.active !== current.active) {
        next.active = body.active;
        /* A timestamp rather than a flag — see `db/init.ts` for why this table
           carries no boolean columns. */
        patch.deactivatedAt = body.active ? null : at;
      }
    }
    if ("sortOrder" in body) {
      recognised = true;
      const order = body.sortOrder;
      if (typeof order !== "number" || !Number.isInteger(order) || Math.abs(order) > 1_000_000) {
        return badRequest("`sortOrder` must be a whole number.");
      }
      if (order !== current.sortOrder) {
        next.sortOrder = order;
        patch.sortOrder = order;
      }
    }
    if (!recognised) return badRequest("Nothing to change. Send a label, colourHex, active or sortOrder.");

    /* One active type per name, checked against the state AFTER this change —
       so a rename onto a taken name and a reactivation beside a namesake are
       both refused, and a retired type may be renamed freely. Only when the
       name or the activity actually moves: a recolour is never refused over a
       name clash it did not create. */
    const nameMatters = next.active && (next.label !== current.label || !current.active);
    if (nameMatters && jobTypeLabelTaken(types, next.label, id)) {
      return Response.json(
        {
          error: current.active
            ? `"${next.label}" is already a job type here.`
            : `An active job type is already called "${next.label}". Rename one of them first.`,
        },
        { status: 409 },
      );
    }

    if (!Object.keys(patch).length) {
      /* The same values again: nothing written, nothing audited, and the caller
         told so plainly rather than handed a 400 for a harmless re-save. */
      return Response.json({ ok: true, changed: [], jobType: current, jobTypes: types });
    }

    await scope.db
      .update(jobTypeConfig)
      .set({ ...patch, updatedAt: at, updatedByEmail: writerEmail(scope) })
      .where(and(eq(jobTypeConfig.organisationId, scope.orgId), eq(jobTypeConfig.id, id)));

    const diff = changeDetail(auditShape(current), auditShape(next));
    const action =
      next.active !== current.active
        ? next.active
          ? "job_type.reactivated"
          : "job_type.deactivated"
        : next.label !== current.label
          ? "job_type.renamed"
          : "job_type.updated";
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action,
      entityType: "job_type",
      entityId: id,
      summary:
        action === "job_type.deactivated"
          ? `Deactivated the job type "${next.label}". Jobs filed under it keep it.`
          : action === "job_type.reactivated"
            ? `Reactivated the job type "${next.label}".`
            : action === "job_type.renamed"
              ? `Renamed the job type "${current.label}" to "${next.label}".`
              : `Updated the job type "${next.label}".`,
      detail: { ...diff, code: current.code },
      request,
    });

    const jobTypes = await listJobTypes(scope.db, scope.orgId);
    return Response.json({
      ok: true,
      changed: diff.changed,
      jobType: jobTypes.find((type) => type.id === id) ?? null,
      jobTypes,
    });
  } catch (error) {
    return failure(error, "The job type could not be saved.");
  }
}

/**
 * The whole order, rewritten as 10, 20, 30… — one statement per type whose
 * position actually moved, each scoped to the organisation and the id.
 *
 * Not a transaction (the D1 interface has no `BEGIN`; see
 * `/api/overview/meter-settings`), and it does not need to be one: every
 * statement is independently valid, and a failure part-way leaves an order the
 * next save corrects and the next GET reports honestly.
 */
async function reorder(
  request: Request,
  scope: ScopedDatabase,
  types: JobType[],
  requested: unknown,
): Promise<Response> {
  const plan = planJobTypeOrder(types, requested);
  if (!plan.ok) return Response.json({ error: plan.error }, { status: plan.status });

  const byId = new Map(types.map((type) => [type.id, type]));
  const at = new Date().toISOString();
  let moved = 0;
  for (const [index, id] of plan.order.entries()) {
    const sortOrder = (index + 1) * 10;
    if (byId.get(id)?.sortOrder === sortOrder) continue;
    await scope.db
      .update(jobTypeConfig)
      .set({ sortOrder, updatedAt: at, updatedByEmail: writerEmail(scope) })
      .where(and(eq(jobTypeConfig.organisationId, scope.orgId), eq(jobTypeConfig.id, id)));
    moved += 1;
  }

  const jobTypes = await listJobTypes(scope.db, scope.orgId);
  if (moved) {
    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "job_type.reordered",
      entityType: "job_type",
      entityId: scope.orgId,
      summary: `Reordered the job types — ${moved} moved.`,
      detail: {
        before: types.map((type) => type.label),
        after: jobTypes.map((type) => type.label),
      },
      request,
    });
  }
  return Response.json({ ok: true, moved, jobTypes });
}

/**
 * The three arms every handler here ends with — a dead session is a 401, a
 * pooler at capacity is a retryable 503, anything else a 503 that carries
 * `error.message` only in development. The same as `/api/overview/meter-settings`.
 */
function failure(error: unknown, consequence: string): Response {
  const anonymous = anonymousRefusal(error);
  if (anonymous) return anonymous;
  const busy = busyRefusal(error, consequence);
  if (busy) return busy;
  console.error("[/api/job-types]", error);
  if (error instanceof Error && error.cause) {
    console.error("[/api/job-types] cause:", error.cause);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json(
    { error: process.env.NODE_ENV === "development" ? `${consequence} ${message}` : consequence },
    { status: 503 },
  );
}
