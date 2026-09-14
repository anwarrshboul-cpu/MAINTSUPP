/**
 * AN ORGANISATION'S COMPLIANCE WARNING WINDOW — where it is kept and how it is read.
 *
 * The approved Compliance specification makes the window "a config value in
 * Settings (default 90 days)", with the renewal countdown split into three equal
 * bands of it. It is one small number per organisation, edited on the Settings
 * screen, so it lives where every other workspace setting of that shape lives —
 * `workspace_settings.settings`, under its own key — exactly as the compliance
 * template (`compliance-template-store.ts`) and the reminder settings do.
 *
 * ── THERE WAS NO SAVED VALUE TO PRESERVE ─────────────────────────────────
 *
 * The sixty-day window the product shipped with was a constant typed in
 * `expiry-status.ts`. No organisation could save a window, so none has: a
 * settings blob without this key means "the product default", and moving the
 * default to 90 overrides nobody's choice. A value an organisation DOES save
 * from now on is honoured by every compliance surface, through
 * `readComplianceRegister`, which resolves it once per read.
 *
 * ── NOT THE REMINDER LADDER ──────────────────────────────────────────────
 *
 * `reminder_defaults`, `reminder_rules` and `compliance_documents
 * .last_alert_stage` all hold numbers like 90 and 60. Those are WHEN reminders
 * are sent, which is a different question from when a certificate turns amber,
 * and nothing here reads them.
 */

import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../db/schema";
import { EXPIRY_DUE_SOON_DAYS, normaliseWarningWindow } from "./expiry-status";

/* eslint-disable @typescript-eslint/no-explicit-any -- the drizzle handle is
   assembled per driver; the schema import is what types this query. Same
   declaration, for the same reason, as `compliance-template-store.ts`. */
type Db = any;

/** The key this setting owns inside the shared settings blob. */
export const COMPLIANCE_POLICY_KEY = "compliancePolicy";

export type CompliancePolicy = {
  /** Days before expiry a certificate turns amber. */
  warningWindowDays: number;
  /** Whether the organisation chose it, or it is the product default. */
  configured: boolean;
};

export const DEFAULT_COMPLIANCE_POLICY: CompliancePolicy = {
  warningWindowDays: EXPIRY_DUE_SOON_DAYS,
  configured: false,
};

function readBlob(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    /* A settings row that will not parse is the default, never an outage on a
       compliance screen. */
    return {};
  }
}

/** The policy inside a settings blob (a JSON string or an already-parsed object). */
export function compliancePolicyFromBlob(raw: unknown): CompliancePolicy {
  const section = readBlob(raw)[COMPLIANCE_POLICY_KEY];
  if (!section || typeof section !== "object") return DEFAULT_COMPLIANCE_POLICY;
  const stored = (section as Record<string, unknown>).warningWindowDays;
  if (stored === undefined || stored === null || stored === "") return DEFAULT_COMPLIANCE_POLICY;
  return { warningWindowDays: normaliseWarningWindow(stored), configured: true };
}

/**
 * What a settings save may write for this key: a window inside the bounds, or
 * nothing at all (`null` — "use the product default"). Anything else is refused
 * by the caller rather than silently coerced, because a typed "9O" saved as the
 * default would read as the organisation's choice.
 */
export function compliancePolicyInput(value: unknown): { ok: true; section: { warningWindowDays: number } | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, section: null };
  if (typeof value !== "object") return { ok: false, error: "The compliance warning window must be a number of days." };
  const raw = (value as Record<string, unknown>).warningWindowDays;
  if (raw === undefined || raw === null || raw === "") return { ok: true, section: null };
  const days = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof days !== "number" || !Number.isInteger(days)) {
    return { ok: false, error: "The compliance warning window must be a whole number of days." };
  }
  if (normaliseWarningWindow(days) !== days) {
    return { ok: false, error: "The compliance warning window must be between 7 and 365 days." };
  }
  return { ok: true, section: { warningWindowDays: days } };
}

/**
 * One organisation's policy — one indexed row by `organisation_id`. Callers that
 * already hold the settings blob use `compliancePolicyFromBlob` instead.
 */
export async function readCompliancePolicy(db: Db, organisationId: string): Promise<CompliancePolicy> {
  const [row] = await db
    .select({ settings: workspaceSettings.settings })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.organisationId, organisationId))
    .limit(1);
  return compliancePolicyFromBlob(row?.settings);
}
