/**
 * THE EXECUTIVE SUMMARY — sentences, each one derivable from a number.
 *
 * The rule the contract states and this file enforces: every sentence must be
 * derivable from a figure in the payload, and a sentence with no supporting
 * figure is not written at all. There is no canned paragraph anywhere in this
 * module, no adjective that is not a comparison the numbers support, and no
 * explanation of WHY anything moved — the data records what happened, not why,
 * and a report that invents a cause is worse than one that omits it.
 *
 * ── WHAT AN EMPTY PERIOD GETS ──────────────────────────────────────────────
 *
 * A short, honest summary saying nothing was recorded. Not "operations were
 * stable", not "a quiet month", not a paragraph of confident nothing. An empty
 * month at a portfolio of thirty sites is far more likely to mean the data did
 * not arrive than that no taps leaked, and the summary should read like a
 * question rather than a reassurance.
 *
 * ── WHY THE FIGURES ARE FORMATTED HERE AND NOWHERE ELSE ────────────────────
 *
 * These strings are prose, so they carry pounds and percentages — the one place
 * in the payload that does. Everything else is integer pence and whole numbers,
 * precisely so an exporter cannot be handed "£1,690.00" and asked to sum it.
 * A sentence is not summed, which is what makes it safe to format one.
 */

import type { ExecutiveCounts, ExecutiveSummary, Pence, ReportPeriod, SpendAnalysis } from "./contract";

/** Pounds, with thousands separators. Prose only — never a value to add up. */
function pounds(value: Pence, currency: string): string {
  const symbol = currency === "GBP" ? "£" : `${currency} `;
  const negative = value < 0;
  const whole = Math.floor(Math.abs(value) / 100);
  const part = String(Math.abs(value) % 100).padStart(2, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${symbol}${grouped}.${part}`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export interface NarrativeInput {
  period: ReportPeriod;
  previousPeriod: ReportPeriod | null;
  counts: ExecutiveCounts;
  spend: SpendAnalysis;
  currency: string;
  /** How many sites the invoice actually charges, for the first sentence. */
  billableSites: number;
  /** Blocking data-quality findings, which change how much the rest is worth. */
  blockingFindings: number;
  warningFindings: number;
}

export function buildNarrative(input: NarrativeInput): string[] {
  const { counts, spend, period } = input;
  const sentences: string[] = [];
  const money = (value: Pence) => pounds(value, input.currency);

  /* 1. What the period is and what it covers. Always true, always first. */
  sentences.push(
    `This report covers ${period.label} (${period.start} to ${period.end}) across ${counts.activeSites} active ${plural(counts.activeSites, "site", "sites")}, of which ${input.billableSites} ${plural(input.billableSites, "is", "are")} charged the service fee.`,
  );

  /* 2. The empty period. Short, and honest about what it does and does not
     mean. Nothing below this line has anything to describe, so we stop. */
  if (counts.totalJobs === 0) {
    sentences.push(
      "No maintenance jobs were recorded against these sites in this period.",
    );
    sentences.push(
      "That is a statement about what is in the system, not about what happened on site — a period with no recorded jobs is worth checking against the sites themselves before it is read as a quiet month.",
    );
    if (spend.serviceFeePence > 0) {
      sentences.push(
        `The service fee of ${money(spend.serviceFeePence)} is charged for the period regardless of job volume.`,
      );
    }
    return sentences;
  }

  /* 3. Volume, and the split. */
  sentences.push(
    `${counts.totalJobs} ${plural(counts.totalJobs, "job was", "jobs were")} recorded: ${counts.completedJobs} completed and ${counts.openJobs} still open${counts.cancelledJobs > 0 ? `, with ${counts.cancelledJobs} cancelled` : ""}.`,
  );

  if (counts.sitesWithJobs > 0) {
    sentences.push(
      `The work was spread across ${counts.sitesWithJobs} of the ${counts.activeSites} active ${plural(counts.activeSites, "site", "sites")}.`,
    );
  }

  /* 4. Volume against the comparable period — only when there is one. */
  if (input.previousPeriod && counts.previousTotalJobs !== null) {
    const change = counts.totalJobs - counts.previousTotalJobs;
    if (counts.previousTotalJobs === 0) {
      sentences.push(
        `No jobs were recorded in ${input.previousPeriod.label}, so there is no volume comparison to draw.`,
      );
    } else if (change === 0) {
      sentences.push(
        `That is the same number of jobs as ${input.previousPeriod.label}.`,
      );
    } else {
      const percent = Math.round((Math.abs(change) / counts.previousTotalJobs) * 100);
      sentences.push(
        `That is ${Math.abs(change)} ${plural(Math.abs(change), "job", "jobs")} ${change > 0 ? "more" : "fewer"} than ${input.previousPeriod.label} (${counts.previousTotalJobs}), a change of ${percent}%.`,
      );
    }
  }

  /* 5. SLA. Null is said out loud; it is not printed as a zero. */
  if (counts.slaPercent === null) {
    sentences.push(
      counts.measurableJobs === 0 && counts.completedJobs > 0
        ? "No job in this period could be measured against an SLA target, so no performance figure is stated. The SLA outcomes table records the reason for each."
        : "No SLA performance figure is stated for this period, because no job in it was measurable against a configured target.",
    );
  } else {
    sentences.push(
      `Of the ${counts.measurableJobs} ${plural(counts.measurableJobs, "job", "jobs")} measurable against an SLA target, ${counts.withinSla} met the target and ${counts.outsideSla} did not — ${counts.slaPercent}% within SLA.`,
    );
    if (counts.jobsWithApprovedHolds > 0) {
      sentences.push(
        `${counts.jobsWithApprovedHolds} of those ${plural(counts.jobsWithApprovedHolds, "job carried an approved hold", "jobs carried approved holds")}, whose days are excluded from the measured duration.`,
      );
    }
  }

  /* 6. What is still open and late. */
  if (counts.openPastTarget > 0) {
    sentences.push(
      `${counts.openPastTarget} open ${plural(counts.openPastTarget, "job is", "jobs are")} past target.`,
    );
  } else if (counts.openJobs > 0) {
    sentences.push("No open job is past its target.");
  }
  if (counts.criticalOpen > 0) {
    sentences.push(
      `${counts.criticalOpen} open ${plural(counts.criticalOpen, "job is", "jobs are")} urgent or Tier 1.`,
    );
  }

  /* 7. Money — five figures, never added together. The sentence says so. */
  sentences.push(
    `Completed maintenance in the period cost ${money(spend.completedMaintenancePence)}, with ${money(spend.openCommittedPence)} committed on jobs still open.`,
  );
  if (spend.projectPence > 0 || spend.routinePence > 0) {
    sentences.push(
      `Of that, ${money(spend.projectPence)} relates to special projects and ${money(spend.routinePence)} to routine planned work.`,
    );
  }
  sentences.push(
    `The service fee of ${money(spend.serviceFeePence)} is charged separately and is not part of the maintenance figures above.`,
  );

  if (spend.previousCompletedMaintenancePence !== null && input.previousPeriod) {
    const change = spend.completedMaintenancePence - spend.previousCompletedMaintenancePence;
    if (change === 0) {
      sentences.push(
        `Completed maintenance spend is unchanged from ${input.previousPeriod.label}.`,
      );
    } else {
      sentences.push(
        `Completed maintenance spend is ${money(Math.abs(change))} ${change > 0 ? "higher" : "lower"} than ${input.previousPeriod.label} (${money(spend.previousCompletedMaintenancePence)}).`,
      );
    }
  }

  /* 8. How much the figures above can be relied on. Last, because it qualifies
     everything before it. */
  if (input.blockingFindings > 0) {
    sentences.push(
      `${input.blockingFindings} data ${plural(input.blockingFindings, "issue", "issues")} must be resolved before this document can be finalised; they are listed in the data quality section.`,
    );
  } else if (input.warningFindings > 0) {
    sentences.push(
      `${input.warningFindings} data ${plural(input.warningFindings, "issue was", "issues were")} noted and ${plural(input.warningFindings, "does", "do")} not prevent finalisation; ${plural(input.warningFindings, "it is", "they are")} listed in the data quality section.`,
    );
  }

  return sentences;
}

export function buildExecutiveSummary(
  counts: ExecutiveCounts,
  narrativeInput: Omit<NarrativeInput, "counts">,
): ExecutiveSummary {
  return { counts, narrative: buildNarrative({ ...narrativeInput, counts }) };
}
