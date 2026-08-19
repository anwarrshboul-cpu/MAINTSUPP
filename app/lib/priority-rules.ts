/**
 * What a priority MEANS — the SLA clock and the tier — keyed by the priority's
 * stable VALUE, never by its display label.
 *
 * WHY THIS MODULE EXISTS. Both submission routes used to write
 *
 *     priority === "Urgent" ? 4 : priority === "Medium" ? 72 : 120
 *
 * against whatever string arrived from the form. That was safe only while
 * labels could not be edited. The option registry (`option_values`) separates
 * the two on purpose — `value` is the stable key that stored jobs carry and
 * that renaming never touches; `label` is the display text an admin may change
 * freely — so the moment labels became editable, business logic hung off a
 * label would silently change meaning with a rename: call "Urgent" "P1" and
 * every new urgent job would quietly get the 120-hour default clock.
 *
 * The submit routes therefore canonicalise the submitted answer to the
 * registry VALUE first (accepting either the value or the current label, so a
 * form opened before a rename still resolves), store the value, and read the
 * SLA from here by that value. Renaming a label changes what people see and
 * nothing else — which is what a rename is.
 *
 * The keys below are the stable priority values provisioned into every
 * workspace ("Urgent", "Medium", "Low" — monday's own priority set, captured
 * in db/monday-board-spec.ts). A value with no entry gets the default rule,
 * so an admin adding a fourth priority gets a working 120-hour clock rather
 * than a crash, and can ask for a bespoke rule as a change to this file.
 */

export type PriorityRule = {
  /** Hours until the job is due, from the moment it is raised. */
  dueHours: number;
  /** The service tier the board records: 1 is the most severe. */
  tier: number;
};

const PRIORITY_RULES: Record<string, PriorityRule> = {
  Urgent: { dueHours: 4, tier: 1 },
  Medium: { dueHours: 72, tier: 2 },
  Low: { dueHours: 120, tier: 3 },
};

/** Anything unrecognised is treated as the least severe, never refused. */
export const DEFAULT_PRIORITY_RULE: PriorityRule = { dueHours: 120, tier: 3 };

export function priorityRule(priorityValue: string): PriorityRule {
  return PRIORITY_RULES[priorityValue] ?? DEFAULT_PRIORITY_RULE;
}

/**
 * Resolves a submitted answer to the registry's stable value.
 *
 * The public form shows LABELS, so the answer arriving is normally the current
 * label; a form left open across a rename posts the old label, which for
 * seeded rows equals the value. Both resolve. Anything that matches nothing —
 * a hostile POST, a label deleted mid-flight — falls back rather than storing
 * an arbitrary string on a column every dashboard groups by.
 */
export function canonicalOptionValue(
  options: ReadonlyArray<{
    value: string;
    label: string;
    active: boolean;
    isDefault?: boolean;
  }>,
  submitted: string,
  fallback: string,
): string {
  if (submitted) {
    const byValue = options.find((option) => option.value === submitted);
    if (byValue) return byValue.value;
    const byLabel = options.find((option) => option.label === submitted && option.active);
    if (byLabel) return byLabel.value;
  }
  const preset = options.find((option) => option.isDefault === true && option.active);
  return preset?.value ?? fallback;
}
