/**
 * WHAT COLOUR IS A JOB, AND WHO DECIDES.
 *
 * Module 2 §4.1 opens with an instruction that reads like a style note and is
 * actually the whole design: "do not hardcode status strings. Statuses came
 * from monday.com and will change." This estate proves the point — the board
 * carries statuses that were typed by operators into a monday column, and the
 * set has already drifted twice during this project. A `switch` on status text
 * is therefore a file that is wrong on the day somebody renames a column, and
 * wrong silently, because the default branch of a switch is invisible.
 *
 * So the mapping is DATA — `job_status_map`, seeded in `db/init.ts` and
 * editable in admin — and this module is the pure lookup over it.
 *
 * ── AN UNMAPPED STATUS IS SHOWN, NEVER HIDDEN ──────────────────────────────
 *
 * The one rule worth stating twice. A status with no row falls back to neutral
 * grey CARRYING ITS RAW LABEL, and the calendar raises a one-line admin notice
 * counting how many there are. It is never filtered out.
 *
 * The alternative is worse than it looks. Hiding an unmapped job makes the
 * calendar quietly disagree with the job list, and the disagreement is
 * invisible precisely because the missing rows are the ones nobody has a name
 * for yet. A grey chip labelled "Awaiting client PO" is a prompt to add a
 * mapping; a chip that never rendered is a job that stopped existing.
 *
 * ── OVERDUE IS A STATE, NOT A STATUS ───────────────────────────────────────
 *
 * §4.2 is explicit: the overdue treatment layers ON TOP of the status colour
 * rather than replacing it. That is why `jobChipAppearance` returns the status
 * appearance and the overlay as separate fields instead of resolving them into
 * one colour. A job that is both "Awaiting parts" and past its deadline is two
 * facts, and collapsing them into a single red chip loses the one that tells
 * you what to do about it.
 *
 * `counts_as_overdue_eligible` exists for the same reason: a job parked on
 * hold with the client's agreement should not accrue an overdue badge, and
 * whether that is true of "Awaiting parts" is an operational decision the
 * operator makes in admin, not a constant this file gets to assume.
 */

/** A row of `job_status_map`, as the API returns it. */
export type JobStatusMapping = {
  sourceStatusLabel: string;
  displayLabel: string;
  colourHex: string;
  icon: string | null;
  chipStyle: JobChipStyle;
  countsAsOpen: boolean;
  countsAsOverdueEligible: boolean;
  sortOrder: number;
  active: boolean;
};

export type JobChipStyle = "solid" | "outline" | "hatched" | "strikethrough";

/**
 * The colour an unmapped status gets.
 *
 * Slate rather than a colour with meaning. Every other swatch in the seeded map
 * says something ("this is booked", "this is blocked"); the fallback must say
 * only "nobody has told the system what this means yet", and a neutral is the
 * one honest way to say that on a coloured calendar.
 */
export const UNMAPPED_STATUS_COLOUR = "#64748B";

const CHIP_STYLES: readonly JobChipStyle[] = [
  "solid",
  "outline",
  "hatched",
  "strikethrough",
];

/** A chip style from stored text, defaulting to `solid` for anything unknown. */
export function jobChipStyle(value: string | null | undefined): JobChipStyle {
  const wanted = (value ?? "").trim().toLowerCase();
  return CHIP_STYLES.find((style) => style === wanted) ?? "solid";
}

/**
 * Comparison key for a status label.
 *
 * Case- and whitespace-insensitive because the labels are free text that has
 * been through a spreadsheet, an import and a human. "In Progress", "in
 * progress" and "In  progress" are one status, and treating them as three
 * would put the same work in three colours on one screen.
 */
function statusKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Index a mapping list once, for repeated lookups while drawing a month. */
export function jobStatusIndex(
  mappings: readonly JobStatusMapping[],
): ReadonlyMap<string, JobStatusMapping> {
  const index = new Map<string, JobStatusMapping>();
  for (const mapping of mappings) {
    if (!mapping.active) continue;
    const key = statusKey(mapping.sourceStatusLabel);
    if (!key) continue;
    /*
     * First active row wins. `job_status_map` has a unique index on
     * (organisation, label) so a duplicate should not exist; if one does — a
     * hand-edited database, a half-applied migration — taking the first is
     * stable across renders, which matters more here than which of the two is
     * "right". A flapping colour is a bug report; a consistently wrong one is
     * a mapping somebody can fix.
     */
    if (!index.has(key)) index.set(key, mapping);
  }
  return index;
}

/**
 * The resolved appearance of one job chip.
 *
 * `mapped` is deliberately part of the answer rather than something the caller
 * infers by comparing the colour to the fallback constant. The admin notice
 * counts unmapped statuses, and a count derived from a colour comparison would
 * start lying the day somebody maps a status TO slate on purpose.
 */
export type JobChipAppearance = {
  label: string;
  colourHex: string;
  icon: string | null;
  chipStyle: JobChipStyle;
  mapped: boolean;
  countsAsOpen: boolean;
  countsAsOverdueEligible: boolean;
};

export function jobChipAppearance(
  status: string | null | undefined,
  index: ReadonlyMap<string, JobStatusMapping>,
): JobChipAppearance {
  const raw = (status ?? "").trim();
  const mapping = index.get(statusKey(raw));
  if (mapping) {
    return {
      label: mapping.displayLabel || mapping.sourceStatusLabel,
      colourHex: mapping.colourHex || UNMAPPED_STATUS_COLOUR,
      icon: mapping.icon,
      chipStyle: mapping.chipStyle,
      mapped: true,
      countsAsOpen: mapping.countsAsOpen,
      countsAsOverdueEligible: mapping.countsAsOverdueEligible,
    };
  }
  return {
    /*
     * The RAW label, and "Unknown" only when there is genuinely no text. A job
     * whose status is blank is a different problem from a job whose status is
     * "Awaiting client PO", and printing "Unmapped" over both would hide which
     * one this is from the person who has to fix it.
     */
    label: raw || "No status",
    colourHex: UNMAPPED_STATUS_COLOUR,
    icon: null,
    chipStyle: "outline",
    mapped: false,
    /*
     * An unmapped status counts as OPEN. The choice matters: an unmapped job
     * that counted as closed would drop out of the unscheduled tray and the
     * open-jobs figure, which is the silent disappearance this module exists to
     * prevent. Counting it as open makes it visible and, at worst, slightly
     * overstates the backlog until somebody maps it.
     */
    countsAsOpen: true,
    /*
     * ...but it is NOT eligible for an overdue badge. Overdue is an accusation
     * — it says a commitment was missed — and making one against a status
     * whose meaning the system admits it does not know would put a red mark on
     * a job that might be legitimately parked. Visible, not indicted.
     */
    countsAsOverdueEligible: false,
  };
}

/**
 * Whether the overdue overlay applies, as a separate question from colour.
 *
 * `deadline` is whichever date the caller is measuring against — the SLA
 * deadline where one exists, otherwise the scheduled date, which is the order
 * §4.2 gives. Returns false with no deadline: a job with no date cannot be
 * late, and treating "undated" as "overdue" would paint the entire unscheduled
 * tray red on its first render.
 */
export function jobIsOverdue(input: {
  deadline: string | null | undefined;
  today: string;
  appearance: Pick<JobChipAppearance, "countsAsOpen" | "countsAsOverdueEligible">;
}): boolean {
  const { deadline, today, appearance } = input;
  if (!appearance.countsAsOpen) return false;
  if (!appearance.countsAsOverdueEligible) return false;
  const day = (deadline ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < today;
}

/**
 * The admin notice Module 2 §4.1 requires — "3 job statuses are unmapped."
 *
 * Returns the distinct labels rather than a count, because the useful notice
 * names them: an operator who is told "3 statuses are unmapped" has to go
 * looking, and one who is told which three has already been given the fix.
 * Null when there is nothing to say, so the caller renders nothing rather than
 * an empty bar.
 */
export function unmappedStatusNotice(
  statuses: readonly (string | null | undefined)[],
  index: ReadonlyMap<string, JobStatusMapping>,
): { labels: string[]; message: string } | null {
  const seen = new Set<string>();
  for (const status of statuses) {
    const raw = (status ?? "").trim();
    if (!raw) continue;
    if (index.has(statusKey(raw))) continue;
    seen.add(raw);
  }
  if (seen.size === 0) return null;
  const labels = [...seen].sort((a, b) => a.localeCompare(b));
  const count = labels.length;
  return {
    labels,
    message:
      count === 1
        ? `1 job status is unmapped: ${labels[0]}. It is shown in grey until it is mapped.`
        : `${count} job statuses are unmapped: ${labels.join(", ")}. They are shown in grey until they are mapped.`,
  };
}
