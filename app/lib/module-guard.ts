/**
 * A SWITCHED-OFF MODULE IS OFF AT THE API TOO (owner decision, 2026-09-22).
 *
 * Until now the portal-module switches (§19, `app/lib/portal-modules.ts`) hid a
 * module from the navigation and redirected its page (`page-guard.ts`), but NO
 * API route consulted them: a workspace that had switched the Invoice Tracker
 * off still answered every `/api/finance/*` call to anyone holding the
 * capability, so the data was one `fetch` away and any second door — a bookmark,
 * a saved link, a workspace section pointing at the same surface — opened it.
 * The owner asked for the switch to hold at the API as well, WITHOUT blindly
 * blocking the shared foundations several modules stand on.
 *
 * So every API route family was classified first, by reading who CALLS it:
 *
 *   A. module-EXCLUSIVE — only that module's own screens call it. Every handler
 *      asks `moduleRefusal` right after its capability guard: `/api/assets`,
 *      `/api/finance/*` (one door, `guardFinance`), `/api/teams*`, `/api/audit`,
 *      `/api/admin/users*`, `/api/admin/roles`, `/api/admin/reconcile`, and the
 *      report documents behind `lib/reporting/route-helpers`'s `guard`.
 *   B. SHARED — boards, jobs, files, sites, contractors, registers, updates,
 *      reminders, search, forms, `/api/workspace`, and three that look
 *      exclusive and are not:
 *        · `/api/trash` — the Recycle Bin module is a DOOR, not a room
 *          (`recycle-bin-section.tsx`): the account area draws the same panel
 *          over the same API, and it is the only way to get a deleted row back.
 *          A switch that hides a screen must not make deletion unrecoverable.
 *        · `/api/maintenance/calendar` — the manual calendar events are read by
 *          the JOB BOARD's calendar view too (`board-view-pane.tsx`), not only
 *          by Planned.
 *        · `/api/compliance/provider` — the renewal contractor is edited from
 *          the data manager's shared record form as well as the Compliance
 *          screen, and compliance records are Store Documentation's too.
 *      Reads that feed the Overview are deliberately ungated for the same
 *      reason: `/api/compliance/metrics|summary|records` and
 *      `/api/reports/metrics`. Where a module owns one OPERATION inside a shared
 *      family, that operation is gated and the family is not: the compliance
 *      setup and alert routes, the report exports, schedules and "Send now", and
 *      "Create due visits now".
 *   C. core — auth, context, navigation, theme, versions, integrations, the
 *      public doors, and the CRONS. Never gated.
 *
 * TWO DELIBERATE OMISSIONS, both because the check could never refuse:
 *   · `/api/admin/clients` and `/api/admin/companies` answer to
 *     `clients.view_all`, which is the Super Admin's alone — and the Super Admin
 *     is exempt below. A guard that cannot fire is not written.
 *   · the crons. `/api/cron/daily` raises §25 planned visits and sends §32
 *     scheduled reports for every workspace, and it keeps doing both. Switching
 *     the Planned screen off is a decision about a screen; silently stopping a
 *     statutory maintenance visit from being raised is not, and nobody would see
 *     it happen. The owner has the question in OWNER ACTIONS.
 *
 * WHAT IT CHECKS: the switch alone. Each route keeps its own capability check,
 * which is the authorisation; the switch is product configuration, and the
 * capability model is untouched (no ROLE_CEILINGS contradiction can arise from
 * here). It follows from that that the check is per WORKSPACE and asks about the
 * workspace the request acts on — `targetOrganisationId` on an admin route — and
 * that a cross-workspace list is judged workspace by workspace where it already
 * iterates them (`/api/audit`, via `moduleSwitchedOff`).
 *
 * A module that cannot be switched off (Overview, Settings) is never refused.
 * The Platform Super Admin is exempt, as from every ceiling: the switches are
 * theirs to set (`navigation.edit` is Super-Admin-only), and they must be able
 * to reach a workspace's data to support or repair it — including to switch the
 * module back on for someone who cannot.
 *
 * FAILING OPEN on a registry read error, deliberately: `readModuleOverrides`
 * answers "no opinion" when it cannot read the table, and the shipped product
 * (every module on) is the right answer to a hiccup — the reasoning is in
 * `page-guard.ts`. A disabled module stays disabled whenever the switch can be
 * read, which is every request that reaches a database at all.
 *
 * THE COST is one indexed lookup on `(organisation_id, module_key)` per gated
 * request, uncached for the reason `portal-module-repository.ts` gives at
 * length: a stale answer here decides whether a module is reachable.
 *
 * WHAT STOPS THE NEXT ROUTE FORGETTING: `tests/module-api-enforcement.test.mjs`
 * holds the classification above as a map and fails when a route in family A
 * does not ask.
 */
import { readModuleOverrides } from "./portal-module-repository";
import { portalModule } from "./portal-modules";
import type { ScopedDatabase } from "./tenant-db";

type ModuleScope = {
  db: ScopedDatabase["db"];
  orgId: string;
  actor: { role: string };
  /** Present on a `ScopedDatabase`; a Platform Super Admin is exempt. */
  platformAdmin?: boolean;
};

/**
 * Whether this workspace has switched `key` off.
 *
 * Exported for the one caller that filters a LIST of workspaces rather than
 * refusing one request — `/api/audit`, which reads every workspace where the
 * actor holds `audit.read` and must drop the ones that have Audit switched off.
 * A module that cannot be switched off is never off.
 */
export async function moduleSwitchedOff(
  db: ScopedDatabase["db"],
  orgId: string,
  key: string,
): Promise<boolean> {
  const definition = portalModule(key);
  if (!definition || !definition.disableable) return false;
  const overrides = await readModuleOverrides(db, orgId);
  return overrides[key] === false;
}

/**
 * The same question, for this actor, where the answer FILTERS rather than
 * refuses: `/api/search` returns invoices and quotes that link into the Invoice
 * Tracker, so leaving them in was a second door into a module the switch had
 * closed. A search must not refuse outright — the other groups are still the
 * reader's — so it drops the group instead, exactly as it already does for a
 * reader who may not see the ledger at all.
 */
export async function moduleOff(scope: ModuleScope, key: string): Promise<boolean> {
  if (scope.platformAdmin || scope.actor.role === "super_admin") return false;
  return moduleSwitchedOff(scope.db, scope.orgId, key);
}

/** 403 when `key`'s module is switched off for this workspace; null otherwise. */
export async function moduleRefusal(scope: ModuleScope, key: string): Promise<Response | null> {
  const definition = portalModule(key);
  if (!definition || !definition.disableable) return null;
  if (!(await moduleOff(scope, key))) return null;
  return Response.json(
    {
      error: `${definition.label} is switched off for this workspace (Settings → Portal modules), so this is not available.`,
      module: key,
      moduleDisabled: true,
    },
    { status: 403 },
  );
}
