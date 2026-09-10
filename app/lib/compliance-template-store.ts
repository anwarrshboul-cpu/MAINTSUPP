/**
 * WHERE AN ORGANISATION'S COMPLIANCE TEMPLATE IS KEPT.
 *
 * ── WHY `workspace_settings` AND NOT A TABLE OF ITS OWN ───────────────────
 *
 * A compliance template IS a workspace setting: one small document per
 * organisation, edited by an administrator a handful of times a year, read on
 * the site-create path. `workspace_settings` already holds exactly that shape
 * for exactly that audience, and `app/lib/reminders/settings.ts` already
 * namespaces a section inside it — this is the same pattern with a different
 * key, and the header of that file is worth reading alongside this one.
 *
 * The alternative was a `compliance_templates` table, which means a
 * `CREATE TABLE IF NOT EXISTS` in `db/init.ts`. That file runs on the boot path
 * of every request and is being edited by other work in this same batch. A new
 * table for a document this small would be paid for on every request forever, to
 * store something a JSON column already stores well.
 *
 * ── THE LOST-UPDATE RISK IS ACCEPTED, WITH THE SAME REASONING ─────────────
 *
 * Read-modify-write on a shared JSON column can lose a concurrent write to a
 * DIFFERENT key. `app/api/workspace/route.ts` has always written this column
 * that way and so does the reminder settings module; introducing a third
 * concurrency discipline for one key would make this the odd one out without
 * making the column safe. The exposure is two administrators saving two
 * different settings sections in the same second.
 *
 * ── WHY THE PURE HALF IS ELSEWHERE ────────────────────────────────────────
 *
 * `compliance-vocabulary.ts` holds the resolver and the parser and imports no
 * database, because the Settings editor is a client component. This file is the
 * only part that needs drizzle, and it is deliberately tiny.
 */

import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../db/schema";
import {
  DEFAULT_COMPLIANCE_TEMPLATE,
  parseComplianceTemplate,
  type ComplianceTemplate,
} from "./compliance-vocabulary";

/* eslint-disable @typescript-eslint/no-explicit-any -- the drizzle handle is
   assembled per driver; the schema import is what types this query. Same
   declaration, for the same reason, as `app/lib/reminders/settings.ts`. */
type Db = any;

/** The key this feature owns inside the shared settings blob. */
export const COMPLIANCE_TEMPLATE_KEY = "complianceTemplate";

function readBlob(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    /* A blob that will not parse is treated as absent rather than fatal, for
       the reason `parseComplianceTemplate` is total: this is read on the create
       path of every site, and a malformed settings row must not stop an
       organisation adding a store. */
    return {};
  }
}

export function complianceTemplateFromBlob(raw: unknown): ComplianceTemplate {
  const section = readBlob(raw)[COMPLIANCE_TEMPLATE_KEY];
  return section === undefined ? DEFAULT_COMPLIANCE_TEMPLATE : parseComplianceTemplate(section);
}

/**
 * One organisation's template.
 *
 * A single indexed row by `organisation_id`, so this is cheap enough to sit on
 * a create path. Callers that already hold the settings blob should use
 * `complianceTemplateFromBlob` instead of reading it twice.
 */
export async function readComplianceTemplate(
  db: Db,
  organisationId: string,
): Promise<ComplianceTemplate> {
  const [row] = await db
    .select({ settings: workspaceSettings.settings })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.organisationId, organisationId))
    .limit(1);
  return complianceTemplateFromBlob(row?.settings);
}

/** Merge the template back into the blob without disturbing the rest. */
export function mergeComplianceTemplate(raw: unknown, next: ComplianceTemplate): string {
  const blob = readBlob(raw);
  blob[COMPLIANCE_TEMPLATE_KEY] = next;
  return JSON.stringify(blob);
}

/**
 * Save one organisation's template.
 *
 * `onConflictDoUpdate` on the organisation index rather than a read-then-insert:
 * `workspace_settings` is keyed by `client_id` and uniquely indexed on
 * `organisation_id`, and an organisation that has never saved a setting has no
 * row at all — which is the ordinary case for every tenant but the first.
 */
export async function writeComplianceTemplate(
  db: Db,
  organisationId: string,
  template: ComplianceTemplate,
  actorEmail: string | null,
): Promise<void> {
  const [row] = await db
    .select({ settings: workspaceSettings.settings })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.organisationId, organisationId))
    .limit(1);
  const settings = mergeComplianceTemplate(row?.settings, template);
  const updatedAt = new Date().toISOString();
  await db
    .insert(workspaceSettings)
    .values({
      /* The primary key is the LEGACY client id column. Every other writer of
         this table passes the organisation id for it — see
         `app/api/workspace/route.ts` — and a different choice here would create
         a second row the unique index then refuses. */
      legacyClientId: organisationId,
      organisationId,
      settings,
      updatedByEmail: actorEmail,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: workspaceSettings.organisationId,
      set: { settings, updatedByEmail: actorEmail, updatedAt },
    });
}
