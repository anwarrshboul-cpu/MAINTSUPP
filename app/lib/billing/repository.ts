/**
 * THE BILLING AND SLA TABLES, read and written in one place.
 *
 * Every function here is scoped by `organisationId` as its first filter, and
 * the caller obtained that id from `scopedDb()` — never from a request body.
 * Nothing in this module accepts an organisation from an argument the browser
 * controls; the routes pass `scope.orgId` and there is no other caller.
 *
 * ── FEES ARE APPENDED, NEVER EDITED ────────────────────────────────────────
 *
 * A fee row is a historical fact: this is what a site cost between these dates.
 * Editing one in place would restate every invoice that was priced from it,
 * including ones already sent, and effective dating would be decoration. So a
 * change CLOSES the current row (`effective_to`) and OPENS a new one, which is
 * what `closeFee` and `addClientFee` / `addSiteOverride` do between them.
 * There is no update path for `fee_pence` in this module, deliberately.
 *
 * ── HOLDS DEFAULT TO UNAPPROVED ────────────────────────────────────────────
 *
 * `recordHold` never sets `approved`. Approving is a separate call requiring a
 * separate capability (`settings.edit`), because an approved hold is a discount
 * on a number a client judges the service by. See `sla.ts`.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../../../db";
import {
  clientSiteFees,
  invoiceAdjustments,
  jobHolds,
  siteFeeOverrides,
  slaRules,
} from "../../../db/schema";
import { selectInChunks } from "../sql-batching";
import type { InvoiceAdjustmentEntry } from "../reporting/contract";
import { dateOnly } from "../reporting/period";
import type { FeeRecord, ReportHold, ReportSlaRule } from "../reporting/inputs";

type Database = Awaited<ReturnType<typeof getDb>>;

/* ------------------------------------------------------------------ fees -- */

export async function listClientFees(
  db: Database,
  organisationId: string,
): Promise<FeeRecord[]> {
  const rows = await db
    .select()
    .from(clientSiteFees)
    .where(eq(clientSiteFees.organisationId, organisationId))
    .orderBy(asc(clientSiteFees.effectiveFrom), asc(clientSiteFees.id));
  return rows.map((row) => ({
    id: row.id,
    siteId: null,
    feePence: row.feePence,
    effectiveFrom: dateOnly(row.effectiveFrom),
    effectiveTo: dateOnly(row.effectiveTo),
    note: row.note ?? null,
  }));
}

export async function listSiteOverrides(
  db: Database,
  organisationId: string,
): Promise<FeeRecord[]> {
  const rows = await db
    .select()
    .from(siteFeeOverrides)
    .where(eq(siteFeeOverrides.organisationId, organisationId))
    .orderBy(asc(siteFeeOverrides.effectiveFrom), asc(siteFeeOverrides.id));
  return rows.map((row) => ({
    id: row.id,
    siteId: row.siteId,
    feePence: row.feePence,
    effectiveFrom: dateOnly(row.effectiveFrom),
    effectiveTo: dateOnly(row.effectiveTo),
    note: row.note ?? null,
  }));
}

export interface NewFee {
  feePence: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  note: string | null;
}

export async function addClientFee(
  db: Database,
  organisationId: string,
  fee: NewFee,
  actorEmail: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(clientSiteFees).values({
    id,
    organisationId,
    feePence: Math.trunc(fee.feePence),
    effectiveFrom: fee.effectiveFrom,
    effectiveTo: fee.effectiveTo,
    note: fee.note,
    createdBy: actorEmail,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export async function addSiteOverride(
  db: Database,
  organisationId: string,
  siteId: string,
  fee: NewFee,
  actorEmail: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(siteFeeOverrides).values({
    id,
    organisationId,
    siteId,
    feePence: Math.trunc(fee.feePence),
    effectiveFrom: fee.effectiveFrom,
    effectiveTo: fee.effectiveTo,
    note: fee.note,
    createdBy: actorEmail,
    createdAt: new Date().toISOString(),
  });
  return id;
}

/**
 * Close a fee row on a date. The ONLY mutation this module performs on a fee,
 * and it never touches the amount — see the header.
 */
export async function closeFee(
  db: Database,
  organisationId: string,
  kind: "client" | "site",
  id: string,
  effectiveTo: string | null,
): Promise<boolean> {
  const table = kind === "client" ? clientSiteFees : siteFeeOverrides;
  const updated = await db
    .update(table)
    .set({ effectiveTo })
    .where(and(eq(table.organisationId, organisationId), eq(table.id, id)))
    .returning({ id: table.id });
  return updated.length > 0;
}

/* ------------------------------------------------------------- sla rules -- */

export async function listSlaRules(
  db: Database,
  organisationId: string,
): Promise<ReportSlaRule[]> {
  const rows = await db
    .select()
    .from(slaRules)
    .where(eq(slaRules.organisationId, organisationId))
    .orderBy(asc(slaRules.classification));
  return rows.map((row) => ({
    id: row.id,
    classification: row.classification,
    targetWorkingDays: row.targetWorkingDays,
    active: Boolean(row.active),
    version: row.version,
    note: row.note ?? null,
  }));
}

/**
 * Create or replace the rule for a classification, bumping its version.
 *
 * A target that changes is a NEW VERSION of the same rule, and the version
 * number travels into the snapshot (`report_snapshots.sla_rules_version`) so a
 * finalised report can say which targets it was measured against. Overwriting
 * the number without moving the version would make every historical report
 * silently claim the current target.
 */
export async function upsertSlaRule(
  db: Database,
  organisationId: string,
  input: { classification: string; targetWorkingDays: number; note: string | null; active?: boolean },
  actorEmail: string | null,
): Promise<{ id: string; version: number; previous: ReportSlaRule | null }> {
  const existing = await db
    .select()
    .from(slaRules)
    .where(
      and(
        eq(slaRules.organisationId, organisationId),
        eq(slaRules.classification, input.classification),
      ),
    )
    .limit(1);

  const now = new Date().toISOString();
  if (existing[0]) {
    const previous: ReportSlaRule = {
      id: existing[0].id,
      classification: existing[0].classification,
      targetWorkingDays: existing[0].targetWorkingDays,
      active: Boolean(existing[0].active),
      version: existing[0].version,
      note: existing[0].note ?? null,
    };
    const version =
      previous.targetWorkingDays === input.targetWorkingDays
        ? previous.version
        : previous.version + 1;
    await db
      .update(slaRules)
      .set({
        targetWorkingDays: Math.trunc(input.targetWorkingDays),
        note: input.note,
        active: input.active ?? true,
        version,
        updatedBy: actorEmail,
        updatedAt: now,
      })
      .where(eq(slaRules.id, existing[0].id));
    return { id: existing[0].id, version, previous };
  }

  const id = crypto.randomUUID();
  await db.insert(slaRules).values({
    id,
    organisationId,
    classification: input.classification,
    targetWorkingDays: Math.trunc(input.targetWorkingDays),
    active: input.active ?? true,
    version: 1,
    note: input.note,
    updatedBy: actorEmail,
    updatedAt: now,
  });
  return { id, version: 1, previous: null };
}

/** The fingerprint stored with a snapshot, so a report can name its targets. */
export function slaRulesVersion(rules: readonly ReportSlaRule[]): string {
  return rules
    .filter((rule) => rule.active)
    .map((rule) => `${rule.classification}:${rule.targetWorkingDays}:v${rule.version}`)
    .sort()
    .join("|");
}

/* ----------------------------------------------------------------- holds -- */

export async function listHolds(
  db: Database,
  organisationId: string,
  requestIds?: readonly string[],
): Promise<ReportHold[]> {
  const rows = requestIds
    ? await selectInChunks(requestIds, (chunk) =>
        db
          .select()
          .from(jobHolds)
          .where(
            and(
              eq(jobHolds.organisationId, organisationId),
              inArray(jobHolds.requestId, chunk),
            ),
          ),
      )
    : await db
        .select()
        .from(jobHolds)
        .where(eq(jobHolds.organisationId, organisationId))
        .orderBy(desc(jobHolds.startAt));

  return rows.map((row) => ({
    id: row.id,
    requestId: row.requestId,
    startAt: dateOnly(row.startAt),
    endAt: dateOnly(row.endAt),
    reason: row.reason ?? null,
    category: row.category ?? null,
    approved: Boolean(row.approved),
    approvedBy: row.approvedBy ?? null,
    approvedAt: dateOnly(row.approvedAt),
    note: row.note ?? null,
  }));
}

export async function recordHold(
  db: Database,
  organisationId: string,
  input: {
    requestId: string;
    startAt: string;
    endAt: string | null;
    reason: string | null;
    category: string | null;
    note: string | null;
  },
  actorEmail: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(jobHolds).values({
    id,
    organisationId,
    requestId: input.requestId,
    startAt: input.startAt,
    endAt: input.endAt,
    reason: input.reason,
    category: input.category,
    /* NOT approved. See the header. */
    approved: false,
    note: input.note,
    createdBy: actorEmail,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export async function approveHold(
  db: Database,
  organisationId: string,
  holdId: string,
  approved: boolean,
  actorEmail: string | null,
): Promise<boolean> {
  const updated = await db
    .update(jobHolds)
    .set({
      approved,
      approvedBy: approved ? actorEmail : null,
      approvedAt: approved ? new Date().toISOString() : null,
    })
    .where(and(eq(jobHolds.organisationId, organisationId), eq(jobHolds.id, holdId)))
    .returning({ id: jobHolds.id });
  return updated.length > 0;
}

/* ----------------------------------------------------------- adjustments -- */

export async function listAdjustments(
  db: Database,
  organisationId: string,
  invoiceId: string,
): Promise<InvoiceAdjustmentEntry[]> {
  const rows = await db
    .select()
    .from(invoiceAdjustments)
    .where(
      and(
        eq(invoiceAdjustments.organisationId, organisationId),
        eq(invoiceAdjustments.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(invoiceAdjustments.createdAt), asc(invoiceAdjustments.id));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind === "credit" ? "credit" : "adjustment",
    /* Stored as a magnitude. `computeInvoiceTotals` subtracts a credit; storing
       a signed value as well would give two ways to say the same thing and one
       of them would eventually be wrong. */
    amountPence: Math.abs(row.amountPence),
    reason: row.reason,
    authorisedByEmail: row.authorisedByEmail ?? null,
    createdAt: row.createdAt,
  }));
}

export async function addAdjustment(
  db: Database,
  organisationId: string,
  invoiceId: string,
  input: { kind: "adjustment" | "credit"; amountPence: number; reason: string },
  actorEmail: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(invoiceAdjustments).values({
    id,
    organisationId,
    invoiceId,
    kind: input.kind,
    amountPence: Math.abs(Math.trunc(input.amountPence)),
    reason: input.reason,
    authorisedByEmail: actorEmail,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export async function removeAdjustment(
  db: Database,
  organisationId: string,
  invoiceId: string,
  adjustmentId: string,
): Promise<InvoiceAdjustmentEntry | null> {
  const existing = await db
    .select()
    .from(invoiceAdjustments)
    .where(
      and(
        eq(invoiceAdjustments.organisationId, organisationId),
        eq(invoiceAdjustments.invoiceId, invoiceId),
        eq(invoiceAdjustments.id, adjustmentId),
      ),
    )
    .limit(1);
  if (!existing[0]) return null;
  await db.delete(invoiceAdjustments).where(eq(invoiceAdjustments.id, adjustmentId));
  return {
    id: existing[0].id,
    kind: existing[0].kind === "credit" ? "credit" : "adjustment",
    amountPence: Math.abs(existing[0].amountPence),
    reason: existing[0].reason,
    authorisedByEmail: existing[0].authorisedByEmail ?? null,
    createdAt: existing[0].createdAt,
  };
}
