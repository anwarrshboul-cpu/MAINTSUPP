"use client";

/**
 * THE SHARED ENGINE BEHIND THE REPORT TAB AND THE INVOICE TAB.
 *
 * This file used to be the combined "Invoice & Report Generator": one screen
 * that drew part 1 and part 2 of one document, with its action block at the
 * bottom. The screen is now two tabs — `report-tab.tsx` and `invoice-tab.tsx` —
 * and there is deliberately NO combined component left behind. A hidden legacy
 * generator would be a third rendering of the same figures that nobody opens
 * and nobody notices going stale.
 *
 * What stayed is everything the two tabs must not each have a copy of: the
 * document state machine, the debounce, save, the lifecycle actions, the
 * inclusion changes, the export call, the setup fields and the data-issues
 * panel. Both tabs mount ONE `useGeneratorDocument` — held above them in
 * `ReportsView` — so switching between Report and Invoice does not abandon a
 * saved draft or refetch the period.
 *
 * ── THE ACTION BLOCK IS NO LONGER HERE, AND IS NO LONGER AT THE BOTTOM ────
 *
 * This header used to argue for the bottom position, on the grounds that a
 * reader "arrives at Finalise having already been shown every reason not to
 * press it". That argument assumed one screen the length of a document, and it
 * stopped holding when the Report tab became a full maintenance report. The bar
 * is now a sticky one at the TOP of both tabs, it lives in
 * `./generator-actions.tsx`, and that file's header carries the reasoning —
 * including why every unavailable control states its own reason and why none of
 * them is a `disabled` button.
 *
 * THE FIGURES COME FROM THE SERVER AND ARE NEVER TOUCHED
 *
 * Every number on these screens comes out of a `CombinedReportPayload` that
 * `/api/reports/preview` computed. Nothing here adds, subtracts, rounds or
 * re-derives one — `invoiceKpiRows`, `maintenanceKpiRows` and
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
import { useCapability } from "../../../lib/client-capabilities";
import type {
  BillableSiteLine,
  CombinedReportPayload,
  DocumentKind,
  ExportFormat,
  FinalisationBlocker,
  InvoiceStatus,
} from "../../../lib/reporting/contract";
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

export const JOBS_ITEM_HREF = (requestId: string) =>
  `/dashboard/jobs?item=${encodeURIComponent(requestId)}`;

/** DD/MM/YYYY, through the export formatter so one screen cannot drift. */
export function formatDate(value: string | null): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

export function StatusChip({ status }: { status: InvoiceStatus }) {
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

export interface GeneratorIssue {
  severity: "blocking" | "warning" | "info";
  code: string;
  message: string;
  href?: string | null;
}

/**
 * The three severities, visually distinct, with the distinction spelled out.
 *
 * Colour alone would leave a colour-blind reader unable to tell a blocker from
 * a note, on the one screen where that difference decides whether a document
 * can be issued. Each carries its word as well as its hue, and blockers carry
 * the sentence "this stops finalisation" rather than leaving it implied.
 */
export function IssueList({
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

/**
 * The data-issues card, scoped to whichever tab drew it.
 *
 * The Report tab passes the maintenance data-quality findings; the Invoice tab
 * passes the per-line validation. Both pass the finalisation blockers, because
 * both tabs carry a Finalise control and a reason it cannot be pressed is not
 * content a reader should have to change tab to read.
 */
export function DataIssuesPanel({
  id,
  lead,
  issues,
  blockers,
  advisories,
}: {
  id: string;
  lead: string;
  issues: GeneratorIssue[];
  blockers: FinalisationBlocker[];
  advisories: FinalisationBlocker[];
}) {
  const blocking = issues.filter((issue) => issue.severity === "blocking");
  const warning = issues.filter((issue) => issue.severity === "warning");
  const info = issues.filter((issue) => issue.severity === "info");
  return (
    <section className="reports-card" id={id} aria-labelledby={`${id}-heading`}>
      <header className="reports-card__head">
        <h2 id={`${id}-heading`}>
          <Icon name="shield" size={17} />
          Data issues
        </h2>
        <p>
          {issues.length
            ? `${blocking.length} blocking, ${warning.length} warning, ${info.length} informational. ${lead}`
            : `Nothing was found wrong with the data behind this document. ${lead}`}
        </p>
      </header>
      <IssueList title="Blocking" severity="blocking" items={blocking} />
      <IssueList title="Warnings" severity="warning" items={warning} />
      <IssueList title="Information" severity="info" items={info} />
      {blockers.length > 0 && (
        <IssueList
          title="Finalisation blockers"
          severity="blocking"
          items={blockers.map((blocker) => ({ code: blocker.code, message: blocker.message }))}
        />
      )}
      {advisories.length > 0 && (
        <IssueList
          title="Advisories"
          severity="warning"
          items={advisories.map((entry) => ({ code: entry.code, message: entry.message }))}
        />
      )}
    </section>
  );
}

/* ── The setup block, drawn identically above both tabs ──────────────────── */

export function GeneratorSetupCards({ generator }: { generator: GeneratorController }) {
  return (
    <>
      <GeneratorSetup
        draft={generator.draft}
        onChange={generator.onDraftChange}
        clients={
          generator.clients.length
            ? generator.clients
            : [{ id: generator.draft.clientId || "current", name: "This workspace" }]
        }
        settings={generator.settings}
        now={generator.now}
        disabled={!generator.editable || generator.canEdit === false}
      />
      <BillingConfigurationSummary
        settings={generator.settings}
        draft={generator.draft}
        loading={generator.settingsLoading}
        error={generator.settingsError}
      />
    </>
  );
}

/* ── The document state, shared by both tabs ─────────────────────────────── */

export interface GeneratorController {
  now: number;
  canEdit: boolean | null;
  canSettle: boolean | null;
  canExport: boolean | null;
  clients: Array<{ id: string; name: string }>;
  draft: GeneratorDraft;
  onDraftChange: (patch: Partial<GeneratorDraft>, touched: DraftField[]) => void;
  settings: BillingSettings | null;
  settingsError: string | null;
  settingsLoading: boolean;
  payload: CombinedReportPayload | null;
  blockers: FinalisationBlocker[];
  warnings: FinalisationBlocker[];
  documentId: string | null;
  snapshot: boolean;
  computing: boolean;
  busy: string | null;
  busyLine: number | null;
  message: { tone: "ok" | "bad"; text: string } | null;
  setMessage: (message: { tone: "ok" | "bad"; text: string } | null) => void;
  status: InvoiceStatus;
  currency: string;
  editable: boolean;
  compute: () => Promise<void>;
  runSave: () => Promise<void>;
  runAction: (action: DocumentAction, prompt?: string) => Promise<void>;
  changeInclusion: (line: BillableSiteLine, include: boolean) => Promise<void>;
  runExport: (format: ExportFormat, kind: DocumentKind) => Promise<void>;
}

export function useGeneratorDocument({
  now,
  openDocumentId = null,
  active = true,
}: {
  now: number;
  /**
   * A document the Documents tab asked to open. Read once on mount and whenever
   * it changes, which is what makes "View" on that table land on the right tab
   * showing that document rather than on a fresh draft.
   */
  openDocumentId?: string | null;
  /**
   * Whether either document tab is on screen.
   *
   * This hook is mounted by `ReportsView` so that the Report tab and the
   * Invoice tab share one document — but `ReportsView` also draws Spend
   * Overview and Documents, and neither of those should cost a preview
   * computation. False suspends the debounce and nothing else: an already
   * loaded document stays loaded, so switching to Documents and back is free.
   */
  active?: boolean;
}): GeneratorController {
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
    if (documentId || !active) return;
    const timer = window.setTimeout(() => void compute(), 500);
    return () => window.clearTimeout(timer);
  }, [active, compute, documentId]);

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
   *
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

  const runSave = useCallback(async () => {
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
  }, [documentId, draft, reloadDocument]);

/**
 * What to say once an action has landed.
 *
 * This was `` `Document ${action}d.` `` — a suffix bolted onto the verb, which
 * gave "Document submitd." and "Document voidd." to anybody who used either
 * control, and carried a `.replace("finalised", "finalised")` that had never
 * replaced anything. Two of the five states this product's whole approval
 * chain runs on announced themselves in broken English.
 *
 * A table, not a rule, because these are not five spellings of one sentence:
 * each one says what changed and what may be done next, which is the thing a
 * reader actually needs after pressing a lifecycle button.
 */
const ACTION_DONE: Record<DocumentAction, string> = {
  recalculate: "Figures recalculated.",
  submit: "Submitted for review.",
  approve: "Approved. It can be finalised or exported.",
  finalise: "Finalised. It is now immutable, and any change needs a new version.",
  void: "Voided. It is kept, and its number is never reused.",
};

  const runAction = useCallback(
    async (action: DocumentAction, prompt?: string) => {
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
      setMessage({ tone: "ok", text: ACTION_DONE[action] });
    },
    [documentId, reloadDocument],
  );

  const changeInclusion = useCallback(
    async (line: BillableSiteLine, include: boolean) => {
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
    },
    [documentId, reloadDocument],
  );

  const runExport = useCallback(
    async (format: ExportFormat, kind: DocumentKind) => {
      setBusy(`export-${format}`);
      if (documentId) {
        // A plain navigation for a saved document — see `exportUrl`.
        window.location.assign(exportUrl(documentId, format, kind));
        setBusy(null);
        return;
      }
      const result = await exportPreview(question, format, kind);
      setBusy(null);
      if (!result.ok) {
        setMessage({ tone: "bad", text: result.error });
        return;
      }
      saveBlob(result.data.blob, result.data.filename);
    },
    [documentId, question],
  );

  return {
    now,
    canEdit,
    canSettle,
    canExport,
    clients,
    draft,
    onDraftChange,
    settings,
    settingsError,
    settingsLoading,
    payload,
    blockers,
    warnings,
    documentId,
    snapshot,
    computing,
    busy,
    busyLine,
    message,
    setMessage,
    status,
    currency,
    editable,
    compute,
    runSave,
    runAction,
    changeInclusion,
    runExport,
  };
}

/* ── The message banner ──────────────────────────────────────────────────── */

export function GeneratorAlert({ generator }: { generator: GeneratorController }) {
  const { message, setMessage } = generator;
  if (!message) return null;
  return (
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
  );
}

