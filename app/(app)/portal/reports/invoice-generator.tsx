"use client";

/**
 * The Invoice & Report Generator tab.
 *
 * WHAT DECIDES THE ORDER OF THIS SCREEN
 *
 * It is the order the owner listed, and the order is the argument: controls,
 * then what the figures are built from, then the invoice figures, then the
 * lines behind them, then the maintenance figures, then what is wrong with the
 * data, then the document, then the actions. A reader arrives at Finalise
 * having already been shown every reason not to press it.
 *
 * THE FIGURES COME FROM THE SERVER AND ARE NEVER TOUCHED
 *
 * Every number on this screen comes out of a `CombinedReportPayload` that
 * `/api/reports/preview` computed. This component does not add, subtract, round
 * or re-derive one of them — `invoiceKpiRows`, `maintenanceKpiRows` and
 * `buildReportDocument` in `app/lib/exports/document-model.ts` are the same
 * functions the three exporters call. That is why the preview and the files
 * cannot disagree: they are not two implementations that agree, they are one.
 *
 * "RECALCULATE IMMEDIATELY ON ANY DRAFT CHANGE"
 *
 * Taken literally would be a request per keystroke in the note field. It is
 * implemented as a 500 ms debounce on the fields that can actually MOVE a
 * figure — the period, the client, the currency and the VAT — and not on the
 * ones that cannot, because a note does not change a total and re-fetching for
 * it would make the screen flicker while somebody is writing. `Recalculate` is
 * also an explicit control, because after somebody else changes a fee the
 * inputs on this screen have not changed and only an explicit ask is honest.
 *
 * PREVIEW NEVER FINALISES
 *
 * There is no path from any preview control to a write. `/api/reports/preview`
 * persists nothing, and the state machine — submit, approve, finalise, void —
 * lives behind separate buttons that each name what they do and each require a
 * saved document.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../../components";
import { AnalyticsMetricCard } from "../dashboard-analytics";
import { useCapability } from "../../../lib/client-capabilities";
import type {
  BillableSiteLine,
  CombinedReportPayload,
  ExportFormat,
  FinalisationBlocker,
  InvoiceStatus,
} from "../../../lib/reporting/contract";
import {
  buildReportDocument,
  invoiceKpiRows,
  maintenanceKpiRows,
  SPEND_LABELS,
} from "../../../lib/exports/document-model";
import { formatBasisPoints, formatMoney } from "../../../lib/exports/format";
import { CombinedDocumentPreview } from "./report-preview";
import {
  BillingConfigurationSummary,
  emptyDraft,
  GeneratorSetup,
  percentToBasisPoints,
  useSettingsPrepopulation,
} from "./generator-setup";
import type { DraftField, GeneratorDraft } from "./generator-setup";
import {
  exportPreview,
  exportUrl,
  fetchBillingSettings,
  fetchDocument,
  fetchPreview,
  fetchWorkspaceClients,
  patchDocument,
  runDocumentAction,
  saveBlob,
  saveDraft,
  setLineInclusion,
} from "./reports-client";
import type { BillingSettings, DocumentAction } from "./reports-client";

/* ── Small shared pieces ─────────────────────────────────────────────────── */

const JOBS_ITEM_HREF = (requestId: string) =>
  `/dashboard/jobs?item=${encodeURIComponent(requestId)}`;

function StatusChip({ status }: { status: InvoiceStatus }) {
  const tone =
    status === "Finalised"
      ? "good"
      : status === "Approved"
        ? "info"
        : status === "Voided"
          ? "blocking"
          : status === "Ready for Review"
            ? "warning"
            : "draft";
  return <span className={`reports-status reports-status--${tone}`}>{status}</span>;
}

/**
 * The three severities, visually distinct, with the distinction spelled out.
 *
 * Colour alone would leave a colour-blind reader unable to tell a blocker from
 * a note, on the one screen where that difference decides whether a document
 * can be issued. Each carries its word as well as its hue, and blockers carry
 * the sentence "this stops finalisation" rather than leaving it implied.
 */
function IssueList({
  title,
  severity,
  items,
}: {
  title: string;
  severity: "blocking" | "warning" | "info";
  items: Array<{ code: string; message: string; href?: string | null }>;
}) {
  if (!items.length) return null;
  return (
    <div className={`reports-issues reports-issues--${severity}`}>
      <h4>
        <Icon name={severity === "blocking" ? "close" : severity === "warning" ? "alert" : "message"} size={15} />
        {title}
        <span className="reports-issues__count">{items.length}</span>
      </h4>
      {severity === "blocking" && (
        <p className="reports-issues__lead">These stop the document being finalised.</p>
      )}
      {severity === "warning" && (
        <p className="reports-issues__lead">
          These do not stop a draft. They are reported so the reader knows what the figures rest on.
        </p>
      )}
      <ul>
        {items.map((item, index) => (
          <li key={`${item.code}-${index}`}>
            <code>{item.code}</code>
            <span>{item.message}</span>
            {item.href && (
              <a href={item.href}>
                Open <Icon name="chevron" size={13} />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── The billable-sites table ────────────────────────────────────────────── */

function BillableSitesTable({
  payload,
  canEdit,
  onExclude,
  onInclude,
  busyLine,
}: {
  payload: CombinedReportPayload;
  canEdit: boolean;
  onExclude: (line: BillableSiteLine) => void;
  onInclude: (line: BillableSiteLine) => void;
  busyLine: number | null;
}) {
  const currency = payload.invoice.currency;
  const totals = payload.invoice.totals;
  return (
    <section className="reports-card" aria-labelledby="generator-sites-heading">
      <header className="reports-card__head">
        <h2 id="generator-sites-heading">
          <Icon name="store" size={17} />
          Billable active sites
        </h2>
        <p>
          One line per site considered for this period. An excluded line keeps its row so the
          exclusion stays visible, and is not counted in the totals.
        </p>
      </header>
      <div className="reports-table-scroll" tabIndex={0} role="region" aria-label="Billable sites">
        <table className="reports-table reports-table--sites">
          <thead>
            <tr>
              <th scope="col">Site name</th>
              <th scope="col">Site reference</th>
              <th scope="col">Active status</th>
              <th scope="col">Active from</th>
              <th scope="col">Active to</th>
              <th scope="col">Billable</th>
              <th scope="col" className="is-right">Applied fee</th>
              <th scope="col">Fee source</th>
              <th scope="col" className="is-right">VAT rate</th>
              <th scope="col" className="is-right">Line subtotal</th>
              <th scope="col">Inclusion</th>
              <th scope="col">Validation</th>
              {canEdit && <th scope="col">Action</th>}
            </tr>
          </thead>
          <tbody>
            {payload.invoice.lines.map((line) => {
              const worst = line.validation.find((entry) => entry.severity === "blocking")
                ?? line.validation.find((entry) => entry.severity === "warning")
                ?? line.validation[0];
              return (
                <tr key={line.lineNo} className={line.included ? undefined : "is-excluded"}>
                  <td data-label="Site name"><strong>{line.siteName}</strong></td>
                  <td data-label="Site reference">{line.siteReference ?? "—"}</td>
                  <td data-label="Active status">{line.activeStatus}</td>
                  <td data-label="Active from">{formatDate(line.activeFrom)}</td>
                  <td data-label="Active to">{formatDate(line.activeTo)}</td>
                  <td data-label="Billable">{line.billable ? "Yes" : "No"}</td>
                  <td data-label="Applied fee" className="is-right">
                    {formatMoney(line.feePence, currency)}
                  </td>
                  <td data-label="Fee source">
                    {line.feeSource ?? (
                      <span className="reports-cell reports-cell--blocking">No fee found</span>
                    )}
                  </td>
                  <td data-label="VAT rate" className="is-right">
                    {formatBasisPoints(line.vatRateBasisPoints)}
                  </td>
                  <td data-label="Line subtotal" className="is-right">
                    {formatMoney(line.lineSubtotalPence, currency)}
                  </td>
                  <td data-label="Inclusion">
                    {line.included ? (
                      "Included"
                    ) : (
                      <span className="reports-exclusion">
                        Excluded
                        {line.excludedByEmail && <small>by {line.excludedByEmail}</small>}
                        {line.exclusionReason && <small>{line.exclusionReason}</small>}
                      </span>
                    )}
                  </td>
                  <td data-label="Validation">
                    {worst ? (
                      <span className={`reports-cell reports-cell--${worst.severity}`}>
                        {worst.message}
                      </span>
                    ) : (
                      <span className="reports-cell reports-cell--good">Clear</span>
                    )}
                  </td>
                  {canEdit && (
                    <td data-label="Action">
                      <button
                        type="button"
                        className="reports-linkish"
                        disabled={busyLine === line.lineNo}
                        onClick={() => (line.included ? onExclude(line) : onInclude(line))}
                      >
                        {line.included ? "Exclude…" : "Include"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
            {!payload.invoice.lines.length && (
              <tr>
                <td colSpan={canEdit ? 13 : 12} className="reports-empty">
                  No site was billable in this period, so the invoice carries no lines.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td data-label="Total sites"><strong>{totals.totalSites} sites</strong></td>
              <td data-label="Included"><strong>{totals.includedSites} included</strong></td>
              <td data-label="Excluded"><strong>{totals.excludedSites} excluded</strong></td>
              <td colSpan={6} />
              <td data-label="Subtotal" className="is-right">
                <strong>{formatMoney(totals.subtotalPence, currency)}</strong>
              </td>
              <td data-label="VAT"><strong>VAT {formatMoney(totals.vatPence, currency)}</strong></td>
              <td data-label="Total" colSpan={canEdit ? 2 : 1}>
                <strong>Total {formatMoney(totals.totalPence, currency)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

/** DD/MM/YYYY, through the export formatter so one screen cannot drift. */
function formatDate(value: string | null): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

/* ── The generator ───────────────────────────────────────────────────────── */

export function InvoiceReportGenerator({
  now,
  openDocumentId = null,
}: {
  now: number;
  /**
   * A document the Generated Documents tab asked to open. Read once on mount
   * and whenever it changes, which is what makes "View" on that table land on
   * this screen showing that document rather than on a fresh draft.
   */
  openDocumentId?: string | null;
}) {
  const canEdit = useCapability("board.edit");
  const canSettle = useCapability("settings.edit");
  const canExport = useCapability("data.export");

  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [draft, setDraft] = useState<GeneratorDraft>(() => emptyDraft(now));
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);

  const [payload, setPayload] = useState<CombinedReportPayload | null>(null);
  const [blockers, setBlockers] = useState<FinalisationBlocker[]>([]);
  const [warnings, setWarnings] = useState<FinalisationBlocker[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(false);

  const [computing, setComputing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyLine, setBusyLine] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [drill, setDrill] = useState<string | null>(null);

  const applyPatch = useCallback((patch: Partial<GeneratorDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);
  const markTouched = useSettingsPrepopulation(settings, draft, applyPatch);

  const onDraftChange = useCallback(
    (patch: Partial<GeneratorDraft>, touched: DraftField[]) => {
      markTouched(touched);
      applyPatch(patch);
    },
    [applyPatch, markTouched],
  );

  /* Billing settings, once. */
  useEffect(() => {
    let cancelled = false;
    void fetchBillingSettings().then((result) => {
      if (cancelled) return;
      setSettingsLoading(false);
      if (result.ok) setSettings(result.data.settings ?? null);
      else setSettingsError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* The clients this reader may bill. See `fetchWorkspaceClients`. */
  useEffect(() => {
    let cancelled = false;
    void fetchWorkspaceClients()
      .then((list) => {
        if (cancelled || !list.length) return;
        setClients(list);
        setDraft((current) =>
          current.clientId ? current : { ...current, clientId: list[0]!.id },
        );
      })
      .catch(() => {
        // The selector stays on "This workspace"; the period still computes.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The question the engine is asked. Only these four fields can move a figure,
   * which is why the debounce below watches this and not the whole draft: a
   * note or a purchase order changes the document without changing a total.
   */
  const question = useMemo(
    () => ({
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      preset: draft.period,
      clientId: draft.clientId,
    }),
    [draft.clientId, draft.period, draft.periodEnd, draft.periodStart],
  );

  const requestToken = useRef(0);
  const compute = useCallback(async () => {
    if (!question.periodStart || !question.periodEnd) return;
    const token = (requestToken.current += 1);
    setComputing(true);
    const result = await fetchPreview(question);
    // A stale answer must never overwrite a fresh one — three quick period
    // changes resolve in whatever order the network chooses.
    if (token !== requestToken.current) return;
    setComputing(false);
    if (!result.ok) {
      setMessage({ tone: "bad", text: result.error });
      return;
    }
    setPayload(result.data.payload);
    setBlockers(result.data.blockers);
    setWarnings(result.data.warnings);
    setSnapshot(false);
  }, [question]);

  /*
   * The debounce. See the header on what "immediately" means here.
   *
   * Suspended once a document is open. A saved document's figures come from
   * that document — its own excluded lines, and its stored snapshot once it is
   * finalised — and a background recomputation from the period alone would put
   * the excluded site's fee back on screen a second after somebody excluded it.
   * `Recalculate` is the explicit way to ask a saved document to re-read the
   * data, and it goes through the document's own action endpoint.
   */
  useEffect(() => {
    if (documentId) return;
    const timer = window.setTimeout(() => void compute(), 500);
    return () => window.clearTimeout(timer);
  }, [compute, documentId]);

  /* `.then` rather than `await` — see the note on `load` in generated-documents.tsx. */
  const reloadDocument = useCallback(
    (id: string) =>
      fetchDocument(id).then((result) => {
        if (!result.ok) {
          setMessage({ tone: "bad", text: result.error });
          return;
        }
        setPayload(result.data.payload);
        setBlockers(result.data.blockers);
        setSnapshot(result.data.snapshot);
      }),
    [],
  );

  /*
   * "View" on the Generated Documents table lands here.
   *
   * Loading the document also stops the debounce above from overwriting it:
   * `documentId` being set makes every subsequent action go through the
   * document endpoints, and the preview refetch only runs when the QUESTION
   * changes, which opening a document does not do.
   */
  /*
   * The id is adopted DURING RENDER rather than in the effect, which is React's
   * documented way to adjust state when a prop changes and is what stops the
   * debounce below firing one recomputation against a period the reader never
   * asked about, in the frame between the prop arriving and an effect running.
   * The FETCH stays in the effect, where a side effect belongs.
   */
  const [adoptedDocumentId, setAdoptedDocumentId] = useState<string | null>(null);
  if (openDocumentId && openDocumentId !== adoptedDocumentId) {
    setAdoptedDocumentId(openDocumentId);
    setDocumentId(openDocumentId);
  }

  useEffect(() => {
    if (!openDocumentId) return;
    void reloadDocument(openDocumentId);
  }, [openDocumentId, reloadDocument]);

  const status: InvoiceStatus = payload?.invoice.status ?? "Draft";
  const currency = payload?.invoice.currency ?? draft.currency;
  const editable = status === "Draft" || status === "Ready for Review";

  /* ── Actions ───────────────────────────────────────────────────────────── */

  const runSave = async () => {
    setBusy("save");
    const input = {
      clientId: draft.clientId,
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      preset: draft.period,
      invoiceDate: draft.invoiceDate || null,
      dueAt: draft.dueAt || null,
      purchaseOrder: draft.purchaseOrder || null,
      clientReference: draft.clientReference || null,
      internalReference: draft.internalReference || null,
      paymentTerms: draft.paymentTerms || null,
      currency: draft.currency,
      vatEnabled: draft.vatEnabled,
      vatRateBasisPoints: percentToBasisPoints(draft.vatRatePercent),
      clientNote: draft.clientNote || null,
      internalNote: draft.internalNote || null,
    };
    const result = documentId
      ? await patchDocument(documentId, input)
      : await saveDraft(input);
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: "bad", text: result.error });
      return;
    }
    const id =
      documentId ??
      (result.data as { document?: { invoiceId?: string }; invoiceId?: string })?.document
        ?.invoiceId ??
      (result.data as { invoiceId?: string })?.invoiceId ??
      null;
    if (id) {
      setDocumentId(id);
      await reloadDocument(id);
    }
    setMessage({ tone: "ok", text: documentId ? "Draft updated." : "Draft saved." });
  };

  const runAction = async (action: DocumentAction, prompt?: string) => {
    if (!documentId) {
      setMessage({ tone: "bad", text: "Save the draft before using this control." });
      return;
    }
    let reason: string | undefined;
    if (prompt) {
      const typed = window.prompt(prompt);
      if (typed === null) return;
      if (!typed.trim()) {
        setMessage({ tone: "bad", text: "A reason is required." });
        return;
      }
      reason = typed.trim();
    }
    setBusy(action);
    const result = await runDocumentAction(documentId, action, reason);
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: "bad", text: result.error });
      return;
    }
    await reloadDocument(documentId);
    setMessage({ tone: "ok", text: `Document ${action}d.`.replace("finalised", "finalised") });
  };

  const changeInclusion = async (line: BillableSiteLine, include: boolean) => {
    if (!documentId) {
      setMessage({
        tone: "bad",
        text: "Save the draft before including or excluding a site — an exclusion is an audited change and needs a document to attach to.",
      });
      return;
    }
    let reason: string | undefined;
    if (!include) {
      const typed = window.prompt(
        `Exclude ${line.siteName} from this invoice.\n\nWhy? This is recorded against your name and shown on the document.`,
      );
      if (typed === null) return;
      if (!typed.trim()) {
        setMessage({ tone: "bad", text: "An exclusion needs a reason." });
        return;
      }
      reason = typed.trim();
    }
    setBusyLine(line.lineNo);
    const result = await setLineInclusion(documentId, {
      lineNo: line.lineNo,
      siteId: line.siteId,
      included: include,
      reason,
    });
    setBusyLine(null);
    if (!result.ok) {
      setMessage({ tone: "bad", text: result.error });
      return;
    }
    await reloadDocument(documentId);
  };

  const runExport = async (format: ExportFormat) => {
    setBusy(`export-${format}`);
    if (documentId) {
      // A plain navigation for a saved document — see `exportUrl`.
      window.location.assign(exportUrl(documentId, format));
      setBusy(null);
      return;
    }
    const result = await exportPreview(question, format);
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: "bad", text: result.error });
      return;
    }
    saveBlob(result.data.blob, result.data.filename);
  };

  /* ── Derived, from the payload and nothing else ────────────────────────── */

  const invoiceCards = payload ? invoiceKpiRows(payload) : [];
  const maintenanceCards = payload ? maintenanceKpiRows(payload) : [];
  const lineIssues = payload
    ? payload.invoice.lines.flatMap((line) =>
        line.validation.map((entry) => ({
          severity: entry.severity,
          code: entry.code,
          message: `${line.siteName}: ${entry.message}`,
          href: null as string | null,
        })),
      )
    : [];
  const quality = payload?.maintenance.dataQuality ?? [];
  const allIssues = [
    ...quality.map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      message: finding.message,
      href: finding.href,
    })),
    ...lineIssues,
  ];
  const blockingIssues = allIssues.filter((issue) => issue.severity === "blocking");
  const warningIssues = allIssues.filter((issue) => issue.severity === "warning");
  const infoIssues = allIssues.filter((issue) => issue.severity === "info");

  const drillRows = useMemo(() => {
    if (!payload || !drill) return [];
    const log = payload.maintenance.jobLog.flatMap((group) =>
      group.rows.map((row) => ({ ...row, group: group.group })),
    );
    switch (drill) {
      case "completed":
        return log.filter((row) => row.group === "Completed");
      case "open":
        return log.filter((row) => row.group !== "Completed" && row.group !== "Cancelled");
      case "hold":
        return log.filter((row) => row.group === "On Hold");
      case "past-target":
        return payload.maintenance.openPastTarget.map((row) => ({
          requestId: row.requestId,
          reference: row.reference,
          siteName: row.siteName,
          issue: row.issue,
          group: row.status,
          raisedOn: row.raisedOn,
        }));
      case "critical":
        return payload.maintenance.criticalOpen.map((row) => ({
          requestId: row.requestId,
          reference: row.reference,
          siteName: row.siteName,
          issue: row.issue,
          group: row.status,
          raisedOn: row.raisedOn,
        }));
      case "sla":
        return payload.maintenance.sla.map((row) => ({
          requestId: row.requestId,
          reference: row.reference,
          siteName: row.siteName,
          issue: row.description,
          group: row.result,
          raisedOn: null,
        }));
      default:
        return log;
    }
  }, [drill, payload]);

  const documentTitle = payload ? buildReportDocument(payload).title : "";

  return (
    <div className="reports-generator">
      {message && (
        <p
          className={`reports-alert reports-alert--${message.tone === "ok" ? "ok" : "blocking"}`}
          role="status"
        >
          <Icon name={message.tone === "ok" ? "check" : "alert"} size={15} />
          {message.text}
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </p>
      )}

      <GeneratorSetup
        draft={draft}
        onChange={onDraftChange}
        clients={clients.length ? clients : [{ id: draft.clientId || "current", name: "This workspace" }]}
        settings={settings}
        now={now}
        disabled={!editable || canEdit === false}
      />

      <BillingConfigurationSummary
        settings={settings}
        draft={draft}
        loading={settingsLoading}
        error={settingsError}
      />

      {/* ── Invoice KPI cards ──────────────────────────────────────────── */}
      <section className="reports-card" aria-labelledby="generator-invoice-heading">
        <header className="reports-card__head">
          <h2 id="generator-invoice-heading">
            <Icon name="chart" size={17} />
            Invoice
            <StatusChip status={status} />
            {computing && <span className="reports-computing">Recalculating…</span>}
          </h2>
          <p>
            The MAINTSUPP service fee for this period. This is what the client is invoiced and is
            never presented as maintenance expenditure.
          </p>
        </header>
        {payload ? (
          <div className="reports-kpis" aria-label="Invoice figures">
            {invoiceCards.map((card) => (
              <article className="reports-kpi" key={card.key}>
                <small>{card.label}</small>
                <strong>{card.value}</strong>
                {card.note && <span>{card.note}</span>}
              </article>
            ))}
          </div>
        ) : (
          <p className="reports-empty">
            {computing ? "Computing the invoice for this period…" : "Choose a period to compute the invoice."}
          </p>
        )}
      </section>

      {payload && (
        <BillableSitesTable
          payload={payload}
          canEdit={Boolean(canEdit) && editable}
          busyLine={busyLine}
          onExclude={(line) => void changeInclusion(line, false)}
          onInclude={(line) => void changeInclusion(line, true)}
        />
      )}

      {/* ── Maintenance KPI cards ──────────────────────────────────────── */}
      {payload && (
        <section className="reports-card" aria-labelledby="generator-maintenance-heading">
          <header className="reports-card__head">
            <h2 id="generator-maintenance-heading">
              <Icon name="tool" size={17} />
              Maintenance performance
            </h2>
            <p>What the portfolio did in this period. Select a figure to list the jobs behind it.</p>
          </header>
          <div className="reports-kpis reports-kpis--wide" aria-label="Maintenance figures">
            {maintenanceCards.map((card) => (
              <AnalyticsMetricCard
                key={card.key}
                label={card.label}
                value={card.value}
                icon="chart"
                tone={card.key === "criticalOpenJobs" ? "red" : card.key === "slaPerformance" ? "blue" : "teal"}
                onClick={() => setDrill((current) => (current === card.drill ? null : card.drill))}
              />
            ))}
          </div>

          {drill && (
            <div className="reports-drill">
              <header>
                <h3>{drillRows.length} job{drillRows.length === 1 ? "" : "s"} behind this figure</h3>
                <button type="button" onClick={() => setDrill(null)}>
                  Close <Icon name="close" size={13} />
                </button>
              </header>
              <div className="reports-table-scroll" tabIndex={0} role="region" aria-label="Jobs behind this figure">
                <table className="reports-table">
                  <thead>
                    <tr>
                      <th scope="col">Reference</th>
                      <th scope="col">Site</th>
                      <th scope="col">Job</th>
                      <th scope="col">State</th>
                      <th scope="col">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillRows.map((row) => (
                      <tr key={row.requestId}>
                        <td data-label="Reference">{row.reference ?? row.requestId}</td>
                        <td data-label="Site">{row.siteName}</td>
                        <td data-label="Job">{row.issue}</td>
                        <td data-label="State">{row.group}</td>
                        <td data-label="Open">
                          <a href={JOBS_ITEM_HREF(row.requestId)}>
                            Open on the board <Icon name="chevron" size={13} />
                          </a>
                        </td>
                      </tr>
                    ))}
                    {!drillRows.length && (
                      <tr>
                        <td colSpan={5} className="reports-empty">
                          No job in this period matches that figure.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* THE FIVE FIGURES, SEPARATELY LABELLED. The owner's instruction was
              that the invoice total must never read as maintenance
              expenditure, so the service fee is first, is labelled as the
              invoice, and the panel says in words that these do not add up. */}
          <div className="reports-spend">
            <h3>Expenditure, reported separately</h3>
            <p>
              These five figures are <strong>not additive</strong>. The service fee is what
              MAINTSUPP invoices; the others are what the portfolio spent on maintenance.
            </p>
            <dl>
              <div className="reports-spend__row is-fee">
                <dt>{SPEND_LABELS.serviceFee}</dt>
                <dd>{formatMoney(payload.maintenance.spend.serviceFeePence, currency)}</dd>
              </div>
              <div className="reports-spend__row">
                <dt>{SPEND_LABELS.completed}</dt>
                <dd>{formatMoney(payload.maintenance.spend.completedMaintenancePence, currency)}</dd>
              </div>
              <div className="reports-spend__row">
                <dt>{SPEND_LABELS.openCommitted}</dt>
                <dd>{formatMoney(payload.maintenance.spend.openCommittedPence, currency)}</dd>
              </div>
              <div className="reports-spend__row">
                <dt>{SPEND_LABELS.project}</dt>
                <dd>{formatMoney(payload.maintenance.spend.projectPence, currency)}</dd>
              </div>
              <div className="reports-spend__row">
                <dt>{SPEND_LABELS.routine}</dt>
                <dd>{formatMoney(payload.maintenance.spend.routinePence, currency)}</dd>
              </div>
            </dl>
          </div>
        </section>
      )}

      {/* ── Data quality ───────────────────────────────────────────────── */}
      {payload && (
        <section className="reports-card" id="generator-issues" aria-labelledby="generator-issues-heading">
          <header className="reports-card__head">
            <h2 id="generator-issues-heading">
              <Icon name="shield" size={17} />
              Data issues
            </h2>
            <p>
              {allIssues.length
                ? `${blockingIssues.length} blocking, ${warningIssues.length} warning, ${infoIssues.length} informational.`
                : "Nothing was found wrong with the data behind this document."}
            </p>
          </header>
          <IssueList title="Blocking" severity="blocking" items={blockingIssues} />
          <IssueList title="Warnings" severity="warning" items={warningIssues} />
          <IssueList title="Information" severity="info" items={infoIssues} />
          {blockers.length > 0 && (
            <IssueList
              title="Finalisation blockers"
              severity="blocking"
              items={blockers.map((blocker) => ({ code: blocker.code, message: blocker.message }))}
            />
          )}
          {warnings.length > 0 && (
            <IssueList
              title="Advisories"
              severity="warning"
              items={warnings.map((warning) => ({ code: warning.code, message: warning.message }))}
            />
          )}
        </section>
      )}

      {/* ── Combined document preview ──────────────────────────────────── */}
      {payload && (
        <section className="reports-card" aria-labelledby="generator-preview-heading">
          <header className="reports-card__head">
            <h2 id="generator-preview-heading">
              <Icon name="document" size={17} />
              Combined document
            </h2>
            <p>
              Part 1 invoice, then Part 2 maintenance performance report. The Word, PDF and Excel
              files are made from this same value, so their totals cannot differ from what is on
              screen.
            </p>
            <button
              type="button"
              className="reports-button"
              onClick={() => setShowPreview((current) => !current)}
              aria-expanded={showPreview}
            >
              {showPreview ? "Hide preview" : "Generate Preview"}
              <Icon name="chevron" size={14} />
            </button>
          </header>
          {showPreview && <CombinedDocumentPreview payload={payload} snapshot={snapshot} />}
          {!showPreview && (
            <p className="reports-empty">
              {documentTitle} is ready to preview. Previewing changes nothing and never finalises.
            </p>
          )}
        </section>
      )}

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <section className="reports-card reports-actions" aria-labelledby="generator-actions-heading">
        <header className="reports-card__head">
          <h2 id="generator-actions-heading">
            <Icon name="check" size={17} />
            Generate, save and export
          </h2>
          <p>
            {documentId
              ? "This draft is saved. Exports come from the saved document, and a finalised one exports its stored snapshot."
              : "Nothing is saved yet. Save a draft to exclude a site, approve, finalise or record an export."}
          </p>
        </header>

        <div className="reports-actions__row">
          <button
            type="button"
            className="reports-button reports-button--primary"
            disabled={!payload || computing || canEdit === false}
            onClick={() => {
              setShowPreview(true);
              void compute();
            }}
          >
            <Icon name="document" size={15} />
            Generate Invoice &amp; Report
          </button>
          <button
            type="button"
            className="reports-button"
            disabled={busy !== null || canEdit === false || !editable}
            onClick={() => void runSave()}
          >
            <Icon name="check" size={15} />
            {documentId ? "Save changes" : "Save Draft"}
          </button>
          <button
            type="button"
            className="reports-button"
            disabled={computing || canEdit === false}
            onClick={() => void (documentId ? runAction("recalculate") : compute())}
          >
            <Icon name="refresh" size={15} />
            Recalculate
          </button>
          <a className="reports-button" href="#generator-issues">
            <Icon name="shield" size={15} />
            Review Data Issues
            {blockingIssues.length > 0 && (
              <span className="reports-badge reports-badge--blocking">{blockingIssues.length}</span>
            )}
          </a>
        </div>

        <div className="reports-actions__row">
          <button
            type="button"
            className="reports-button"
            disabled={!documentId || busy !== null || canEdit === false || status !== "Draft"}
            onClick={() => void runAction("submit")}
          >
            Submit for review
          </button>
          <button
            type="button"
            className="reports-button"
            disabled={!documentId || busy !== null || canSettle === false || status === "Finalised" || status === "Voided"}
            onClick={() => void runAction("approve")}
          >
            <Icon name="thumb" size={15} />
            Approve
          </button>
          <button
            type="button"
            className="reports-button reports-button--commit"
            disabled={
              !documentId ||
              busy !== null ||
              canSettle === false ||
              blockers.length > 0 ||
              status === "Finalised" ||
              status === "Voided"
            }
            title={
              blockers.length
                ? `${blockers.length} blocking issue${blockers.length === 1 ? "" : "s"} must be cleared first.`
                : "Issue the invoice number and store the snapshot."
            }
            onClick={() => void runAction("finalise")}
          >
            <Icon name="shield" size={15} />
            Finalise
          </button>
          <button
            type="button"
            className="reports-button reports-button--danger"
            disabled={!documentId || busy !== null || canSettle === false || status === "Voided"}
            onClick={() => void runAction("void", "Void this document. Why?")}
          >
            <Icon name="close" size={15} />
            Void
          </button>
        </div>

        <div className="reports-actions__row">
          {(["docx", "pdf", "xlsx"] as ExportFormat[]).map((format) => (
            <button
              key={format}
              type="button"
              className="reports-button"
              disabled={!payload || busy !== null || canExport === false}
              onClick={() => void runExport(format)}
            >
              <Icon name="download" size={15} />
              Export {format === "docx" ? "Word" : format === "pdf" ? "PDF" : "Excel"}
            </button>
          ))}
        </div>

        {canExport === false && (
          <p className="reports-alert reports-alert--warning">
            <Icon name="alert" size={15} />
            Your role does not include Export data, so the download controls are unavailable.
          </p>
        )}
      </section>
    </div>
  );
}
