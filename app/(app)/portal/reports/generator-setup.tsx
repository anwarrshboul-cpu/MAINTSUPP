"use client";

/**
 * The generator's first two sections: what to bill, and what it is billed on.
 *
 * PREPOPULATED, NEVER RETYPED
 *
 * The owner's instruction was one sentence — "never make the user retype what
 * is already stored" — and it is the reason this form has a `settings` prop and
 * a `touched` set rather than a pile of `useState` defaults. Currency, VAT
 * status, VAT rate, VAT number, payment terms, billing address, client
 * reference and purchase order all have a stored value on the workspace's
 * billing settings. They arrive filled in.
 *
 * `touched` is what makes that safe to do TWICE. Settings load asynchronously
 * and a client switch loads them again; without a record of which fields the
 * person has actually edited, the second load overwrites a due date they typed
 * while it was in flight. A field the reader has touched is never re-seeded.
 *
 * THE PERIOD CONTROL IS THE PRODUCT'S PERIOD CONTROL
 *
 * `period-model.ts`'s vocabulary, not a second one. Its header is explicit
 * about why: two controls on two screens must not mean two different things by
 * "this period". The eight presets the owner named map onto tokens that already
 * exist and already resolve to those exact windows — `mtd` IS this month,
 * `ytd` IS this year — and the resolved start and end are shown as editable
 * dates underneath, so a reader can see the window a preset produced and
 * override either end into a custom range without leaving the vocabulary.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../../components";
import { isoDay } from "../period-picker";
import { rangeToken, resolvePeriod } from "../period-model";
import type { BillingSettings } from "./reports-client";
import { formatBasisPoints, formatMoney } from "../../../lib/exports/format";

/**
 * The eight presets the brief names, mapped onto tokens that already exist.
 *
 * The labels are the owner's words; the values are `period-model.ts`'s. Where
 * the two vocabularies use different words for the same window — "This Month"
 * and `mtd`, "This Year" and `ytd` — the label wins on screen and the token
 * wins everywhere else, so nothing downstream has to learn a second name for a
 * window it already resolves.
 */
export const GENERATOR_PERIOD_PRESETS: Array<{ value: string; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "mtd", label: "This Month" },
  { value: "month-1", label: "Last Month" },
  { value: "quarter", label: "This Quarter" },
  { value: "ytd", label: "This Year" },
  { value: "12m", label: "Last 12 Months" },
  { value: "range", label: "Custom Range" },
];

export interface GeneratorDraft {
  clientId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  invoiceDate: string;
  dueAt: string;
  purchaseOrder: string;
  clientReference: string;
  internalReference: string;
  paymentTerms: string;
  currency: string;
  vatEnabled: boolean;
  vatRatePercent: string;
  clientNote: string;
  internalNote: string;
}

export type DraftField = keyof GeneratorDraft;

export function emptyDraft(now: number): GeneratorDraft {
  const window = resolvePeriod("mtd", now);
  return {
    clientId: "",
    period: "mtd",
    periodStart: isoDay(window.start),
    periodEnd: isoDay(Math.min(window.end, now)),
    invoiceDate: isoDay(now),
    dueAt: "",
    purchaseOrder: "",
    clientReference: "",
    internalReference: "",
    paymentTerms: "",
    currency: "GBP",
    vatEnabled: true,
    vatRatePercent: "20",
    clientNote: "",
    internalNote: "",
  };
}

/**
 * Percent typed by a person to the basis points the contract carries.
 *
 * Basis points and not a float: 17.5% is 1750 exactly, where `0.175` is
 * 0.17499999999999999 and an invoice built on it eventually disagrees with
 * itself by a penny. Rounded rather than truncated so 17.5 does not become
 * 1749.
 */
export function percentToBasisPoints(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100);
}

/** Days added to a date, as `YYYY-MM-DD`. Used to offer a due date. */
function addCalendarDays(iso: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return "";
  const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const moved = new Date(stamp + days * 86_400_000);
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}-${String(moved.getUTCDate()).padStart(2, "0")}`;
}

/* ── Section 1 — client and reporting period ─────────────────────────────── */

export function GeneratorSetup({
  draft,
  onChange,
  clients,
  settings,
  now,
  disabled,
}: {
  draft: GeneratorDraft;
  onChange: (patch: Partial<GeneratorDraft>, touched: DraftField[]) => void;
  clients: Array<{ id: string; name: string }>;
  settings: BillingSettings | null;
  now: number;
  disabled: boolean;
}) {
  const window = useMemo(() => resolvePeriod(draft.period, now), [draft.period, now]);

  const choosePreset = (value: string) => {
    if (value === "range") {
      onChange(
        { period: rangeToken(draft.periodStart, draft.periodEnd) },
        ["period"],
      );
      return;
    }
    const next = resolvePeriod(value, now);
    if (!Number.isFinite(next.start) || !Number.isFinite(next.end)) {
      onChange({ period: value }, ["period"]);
      return;
    }
    onChange(
      {
        period: value,
        periodStart: isoDay(next.start),
        // A rolling window's end is a day out by design (see `analyticsWindow`);
        // an invoice must not claim to cover tomorrow, so the end is clamped to
        // today whenever the window runs past it.
        periodEnd: isoDay(Math.min(next.end, now)),
      },
      ["period", "periodStart", "periodEnd"],
    );
  };

  const editRange = (which: "periodStart" | "periodEnd", value: string) => {
    const start = which === "periodStart" ? value : draft.periodStart;
    const end = which === "periodEnd" ? value : draft.periodEnd;
    onChange(
      { [which]: value, period: rangeToken(start, end) } as Partial<GeneratorDraft>,
      [which, "period"],
    );
  };

  const presetValue = GENERATOR_PERIOD_PRESETS.some((preset) => preset.value === draft.period)
    ? draft.period
    : "range";

  return (
    <section className="reports-card" aria-labelledby="generator-setup-heading">
      <header className="reports-card__head">
        <h2 id="generator-setup-heading">
          <Icon name="settings" size={17} />
          Client and reporting period
        </h2>
        <p>Everything below is prepopulated from this workspace&rsquo;s stored billing settings. Change only what differs.</p>
      </header>

      <div className="reports-form">
        <label className="reports-field">
          <span>Client</span>
          <select
            value={draft.clientId}
            disabled={disabled || clients.length <= 1}
            onChange={(event) => onChange({ clientId: event.target.value }, ["clientId"])}
          >
            {clients.map((client) => (
              <option value={client.id} key={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>

        <label className="reports-field">
          <span>Reporting period</span>
          <select
            value={presetValue}
            disabled={disabled}
            onChange={(event) => choosePreset(event.target.value)}
          >
            {GENERATOR_PERIOD_PRESETS.map((preset) => (
              <option value={preset.value} key={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <label className="reports-field">
          <span>Period start</span>
          <input
            type="date"
            value={draft.periodStart}
            disabled={disabled}
            onChange={(event) => editRange("periodStart", event.target.value)}
          />
        </label>

        <label className="reports-field">
          <span>Period end</span>
          <input
            type="date"
            value={draft.periodEnd}
            disabled={disabled}
            onChange={(event) => editRange("periodEnd", event.target.value)}
          />
        </label>

        <label className="reports-field">
          <span>Invoice date</span>
          <input
            type="date"
            value={draft.invoiceDate}
            disabled={disabled}
            onChange={(event) => onChange({ invoiceDate: event.target.value }, ["invoiceDate"])}
          />
        </label>

        <label className="reports-field">
          <span>Payment due</span>
          <input
            type="date"
            value={draft.dueAt}
            disabled={disabled}
            onChange={(event) => onChange({ dueAt: event.target.value }, ["dueAt"])}
          />
        </label>

        <label className="reports-field">
          <span>Purchase order</span>
          <input
            type="text"
            value={draft.purchaseOrder}
            maxLength={60}
            disabled={disabled}
            onChange={(event) => onChange({ purchaseOrder: event.target.value }, ["purchaseOrder"])}
          />
        </label>

        <label className="reports-field">
          <span>Client reference</span>
          <input
            type="text"
            value={draft.clientReference}
            maxLength={60}
            disabled={disabled}
            onChange={(event) => onChange({ clientReference: event.target.value }, ["clientReference"])}
          />
        </label>

        <label className="reports-field">
          <span>
            Internal reference
            <span className="reports-internal-tag">Internal</span>
          </span>
          <input
            type="text"
            value={draft.internalReference}
            maxLength={60}
            disabled={disabled}
            onChange={(event) => onChange({ internalReference: event.target.value }, ["internalReference"])}
          />
        </label>

        <label className="reports-field">
          <span>Payment terms</span>
          <input
            type="text"
            value={draft.paymentTerms}
            maxLength={120}
            placeholder="30 days from invoice date"
            disabled={disabled}
            onChange={(event) => onChange({ paymentTerms: event.target.value }, ["paymentTerms"])}
          />
        </label>

        <label className="reports-field">
          <span>Currency</span>
          <select
            value={draft.currency}
            disabled={disabled}
            onChange={(event) => onChange({ currency: event.target.value }, ["currency"])}
          >
            <option value="GBP">GBP — Pound sterling</option>
            <option value="EUR">EUR — Euro</option>
            <option value="USD">USD — US dollar</option>
          </select>
        </label>

        <label className="reports-field">
          <span>VAT status</span>
          <select
            value={draft.vatEnabled ? "charged" : "not-charged"}
            disabled={disabled}
            onChange={(event) =>
              onChange({ vatEnabled: event.target.value === "charged" }, ["vatEnabled"])
            }
          >
            <option value="charged">Charged</option>
            <option value="not-charged">Not charged</option>
          </select>
        </label>

        <label className="reports-field">
          <span>VAT rate (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={draft.vatRatePercent}
            disabled={disabled || !draft.vatEnabled}
            onChange={(event) => onChange({ vatRatePercent: event.target.value }, ["vatRatePercent"])}
          />
        </label>

        <label className="reports-field reports-field--wide">
          <span>Note to the client</span>
          <textarea
            rows={2}
            maxLength={600}
            value={draft.clientNote}
            disabled={disabled}
            onChange={(event) => onChange({ clientNote: event.target.value }, ["clientNote"])}
          />
        </label>

        <label className="reports-field reports-field--wide">
          <span>
            Internal note
            <span className="reports-internal-tag">Never sent to the client</span>
          </span>
          <textarea
            rows={2}
            maxLength={600}
            value={draft.internalNote}
            disabled={disabled}
            onChange={(event) => onChange({ internalNote: event.target.value }, ["internalNote"])}
          />
        </label>
      </div>

      <p className="reports-card__foot">
        <Icon name="calendar" size={14} />
        {window.recognised ? (
          <>
            <strong>{window.label}</strong>
            <span>
              {draft.periodStart || "—"} to {draft.periodEnd || "—"}, stored as ISO and shown as
              DD/MM/YYYY on the document.
            </span>
          </>
        ) : (
          <span>{window.reason}</span>
        )}
        {draft.invoiceDate && !draft.dueAt && (
          <button
            type="button"
            className="reports-linkish"
            disabled={disabled}
            onClick={() =>
              onChange({ dueAt: addCalendarDays(draft.invoiceDate, settings?.paymentTermsDays ?? 30) }, ["dueAt"])
            }
          >
            Set due date {settings?.paymentTermsDays ?? 30} days out
          </button>
        )}
      </p>
    </section>
  );
}

/* ── Section 2 — billing configuration summary ───────────────────────────── */

/**
 * What the invoice is being built from, stated before any figure appears.
 *
 * A reader who sees "Total payable £485.00" and disagrees with it needs to know
 * which fee, which VAT rate and which default were used to get there. That is
 * what this panel is: the configuration, read back, with the organisation
 * default beside it — so a wrong total is traceable to a wrong setting rather
 * than to "the system".
 */
export function BillingConfigurationSummary({
  settings,
  draft,
  loading,
  error,
}: {
  settings: BillingSettings | null;
  draft: GeneratorDraft;
  loading: boolean;
  error: string | null;
}) {
  const rows: Array<{ label: string; value: string; note?: string }> = [
    {
      label: "Organisation default fee per site",
      value:
        typeof settings?.defaultFeePence === "number"
          ? formatMoney(settings.defaultFeePence, draft.currency)
          : "Not set",
      note: "Used where a site has no override and the client has no fee.",
    },
    {
      label: "Currency",
      value: draft.currency,
      note: settings?.currency && settings.currency !== draft.currency
        ? `Stored setting is ${settings.currency}; this document overrides it.`
        : undefined,
    },
    {
      label: "VAT",
      value: draft.vatEnabled
        ? `Charged at ${formatBasisPoints(percentToBasisPoints(draft.vatRatePercent))}`
        : "Not charged",
      note: settings?.vatNumber ? `VAT number ${settings.vatNumber}` : undefined,
    },
    {
      label: "Invoice numbering",
      value: settings?.invoiceNumberPrefix
        ? `${settings.invoiceNumberPrefix}-${String((settings.invoiceSequence ?? 0) + 1).padStart(6, "0")} next`
        : "Issued at finalisation",
      note: "A number is issued when the document is finalised, never before.",
    },
    {
      label: "Billing address",
      value: settings?.billingAddress || "Not set",
    },
  ];

  return (
    <section className="reports-card" aria-labelledby="generator-config-heading">
      <header className="reports-card__head">
        <h2 id="generator-config-heading">
          <Icon name="shield" size={17} />
          Billing configuration
        </h2>
        <p>The stored settings these figures are built from.</p>
      </header>
      {error ? (
        <p className="reports-alert reports-alert--warning">
          <Icon name="alert" size={15} />
          {error} The generator will still compute from the period, but the fields above were
          not prepopulated.
        </p>
      ) : loading ? (
        <p className="reports-empty">Reading the billing settings…</p>
      ) : (
        <dl className="reports-facts reports-facts--grid">
          {rows.map((row) => (
            <div className="reports-facts__row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>
                {row.value}
                {row.note && <small>{row.note}</small>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/* ── Prepopulation ───────────────────────────────────────────────────────── */

/**
 * Seed the draft from stored settings, without overwriting anything typed.
 *
 * The `touched` set is a ref rather than state on purpose: it must not cause a
 * render, and it must survive the settings arriving. See the file header for
 * why re-seeding is otherwise a data-loss bug rather than a cosmetic one.
 */
export function useSettingsPrepopulation(
  settings: BillingSettings | null,
  draft: GeneratorDraft,
  apply: (patch: Partial<GeneratorDraft>) => void,
): (fields: DraftField[]) => void {
  const touched = useRef(new Set<DraftField>());
  const markTouched = useCallback((fields: DraftField[]) => {
    for (const field of fields) touched.current.add(field);
  }, []);

  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!settings || seeded) return;
    const patch: Partial<GeneratorDraft> = {};
    const put = <K extends DraftField>(field: K, value: GeneratorDraft[K] | undefined | null) => {
      if (touched.current.has(field)) return;
      if (value === undefined || value === null || value === "") return;
      patch[field] = value;
    };
    put("currency", settings.currency);
    put("vatEnabled", settings.vatEnabled);
    if (typeof settings.vatRateBasisPoints === "number") {
      put("vatRatePercent", String(settings.vatRateBasisPoints / 100));
    }
    put("paymentTerms", settings.paymentTerms ?? undefined);
    put("clientReference", settings.clientReference ?? undefined);
    put("purchaseOrder", settings.purchaseOrder ?? undefined);
    if (!touched.current.has("dueAt") && !draft.dueAt && draft.invoiceDate) {
      patch.dueAt = addCalendarDays(draft.invoiceDate, settings.paymentTermsDays ?? 30);
    }
    setSeeded(true);
    if (Object.keys(patch).length) apply(patch);
  }, [apply, draft.dueAt, draft.invoiceDate, seeded, settings]);

  return markTouched;
}
