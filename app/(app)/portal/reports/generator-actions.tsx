"use client";

/**
 * THE ACTION BAR, AND WHY EVERY UNAVAILABLE CONTROL EXPLAINS ITSELF.
 *
 * One bar, drawn by both `report-tab.tsx` and `invoice-tab.tsx` immediately
 * under the tablist. `kind` is what makes one component serve two tabs without
 * a second copy: it goes straight through to `sectionsFor` and
 * `exportFilename`, so pressing Export Word on the Report tab cannot produce an
 * invoice and pressing it on the Invoice tab cannot produce a job log.
 *
 * ── WHY IT IS AT THE TOP ──────────────────────────────────────────────────
 *
 * It used to be the last card on the combined generator, and that file's header
 * argued for the position: a reader "arrives at Finalise having already been
 * shown every reason not to press it". The argument assumed one screen the
 * length of a document, and it stopped holding the moment the Report tab became
 * a full maintenance report — Save, Recalculate and Export ended up several
 * thousand pixels below the fold, so somebody who changed a period had to
 * scroll the whole report to re-run it, and somebody checking a figure could
 * not see whether the document was even saved.
 *
 * The safety argument survives without the position, because it was never
 * really about the position. Nothing on this bar commits anything a reader has
 * not been shown: `Finalise` is DERIVED from `DOCUMENT_TRANSITIONS`, so it is
 * unavailable until the document is Approved, and its blockers are counted into
 * the sentence it gives for being unavailable. The bar is sticky, so those
 * sentences follow the reader down the page instead of being read once on the
 * way past.
 *
 * ── NO SILENTLY GREYED BUTTON ─────────────────────────────────────────────
 *
 * Every unavailable action states WHY, on hover and on tap, and the sentence is
 * derived rather than written per button: `DOCUMENT_TRANSITIONS` says what the
 * document can become, so the reason names the state it is in and what it can
 * move to. A hardcoded string per button is what this design exists to prevent,
 * because it is what goes stale — under the old hardcoded rule `Finalise` was
 * enabled on a Draft and the server refused it, which is a greyed-out button's
 * failure mode arriving as a red error instead.
 *
 * That is also why these carry `aria-disabled` rather than `disabled`: a
 * `disabled` button receives no pointer or touch events at all, so its `title`
 * is unreachable with a keyboard and completely unreachable on a phone.
 *
 * ── THE PHONE ────────────────────────────────────────────────────────────
 *
 * Eleven controls do not fit on a 380px row at any font size, and a row that
 * scrolled sideways would be the second horizontally scrolling surface on this
 * screen, which reports.css does not allow. So below 640px the full set is
 * replaced by four icon buttons and a "More" menu carrying the rest — the SAME
 * action objects with the same reasons, and the menu prints each reason under
 * its item, so the phone explains an unavailable action better than the desktop
 * tooltip does.
 */

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../../components";
import type {
  DocumentKind,
  ExportFormat,
  FinalisationBlocker,
  InvoiceStatus,
} from "../../../lib/reporting/contract";
import { canTransition, DOCUMENT_TRANSITIONS } from "../../../lib/reporting/access";
import { StatusChip } from "./invoice-generator";
import type { GeneratorController } from "./invoice-generator";

/* ── Availability, derived from the state machine ──────────────────── */

/**
 * Which status each lifecycle button is asking the document to become.
 *
 * This is the ONLY hand-written part of the availability rules. Everything
 * else — whether the move is legal, and the sentence explaining why it is not —
 * comes out of `DOCUMENT_TRANSITIONS`, so a change to the state machine changes
 * the buttons and their explanations together and cannot leave a button
 * enabled for a move the server will refuse.
 */
const ACTION_TARGET: Record<"submit" | "approve" | "finalise" | "void", InvoiceStatus> = {
  submit: "Ready for Review",
  approve: "Approved",
  finalise: "Finalised",
  void: "Voided",
};

/** "Draft, Approved or Voided" — the states this document can still reach. */
function listStatuses(statuses: InvoiceStatus[]): string {
  if (statuses.length === 1) return statuses[0]!;
  return `${statuses.slice(0, -1).join(", ")} or ${statuses[statuses.length - 1]}`;
}

/**
 * Why this lifecycle action is unavailable, or null if it is available.
 *
 * Order matters: an unsaved draft is the first thing to say, because it is the
 * one a reader can fix immediately and it makes every other reason moot.
 */
function lifecycleReason(
  action: keyof typeof ACTION_TARGET,
  label: string,
  {
    status,
    documentId,
    denied,
    blockers,
    busy,
  }: {
    status: InvoiceStatus;
    documentId: string | null;
    /** The permission refusal for this action, already worded, or null. */
    denied: string | null;
    blockers: FinalisationBlocker[];
    busy: string | null;
  },
): string | null {
  if (!documentId) {
    return `${label} needs a saved document. Save the draft first — there is nothing yet for this to act on.`;
  }
  const target = ACTION_TARGET[action];
  if (!canTransition(status, target)) {
    const reachable = DOCUMENT_TRANSITIONS[status];
    return reachable.length
      ? `${label} is unavailable while this document is ${status}. From ${status} it can only move to ${listStatuses(reachable)}.`
      : `${label} is unavailable: ${status} is the end of this document's life and nothing follows it.`;
  }
  if (denied) return denied;
  if (action === "finalise" && blockers.length) {
    return `${label} is unavailable until ${blockers.length} blocking issue${
      blockers.length === 1 ? "" : "s"
    } ${blockers.length === 1 ? "is" : "are"} cleared. They are listed under Data issues.`;
  }
  if (busy) return `${label} is unavailable while another action finishes.`;
  return null;
}

interface BarAction {
  id: string;
  label: string;
  /** The word shown beside the icon in the compact phone row. */
  short: string;
  icon: IconName;
  tone?: "primary" | "commit" | "danger";
  /** Null when available; the sentence explaining why not, otherwise. */
  reason: string | null;
  run: () => void;
  badge?: number;
  /** Drawn in the compact phone row rather than behind "More". */
  compact?: boolean;
}

/**
 * One button, available or not, that always answers "why not".
 *
 * `aria-disabled` and NOT `disabled`, deliberately. A `disabled` button is
 * removed from the tab order and receives no pointer or touch events at all, so
 * a `title` on it is unreachable with a keyboard and completely unreachable on
 * a phone — which is the exact failure the brief is about. This one stays
 * focusable, states its reason in `title` for a pointer, in `aria-describedby`
 * for a screen reader, and puts the same sentence in the page's message banner
 * when it is tapped.
 */
function ActionButton({
  action,
  onRefused,
}: {
  action: BarAction;
  onRefused: (reason: string) => void;
}) {
  const unavailable = action.reason !== null;
  const reasonId = `reports-action-why-${action.id}`;
  return (
    <>
      <button
        type="button"
        className={`reports-button${action.tone ? ` reports-button--${action.tone}` : ""}${
          unavailable ? " is-unavailable" : ""
        }`}
        aria-disabled={unavailable}
        aria-describedby={unavailable ? reasonId : undefined}
        /*
         * Both always present, because at 640px and below this button is an
         * icon and nothing else: `aria-label` is then the only name it has, and
         * `title` is the only way a pointer or a long press can read it. When
         * the action is unavailable the title becomes the REASON, which is the
         * more useful of the two things to say at that moment.
         */
        aria-label={action.label}
        title={action.reason ?? action.label}
        onClick={() => (unavailable ? onRefused(action.reason!) : action.run())}
      >
        <Icon name={action.icon} size={15} />
        <span className="reports-button__label">{action.label}</span>
        <span className="reports-button__short">{action.short}</span>
        {typeof action.badge === "number" && action.badge > 0 && (
          <span className="reports-badge reports-badge--blocking">{action.badge}</span>
        )}
      </button>
      {unavailable && (
        <span id={reasonId} className="reports-visually-hidden">
          {action.reason}
        </span>
      )}
    </>
  );
}

/** The overflow menu behind "More" at phone widths. */
function MoreMenu({
  actions,
  onRefused,
}: {
  actions: BarAction[];
  onRefused: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!actions.length) return null;
  return (
    <div className="reports-more" ref={wrapper}>
      <button
        type="button"
        className="reports-button reports-more__toggle"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="more" size={15} />
        <span>More</span>
      </button>
      {open && (
        <div className="reports-more__panel" role="menu" aria-label="More actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className={`reports-more__item${action.reason ? " is-unavailable" : ""}`}
              aria-disabled={action.reason !== null}
              title={action.reason ?? undefined}
              onClick={() => {
                if (action.reason) {
                  onRefused(action.reason);
                } else {
                  action.run();
                }
                setOpen(false);
              }}
            >
              <Icon name={action.icon} size={15} />
              <span>{action.label}</span>
              {typeof action.badge === "number" && action.badge > 0 && (
                <span className="reports-badge reports-badge--blocking">{action.badge}</span>
              )}
              {action.reason && <small>{action.reason}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The sticky bar both tabs draw immediately under the tablist.
 *
 * `kind` is what makes one bar serve two tabs without a second copy: the
 * Generate, Preview and Export controls carry it straight through to
 * `sectionsFor` and `exportFilename`, so pressing Export Word on the Report tab
 * cannot produce an invoice and pressing it on the Invoice tab cannot produce a
 * job log.
 */
export function GeneratorActionBar({
  generator,
  kind,
  issuesAnchorId,
  blockingCount,
  onGenerate,
}: {
  generator: GeneratorController;
  kind: Exclude<DocumentKind, "combined">;
  /** The id of this tab's own Data issues card, which "Review" scrolls to. */
  issuesAnchorId: string;
  blockingCount: number;
  onGenerate: () => void;
}) {
  const {
    payload,
    computing,
    busy,
    documentId,
    status,
    editable,
    blockers,
    canEdit,
    canSettle,
    canExport,
    setMessage,
  } = generator;

  const noun = kind === "invoice" ? "invoice" : "report";
  const refuse = (reason: string) => setMessage({ tone: "bad", text: reason });

  /*
   * The two permission refusals, worded once.
   *
   * Approve, Finalise and Void are the `settings.edit` half of the model and
   * Submit is the `board.edit` half — the split `REPORT_CAPABILITIES` in
   * `lib/reporting/access.ts` already makes, restated here only as the sentence
   * the reader sees, never as a second rule about who may do what. The SERVER
   * refuses either way; this is what the button says while it does.
   */
  const settlementDenied =
    canSettle === false
      ? "Approving, finalising and voiding need the Manage settings permission, which your role does not include."
      : null;
  const editDenied =
    canEdit === false
      ? "This needs the Edit board permission, which your role does not include."
      : null;

  const lifecycle = { status, documentId, blockers, busy, denied: settlementDenied };

  const actions: BarAction[] = [
    {
      id: "generate",
      label: `Generate ${noun}`,
      short: "Generate",
      icon: "document",
      tone: "primary",
      compact: true,
      reason:
        canEdit === false
          ? `Generating a ${noun} needs the Edit board permission, which your role does not include.`
          : computing
            ? "The figures are still being recalculated. This becomes available the moment they land."
            : !payload
              ? "There is nothing computed yet. Choose a period and a client, and the figures arrive on their own."
              : null,
      run: onGenerate,
    },
    {
      id: "save",
      label: documentId ? "Save changes" : "Save draft",
      short: "Save",
      icon: "check",
      compact: true,
      reason:
        canEdit === false
          ? "Saving needs the Edit board permission, which your role does not include."
          : !editable
            ? `This document is ${status} and is no longer editable. From ${status} it can only move to ${
                DOCUMENT_TRANSITIONS[status].length
                  ? listStatuses(DOCUMENT_TRANSITIONS[status])
                  : "nothing — it is the end of the document's life"
              }.`
            : busy !== null
              ? "Saving is unavailable while another action finishes."
              : null,
      run: () => void generator.runSave(),
    },
    {
      id: "recalculate",
      label: "Recalculate",
      short: "Refresh",
      icon: "refresh",
      reason:
        canEdit === false
          ? "Recalculating needs the Edit board permission, which your role does not include."
          : computing
            ? "A recalculation is already running."
            : null,
      run: () => void (documentId ? generator.runAction("recalculate") : generator.compute()),
    },
    {
      id: "issues",
      label: "Review data issues",
      short: "Issues",
      icon: "shield",
      compact: true,
      badge: blockingCount,
      reason: payload ? null : "There are no figures yet, so nothing has been checked.",
      run: () => {
        document
          .getElementById(issuesAnchorId)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    },
    {
      id: "submit",
      label: "Submit for review",
      short: "Submit",
      icon: "reply",
      reason: lifecycleReason("submit", "Submit for review", {
        ...lifecycle,
        denied: editDenied,
      }),
      run: () => void generator.runAction("submit"),
    },
    {
      id: "approve",
      label: "Approve",
      short: "Approve",
      icon: "thumb",
      reason: lifecycleReason("approve", "Approve", lifecycle),
      run: () => void generator.runAction("approve"),
    },
    {
      id: "finalise",
      label: "Finalise",
      short: "Finalise",
      icon: "shield",
      tone: "commit",
      reason: lifecycleReason("finalise", "Finalise", lifecycle),
      run: () => void generator.runAction("finalise"),
    },
    {
      id: "void",
      label: "Void",
      short: "Void",
      icon: "close",
      tone: "danger",
      reason: lifecycleReason("void", "Void", lifecycle),
      run: () => void generator.runAction("void", "Void this document. Why?"),
    },
    ...(["docx", "pdf", "xlsx"] as ExportFormat[]).map<BarAction>((format) => ({
      id: `export-${format}`,
      label: `Export ${format === "docx" ? "Word" : format === "pdf" ? "PDF" : "Excel"}`,
      short: format === "docx" ? "Word" : format === "pdf" ? "PDF" : "Excel",
      icon: "download",
      compact: format === "pdf",
      reason:
        canExport === false
          ? "Downloading needs the Export data permission, which your role does not include."
          : !payload
            ? "There is nothing to export yet — the figures for this period have not been computed."
            : busy !== null
              ? "Downloading is unavailable while another action finishes."
              : null,
      run: () => void generator.runExport(format, kind),
    })),
  ];

  const compact = actions.filter((action) => action.compact);
  const overflow = actions.filter((action) => !action.compact);

  return (
    <section
      className="reports-actions reports-actions--sticky"
      aria-label={`${kind === "invoice" ? "Invoice" : "Report"} actions`}
    >
      <p className="reports-actions__state">
        <StatusChip status={status} />
        <span>
          {documentId
            ? "Saved. Exports come from the saved document, and a finalised one exports its stored snapshot."
            : "Nothing is saved yet. Save a draft to exclude a site, submit, approve, finalise or record an export."}
        </span>
        {computing && <span className="reports-computing">Recalculating…</span>}
      </p>

      {/* Desktop and tablet: every control, wrapped. */}
      <div className="reports-actions__full">
        {actions.map((action) => (
          <ActionButton key={action.id} action={action} onRefused={refuse} />
        ))}
      </div>

      {/* Phone: four controls and an overflow. Same objects, same reasons. */}
      <div className="reports-actions__compact">
        {compact.map((action) => (
          <ActionButton key={action.id} action={action} onRefused={refuse} />
        ))}
        <MoreMenu actions={overflow} onRefused={refuse} />
      </div>

      {canExport === false && (
        <p className="reports-actions__note">
          <Icon name="alert" size={15} />
          Your role does not include Export data, so the download controls are unavailable.
        </p>
      )}
    </section>
  );
}
