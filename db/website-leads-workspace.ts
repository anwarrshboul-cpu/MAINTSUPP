/**
 * The workspace MAINTSUPP's own website enquiries belong to.
 *
 * ⚠️ WHY THIS EXISTS: PUBLIC ENQUIRIES WERE FILED UNDER A CUSTOMER.
 *
 * A public enquiry has no account, so `POST /api/leads` resolved its scope with
 * `allowAnonymous: true` — and an anonymous request resolves to `primary`, which is
 * `activeOrganisations.find(id === PRIMARY_ORGANISATION_ID)`. That constant is
 * `org_000000000000000000000001`, and on this installation that workspace belongs to
 * **Sunnamusk UK, a real client company**. Measured live: all 8 stored leads sat in
 * it.
 *
 * So MAINTSUPP's own inbound sales pipeline was being written into a customer's
 * tenant. Nothing leaked, because the inbox answers only to `platformAdmin` — but
 * the row said it belonged to a customer, and the first workspace capability anybody
 * granted over `leads` would have made that true.
 *
 * The fault was never "ordering". It was a hard-coded constant that names a
 * customer's workspace. So the fix is a different constant that names a workspace
 * the platform owns, and this file is it.
 *
 * WHY A NEW WORKSPACE RATHER THAN THE DEMO ONE.
 *
 * `db/demo-workspace.ts` already owns an INTERNAL company — `kind = 'internal'`, so
 * `reachableOrganisationIds` drops it from every customer's reach and only a
 * platform admin sees it. Reusing that *mechanism* is right; reusing that
 * *workspace* would not be. The demo workspace holds demonstration jobs, sites and
 * documents, and making it the semantic owner of the sales pipeline would mean the
 * pipeline lives among sample data that exists to be reset. A purpose-named
 * workspace of its own says what it is.
 *
 * WHY THE ID IS FIXED AND THE NAME IS NOT LOAD-BEARING.
 *
 * The same reason `db/init.ts` gives for marking the demo company internal by id:
 * *"never by its name, which anybody with the platform console can change"*. Every
 * statement below keys on `WEBSITE_LEADS_WORKSPACE_ID`, so renaming the workspace in
 * the console cannot detach it, un-internal it, or send the next enquiry somewhere
 * else.
 *
 * WHY IT IS IN `FINGERPRINTED_SOURCES`.
 *
 * Changing the id here IS a migration change — it decides which workspace the seed
 * creates and which one the intake path writes to. Excluded from the fingerprint, an
 * edit to that constant would leave a database that believes it is already up to
 * date while the route wrote to a workspace that was never created.
 */

/*
 * TYPE-ONLY, unlike `db/demo-workspace.ts`'s value import of the same thing.
 * `getD1` is used here purely to name a type, and a value import of "." is a
 * DIRECTORY import: Node's ESM resolver refuses it outright, so any test that
 * imports this module for its constants would fail to load. `import type` is
 * erased before Node sees the file.
 */
import type { getD1 } from ".";

/** The same handle `db/init.ts` works with; declared the same way it declares it. */
type D1DatabaseLike = Awaited<ReturnType<typeof getD1>>;

export const WEBSITE_LEADS_WORKSPACE_ID = "org_maintsupp_website_leads";
export const WEBSITE_LEADS_WORKSPACE_SLUG = "maintsupp-website-leads";
export const WEBSITE_LEADS_WORKSPACE_NAME = "MAINTSUPP Website Leads";

/**
 * Its client company.
 *
 * `'company-' || id` is not a choice — it is the id `attachWorkspacesToCompanies`
 * derives for any workspace with no company, and that repair runs on EVERY boot.
 * Using the same shape means the two can never race to create two companies for one
 * workspace: whichever runs first, `INSERT OR IGNORE` makes the second a no-op.
 */
export const WEBSITE_LEADS_COMPANY_ID = `company-${WEBSITE_LEADS_WORKSPACE_ID}`;

/**
 * Create the intake workspace, attach it to an internal company, and keep it
 * internal. Idempotent, and safe to run on a database that already has it.
 *
 * Four statements, in this order, and the order is the point:
 *
 *   1. the company FIRST, so the workspace can reference it in the same pass and
 *      `attachWorkspacesToCompanies` never sees a workspace with no company;
 *   2. the workspace, carrying its company id explicitly rather than waiting for
 *      the repair to guess it;
 *   3. the attachment, for the one case step 2 cannot cover — a database where the
 *      repair created the row first and left `client_company_id` null;
 *   4. the internal mark, keyed on the workspace id.
 *
 * Step 4 is not redundant with step 1. `attachWorkspacesToCompanies` inserts with no
 * `kind` at all, so the column takes its `'customer'` default — and on any estate
 * where that repair ran before this stage existed, the company is already there and
 * `INSERT OR IGNORE` in step 1 does nothing. Without step 4 the intake workspace
 * would be a CUSTOMER company, reachable by an unaffiliated account, which is the
 * exact fault this file exists to fix.
 *
 * `plan_tier` is `'development'`, the same as every other workspace, NOT
 * `'internal'`. The internal-ness lives in `client_companies.kind`, which is the
 * mechanism the access resolver actually reads; `plan_tier` is a plan label, and
 * `admin-clients.tsx` renders it into a CSS class (`admin-plan--${planTier}`), so an
 * invented value would show as an unstyled badge in the console for no gain.
 *
 * `status = 'active'` is deliberate: `resolveTenantAccess` builds a platform admin's
 * `organisationIds` from `activeOrganisations`, so an archived intake workspace
 * would still accept enquiries and show none of them in the inbox.
 */
export async function ensureWebsiteLeadsWorkspace(d1: D1DatabaseLike) {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO client_companies
         (id, name, slug, status, kind, default_organisation_id, created_by)
       VALUES (?, ?, ?, 'active', 'internal', ?, 'migration:website-leads-intake')`,
    )
    .bind(
      WEBSITE_LEADS_COMPANY_ID,
      WEBSITE_LEADS_WORKSPACE_NAME,
      WEBSITE_LEADS_WORKSPACE_SLUG,
      WEBSITE_LEADS_WORKSPACE_ID,
    )
    .run();

  await d1
    .prepare(
      `INSERT OR IGNORE INTO organisations
         (id, name, slug, status, plan_tier, client_company_id)
       VALUES (?, ?, ?, 'active', 'development', ?)`,
    )
    .bind(
      WEBSITE_LEADS_WORKSPACE_ID,
      WEBSITE_LEADS_WORKSPACE_NAME,
      WEBSITE_LEADS_WORKSPACE_SLUG,
      WEBSITE_LEADS_COMPANY_ID,
    )
    .run();

  await d1
    .prepare(
      `UPDATE organisations
          SET client_company_id = ?
        WHERE id = ? AND client_company_id IS NULL`,
    )
    .bind(WEBSITE_LEADS_COMPANY_ID, WEBSITE_LEADS_WORKSPACE_ID)
    .run();

  /* Keyed on the workspace, exactly as the demo company's mark is, so a rename in
     the console cannot turn the sales pipeline into a customer's workspace. */
  await d1
    .prepare(
      `UPDATE client_companies
          SET kind = 'internal'
        WHERE kind <> 'internal'
          AND id = (SELECT client_company_id FROM organisations WHERE id = ?)`,
    )
    .bind(WEBSITE_LEADS_WORKSPACE_ID)
    .run();
}
