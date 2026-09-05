"use client";

/**
 * THE JOB, OPENED FROM THE CALENDAR — AND WHY IT IS A PANEL AND NOT THE DRAWER.
 *
 * Module 2 §5 says a click on a job chip "opens the job in a side panel, not
 * the creation modal", and then lists a handful of fields that are editable
 * inline. Read quickly that is a styling instruction. It is not. It is about
 * where a person is standing when they change something.
 *
 * Somebody on the calendar is looking at a WEEK. They are moving a visit,
 * chasing a deadline, deciding what to do about Tuesday. Sending them to the
 * full job record to change a status takes the week off the screen, and they
 * come back to a grid that has scrolled, re-filtered and lost the row they were
 * comparing against. So the five fields §5 names — status, scheduled date and
 * time, assignee, priority, SLA deadline — are editable HERE, beside the grid,
 * and everything else deliberately is not: it links out.
 *
 * The five are not an arbitrary subset. They are exactly the fields whose value
 * is a scheduling decision. Cost, description, contractor rates and the comment
 * thread are all things you change while thinking about the JOB, and the job
 * record is where that thinking is done.
 *
 * ── EVERY EDIT IS A WRITE TO THE JOB, NEVER TO A CALENDAR ROW ──────────────
 *
 * §2's rule ("do not duplicate") reaches this file as a constraint on the save
 * path rather than as an idea. The panel holds NO draft of the job. Each
 * control writes its own field through the one callback the host supplies, and
 * the host re-reads. There is no local copy to disagree with the board, because
 * there is no local copy at all — which is also why a status changed on the
 * board while this is open corrects itself rather than being overwritten by a
 * stale form on the next save.
 *
 * ── WHY THE CHIP VOCABULARY LIVES IN THIS FILE ────────────────────────────
 *
 * `jobChipCss` below turns a `JobChipAppearance` into the inline style a chip
 * wears. It is here, in the module about ONE job, because that is what it
 * describes: how a single job announces its status. The unscheduled tray
 * imports it rather than restating it — one job drawn small is still one job,
 * and two copies of this arithmetic is how a tray entry and its own chip on the
 * grid come to be two different colours for the same row.
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../../components";
import { formatShortDate } from "../../lib/format-date";
import type { MaintenanceRequest } from "../../lib/types";
import type { WorkspaceComplianceRecord } from "../../lib/workspace-data";
import { chipInk } from "./chip-ink";
import {
  UNMAPPED_STATUS_COLOUR,
  type JobChipAppearance,
  type JobStatusMapping,
} from "./job-status-map";
import { parseStamp } from "./period-model";
import "./job-side-panel.css";

/**
 * A job as the calendar needs it.
 *
 * An intersection rather than an edit to `MaintenanceRequest`, and the reason
 * is worth writing down because it looks like a shortcut and is not.
 * `maintenance_requests` HAS carried `scheduled_date`, `scheduled_time` and
 * `target_completion_date` since the Module 2 migration, and `exposeRequest`
 * spreads the whole row and deletes only a redaction list — so the browser has
 * already been receiving these three fields. What is missing is the TYPE
 * declaration, nothing else.
 *
 * Declaring them structurally here keeps this module honest about what it
 * reads without reaching into a shared type that four other screens compile
 * against. When `app/lib/types.ts` gains the three fields this alias collapses
 * to `MaintenanceRequest` and every call site stays as it is.
 */
export type CalendarJob = MaintenanceRequest & {
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  targetCompletionDate?: string | null;
};

/** The five fields §5 allows this panel to change, and nothing else. */
export type JobFieldPatch = Partial<{
  status: string;
  priority: string;
  assignee: string | null;
  /** The SLA deadline. `dueAt` is the column that has always held it. */
  dueAt: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
}>;

/* ── Dates a job carries ─────────────────────────────────────────────────── */

/** A `YYYY-MM-DD` out of any stamp shape this database stores, or null. */
export function jobDay(value: string | null | undefined): string | null {
  const day = (value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** The day a visit is booked for, or null when nobody has booked one. */
export function jobScheduledDay(job: CalendarJob): string | null {
  return jobDay(job.scheduledDate);
}

/**
 * The date the overdue overlay measures against.
 *
 * `jobIsOverdue` documents the order — the SLA deadline where one exists,
 * otherwise the scheduled date — and this is that order in one place so the
 * chip, the tray and this panel cannot each pick a different answer. A job with
 * neither returns null and is never late, which is the whole point of the tray:
 * an undated job is invisible, not overdue.
 */
export function jobDeadlineDay(job: CalendarJob): string | null {
  return jobDay(job.dueAt) ?? jobScheduledDay(job);
}

/* ── The SLA clock ───────────────────────────────────────────────────────── */

export type SlaCountdown = {
  /** Milliseconds left. Negative once the deadline has passed. */
  remainingMs: number | null;
  breached: boolean;
  /** "2 days left", "4 hours left", "3 days overdue", or null with no deadline. */
  label: string | null;
};

/**
 * Time remaining on a job's response deadline.
 *
 * Rounded to whole days above 48 hours and to whole hours below it, because
 * that is the resolution the decision is made at. "1.7 days" is a number nobody
 * acts on differently from "2 days", and printing it invites a reader to
 * believe the deadline is known to the minute when the column holds a date.
 *
 * NULL, NOT ZERO, with no deadline. A job with no SLA is not a job with none
 * remaining, and the two render differently: one says nothing, the other says
 * "overdue" about a commitment that was never made.
 */
export function slaCountdown(input: {
  deadline: string | null | undefined;
  now: number;
}): SlaCountdown {
  const at = parseStamp(input.deadline ?? undefined);
  if (!Number.isFinite(at)) return { remainingMs: null, breached: false, label: null };
  /*
   * The END of the deadline day, not its midnight. A deadline of "the 12th" is
   * met by work done at four in the afternoon on the 12th, and measuring
   * against 00:00 would mark every same-day job breached from the moment the
   * clock struck midnight — a red badge on a job that has all day to run.
   */
  const endOfDay = at + 86_399_999;
  const remainingMs = endOfDay - input.now;
  const breached = remainingMs < 0;
  const size = Math.abs(remainingMs);
  const hours = Math.floor(size / 3_600_000);
  const days = Math.floor(hours / 24);
  const amount =
    hours >= 48
      ? `${days} day${days === 1 ? "" : "s"}`
      : hours >= 1
        ? `${hours} hour${hours === 1 ? "" : "s"}`
        : `${Math.max(1, Math.floor(size / 60_000))} minute${
            Math.floor(size / 60_000) === 1 ? "" : "s"
          }`;
  return {
    remainingMs,
    breached,
    label: breached ? `${amount} overdue` : `${amount} left`,
  };
}

/**
 * How much of the agreed response window is left, as a fraction.
 *
 * §8 sets the escalation trigger at "25% of window remaining", and the
 * unscheduled tray turns red on the same measure, so the arithmetic is defined
 * once here rather than twice with a chance of disagreeing. The window is
 * raised-to-due, which is the window the SLA rules in `app/lib/priority-rules.ts`
 * actually set when the job was created.
 *
 * Null when either end is missing or the window is not positive. A window of
 * zero length is not "100% used"; it is a row whose dates do not describe a
 * window at all, and inventing a fraction for it would put a red count in front
 * of an operator about nothing.
 */
export function slaWindowRemaining(input: {
  raisedAt: string | null | undefined;
  deadline: string | null | undefined;
  now: number;
}): number | null {
  const start = parseStamp(input.raisedAt ?? undefined);
  const end = parseStamp(input.deadline ?? undefined);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const total = end + 86_399_999 - start;
  if (total <= 0) return null;
  return (end + 86_399_999 - input.now) / total;
}

/* ── What a job chip looks like ──────────────────────────────────────────── */

export type JobChipOptions = {
  appearance: JobChipAppearance;
  /** The overdue overlay, decided by `jobIsOverdue` — never inferred here. */
  overdue: boolean;
  /** §4.2's P1 marker. Tier 1 is this estate's most severe service tier. */
  urgent: boolean;
};

/**
 * §4.2's red, as a token rather than as the spec's `#EF4444`.
 *
 * The spec names a hex and this repository has a rule that outranks it: a
 * colour that is not DATA is a token, because a literal is how a screen ends up
 * legible in one theme and not the other. `--danger-solid` is the house red, is
 * defined identically in both themes by design (see the "Brand fills" block in
 * globals.css), and is already what every other refusal and breach in the
 * product is painted with. Using it here means the overdue marker matches the
 * rest of the product instead of being a second red that only the calendar has.
 *
 * The STATUS colour is the exception and stays a literal, because it arrives
 * from `job_status_map` — an admin picked it, and a token cannot represent a
 * value the database holds.
 */
const OVERLAY_RED = "var(--danger-solid)";

/**
 * The inline style for one job chip.
 *
 * Inline because that is the only hook the calendar surface offers — chips are
 * drawn by `calendar-views.tsx`, which takes a `chipStyle` callback and owns
 * the className. That constraint is why the P1 marker below is a gradient
 * rather than a `::after`: with no class to hang a pseudo-element on, a
 * background layer is the honest way to draw a dot, and it composes with the
 * hatch layer instead of fighting it.
 *
 * ── THE FOUR CHIP STYLES, AND WHAT EACH ONE IS FOR ────────────────────────
 *
 *   solid           the ground IS the status colour; the ink is measured
 *   outline         a card ground with the status colour as its edge
 *   hatched         solid, plus diagonal stripes — "this is parked"
 *   strikethrough   solid, plus a line through the label — "this is off"
 *
 * Three of the four survive greyscale on their own (stripes, a line, an edge),
 * which is the §4.3 requirement restated: colour is never the only signal.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * §4.2 asks for Completed at "60% opacity". It is not implemented and that is
 * a decision, not an omission. `calendar-preferences.ts` records why in its own
 * words: "a 0.7 wash on a chip that measured 5:1 puts it under AA again, and it
 * would do it invisibly to the contrast suite, which measures the pair and not
 * what was painted over it." Completed already reads as finished through its
 * green and, on the grid, through the dashed left border `calendarChipStyle`
 * gives a resolved event. Fading it would buy nothing and cost legibility.
 */
export function jobChipCss(options: JobChipOptions): CSSProperties {
  const { appearance, overdue, urgent } = options;
  const colour = appearance.colourHex || UNMAPPED_STATUS_COLOUR;
  const outline = appearance.chipStyle === "outline";

  /*
   * An outline chip's GROUND is a surface token and its ink is the body ink, so
   * it is legible in both themes by construction. Painting a pale tint of the
   * status colour instead would need a per-theme lightness decision this file
   * has no way to make — the status colour is chosen by an admin who never saw
   * the dark theme.
   */
  const background = outline ? "var(--surface-card)" : colour;
  const ink = outline ? "var(--ink)" : chipInk(colour);

  const layers: string[] = [];
  if (appearance.chipStyle === "hatched") {
    /*
     * The stripes take the INK colour, which is by construction the colour with
     * the most contrast against this ground — so a hatch stays visible whatever
     * an admin picked.
     *
     * 1px every 9px, which is thinner than it first looks like it should be.
     * Drawn at 2-in-7 it covers a third of the chip, and on a month grid where
     * most of the estate sits in one hatched status the whole calendar became a
     * field of stripes with the job titles inside it — legible one chip at a
     * time and unreadable as a screen. It is TEXTURE behind a label, and the
     * label is the thing somebody came to read.
     */
    layers.push(
      `repeating-linear-gradient(135deg, ${
        outline ? colour : ink
      } 0 1px, transparent 1px 9px)`,
    );
  }
  if (urgent) {
    /* §4.2's P1 dot: independent of status, so it is drawn on top of whatever
       the status decided rather than changing it. */
    layers.push(
      `radial-gradient(circle at calc(100% - 6px) 6px, ${OVERLAY_RED} 0 3px, transparent 3.5px)`,
    );
  }

  /*
   * LONGHANDS ONLY, and this is a defect that was caught in a browser rather
   * than reasoned about. Written as `border: "1px solid …"` plus a
   * `borderLeftWidth`, React warns — "don't mix shorthand and non-shorthand
   * properties for the same value" — and then proves the warning: on a
   * re-render it replays the shorthand AFTER the longhand, so the overdue edge
   * silently reverted from 4px to 1px. The one visual signal §4.2 asks for was
   * being erased by the property next to it.
   *
   * `backgroundColor` rather than `background` for the same reason: the hatch
   * and the P1 dot are set through `backgroundImage`, and a shorthand beside
   * them is the same trap one property along.
   */
  const style: CSSProperties = {
    borderTopStyle: "solid",
    borderRightStyle: "solid",
    borderBottomStyle: "solid",
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderTopColor: outline ? colour : "transparent",
    borderRightColor: outline ? colour : "transparent",
    borderBottomColor: outline ? colour : "transparent",
    backgroundColor: background,
    color: ink,
    /*
     * §4.3 — JOBS ARE SQUARE. Certificates are rounded, visits are rounded, a
     * note has no border at all. That is the greyscale distinction the brief
     * asks for, and it is set here because a shape is a property of the record
     * type rather than of the reader's colour settings.
     */
    borderRadius: 2,
    borderLeftStyle: "solid",
    borderLeftWidth: overdue ? 4 : 2,
    /*
     * OVERDUE LAYERS, IT DOES NOT REPLACE. The ground is still the status
     * colour; only the left edge turns red. A job that is "Awaiting parts" AND
     * late is two facts, and a chip repainted red would have told the reader
     * the less useful one.
     */
    borderLeftColor: overdue ? OVERLAY_RED : outline ? colour : ink,
  };
  if (layers.length) style.backgroundImage = layers.join(", ");
  if (appearance.chipStyle === "strikethrough") style.textDecoration = "line-through";
  return style;
}

/** The same decision, as a small swatch for a list row rather than a chip. */
export function jobSwatchCss(appearance: JobChipAppearance): CSSProperties {
  return {
    background:
      appearance.chipStyle === "outline"
        ? "var(--surface-card)"
        : appearance.colourHex || UNMAPPED_STATUS_COLOUR,
    borderColor: appearance.colourHex || UNMAPPED_STATUS_COLOUR,
  };
}

/* ── The panel ───────────────────────────────────────────────────────────── */

export type JobSidePanelProps = {
  job: CalendarJob;
  appearance: JobChipAppearance;
  overdue: boolean;
  /** Every active mapping, so the status control offers meanings and not ids. */
  mappings: readonly JobStatusMapping[];
  siteName: string | null;
  /** The priorities and people this workspace actually uses. */
  priorities: readonly string[];
  assignees: readonly string[];
  /** Certificates for this job's site — §5's "linked certificates, if any". */
  certificates: readonly WorkspaceComplianceRecord[];
  canEdit: boolean;
  /** Writes one or more of the five fields straight to the job record. */
  onSave: (patch: JobFieldPatch) => Promise<void>;
  /** Everything this panel does not edit opens the full record. */
  onOpenRecord: () => void;
  onOpenCertificate: (id: string) => void;
  onClose: () => void;
};

export function JobSidePanel({
  job,
  appearance,
  overdue,
  mappings,
  siteName,
  priorities,
  assignees,
  certificates,
  canEdit,
  onSave,
  onOpenRecord,
  onOpenCertificate,
  onClose,
}: JobSidePanelProps) {
  /*
   * `busy` names the FIELD being written, not a boolean.
   *
   * Two controls can be changed in quick succession — a status and then a date
   * — and a shared boolean would grey out the second while the first was in
   * flight, which reads as the panel having frozen. Naming the field disables
   * only the control that is actually mid-write.
   */
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  /*
   * The clock is state so the countdown is right when the panel opens and does
   * not go stale while it is left open. One tick a minute: the label is rounded
   * to hours and days, so a faster tick would repaint for nothing.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const sla = useMemo(
    () => slaCountdown({ deadline: job.dueAt, now }),
    [job.dueAt, now],
  );

  const write = async (field: string, patch: JobFieldPatch) => {
    setBusy(field);
    setFailure(null);
    try {
      await onSave(patch);
    } catch (error) {
      /*
       * SAID OUT LOUD, IN THE PANEL. A failed inline edit that only raised a
       * toast left the control showing the value the person chose while the
       * record held the old one — the appearance of a saved change that did not
       * happen, which is the one outcome this codebase keeps recording as the
       * worst available.
       */
      setFailure(
        error instanceof Error ? error.message : "That change could not be saved.",
      );
    } finally {
      setBusy(null);
    }
  };

  /*
   * The status list, with the job's OWN status added when it is unmapped.
   *
   * Without this the control would silently offer no way back: an unmapped
   * status is not in `job_status_map`, so a `<select>` built from the map alone
   * shows the first mapped status as selected and the first blur writes it. The
   * raw label is kept, marked as unmapped, so opening the panel on such a job
   * cannot change it by accident.
   */
  const statusOptions = useMemo(() => {
    const options = mappings
      .filter((mapping) => mapping.active)
      .map((mapping) => ({
        value: mapping.sourceStatusLabel,
        label: mapping.displayLabel || mapping.sourceStatusLabel,
      }));
    const current = (job.status ?? "").trim();
    if (current && !options.some((option) => option.value === current)) {
      options.unshift({ value: current, label: `${current} (unmapped)` });
    }
    return options;
  }, [job.status, mappings]);

  const scheduled = jobScheduledDay(job) ?? "";
  const deadline = jobDay(job.dueAt) ?? "";
  const disabled = !canEdit;

  return (
    <aside
      className="job-panel"
      role="complementary"
      aria-label={`Job ${job.reference ?? job.id}`}
    >
      <header className="job-panel__head">
        <div className="job-panel__identity">
          <span className="job-panel__reference">{job.reference ?? job.id}</span>
          <h2 className="job-panel__title">{job.title}</h2>
        </div>
        <button
          type="button"
          className="job-panel__close"
          onClick={onClose}
          aria-label="Close this job"
        >
          <Icon name="close" size={16} />
        </button>
      </header>

      <p className="job-panel__status-line">
        <span
          className={`job-panel__chip${overdue ? " is-overdue" : ""}`}
          style={jobChipCss({ appearance, overdue, urgent: job.tier === 1 })}
        >
          <Icon name="wrench" size={12} />
          {appearance.label}
        </span>
        {overdue && (
          <span className="job-panel__overdue">
            <Icon name="alert" size={13} />
            Overdue
          </span>
        )}
        {!appearance.mapped && (
          <span className="job-panel__unmapped">
            This status has no mapping, so it is drawn in grey with its own label.
          </span>
        )}
      </p>

      {failure && (
        <p className="job-panel__failure" role="alert">
          <Icon name="alert" size={14} />
          {failure}
        </p>
      )}

      {/* ── The five §5 lets this panel change ─────────────────────────── */}

      <div className="job-panel__grid">
        <label className="job-panel__field">
          <span>Status</span>
          <select
            value={(job.status ?? "").trim()}
            disabled={disabled || busy === "status"}
            onChange={(changed) => void write("status", { status: changed.target.value })}
          >
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="job-panel__field">
          <span>Priority</span>
          <select
            value={job.priority ?? ""}
            disabled={disabled || busy === "priority"}
            onChange={(changed) =>
              void write("priority", { priority: changed.target.value })
            }
          >
            {priorities.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>

        <label className="job-panel__field">
          <span>Scheduled date</span>
          <input
            type="date"
            value={scheduled}
            disabled={disabled || busy === "scheduledDate"}
            /*
             * onChange, not onBlur. A date input commits a whole date at once
             * and a blur-committed field is the one people lose work in: they
             * pick a date, click a chip on the grid, and the panel unmounts
             * before the blur ever fires.
             */
            onChange={(changed) =>
              void write("scheduledDate", {
                scheduledDate: changed.target.value || null,
              })
            }
          />
        </label>

        <label className="job-panel__field">
          <span>Scheduled time</span>
          <input
            type="time"
            value={job.scheduledTime ?? ""}
            disabled={disabled || busy === "scheduledTime"}
            onChange={(changed) =>
              void write("scheduledTime", {
                scheduledTime: changed.target.value || null,
              })
            }
          />
        </label>

        <label className="job-panel__field">
          <span>Assignee</span>
          <select
            value={job.assignee ?? ""}
            disabled={disabled || busy === "assignee"}
            onChange={(changed) =>
              void write("assignee", { assignee: changed.target.value || null })
            }
          >
            {/* Unassigned is a value somebody chooses, not the absence of one. */}
            <option value="">Unassigned</option>
            {assignees.map((person) => (
              <option key={person} value={person}>
                {person}
              </option>
            ))}
          </select>
        </label>

        <label className="job-panel__field">
          <span>SLA deadline</span>
          <input
            type="date"
            value={deadline}
            disabled={disabled || busy === "dueAt"}
            onChange={(changed) =>
              void write("dueAt", { dueAt: changed.target.value || null })
            }
          />
        </label>
      </div>

      <p className={`job-panel__sla${sla.breached ? " is-breached" : ""}`}>
        {sla.label ? (
          <>
            {sla.breached && <Icon name="alert" size={14} />}
            <span>
              {formatShortDate(job.dueAt)} — {sla.label}
            </span>
          </>
        ) : (
          <span>No response deadline is set on this job.</span>
        )}
      </p>

      {/* ── Read-only context. Everything here links out. ───────────────── */}

      <dl className="job-panel__facts">
        <div>
          {/*
            `||`, not `??`. Most rows in this estate carry `location` as an
            EMPTY STRING rather than null — 21 of the 31 imported stores have no
            `sites` row to be named from — and `??` only catches null, so the
            field rendered blank where it should have fallen through to the next
            answer. A store with no name says so.
          */}
          <dt>Store</dt>
          <dd>{siteName || job.location || "No store on this job"}</dd>
        </div>
        <div>
          <dt>Reported</dt>
          <dd>{formatShortDate(job.requestedAt)}</dd>
        </div>
        <div>
          <dt>Contractor</dt>
          <dd>{job.contractor ?? "None named"}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{job.category || "—"}</dd>
        </div>
      </dl>

      {job.description && (
        <div className="job-panel__description">
          <h3>Description</h3>
          <p>{job.description}</p>
        </div>
      )}

      {certificates.length > 0 && (
        <div className="job-panel__certificates">
          <h3>Certificates at this store</h3>
          <ul>
            {certificates.map((certificate) => (
              <li key={certificate.id}>
                <button type="button" onClick={() => onOpenCertificate(certificate.id)}>
                  <Icon name="shield" size={14} />
                  <span>{certificate.kind}</span>
                  <em>
                    {certificate.expiry
                      ? `expires ${formatShortDate(certificate.expiry)}`
                      : certificate.state}
                  </em>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="job-panel__foot">
        <button type="button" className="primary-button" onClick={onOpenRecord}>
          Open the full job record
        </button>
        <p>
          Photos, comments, cost and the activity log live on the record. This
          panel changes only what a schedule depends on.
        </p>
      </footer>
    </aside>
  );
}
