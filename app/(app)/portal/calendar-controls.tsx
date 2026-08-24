"use client";

/**
 * The calendar's chrome: which date fields it draws from, what it is filtered
 * to, what colour each kind of event is, and a key explaining the result.
 *
 * WHY POPOVERS AND NOT INLINE CONTROLS
 *
 * Six facets, five date sources and two colour pickers laid out inline is a
 * control block taller than the first week of the month on a laptop, and on a
 * phone it is the whole screen. Each control is therefore a labelled trigger
 * that carries its own state at a glance — "Site 3", "Dates 2", "Job type ·
 * None recorded" — and opens a surface only when asked.
 *
 * WHY NOTHING HERE POSITIONS ITSELF
 *
 * `overlay/anchored.tsx` already solves this, and solved it because the board's
 * menus used to be `absolute` children of whatever opened them and got clipped
 * by a `backdrop-filter` ancestor. `AnchoredPopover` portals to the shared
 * layer, measures in viewport coordinates, flips and clamps inside the
 * viewport, closes on Escape and on an outside press, and puts focus back on
 * the trigger. On a phone the same content goes into `MobileCellSheet`, the
 * bottom sheet the board already uses for cell editing, because a 260px
 * popover anchored to a wrapped button row is not a thing a thumb can use.
 * Neither component is new here; both are the product's own.
 *
 * WHY COLOUR IS NEVER THE ONLY SIGNAL
 *
 * The chips are user-coloured, so their meaning cannot rest on the colour: the
 * legend pairs every swatch with a word and a glyph, and the timing states are
 * carried by border weight and border style — see `calendarChipStyle`.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { Icon } from "../../components";
import { MobileCellSheet } from "./board-primitives";
import { AnchoredPopover } from "./overlay/anchored";
import {
  CALENDAR_DATE_SOURCES,
  calendarFilterCount,
  type CalendarEntity,
  type CalendarEvent,
  type CalendarFilterOption,
  type CalendarFilterOptions,
  type CalendarFilters,
} from "./calendar-model";
import {
  DEFAULT_CALENDAR_COLOURS,
  calendarBestContrast,
  calendarChipStyle,
  calendarColourFails,
  calendarInk,
  type CalendarColours,
} from "./calendar-preferences";
import "./calendar-controls.css";

/** WCAG AA for body text — the bar the colour warning is measured against. */
const AA = 4.5;

/* ── Viewport ─────────────────────────────────────────────────────────────── */

/**
 * Whether the controls are on a phone, and therefore whether a surface is a
 * sheet or a popover.
 *
 * `matchMedia` rather than a CSS rule because the point is not to restyle the
 * popover into a sheet but to render a different component — one that locks
 * the page behind it and puts a 44px close button in reach. 767 is the
 * touch-target breakpoint brand-overrides.css already uses.
 *
 * The first paint is the desktop shape and the effect corrects it, which is
 * the same trade `narrowTopbar` in portal-app.tsx makes and for the same
 * reason: this is a client component that is still server-rendered, and a
 * server has no viewport to ask. Nothing is visible either way until a trigger
 * is pressed, so the correction costs no visible reflow.
 */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return narrow;
}

/* ── The shared surface ───────────────────────────────────────────────────── */

/**
 * One control's contents: an anchored popover on a laptop, a bottom sheet on a
 * phone.
 *
 * `role="dialog"` rather than `role="menu"`: the contents are checkboxes and
 * buttons, and a menu makes Tab close the surface, which would eject a
 * keyboard user on the way to the second checkbox. Dialog keeps Escape and the
 * outside-press dismissal and leaves Tab alone.
 */
function ControlSurface({
  open,
  anchorRef,
  onClose,
  title,
  subtitle,
  action,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const narrow = useNarrowViewport();

  /*
   * `MobileCellSheet` closes on Escape and on the backdrop, but it does not
   * hand focus back — it was written for cells, which are re-focused by the
   * grid. Here the trigger is the only thing to come back to, so the sheet
   * borrows the restore that `AnchoredPopover` does for the popover branch.
   * Guarded on focus having been lost, so a close caused by pressing some
   * other control does not steal it back.
   */
  useEffect(() => {
    if (!narrow || !open) return undefined;
    const anchor = anchorRef.current;
    return () => {
      if (!anchor) return;
      const active = document.activeElement;
      if (!active || active === document.body || !document.contains(active)) {
        anchor.focus({ preventScroll: true });
      }
    };
  }, [narrow, open, anchorRef]);

  if (narrow) {
    if (!open) return null;
    return (
      <MobileCellSheet
        title={title}
        subtitle={subtitle}
        onClose={onClose}
        className="calendar-sheet"
        headerAction={action}
      >
        {children}
      </MobileCellSheet>
    );
  }

  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      role="dialog"
      label={title}
      placement="bottom-start"
      className="calendar-menu-surface"
    >
      <div className="calendar-menu">
        <div className="calendar-menu__head">
          <div className="calendar-menu__heading">
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </div>
          {action}
        </div>
        {children}
      </div>
    </AnchoredPopover>
  );
}

/**
 * A control's trigger: the label, its current state, and a caret.
 *
 * `aria-expanded` is on the trigger and the surface is labelled with the same
 * title, so the pair is announced as one control. A trigger with nothing to
 * show is `aria-disabled` rather than `disabled`, so it stays focusable and a
 * keyboard user can still reach the note saying why it is inert — a `disabled`
 * button is skipped by the tab order and takes its own explanation with it.
 */
function ControlTrigger({
  buttonRef,
  label,
  state,
  tone,
  inert,
  inertNote,
  onOpen,
  open,
  testId,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  label: string;
  state?: string;
  tone?: "count" | "none";
  inert?: boolean;
  inertNote?: string;
  onOpen: () => void;
  open: boolean;
  /* Acceptance addresses the trigger by its role, not by its visible word, so
     rewording a button cannot silently disable a test. Same reasoning as
     `eventData` in calendar-views.tsx. */
  testId?: string;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="secondary-button calendar-control-trigger"
      {...(testId ? { [testId]: "" } : {})}
      aria-expanded={inert ? undefined : open}
      aria-haspopup={inert ? undefined : "dialog"}
      aria-disabled={inert ? true : undefined}
      aria-label={inert && inertNote ? `${label}. ${inertNote}` : undefined}
      onClick={inert ? undefined : onOpen}
    >
      <span className="calendar-control-trigger__label">{label}</span>
      {state ? (
        <span
          className={
            tone === "none"
              ? "calendar-control-trigger__none"
              : "calendar-control-trigger__count"
          }
        >
          {state}
        </span>
      ) : null}
      <Icon name="chevron" size={13} className="calendar-control-trigger__caret" />
    </button>
  );
}

/* ── Date sources ─────────────────────────────────────────────────────────── */

const ENTITY_LABEL: Record<CalendarEntity, string> = {
  job: "Jobs",
  compliance: "Compliance",
};

const ENTITY_ORDER: readonly CalendarEntity[] = ["job", "compliance"];

/**
 * Which date fields the calendar draws from.
 *
 * Every declared source is listed whether or not it is producing anything, and
 * each carries its live count, because the question this control exists to
 * answer is "why is nothing showing up" — and a field sitting at (0) answers
 * it where an absent row would not.
 */
export function CalendarDateSourcePicker({
  value,
  onChange,
  counts,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** How many events each source is currently producing, for the "(0)" hint. */
  counts: Record<string, number>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const chosen = new Set(value);

  const toggle = useCallback(
    (id: string, on: boolean) => {
      const next = on
        ? [...value.filter((entry) => entry !== id), id]
        : value.filter((entry) => entry !== id);
      onChange(next);
    },
    [onChange, value],
  );

  return (
    <div className="calendar-control" data-board-popover="">
      <ControlTrigger
        buttonRef={triggerRef}
        label="Dates"
        testId="data-calendar-sources"
        state={value.length ? String(value.length) : "None"}
        tone={value.length ? "count" : "none"}
        open={open}
        /* Idempotent by construction: the trigger toggles, everything that
           dismisses sets `open` to false. See `onClose` below. */
        onOpen={() => setOpen((current) => !current)}
      />
      <ControlSurface
        open={open}
        anchorRef={triggerRef}
        /* NEVER a toggle. An outside press can reach both this and a
           board-level dismissal in the same gesture, and a toggle would
           re-open what the first one closed. */
        onClose={() => setOpen(false)}
        title="Dates"
        subtitle="Which fields put an event on the calendar"
      >
        {value.length === 0 ? (
          <p className="calendar-menu__warning" role="status">
            <Icon name="alert" size={14} />
            <span>
              No date source selected, so the calendar has nothing to place.
              Tick a field below to see events again.
            </span>
          </p>
        ) : null}
        {ENTITY_ORDER.map((entity) => {
          const sources = CALENDAR_DATE_SOURCES.filter(
            (source) => source.entity === entity,
          );
          if (!sources.length) return null;
          return (
            <fieldset className="calendar-menu__group" key={entity}>
              <legend>{ENTITY_LABEL[entity]}</legend>
              <div className="calendar-menu__list">
                {sources.map((source) => {
                  const count = counts[source.id] ?? 0;
                  return (
                    <label className="calendar-menu__option" key={source.id}>
                      <input
                        type="checkbox"
                        data-source-toggle={source.id}
                        checked={chosen.has(source.id)}
                        onChange={(event) => toggle(source.id, event.target.checked)}
                      />
                      <span className="calendar-menu__option-body">
                        <span className="calendar-menu__option-label">
                          {source.label}
                          {source.editable ? null : (
                            <span className="calendar-menu__tag">Read-only</span>
                          )}
                        </span>
                        <small className="calendar-menu__desc">{source.description}</small>
                      </span>
                      <span
                        className="calendar-menu__count"
                        data-empty={count === 0 ? "true" : undefined}
                      >
                        {count.toLocaleString("en-GB")}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </ControlSurface>
    </div>
  );
}

/* ── Filters ──────────────────────────────────────────────────────────────── */

type FacetKey = keyof CalendarFilters;

/**
 * The six facets, with the sentence each shows when a workspace has nothing to
 * put in it. The note names the thing that is missing rather than saying "no
 * options", because "No job types recorded" tells an owner what to go and fix.
 */
const FACETS: readonly { key: FacetKey; label: string; empty: string }[] = [
  { key: "sites", label: "Site", empty: "No sites recorded" },
  { key: "statuses", label: "Status", empty: "No statuses recorded" },
  { key: "priorities", label: "Priority", empty: "No priorities recorded" },
  { key: "contractors", label: "Contractor", empty: "No contractors recorded" },
  { key: "jobTypes", label: "Job type", empty: "No job types recorded" },
  {
    key: "complianceTypes",
    label: "Compliance type",
    empty: "No compliance types recorded",
  },
];

function FacetPicker({
  facet,
  label,
  emptyNote,
  options,
  selected,
  onChange,
}: {
  facet: string;
  label: string;
  emptyNote: string;
  options: CalendarFilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inert = options.length === 0;
  const chosen = new Set(selected);

  const toggle = useCallback(
    (option: string, on: boolean) => {
      onChange(
        on
          ? [...selected.filter((entry) => entry !== option), option]
          : selected.filter((entry) => entry !== option),
      );
    },
    [onChange, selected],
  );

  return (
    <div className="calendar-control" data-board-popover="" data-facet={facet}>
      <ControlTrigger
        buttonRef={triggerRef}
        label={label}
        testId="data-calendar-filters"
        state={inert ? "None recorded" : selected.length ? String(selected.length) : undefined}
        tone={inert ? "none" : "count"}
        inert={inert}
        inertNote={emptyNote}
        open={open}
        onOpen={() => setOpen((current) => !current)}
      />
      <ControlSurface
        open={open && !inert}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        title={label}
        action={
          <button
            type="button"
            className="text-button calendar-menu__clear"
            disabled={selected.length === 0}
            onClick={() => onChange([])}
          >
            Clear
          </button>
        }
      >
        <div className="calendar-menu__list">
          {options.map((option) => (
            <label className="calendar-menu__option" key={option.value}>
              <input
                type="checkbox"
                checked={chosen.has(option.value)}
                onChange={(event) => toggle(option.value, event.target.checked)}
              />
              <span className="calendar-menu__option-body">
                <span className="calendar-menu__option-label">{option.label}</span>
              </span>
              <span
                className="calendar-menu__count"
                data-empty={option.count === 0 ? "true" : undefined}
              >
                {option.count.toLocaleString("en-GB")}
              </span>
            </label>
          ))}
        </div>
      </ControlSurface>
    </div>
  );
}

/**
 * The six facets and one "Clear all".
 *
 * A facet with no values renders inert with the reason on it rather than
 * opening onto an empty list — an empty menu tells the user the control is
 * broken, and "No job types recorded" tells them it is not.
 */
export function CalendarFilterBar({
  filters,
  options,
  onChange,
}: {
  filters: CalendarFilters;
  options: CalendarFilterOptions;
  onChange: (next: CalendarFilters) => void;
}): React.JSX.Element {
  const active = calendarFilterCount(filters);
  return (
    <div className="calendar-filter-bar">
      <span className="calendar-filter-bar__label">
        <Icon name="filter" size={14} />
        Filters
      </span>
      {FACETS.map((facet) => (
        <FacetPicker
          key={facet.key}
          facet={facet.key}
          label={facet.label}
          emptyNote={facet.empty}
          options={options[facet.key] ?? []}
          selected={filters[facet.key] ?? []}
          onChange={(next) => onChange({ ...filters, [facet.key]: next })}
        />
      ))}
      <button
        type="button"
        className="text-button calendar-clear-all"
        disabled={active === 0}
        onClick={() =>
          onChange({
            sites: [],
            statuses: [],
            priorities: [],
            contractors: [],
            jobTypes: [],
            complianceTypes: [],
          })
        }
      >
        Clear all
        {active > 0 ? <span className="calendar-clear-all__count">{active}</span> : null}
      </button>
    </div>
  );
}

/* ── Colours ──────────────────────────────────────────────────────────────── */

/**
 * A stand-in event for the preview chip, so the preview is painted by exactly
 * the function that paints the calendar rather than by a second copy of its
 * rules. If `calendarChipStyle` changes, the preview changes with it.
 */
function previewEvent(kind: CalendarEntity): CalendarEvent {
  const job = kind === "job";
  return {
    key: `calendar-preview:${kind}`,
    kind,
    sourceId: job ? "job:dueAt" : "compliance:expiry",
    recordId: "preview",
    field: job ? "dueAt" : "expiry",
    fieldLabel: job ? "Due" : "Expires",
    day: "",
    time: "",
    title: job ? "Boiler service" : "Gas safety certificate",
    subtitle: "Riverside Court",
    timing: "upcoming",
    editable: true,
  };
}

function ColourRow({
  kind,
  label,
  colours,
  onChange,
}: {
  kind: CalendarEntity;
  label: string;
  colours: CalendarColours;
  onChange: (next: CalendarColours) => void;
}) {
  const inputId = useId();
  const value = kind === "job" ? colours.job : colours.compliance;
  const fallback =
    kind === "job" ? DEFAULT_CALENDAR_COLOURS.job : DEFAULT_CALENDAR_COLOURS.compliance;
  const set = (next: string) =>
    onChange(kind === "job" ? { ...colours, job: next } : { ...colours, compliance: next });
  /*
   * `chipInk` returns the best ink available, not a guaranteed pass — on a
   * mid-tone ground neither white nor the dark ink reaches AA, and no amount
   * of choosing between them fixes it. So the warning is measured against the
   * best of all three candidate inks, and says the real number rather than
   * "this may be hard to read".
   */
  const ratio = calendarBestContrast(value);
  const fails = calendarColourFails(value);

  return (
    <div className="calendar-colour-row">
      <label className="calendar-colour-row__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="calendar-colour-row__input"
        data-colour-for={kind}
        type="color"
        value={value}
        onChange={(event) => set(event.target.value)}
      />
      <span
        className="calendar-colour-preview"
        style={calendarChipStyle(previewEvent(kind), colours)}
      >
        <Icon name={kind === "job" ? "wrench" : "shield"} size={12} />
        <strong>{kind === "job" ? "Boiler service" : "Gas certificate"}</strong>
      </span>
      <button
        type="button"
        className="text-button calendar-colour-row__reset"
        disabled={value === fallback}
        onClick={() => set(fallback)}
      >
        Reset to default
      </button>
      {fails ? (
        <p className="calendar-colour-warning" role="status">
          <Icon name="alert" size={14} />
          <span>
            Label text reaches only {ratio.toFixed(2)}:1 on this colour, under the{" "}
            {AA}:1 the rest of the product is held to. Pick a lighter or darker
            shade, or reset.
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The two event colours, each with a live preview and a way back.
 *
 * The preview is not decoration: the ink is computed from the chosen ground,
 * so it is the only place a user can see what their pick will actually read
 * like before it is on forty chips.
 */
export function CalendarColourSettings({
  colours,
  onChange,
}: {
  colours: CalendarColours;
  onChange: (next: CalendarColours) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const custom =
    (colours.job !== DEFAULT_CALENDAR_COLOURS.job ? 1 : 0) +
    (colours.compliance !== DEFAULT_CALENDAR_COLOURS.compliance ? 1 : 0);

  return (
    <div className="calendar-control" data-board-popover="">
      <ControlTrigger
        buttonRef={triggerRef}
        label="Colours"
        testId="data-calendar-colours"
        state={custom ? String(custom) : undefined}
        open={open}
        onOpen={() => setOpen((current) => !current)}
      />
      <ControlSurface
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        title="Colours"
        subtitle="Kept in this browser, not on your account"
      >
        <div className="calendar-colours">
          <ColourRow kind="job" label="Jobs" colours={colours} onChange={onChange} />
          <ColourRow
            kind="compliance"
            label="Compliance"
            colours={colours}
            onChange={onChange}
          />
        </div>
      </ControlSurface>
    </div>
  );
}

/* ── Legend ───────────────────────────────────────────────────────────────── */

/**
 * What the calendar's marks mean.
 *
 * Every entry carries a word AND a shape — a glyph in the swatch for the two
 * kinds, a thick edge for overdue, a broken edge for done — because the two
 * grounds are chosen by the user and a legend that reads "the blue ones are
 * jobs" stops being true the moment somebody picks purple, and never was true
 * for a reader who cannot separate the two.
 */
export function CalendarLegend({
  colours,
}: {
  colours: CalendarColours;
}): React.JSX.Element {
  const job = { background: colours.job, color: calendarInk(colours.job) };
  const compliance = {
    background: colours.compliance,
    color: calendarInk(colours.compliance),
  };
  return (
    <ul className="calendar-key" aria-label="What the calendar's marks mean">
      <li className="calendar-key__item">
        <span className="calendar-key__swatch" style={job}>
          <Icon name="wrench" size={11} />
        </span>
        Jobs
      </li>
      <li className="calendar-key__item">
        <span className="calendar-key__swatch" style={compliance}>
          <Icon name="shield" size={11} />
        </span>
        Compliance
      </li>
      <li className="calendar-key__item">
        <span
          className="calendar-key__swatch calendar-key__swatch--overdue"
          style={{ ...job, borderLeftColor: job.color }}
        >
          <Icon name="alert" size={11} />
        </span>
        Overdue
      </li>
      <li className="calendar-key__item">
        <span
          className="calendar-key__swatch calendar-key__swatch--done"
          style={{ ...job, borderLeftColor: job.color }}
        >
          <Icon name="check" size={11} />
        </span>
        Done
      </li>
    </ul>
  );
}
