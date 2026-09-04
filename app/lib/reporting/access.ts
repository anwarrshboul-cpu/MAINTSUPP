/**
 * WHO MAY DO WHAT TO A REPORT — mapped onto the capabilities that already exist.
 *
 * ── NO PARALLEL ROLE SYSTEM ────────────────────────────────────────────────
 *
 * The owner described four roles: Administrator, Operations Manager, Finance,
 * Viewer. This workspace has three (`client`, `admin`, `super_admin`) and one
 * capability catalogue, and `app/lib/permissions.ts` explains at length why
 * `role_capabilities` is a sparse diff rather than a source of truth. Inventing
 * a second role table for reports would mean two systems disagreeing about who
 * an Administrator is, and an owner editing the roles matrix would find it did
 * not govern the one screen with money on it.
 *
 * So the four intents are expressed as capabilities that are ALREADY enforced:
 *
 *   Administrator / Finance  ->  `settings.edit`
 *       billing configuration, SLA configuration, authorised adjustments,
 *       approving a hold, approve, finalise, void.
 *   Operations Manager       ->  `board.edit`
 *       preview, save a draft, recalculate, commentary, include/exclude a site,
 *       record a hold, work through the data issues.
 *   Viewer                   ->  `board.view` (+ `data.export` to download)
 *       list and read FINALISED documents only. Enforced by narrowing the
 *       query — see `visibleStatusesFor` — not by hiding a button.
 *
 * ── WHY NOT `billing.manage` ───────────────────────────────────────────────
 *
 * It exists, and its own catalogue entry says it "grants nothing today", which
 * makes it look like the obvious home for this feature. It is not: its built-in
 * default is `super_admin` ONLY. Wiring finalisation to it would ship a
 * workspace Administrator who cannot finalise their own invoices — the opposite
 * of the stated intent — and the fix would be a permissions edit on every
 * existing workspace. Re-pointing it is a deliberate product decision with a
 * migration attached, not a side effect of adding a screen.
 */

import type { Capability } from "../permissions";
import type { InvoiceStatus } from "./contract";

/** Every distinct thing a caller can ask the reporting engine to do. */
export type ReportOperation =
  | "settings.read"
  | "settings.write"
  | "fees.read"
  | "fees.write"
  | "sla.read"
  | "sla.write"
  | "holds.read"
  | "holds.write"
  | "holds.approve"
  | "report.preview"
  | "document.list"
  | "document.read"
  | "document.create"
  | "document.edit"
  | "document.recalculate"
  | "document.submit"
  | "document.adjust"
  | "document.approve"
  | "document.finalise"
  | "document.void"
  | "document.delete"
  | "document.export";

/**
 * The capability each operation requires. One table, so a reviewer can read the
 * whole authorisation model of this feature in twenty lines rather than by
 * grepping for `scopedDbWithCapability` across ten route files.
 */
export const REPORT_CAPABILITIES: Record<ReportOperation, Capability> = {
  "settings.read": "board.view",
  "settings.write": "settings.edit",
  "fees.read": "board.view",
  "fees.write": "settings.edit",
  "sla.read": "board.view",
  "sla.write": "settings.edit",
  "holds.read": "board.view",
  "holds.write": "board.edit",
  "holds.approve": "settings.edit",
  "report.preview": "board.edit",
  "document.list": "board.view",
  "document.read": "board.view",
  "document.create": "board.edit",
  "document.edit": "board.edit",
  "document.recalculate": "board.edit",
  "document.submit": "board.edit",
  "document.adjust": "settings.edit",
  "document.approve": "settings.edit",
  "document.finalise": "settings.edit",
  "document.void": "settings.edit",
  /*
   * Permanently removing a draft is `data.delete` — the capability this
   * codebase deliberately withholds from `admin` because archiving is
   * reversible and deletion is not. It is the right verb here for the same
   * reason: a draft raised by mistake should be removable, and nothing else in
   * this feature destroys a row. A FINALISED or VOIDED document is a financial
   * record and the route refuses to delete one whatever capability the caller
   * holds — void is how a finalised document is withdrawn, and the voided row
   * is the evidence that it was.
   */
  "document.delete": "data.delete",
  "document.export": "data.export",
};

/**
 * Which document statuses a caller may see.
 *
 * A Viewer sees FINALISED documents and nothing else — the owner's "view and
 * download permitted finals only". This is applied as a WHERE clause in the
 * list and read routes, so a Viewer who guesses a draft's id is answered 404
 * rather than being shown a working document with the wrong total on it.
 *
 * `canEdit` is `board.edit` resolved by the caller, because this module is pure
 * and must not resolve permissions itself.
 */
export function visibleStatusesFor(canEdit: boolean): InvoiceStatus[] {
  if (canEdit) return ["Draft", "Ready for Review", "Approved", "Finalised", "Voided"];
  return ["Finalised"];
}

/**
 * The state machine. A transition not listed here does not exist.
 *
 * Voided is terminal: a voided document is evidence that something was raised
 * and withdrawn, and un-voiding it would destroy that. Finalised only moves to
 * Voided — a finalised invoice is never edited back into a draft, which is the
 * whole point of finalising one.
 */
export const DOCUMENT_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  Draft: ["Ready for Review", "Approved", "Voided"],
  "Ready for Review": ["Draft", "Approved", "Voided"],
  Approved: ["Ready for Review", "Finalised", "Voided"],
  Finalised: ["Voided"],
  Voided: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return DOCUMENT_TRANSITIONS[from]?.includes(to) ?? false;
}
