/**
 * A SETTINGS SAVE MERGES INTO THE STORED BLOB; IT DOES NOT REPLACE IT.
 *
 * `workspace_settings.settings` is one JSON document per organisation, and
 * several features keep a section in it: the Settings screen's alerts, SLAs and
 * completion-evidence categories; the compliance template
 * (`compliance-template-store.ts`); the reminder settings
 * (`reminders/settings.ts`); and the compliance warning window
 * (`compliance-policy.ts`). `/api/workspace` used to save the Settings screen by
 * writing the request body over the whole column, and the screen only ever sent
 * its own three sections — so every save silently erased the template and the
 * reminder settings, and would have reset an organisation's chosen warning
 * window the next time anybody changed an SLA.
 *
 * Pure: the route reads the stored blob and writes the result; this decides what
 * the result is, and a test calls it directly.
 */

import { COMPLIANCE_POLICY_KEY, compliancePolicyInput } from "./compliance-policy";

/** The sections of the blob the Settings screen owns and saves through `/api/workspace`. */
export const WORKSPACE_OWNED_SETTINGS = ["alerts", "slas", "completionEvidenceCategories"] as const;

function storedObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The blob after one Settings save: the sections this screen owns are replaced
 * when sent, the warning window is validated and written or cleared, and every
 * other key is kept exactly as stored. A malformed window is refused — never
 * coerced into the default and saved as if it were the organisation's choice.
 */
export function mergeWorkspaceSettingsBlob(
  stored: unknown,
  data: Record<string, unknown>,
): { ok: true; settings: string } | { ok: false; error: string } {
  const blob = storedObject(stored);
  for (const key of WORKSPACE_OWNED_SETTINGS) {
    if (key in data) blob[key] = data[key];
  }
  if ("compliancePolicy" in data) {
    const policy = compliancePolicyInput(data.compliancePolicy);
    if (!policy.ok) return policy;
    if (policy.section) blob[COMPLIANCE_POLICY_KEY] = policy.section;
    else delete blob[COMPLIANCE_POLICY_KEY];
  }
  return { ok: true, settings: JSON.stringify(blob) };
}
