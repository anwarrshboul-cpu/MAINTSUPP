"use client";

/**
 * THE STICKY FILTER BAR, AND THE BOTTOM SHEET IT BECOMES ON A PHONE.
 *
 * One component for all four pages, because they take the same shape and
 * because building it four times is how three of them ended up with a different
 * idea of what `Clear all` clears.
 *
 * ── THE PERIOD NEVER LEAVES THE BAR ───────────────────────────────────────
 *
 * On a phone every other control folds into `Filters (3)`, which opens a bottom
 * sheet. The period does not fold, because it is the control people change most
 * and burying the commonest action behind two taps is a worse trade than the
 * width it costs.
 *
 * ── OR WITHIN A DIMENSION, AND WITHIN A DIMENSION ONLY ────────────────────
 *
 * Every group here is a multi-select and every one behaves the same way:
 * picking two values means "either of these", and picking values in two groups
 * means "both". The SQL applies exactly that rule — see `dimensionConditions` —
 * so what the chips say and what the database counts cannot come apart.
 *
 * ── THE CHIPS ARE THE STATE ───────────────────────────────────────────────
 *
 * Active filters render as removable chips whatever width the page is at,
 * including the ones set from a chart segment on a card below. A cross-filter
 * that changed the numbers without appearing in the bar would be a page whose
 * figures could not be explained by anything visible on it.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../../components";
import { FilterChip } from "./ops-primitives";
import { useQueryState } from "./ops-url-state";

export type FilterOption = { value: string; label: string; count?: number };

export type FilterGroup = {
  /** The query-string key. Repeated, never comma-joined. */
  key: string;
  label: string;
  options: FilterOption[];
  /** Adds a search box above the options once the list gets long. */
  searchable?: boolean;
};

export function OpsFilterBar({
  periodControl,
  groups,
  extra,
  sheetLead,
  onClearAll,
  activeChips,
}: {
  periodControl: ReactNode;
  groups: FilterGroup[];
  extra?: ReactNode;
  /**
   * WHAT SITS AT THE TOP OF THE MOBILE SHEET, ABOVE THE FILTER GROUPS.
   *
   * §1.8's table is explicit about this row: "Date range + Measure-by controls
   * → Inside the same bottom sheet, at the top." The sheet used to render the
   * groups and nothing else, so on a phone the period selector was reachable
   * (it stays on the bar) but the cohort axis was not reachable at all — and
   * §1.8's opening sentence is that no feature is desktop-only.
   *
   * A separate slot from `extra` rather than the same one, because the two
   * appear in different places and a control can legitimately want both: the
   * caller passes the same node twice and each surface gets its own instance.
   */
  sheetLead?: ReactNode;
  onClearAll: () => void;
  activeChips: Array<{ key: string; label: string; value: string; onRemove: () => void }>;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  /*
   * Escape closes the sheet and focus goes back to the button that opened it.
   * Without the second half a keyboard user lands at the top of the document
   * every time they dismiss a filter sheet, which on this page is several
   * hundred pixels above where they were reading.
   */
  useEffect(() => {
    if (!sheetOpen) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSheetOpen(false);
        openerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const count = activeChips.length;

  return (
    <>
      <div className="ops-filterbar">
        <div className="ops-filterbar__row">
          {periodControl}
          <button
            ref={openerRef}
            type="button"
            className="ops-filterbar__more"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
          >
            <Icon name="filter" size={16} />
            Filters{count ? ` (${count})` : ""}
          </button>
          <div className="ops-filterbar__panel">
            {groups.map((group) => (
              <FilterGroupControl key={group.key} group={group} />
            ))}
            {extra}
          </div>
        </div>

        {count > 0 ? (
          <div className="ops-filterbar__chips">
            {activeChips.map((chip) => (
              <FilterChip
                key={`${chip.key}:${chip.value}`}
                label={chip.label}
                value={chip.value}
                onRemove={chip.onRemove}
              />
            ))}
            <button type="button" className="ops-filterbar__clear" onClick={onClearAll}>
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      {sheetOpen ? (
        <div
          className="ops-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Filters"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setSheetOpen(false);
              openerRef.current?.focus();
            }
          }}
        >
          <div className="ops-sheet__panel">
            <div className="ops-sheet__head">
              <h2>Filters</h2>
              <button
                ref={closeRef}
                type="button"
                className="ops-menu__button"
                aria-label="Close filters"
                onClick={() => {
                  setSheetOpen(false);
                  openerRef.current?.focus();
                }}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            {sheetLead ? <div className="ops-sheet__lead">{sheetLead}</div> : null}
            {groups.map((group) => (
              <SheetGroup key={group.key} group={group} />
            ))}
            {count > 0 ? (
              <button type="button" className="secondary-button" onClick={onClearAll}>
                Clear all
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The desktop form of one group: a native `<select multiple>` would be a
 * usability disaster, so it is a labelled disclosure with pressed toggles.
 */
function FilterGroupControl({ group }: { group: FilterGroup }) {
  const { params, setParams } = useQueryState();
  const selected = params.getAll(group.key);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!group.options.length) return null;

  return (
    <div className="ops-menu" ref={wrapper}>
      {/*
        `--group`, not an inline style beating a media query.

        `.ops-filterbar__more` is hidden at ≥768 because that is where the
        mobile `Filters (3)` button stops being needed; these per-dimension
        buttons live in the panel that appears at the same width, so they need
        the look without the hiding rule. A modifier class says that; an inline
        `display` would have been an override nobody could find from the
        stylesheet.
      */}
      <button
        type="button"
        className="ops-filterbar__more ops-filterbar__more--group"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {group.label}
        {selected.length ? ` (${selected.length})` : ""}
        <Icon name="chevron" size={14} />
      </button>
      {open ? (
        <div className="ops-menu__list" style={{ minWidth: 220, maxHeight: 320, overflowY: "auto" }}>
          <OptionList group={group} params={params} setParams={setParams} />
        </div>
      ) : null}
    </div>
  );
}

function SheetGroup({ group }: { group: FilterGroup }) {
  const { params, setParams } = useQueryState();
  if (!group.options.length) return null;
  return (
    <div className="ops-sheet__group">
      <strong>{group.label}</strong>
      <div className="ops-sheet__options">
        <OptionList group={group} params={params} setParams={setParams} />
      </div>
    </div>
  );
}

function OptionList({
  group,
  params,
  setParams,
}: {
  group: FilterGroup;
  params: URLSearchParams;
  setParams: (next: URLSearchParams) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = new Set(params.getAll(group.key));
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? group.options.filter((option) => option.label.toLowerCase().includes(needle))
    : group.options;

  const toggle = (value: string) => {
    const next = new URLSearchParams(params);
    const existing = next.getAll(group.key);
    const updated = existing.includes(value)
      ? existing.filter((entry) => entry !== value)
      : [...existing, value];
    next.delete(group.key);
    for (const entry of [...new Set(updated)].sort()) next.append(group.key, entry);
    setParams(next);
  };

  return (
    <>
      {group.searchable && group.options.length > 8 ? (
        <label className="ops-field" style={{ marginBottom: 6 }}>
          <span className="visually-hidden">Search {group.label}</span>
          <input
            type="search"
            placeholder={`Search ${group.label.toLowerCase()}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
      {visible.map((option) => (
        <button
          key={option.value}
          type="button"
          className="ops-option"
          aria-pressed={selected.has(option.value)}
          onClick={() => toggle(option.value)}
        >
          {option.label}
          {option.count === undefined ? null : <small>{option.count}</small>}
        </button>
      ))}
      {visible.length === 0 ? <span className="ops-empty">No matches.</span> : null}
    </>
  );
}

/**
 * The period select plus its two custom-range dates.
 *
 * The dates only appear once "Custom range" is chosen, so the bar is not two
 * empty date boxes wide for the four readers in five who want a preset — the
 * same judgement the compliance toolbar already makes.
 */
export function PeriodControl({
  periods,
  value,
  from,
  to,
  onChange,
}: {
  periods: ReadonlyArray<{ key: string; label: string }>;
  value: string;
  from: string;
  to: string;
  onChange: (next: { period?: string; from?: string; to?: string }) => void;
}) {
  return (
    <>
      <label>
        <span className="visually-hidden">Period</span>
        <select value={value} onChange={(event) => onChange({ period: event.target.value })}>
          {periods.map((period) => (
            <option key={period.key} value={period.key}>
              {period.label}
            </option>
          ))}
        </select>
      </label>
      {value === "custom" ? (
        <>
          <label>
            <span className="visually-hidden">From</span>
            <input
              type="date"
              value={from}
              onChange={(event) => onChange({ from: event.target.value })}
            />
          </label>
          <label>
            <span className="visually-hidden">To</span>
            <input
              type="date"
              value={to}
              onChange={(event) => onChange({ to: event.target.value })}
            />
          </label>
        </>
      ) : null}
    </>
  );
}
