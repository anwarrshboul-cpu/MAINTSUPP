/**
 * `/api/reports/settings` — the organisation's billing configuration.
 *
 * GET is `board.view`, because the fee a site is charged is something anyone
 * who can see the estate is entitled to know. PUT is `settings.edit`, which is
 * the Administrator / Finance capability in this workspace's existing model —
 * see `app/lib/reporting/access.ts` for the whole mapping and for why
 * `billing.manage` was not used.
 *
 * `invoice_sequence` is not writable here. It is the counter that must never
 * issue a number twice, and a settings form that could reset it is how two
 * invoices end up sharing one.
 */

import { auditActor, changeDetail, recordAudit } from "../../../lib/audit";
import {
  billingConfiguration,
  readBillingSettings,
  writeBillingSettings,
  type BillingSettingsPatch,
} from "../../../lib/billing/settings";
import { REPORT_CAPABILITIES } from "../../../lib/reporting/access";
import {
  badRequest,
  guard,
  pence,
  reportUnavailable,
  text,
} from "../../../lib/reporting/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["settings.read"]);
    if (guarded.denied) return guarded.denied;
    const { db, orgId, organisation } = guarded.scope;
    const row = await readBillingSettings(db, orgId);
    return Response.json({
      settings: row,
      configuration: billingConfiguration(row),
      clientName: organisation.name,
    });
  } catch (error) {
    return reportUnavailable(error);
  }
}

export async function PUT(request: Request) {
  try {
    const guarded = await guard(request, REPORT_CAPABILITIES["settings.write"]);
    if (guarded.denied) return guarded.denied;
    const scope = guarded.scope;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return badRequest("Send a JSON body.");

    const patch: BillingSettingsPatch = {};
    if ("currency" in body) {
      const currency = text(body.currency, 8);
      if (!currency) return badRequest("A currency is required.");
      patch.currency = currency.toUpperCase();
    }
    if ("defaultSiteFeePence" in body) {
      /* Null is meaningful and different from zero: null means "no default is
         configured", which the fee resolver reports as a blocking gap, while
         zero means "every site is charged nothing", which is a decision. */
      if (body.defaultSiteFeePence === null) {
        patch.defaultSiteFeePence = null;
      } else {
        const value = pence(body.defaultSiteFeePence);
        if (value === null || value < 0) return badRequest("The default site fee must be a whole number of pence, or null.");
        patch.defaultSiteFeePence = value;
      }
    }
    if ("vatEnabled" in body) patch.vatEnabled = Boolean(body.vatEnabled);
    if ("vatRateBasisPoints" in body) {
      const value = pence(body.vatRateBasisPoints);
      if (value === null || value < 0 || value > 10_000) {
        return badRequest("The VAT rate must be in basis points between 0 and 10000 (20% is 2000).");
      }
      patch.vatRateBasisPoints = value;
    }
    if ("vatNumber" in body) patch.vatNumber = text(body.vatNumber, 40);
    if ("paymentTermsDays" in body) {
      const value = pence(body.paymentTermsDays);
      if (value === null || value < 0 || value > 365) return badRequest("Payment terms must be between 0 and 365 days.");
      patch.paymentTermsDays = value;
    }
    if ("paymentTermsNote" in body) patch.paymentTermsNote = text(body.paymentTermsNote, 400);
    if ("billingAddress" in body) patch.billingAddress = text(body.billingAddress, 600);
    if ("invoiceNumberPrefix" in body) {
      const prefix = text(body.invoiceNumberPrefix, 12);
      if (!prefix) return badRequest("An invoice number prefix is required.");
      patch.invoiceNumberPrefix = prefix;
    }
    if ("proRataEnabled" in body) patch.proRataEnabled = Boolean(body.proRataEnabled);

    if (Object.keys(patch).length === 0) return badRequest("Nothing to change.");

    const before = await readBillingSettings(scope.db, scope.orgId);
    const after = await writeBillingSettings(scope.db, scope.orgId, patch, scope.identityEmail);

    await recordAudit({
      db: scope.db,
      organisationId: scope.orgId,
      actor: auditActor(scope),
      action: "billing.settings_changed",
      entityType: "billing_settings",
      entityId: after.id,
      summary: `Changed the billing settings (${Object.keys(patch).join(", ")}).`,
      detail: changeDetail(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
      ),
      request,
    });

    return Response.json({ settings: after, configuration: billingConfiguration(after) });
  } catch (error) {
    return reportUnavailable(error);
  }
}
