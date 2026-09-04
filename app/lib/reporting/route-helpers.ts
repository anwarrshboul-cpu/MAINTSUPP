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
import { resolveReportPeriod } from "./period";

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
 * The period a request is asking about.
 *
 * Accepts either a preset or an explicit range; an explicit range without
 * `preset: "custom"` is still treated as custom, because a caller that sent two
 * dates plainly means them. Refuses rather than defaulting: a report silently
 * generated for the wrong month is worse than one that was not generated.
 */
export function periodFromPayload(
  body: Record<string, unknown>,
): { ok: true; period: ReportPeriod } | { ok: false; error: string } {
  const start = typeof body.start === "string" ? body.start : null;
  const end = typeof body.end === "string" ? body.end : null;
  const preset: ReportPeriodPreset = isPreset(body.preset)
    ? body.preset
    : start && end
      ? "custom"
      : "last-month";
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
