/**
 * The five things every reporting route does, done once.
 *
 * Refusal shapes are deliberately the SAME three every other route in this
 * codebase uses — 401 through `anonymousRefusal`, 403 through
 * `scopedDbWithCapability`, 503 with a sentence — so a client can branch on the
 * status without learning a new vocabulary for this feature.
 */

import { ensureDatabase } from "../../../db/init";
import { can, resolvePermissions, type Capability } from "../permissions";
import { anonymousRefusal, scopedDbWithCapability, type ScopedDatabase } from "../tenant-db";
import type { InvoiceStatus, IsoDate, ReportPeriod, ReportPeriodPreset } from "./contract";
import { REPORT_PERIOD_PRESETS } from "./contract";
import { visibleStatusesFor } from "./access";
import { dateOnly, resolveReportPeriod } from "./period";

/**
 * Today, as a UTC calendar date.
 *
 * UTC rather than the server's local zone, because a reporting period is a
 * commercial term on a document and must not depend on where the process
 * happens to be running. Every module downstream takes this as an argument and
 * none of them reads a clock — see `period.ts`.
 */
export function todayIso(): IsoDate {
  return new Date().toISOString().slice(0, 10);
}

export function reportUnavailable(error?: unknown): Response {
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  console.error("[reports] request failed", error);
  return Response.json(
    { error: "Reporting is temporarily unavailable." },
    { status: 503 },
  );
}

export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export function notFound(message = "That document does not exist."): Response {
  return Response.json({ error: message }, { status: 404 });
}

/** `scopedDbWithCapability`, with the database bootstrapped first. */
export async function guard(
  request: Request,
  capability: Capability,
): Promise<{ denied: Response; scope?: never } | { denied?: never; scope: ScopedDatabase }> {
  await ensureDatabase();
  return scopedDbWithCapability(request, capability);
}

/**
 * Refuse a request that names a client this scope is not billing.
 *
 * THE SCOPE IS STILL THE ONLY AUTHORITY. `scopedDb()` decides `orgId` from the
 * actor's memberships, never from the request, and nothing here widens that —
 * a `clientId` naming another organisation does not select it, it is refused.
 * This is not a second tenant filter; it is a check that the caller and the
 * server agree about whose invoice is being produced.
 *
 * It exists because they can disagree in one specific, silent way. "Client" IS
 * the organisation in this product, `/api/context` lists every organisation the
 * reader belongs to, and the generator's client selector defaults to the first
 * of them — which need not be the one the session is scoped to. Ignoring the
 * field, as these routes did, means the screen names one client and the
 * document is raised for another, with no sign on either that they differ.
 *
 * An absent or empty `clientId` is fine: most callers do not send one, and the
 * scope answers the question on its own.
 */
export function clientMismatch(
  body: Record<string, unknown>,
  scope: ScopedDatabase,
): Response | null {
  const clientId = text(body.clientId, 64);
  if (!clientId || clientId === scope.orgId) return null;
  return Response.json(
    {
      error: `This session is billing ${scope.organisation.name}. Switch workspace to raise a document for another client.`,
    },
    { status: 409 },
  );
}

/**
 * Whether the caller may see working documents, or only finalised ones.
 *
 * Resolved against the workspace's own capability table rather than a role
 * literal, so an admin who has had `board.edit` withdrawn loses drafts without
 * a deploy — the same rule `/api/audit` applies to `audit.read`.
 */
export async function visibleStatuses(scope: ScopedDatabase): Promise<InvoiceStatus[]> {
  const subject = await resolvePermissions(scope.db, scope.orgId, scope.actor.role);
  return visibleStatusesFor(can(subject, "board.edit"));
}

function isPreset(value: unknown): value is ReportPeriodPreset {
  return typeof value === "string" && (REPORT_PERIOD_PRESETS as readonly string[]).includes(value);
}

/**
 * `period-model.ts`'s tokens, mapped onto the contract's presets.
 *
 * THE TWO VOCABULARIES ARE REAL AND BOTH ARE CORRECT. `contract.ts` names the
 * eight reporting periods (`this-month`, `last-month`, …) and is frozen.
 * `app/(app)/portal/period-model.ts` names the same eight windows in the tokens
 * every other screen in the product already speaks (`mtd`, `month-1`, …), and
 * `GENERATOR_PERIOD_PRESETS` in `generator-setup.tsx` deliberately reuses them
 * so the reporting screen does not invent a ninth vocabulary for a control the
 * dashboard already has.
 *
 * What was missing was the translation. Without it every token but `today` — the
 * one word the two vocabularies happen to share — fell through `isPreset` and,
 * because the browser sends its dates as `periodStart`/`periodEnd` while this
 * function only read `start`/`end`, landed on the `"last-month"` default. Every
 * document generated from the screen was therefore computed for LAST MONTH
 * whatever the operator chose, silently, which is the exact failure the comment
 * below promises does not happen.
 */
const PRESET_ALIASES: Record<string, ReportPeriodPreset> = {
  week: "this-week",
  mtd: "this-month",
  "month-1": "last-month",
  quarter: "this-quarter",
  ytd: "this-year",
  "12m": "last-12-months",
  range: "custom",
};

/** `rangeToken(from, to)` in `period-model.ts` — a hand-edited range, as one token. */
const RANGE_TOKEN = /^range:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/** The first of several candidate fields that parses as a calendar date. */
function firstIsoDate(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const parsed = dateOnly(typeof candidate === "string" ? candidate : null);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * The period a request is asking about.
 *
 * Accepts either a preset or an explicit range; an explicit range without
 * `preset: "custom"` is still treated as custom, because a caller that sent two
 * dates plainly means them. Refuses rather than defaulting: a report silently
 * generated for the wrong month is worse than one that was not generated.
 *
 * THE RANGE MAY ARRIVE UNDER EITHER NAME. `start`/`end` is this function's own
 * spelling; `periodStart`/`periodEnd` is what the browser sends and what
 * `PATCH /api/reports/documents/[id]` already reads for the same two dates.
 * Reading both here rather than renaming either is what lets one endpoint serve
 * the generator screen, the export buttons and a hand-written call without any
 * of the three learning a second name for the same thing.
 *
 * AN UNRECOGNISED PRESET IS REFUSED, not defaulted. That is the sentence above
 * made true: a token this function cannot place is a caller asking for a period
 * nobody has defined, and answering it with last month's figures under the
 * caller's own heading is worse than answering nothing.
 */
export function periodFromPayload(
  body: Record<string, unknown>,
): { ok: true; period: ReportPeriod } | { ok: false; error: string } {
  const raw = typeof body.preset === "string" ? body.preset.trim() : "";
  const token = RANGE_TOKEN.exec(raw);

  /* Dates win wherever two of them parse — see the header. `dateOnly` rather
     than a truthiness check, so the `""` that `/api/reports/exports` sends for
     an absent field reads as absent rather than as a malformed date. */
  const start = firstIsoDate(body.start, body.periodStart, token?.[1]);
  const end = firstIsoDate(body.end, body.periodEnd, token?.[2]);
  if (start && end) {
    const resolved = resolveReportPeriod({ preset: "custom", todayIso: todayIso(), start, end });
    return resolved.ok ? { ok: true, period: resolved.period } : { ok: false, error: resolved.error };
  }

  let preset: ReportPeriodPreset;
  if (!raw) {
    preset = "last-month";
  } else if (isPreset(raw)) {
    preset = raw;
  } else if (raw in PRESET_ALIASES) {
    preset = PRESET_ALIASES[raw] as ReportPeriodPreset;
  } else {
    return {
      ok: false,
      error: `"${raw.slice(0, 40)}" is not a reporting period. Send one of ${REPORT_PERIOD_PRESETS.join(", ")}, or a start and end date.`,
    };
  }

  const resolved = resolveReportPeriod({ preset, todayIso: todayIso(), start, end });
  return resolved.ok ? { ok: true, period: resolved.period } : { ok: false, error: resolved.error };
}

/** A bounded, trimmed string from an untrusted body. Never a silent default. */
export function text(value: unknown, max = 400): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Integer pence from an untrusted body. Rejects anything that is not a number. */
export function pence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}
