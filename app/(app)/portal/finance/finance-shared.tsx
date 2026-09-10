"use client";

/**
 * THE PARTS EVERY INVOICE TRACKER TAB USES. One copy, six callers.
 *
 * Nothing here is a new primitive where the Operations pages already have one:
 * `SkeletonRow`, `EmptyState`, `StatusChip`, `HiddenDataTable`, `ChartFrame`,
 * `MetricTile`, `formatMoneyPence` and `useOpsQuery` are all imported from
 * `../ops/`, and the wrappers below only add what §5 and §6 need on top —
 * the token-backed status chip, the days-overdue badge, the allocation editor
 * that will not let a split miss its total, and the side panel.
 *
 * ── NO COMPONENT HERE WORKS OUT A BALANCE ─────────────────────────────────
 *
 * §6: "Never store a balance field — always compute it." The corollary the UI
 * has to honour is that it must not compute one EITHER: `invoiceBalance`,
 * `allocationState` and `blockingFlags` from `app/lib/finance/rules.ts` are the
 * arithmetic, and a component that added up payments itself would be a second
 * answer to a question with one right answer. Every figure on this page comes
 * from the server or from those three functions.
 *
 * ── GRACEFUL DEGRADATION IS A STATE, NOT A CRASH ──────────────────────────
 *
 * Module 5's analytics routes land after this UI does. `useFinanceEndpoint`
 * therefore separates "this did not load" from "this route does not exist yet",
 * and the tabs render an honest, named notice for the second rather than an
 * error for both — a card that says "the margin endpoint is not answering" is
 * something an operator can report; a red box that says "failed" is not.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "../../../components";
import {
  allocationState,
  blockingFlags,
  type AllocationState,
  type FlagLike,
} from "../../../lib/finance/rules";
import {
  financeDay,
  formatPence,
  penceFromInput,
} from "../../../lib/finance/model";
import { formatMoneyPence, useAbbreviatedNumbers } from "../ops/overview-shared";
import { EmptyState, SkeletonRow, StatusChip } from "../ops/ops-primitives";
import { useOpsQuery } from "../ops/ops-url-state";
import {
  flagName,
  flagWhy,
  presentStatus,
  proximityBand,
  type StatusMapEntry,
  type StatusPresentation,
} from "./finance-status";

/* ── Fetching ─────────────────────────────────────────────────────────────── */

export interface FinanceEndpoint<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** The route answered 404: it has not been built yet, and that is not an error. */
  unavailable: boolean;
  reload: () => void;
}

/**
 * `useOpsQuery`, with "not built yet" told apart from "did not load".
 *
 * An unknown `/api/*` path in this app answers a bare-text 404, so
 * `useOpsQuery` cannot parse a body and produces its own sentence carrying the
 * status in brackets. Reading that is admittedly a string match, and it is
 * deliberate: the alternative is a second fetch hook duplicating the refresh
 * listener, the stale-data behaviour and the abort handling that one already
 * has, for the sake of one integer.
 */
export function useFinanceEndpoint<T>(
  path: string,
  search = "",
  options: { enabled?: boolean } = {},
): FinanceEndpoint<T> {
  const { data, loading, error, reload } = useOpsQuery<T>(path, search, options);
  return {
    data,
    loading,
    error,
    unavailable: typeof error === "string" && error.includes("(404)"),
    reload,
  };
}

export interface ActionResult {
  ok: boolean;
  /** The server's own sentence. §7 and §15.14 both refuse in prose, not in codes. */
  error: string | null;
  payload: Record<string, unknown> | null;
}

/**
 * ONE WRITE, AND THE SERVER'S REFUSAL KEPT VERBATIM.
 *
 * Every finance route answers a refusal as `{ error: "<a sentence>" }` with a
 * 400 or a 409, and those sentences are the product: "This invoice was
 * finalised on 2026-03-04 and its accounting fields cannot be edited. Raise a
 * credit note instead." Rewriting that into "Could not save" would throw away
 * the only thing on screen that tells the operator what to do next, so the
 * caller renders exactly what came back.
 */
export function useFinanceWrite(): {
  busy: boolean;
  error: string | null;
  clearError: () => void;
  run: (
    path: string,
    init: { method: string; body?: unknown },
  ) => Promise<ActionResult>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (path: string, init: { method: string; body?: unknown }) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: init.method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const payload = (await response.json().catch(() => null)) as
        | (Record<string, unknown> & { error?: string })
        | null;
      if (!response.ok) {
        const sentence = typeof payload?.error === "string"
          ? payload.error
          : `That did not go through (${response.status}).`;
        setError(sentence);
        return { ok: false, error: sentence, payload };
      }
      return { ok: true, error: null, payload };
    } catch {
      const sentence = "That did not go through. Check your connection and try again.";
      setError(sentence);
      return { ok: false, error: sentence, payload: null };
    } finally {
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { busy, error, clearError, run };
}

/**
 * A ROUTE THAT MIGHT ANSWER WITH A FILE, AND MIGHT ANSWER WITH A REFUSAL.
 *
 * §15.6's accounting exports and §13's bank file are both "press this and a CSV
 * arrives", and both share every failure mode with an ordinary write: the route
 * may not exist yet, the caller may lack the capability, the filter may match
 * nothing. A `window.location` navigation to a download URL shows none of that
 * — the browser either saves a file or silently does nothing, and a missing
 * route becomes a button that appears broken.
 *
 * So the fetch is made in JavaScript and the CONTENT TYPE decides what happened:
 * a CSV is saved, a JSON body is handed back to the caller (which is also how a
 * route that exports asynchronously and answers `{ ok: true }` is handled), and
 * anything else is a refusal in the server's own words.
 */
export async function fetchDownload(
  path: string,
  init: { method?: string; body?: unknown; filename?: string } = {},
): Promise<{ ok: boolean; error: string | null; payload: Record<string, unknown> | null }> {
  try {
    const response = await fetch(path, {
      method: init.method ?? "GET",
      headers: {
        Accept: "text/csv, application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const type = response.headers.get("content-type") ?? "";

    if (type.includes("application/json") || !response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | (Record<string, unknown> & { error?: string })
        | null;
      if (!response.ok) {
        return {
          ok: false,
          error: typeof payload?.error === "string"
            ? payload.error
            : `That export did not go through (${response.status}).`,
          payload,
        };
      }
      return { ok: true, error: null, payload };
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filenameFrom(response.headers.get("content-disposition"))
      ?? init.filename
      ?? "export.csv";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return { ok: true, error: null, payload: null };
  } catch {
    return {
      ok: false,
      error: "That export did not go through. Check your connection and try again.",
      payload: null,
    };
  }
}

/** The server's own filename, when it sent one. Same rule the file routes use. */
function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match ? match[1].trim() : null;
}

/* ── Days ─────────────────────────────────────────────────────────────────── */

/** Today, as the ledger's own `YYYY-MM-DD`. */
export function todayDay(): string {
  return financeDay(new Date());
}

/** The ten characters that matter, whatever shape the column arrived in. */
export function dayText(value: string | null | undefined): string {
  if (typeof value !== "string") return "—";
  const candidate = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "—";
}

/** Whole days from today to a day, positive when the day is in the future. */
export function daysUntil(day: string | null | undefined, today: string): number | null {
  const target = dayText(day);
  if (target === "—") return null;
  const [ty, tm, td] = today.split("-").map(Number);
  const [dy, dm, dd] = target.split("-").map(Number);
  return Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

/* ── Money ────────────────────────────────────────────────────────────────── */

/**
 * A figure, abbreviated on a phone, with the full value in the accessible name.
 *
 * Dashboard master prompt §1.9: "screen-reader labels state the full value, not
 * the abbreviated one." `formatPence` is the un-abbreviated string and
 * `formatMoneyPence` the small-screen one, so both come from shared code and
 * neither is a second rounding rule.
 */
export function Money({
  pence,
  className,
  currency,
}: {
  pence: number | null | undefined;
  className?: string;
  currency?: string;
}) {
  const abbreviate = useAbbreviatedNumbers();
  if (pence === null || pence === undefined || !Number.isFinite(pence)) {
    return <span className={className ?? "fin-money"}>—</span>;
  }
  const full = formatPence(pence, { currency });
  const shown = currency && currency !== "GBP" ? full : formatMoneyPence(pence, abbreviate);
  return (
    <span
      className={`${className ?? "fin-money"}${pence < 0 ? " fin-money--negative" : ""}`}
      title={full}
    >
      <span aria-hidden="true">{shown}</span>
      <span className="visually-hidden">{full}</span>
    </span>
  );
}

/* ── Status ───────────────────────────────────────────────────────────────── */

/**
 * §5's chip: an icon, a coloured dot and the WORD. Never the colour alone.
 *
 * `StatusChip` from `ops-primitives` paints the dot and the text; the glyph in
 * front of it is this page's addition, because §5 asks for a status icon on
 * every row and a dot is not an icon.
 */
export function FinanceStatusChip({
  presentation,
  size = "regular",
}: {
  presentation: StatusPresentation;
  size?: "regular" | "small";
}) {
  return (
    <StatusChip
      tone={presentation.tone}
      size={size}
      title={presentation.mapped ? undefined : "This status is not in the workspace's status map."}
    >
      <Icon name={presentation.icon} size={12} aria-hidden="true" />
      <span className={presentation.struck ? "fin-status--struck" : undefined}>
        <span className={presentation.struck ? "fin-status__label" : undefined}>
          {presentation.label}
        </span>
      </span>
    </StatusChip>
  );
}

/**
 * §5's second signal: how late this is, in days, in words.
 *
 * Rendered whenever there is something to say and omitted when there is not —
 * a badge reading "0 days overdue" on every current invoice trains the eye to
 * skip the badge, and then it skips the one that matters.
 */
export function AgeBadge({
  dueDay,
  today,
  kind = "due",
}: {
  dueDay: string | null | undefined;
  today: string;
  /**
   * `expiry` re-words the same band for §3's quotes.
   *
   * The arithmetic, the colour and the four bands are identical — a quote that
   * lapsed forty days ago is as dark red as an invoice forty days late — but
   * "40 days overdue" is the wrong sentence for a quote, which was never owed.
   * Only the words change, and they change here rather than in
   * `proximityBand`, so there is still one place that decides how late a date
   * is and one that decides what to call it.
   */
  kind?: "due" | "expiry";
}) {
  const remaining = daysUntil(dueDay, today);
  const band = proximityBand(dueDay, today, remaining);
  if (!band.sentence) return null;
  const sentence = kind === "due"
    ? band.sentence
    : band.overdue
      ? `Expired ${band.daysOverdue} day${band.daysOverdue === 1 ? "" : "s"} ago`
      : remaining === 0
        ? "Expires today"
        : `Expires in ${remaining} day${remaining === 1 ? "" : "s"}`;
  return (
    <span className="fin-age" style={{ borderLeftColor: band.tone }}>
      <Icon name={band.overdue ? "alert" : "clock"} size={12} aria-hidden="true" />
      {sentence}
    </span>
  );
}

/**
 * The admin notice §5 demands when a status is not in the map.
 *
 * "Unmapped statuses render grey with the raw label and raise an admin notice,
 * never disappear." The row is already drawn grey by `presentStatus`; this is
 * the notice, and it names the keys so an administrator can add them.
 */
export function UnmappedStatusNotice({ keys }: { keys: readonly string[] }) {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return null;
  return (
    <div className="fin-notice fin-notice--admin" role="note">
      <p>
        {unique.length === 1
          ? "One status on this page is not in the workspace's status map, so it is drawn grey with its raw label."
          : `${unique.length} statuses on this page are not in the workspace's status map, so they are drawn grey with their raw labels.`}
        {" "}Nothing has been hidden. An administrator can add them under Settings.
      </p>
      <p className="fin-notice__code">{unique.join(", ")}</p>
    </div>
  );
}

/* ── Notices ──────────────────────────────────────────────────────────────── */

/** A route that has not been built yet, named, with what the tab is doing instead. */
export function DegradedNotice({
  endpoint,
  what,
  fallback,
}: {
  endpoint: string;
  what: string;
  fallback?: string;
}) {
  return (
    <div className="fin-notice fin-notice--degraded" role="note">
      <p>
        {what} is not available: <code>{endpoint}</code> is not answering yet.
        {fallback ? ` ${fallback}` : " Nothing on this card has been guessed."}
      </p>
    </div>
  );
}

/** The server's refusal, in the server's own words. */
export function Refusal({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="fin-notice fin-notice--refused" role="alert">
      <p>{message}</p>
    </div>
  );
}

export function Confirmation({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="fin-notice fin-notice--ok" role="status">
      <p>{message}</p>
    </div>
  );
}

/* ── Loading and empty, in one place ──────────────────────────────────────── */

export function FinanceState({
  loading,
  error,
  unavailable,
  endpoint,
  what,
  empty,
  emptyLabel,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  endpoint: string;
  what: string;
  empty?: boolean;
  emptyLabel?: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (loading) return <SkeletonRow lines={4} height={120} />;
  if (unavailable) return <DegradedNotice endpoint={endpoint} what={what} />;
  if (error) {
    return (
      <div className="fin-notice fin-notice--refused" role="alert">
        <p>{error}</p>
        {onRetry ? (
          <p>
            <button type="button" className="fin-button" onClick={onRetry}>
              Try again
            </button>
          </p>
        ) : null}
      </div>
    );
  }
  if (empty) return <EmptyState>{emptyLabel ?? "Nothing here yet."}</EmptyState>;
  return <>{children}</>;
}

/* ── Fields ───────────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="fin-field">
      <span>{label}</span>
      {children}
      {hint ? <span className="fin-field__hint">{hint}</span> : null}
    </label>
  );
}

/**
 * A MONEY FIELD THAT SHOWS WHAT IT PARSED, BEFORE ANYTHING IS SAVED.
 *
 * `penceFromInput` is the one door an outside number comes through and its rule
 * is deliberate rather than clever: a value with a decimal or a currency symbol
 * is POUNDS, a bare integer is PENCE. That is the correct rule and it is also
 * surprising the first time somebody types `1200` meaning twelve hundred
 * pounds — so the parsed figure is printed under the box, live, in the format
 * the ledger will store. Nobody can be wrong silently, which is the only
 * property that matters on a field that books money.
 */
export function MoneyField({
  label,
  value,
  onChange,
  hint,
  name,
}: {
  label: string;
  value: string;
  onChange: (raw: string) => void;
  hint?: string;
  name?: string;
}) {
  const parsed = penceFromInput(value);
  return (
    <label className="fin-field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
      />
      <span className="fin-field__hint">
        {value.trim() === ""
          ? hint ?? "£1,234.56 or 1234.56 for pounds; a whole number is read as pence."
          : parsed === null
            ? "That is not a number this field can read."
            : `Reads as ${formatPence(parsed)}`}
      </span>
    </label>
  );
}

/** The pence a money field currently holds, or null when it holds nothing usable. */
export function fieldPence(value: string): number | null {
  return penceFromInput(value);
}

/* ── Allocation ───────────────────────────────────────────────────────────── */

export interface AllocationDraft {
  /** A stable key for the row while it is being edited. */
  key: string;
  /** The job or invoice the share lands on. */
  targetId: string;
  /** The money field's raw text, so a half-typed number is not lost. */
  amount: string;
  note?: string;
}

export function draftState(target: number, rows: readonly AllocationDraft[]): AllocationState {
  return allocationState(
    target,
    rows.map((row) => ({
      requestId: row.targetId,
      amountPence: penceFromInput(row.amount) ?? 0,
    })),
  );
}

/**
 * THE SPLIT, AND THE DIFFERENCE, LIVE.
 *
 * §4 for jobs and §6 for payments state the same constraint in the same words —
 * the parts must sum to the whole — and both are enforced by the same
 * `allocationState` the server enforces with, so the number under the form and
 * the number in the 409 can never disagree.
 *
 * The difference is shown with its SIGN and in pounds: "£120.00 still to
 * allocate" and "£40.00 over-allocated" are two different mistakes and a bare
 * "does not balance" tells an operator which one to look for in neither case.
 */
export function AllocationEditor({
  rows,
  targetPence,
  targetLabel,
  rowLabel,
  options,
  onChange,
  disabled,
}: {
  rows: AllocationDraft[];
  targetPence: number;
  targetLabel: string;
  rowLabel: string;
  /** When the caller knows the candidates, the target becomes a select. */
  options?: Array<{ value: string; label: string }>;
  onChange: (rows: AllocationDraft[]) => void;
  disabled?: boolean;
}) {
  const state = draftState(targetPence, rows);
  const outstanding = -state.difference;

  const update = (key: string, patch: Partial<AllocationDraft>) => {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  return (
    <div className="fin-alloc">
      {rows.map((row, index) => (
        <div className="fin-alloc__row" key={row.key}>
          <Field label={`${rowLabel} ${index + 1}`}>
            {options ? (
              <select
                value={row.targetId}
                disabled={disabled}
                onChange={(event) => update(row.key, { targetId: event.target.value })}
              >
                <option value="">Choose one…</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={row.targetId}
                disabled={disabled}
                onChange={(event) => update(row.key, { targetId: event.target.value })}
                autoComplete="off"
              />
            )}
          </Field>
          <MoneyField
            label="Share"
            value={row.amount}
            onChange={(amount) => update(row.key, { amount })}
          />
          <button
            type="button"
            className="fin-button"
            disabled={disabled || rows.length <= 1}
            onClick={() => onChange(rows.filter((entry) => entry.key !== row.key))}
          >
            Remove
          </button>
        </div>
      ))}

      <div className="fin-actions">
        <button
          type="button"
          className="fin-button"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...rows,
              { key: `row-${Date.now()}-${rows.length}`, targetId: "", amount: "" },
            ])
          }
        >
          Add another {rowLabel.toLowerCase()}
        </button>
      </div>

      <p
        className={`fin-alloc__sum${state.balanced ? " fin-alloc__sum--balanced" : ""}`}
        role="status"
      >
        <span>
          {targetLabel} <Money pence={state.targetPence} /> · allocated{" "}
          <Money pence={state.totalPence} />
        </span>
        <span className="fin-alloc__difference">
          {state.balanced
            ? "Balanced"
            : outstanding > 0
              ? `${formatPence(outstanding)} still to allocate`
              : `${formatPence(-outstanding)} over-allocated`}
        </span>
      </p>
    </div>
  );
}

/* ── Flags ────────────────────────────────────────────────────────────────── */

export interface UiFlag extends FlagLike {
  id: string;
  detail: string | null;
  waivedBy: string | null;
  waiveReason: string | null;
}

/**
 * §7's flags, and the two ways past one.
 *
 * `blockingFlags` decides which of them stop an approval — not a `filter` here,
 * because the server refuses with the same function and a UI that disagreed
 * with it would offer a button that always 409s.
 */
export function FlagList({
  flags,
  onWaive,
  onClear,
  busy,
}: {
  flags: readonly UiFlag[];
  onWaive?: (flag: UiFlag, reason: string) => void;
  onClear?: (flag: UiFlag) => void;
  busy?: boolean;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  if (flags.length === 0) {
    return <p className="fin-card__note">The three-way match raised nothing against this invoice.</p>;
  }
  return (
    <ul className="fin-flags">
      {flags.map((flag) => {
        const blocking = flag.status === "open" && flag.severity === "blocking";
        return (
          <li
            key={flag.id}
            className={`fin-flag${blocking ? " fin-flag--blocking" : ""}${
              flag.status === "waived" ? " fin-flag--waived" : ""
            }${flag.status === "cleared" ? " fin-flag--cleared" : ""}`}
          >
            <div className="fin-flag__head">
              <Icon name={blocking ? "alert" : "check"} size={14} aria-hidden="true" />
              <span className="fin-flag__name">{flagName(flag.flagType)}</span>
              <span className="fin-card__note">
                {flag.status === "open"
                  ? blocking
                    ? "Open — blocks approval"
                    : "Open — advisory"
                  : flag.status === "waived"
                    ? "Waived"
                    : "Cleared"}
              </span>
            </div>
            <p className="fin-flag__detail">{flag.detail || flagWhy(flag.flagType)}</p>
            {flag.status === "waived" ? (
              <p className="fin-flag__reason">
                Waived by {flag.waivedBy ?? "somebody"}: {flag.waiveReason ?? "no reason recorded"}
              </p>
            ) : null}
            {flag.status === "open" && onWaive ? (
              <>
                <Field
                  label="Reason for waiving"
                  hint="Recorded against the invoice with your name and the time. At least a few words."
                >
                  <input
                    type="text"
                    value={reasons[flag.id] ?? ""}
                    onChange={(event) =>
                      setReasons((current) => ({ ...current, [flag.id]: event.target.value }))
                    }
                    autoComplete="off"
                  />
                </Field>
                <div className="fin-actions">
                  <button
                    type="button"
                    className="fin-button"
                    disabled={busy || (reasons[flag.id] ?? "").trim().length < 8}
                    onClick={() => onWaive(flag, (reasons[flag.id] ?? "").trim())}
                  >
                    Waive with this reason
                  </button>
                  {onClear ? (
                    <button
                      type="button"
                      className="fin-button"
                      disabled={busy}
                      onClick={() => onClear(flag)}
                    >
                      Mark cleared
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** How many flags still stand between this invoice and an approval. */
export function openBlockingCount(flags: readonly UiFlag[]): number {
  return blockingFlags(flags).length;
}

/* ── The side panel ───────────────────────────────────────────────────────── */

/**
 * ONE RECORD, IN A DRAWER, AT EVERY WIDTH.
 *
 * Full screen below 768px and a right-hand drawer above it — see `finance.css`.
 * Escape closes it, the backdrop is a real button so a pointer and a keyboard
 * both reach the same affordance, and focus moves to the close control on open
 * so a keyboard user is inside the thing that just appeared rather than still
 * on the row behind it.
 */
export function SidePanel({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        className="fin-panel-backdrop"
        aria-label="Close this record"
        onClick={onClose}
      />
      <div className="fin-panel" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <div className="fin-panel__head">
          <div className="fin-panel__title">
            <h2 id={headingId}>{title}</h2>
            {subtitle ? <div className="fin-card__note">{subtitle}</div> : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="fin-panel__close"
            onClick={onClose}
            aria-label="Close this record"
          >
            <Icon name="close" size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="fin-panel__body">{children}</div>
      </div>
    </>
  );
}

export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="fin-panel__section">
      <h3 className="fin-section-title">{title}</h3>
      {children}
    </section>
  );
}

/** A definition list of facts, with the "not recorded" case spelled out. */
export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="fin-facts">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value === null || value === undefined || value === "" ? "—" : value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Small helpers the tabs share ─────────────────────────────────────────── */

/** Every distinct unmapped status key on a page, for the §5 admin notice. */
export function unmappedKeys(
  statuses: readonly (string | null | undefined)[],
  statusMap?: readonly StatusMapEntry[] | null,
): string[] {
  return statuses
    .map((status) => presentStatus(status, statusMap))
    .filter((presentation) => !presentation.mapped)
    .map((presentation) => presentation.key);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}
