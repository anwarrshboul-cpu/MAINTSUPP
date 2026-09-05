/**
 * THE STATUS MAP AND THE HYBRID VISIT MODEL.
 *
 * Two modules, one theme: neither of them is allowed to lose a record.
 *
 * `job-status-map.ts` must render a status nobody has mapped rather than hiding
 * it, because a hidden job is a job that stopped existing on one screen and not
 * on another. `planned-visit.ts` must never let one visit exist as two records,
 * because Module 2 §2 says the two copies drift within a week and every later
 * bug traces back to that decision.
 *
 * The assertions below are written against the failure, not the feature: what
 * is pinned is that an unmapped status still appears, that a linked visit reads
 * its date from the job even when a stale one sits on the row, and that
 * converting a visit CLEARS the row's own schedule rather than leaving it
 * behind "just in case".
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFile(path.join(root, file), "utf8");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const asModule = (javascript) =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;

/* Both are pure and import nothing, which is what lets them load standalone. */
const statusMap = await import(
  asModule(transpile(await read("app/(app)/portal/job-status-map.ts")))
);
const visits = await import(
  asModule(transpile(await read("app/(app)/portal/planned-visit.ts")))
);

const mapping = (over = {}) => ({
  sourceStatusLabel: "Scheduled",
  displayLabel: "Scheduled",
  colourHex: "#14B8A6",
  icon: "calendar",
  chipStyle: "solid",
  countsAsOpen: true,
  countsAsOverdueEligible: true,
  sortOrder: 0,
  active: true,
  ...over,
});

/* ------------------------------------------------------------ status map */

test("a mapped status takes its colour, label and chip style from the row", () => {
  const index = statusMap.jobStatusIndex([
    mapping(),
    mapping({ sourceStatusLabel: "On hold", colourHex: "#64748B", chipStyle: "hatched", countsAsOverdueEligible: false }),
  ]);

  const scheduled = statusMap.jobChipAppearance("Scheduled", index);
  assert.equal(scheduled.colourHex, "#14B8A6");
  assert.equal(scheduled.chipStyle, "solid");
  assert.equal(scheduled.mapped, true);

  const held = statusMap.jobChipAppearance("On hold", index);
  assert.equal(held.chipStyle, "hatched");
  assert.equal(
    held.countsAsOverdueEligible,
    false,
    "a job parked with the client's agreement must not accrue an overdue badge",
  );
});

test("matching ignores case and collapsed whitespace", () => {
  const index = statusMap.jobStatusIndex([mapping({ sourceStatusLabel: "In progress" })]);
  for (const written of ["In progress", "in progress", "  IN  PROGRESS  ", "In  progress"]) {
    assert.equal(
      statusMap.jobChipAppearance(written, index).mapped,
      true,
      `"${written}" is the same status and must not become a second colour`,
    );
  }
});

test("an unmapped status is drawn grey WITH ITS RAW LABEL, never hidden", () => {
  const index = statusMap.jobStatusIndex([mapping()]);
  const unknown = statusMap.jobChipAppearance("Awaiting client PO", index);

  assert.equal(unknown.mapped, false);
  assert.equal(unknown.colourHex, statusMap.UNMAPPED_STATUS_COLOUR);
  assert.equal(
    unknown.label,
    "Awaiting client PO",
    "the raw label is the prompt to add a mapping; 'Unmapped' would hide which one",
  );
  assert.equal(
    unknown.countsAsOpen,
    true,
    "an unmapped job must stay in the open count and the tray, not vanish from both",
  );
  assert.equal(
    unknown.countsAsOverdueEligible,
    false,
    "visible, not indicted — overdue is an accusation and the system admits it does not know this status",
  );
});

test("a blank status is distinguishable from an unrecognised one", () => {
  const index = statusMap.jobStatusIndex([mapping()]);
  assert.equal(statusMap.jobChipAppearance("", index).label, "No status");
  assert.equal(statusMap.jobChipAppearance(null, index).label, "No status");
  assert.equal(statusMap.jobChipAppearance("Weird", index).label, "Weird");
});

test("an inactive mapping does not apply", () => {
  const index = statusMap.jobStatusIndex([mapping({ active: false })]);
  assert.equal(statusMap.jobChipAppearance("Scheduled", index).mapped, false);
});

test("overdue layers on top of status and never replaces it", () => {
  const index = statusMap.jobStatusIndex([mapping()]);
  const appearance = statusMap.jobChipAppearance("Scheduled", index);

  assert.equal(
    statusMap.jobIsOverdue({ deadline: "2026-09-01", today: "2026-09-05", appearance }),
    true,
  );
  assert.equal(
    appearance.colourHex,
    "#14B8A6",
    "the status colour is untouched by the overlay — two facts, not one",
  );
  assert.equal(
    statusMap.jobIsOverdue({ deadline: "2026-09-05", today: "2026-09-05", appearance }),
    false,
    "due today is not yet overdue",
  );
});

test("a job with no deadline is never overdue", () => {
  const index = statusMap.jobStatusIndex([mapping()]);
  const appearance = statusMap.jobChipAppearance("Scheduled", index);
  for (const deadline of [null, undefined, "", "not-a-date"]) {
    assert.equal(
      statusMap.jobIsOverdue({ deadline, today: "2026-09-05", appearance }),
      false,
      "otherwise the whole unscheduled tray paints red on first render",
    );
  }
});

test("a closed status is never overdue however old", () => {
  const index = statusMap.jobStatusIndex([
    mapping({ sourceStatusLabel: "Completed", countsAsOpen: false, countsAsOverdueEligible: false }),
  ]);
  const appearance = statusMap.jobChipAppearance("Completed", index);
  assert.equal(
    statusMap.jobIsOverdue({ deadline: "2020-01-01", today: "2026-09-05", appearance }),
    false,
  );
});

test("the admin notice names the unmapped statuses rather than counting them", () => {
  const index = statusMap.jobStatusIndex([mapping()]);
  const notice = statusMap.unmappedStatusNotice(
    ["Scheduled", "Awaiting client PO", "Parked", "Awaiting client PO", "", null],
    index,
  );

  assert.ok(notice);
  assert.deepEqual(notice.labels, ["Awaiting client PO", "Parked"], "distinct and sorted");
  assert.match(notice.message, /2 job statuses are unmapped/);
  assert.match(notice.message, /Awaiting client PO/, "naming them is the fix; a count is a search");
});

test("no notice when everything maps", () => {
  const index = statusMap.jobStatusIndex([mapping()]);
  assert.equal(statusMap.unmappedStatusNotice(["Scheduled", "", null], index), null);
});

/* --------------------------------------------------- the hybrid visit model */

const standalone = {
  id: "cal_1",
  requestId: null,
  startsOn: "2026-09-10",
  startsAtTime: "09:00",
  title: "Roof survey",
  siteId: "site_1",
  visitType: "Survey",
};

const linked = {
  id: "cal_2",
  requestId: "req_9",
  startsOn: null,
  title: "Boiler repair attendance",
};

test("mode is decided by the link and nothing else", () => {
  assert.equal(visits.plannedVisitMode(standalone), "standalone");
  assert.equal(visits.plannedVisitMode(linked), "job-backed");
});

test("a schedule edit on a linked visit is written to the JOB, not the row", () => {
  assert.deepEqual(visits.visitScheduleTarget(linked), {
    kind: "job",
    requestId: "req_9",
    field: "scheduled_date",
  });
  assert.deepEqual(visits.visitScheduleTarget(standalone), {
    kind: "calendar-event",
    eventId: "cal_1",
    field: "starts_on",
  });
});

test("a linked visit reads its date from the job EVEN IF the row still holds one", () => {
  /*
   * The stale-copy case, and the one that matters. A row linked to a job after
   * it was created still carries the date it was booked with; preferring it
   * would resurrect the old date the first time somebody reschedules the job.
   */
  const stale = { ...linked, startsOn: "2026-01-01" };
  const job = { id: "req_9", scheduledDate: "2026-09-20", scheduledTime: "14:00" };

  assert.equal(visits.plannedVisitDay(stale, job), "2026-09-20", "the job wins, always");
  assert.equal(visits.plannedVisitTime(stale, job), "14:00");

  const issue = visits.plannedVisitIntegrityIssue(stale);
  assert.ok(issue, "and the leftover is reported so it can be cleared");
  assert.match(issue, /still stores its own start date/);
  assert.match(issue, /2026-01-01/);
});

test("a clean linked row and a standalone row raise no integrity issue", () => {
  assert.equal(visits.plannedVisitIntegrityIssue(linked), null);
  assert.equal(visits.plannedVisitIntegrityIssue(standalone), null);
});

test("a standalone visit keeps its own date", () => {
  assert.equal(visits.plannedVisitDay(standalone, null), "2026-09-10");
  assert.equal(visits.plannedVisitTime(standalone, null), "09:00");
});

test("Create job from this visit is offered once, and never on a linked visit", () => {
  assert.equal(visits.canCreateJobFromVisit(standalone), true);
  assert.equal(visits.canCreateJobFromVisit(linked), false);
  assert.equal(visits.createJobUnavailableReason(standalone), null);
  assert.match(
    visits.createJobUnavailableReason(linked),
    /already linked to job req_9/,
    "a disabled control must say why — offering it twice is how the second job appears",
  );
});

test("the created job carries the visit's fields and invents no SLA deadline", () => {
  const draft = visits.jobDraftFromVisit(standalone);
  assert.equal(draft.title, "Roof survey");
  assert.equal(draft.siteId, "site_1");
  assert.equal(draft.scheduledDate, "2026-09-10");
  assert.equal(draft.status, "Scheduled", "it is already booked; do not send it back to the tray");
  assert.equal(
    draft.dueAt,
    null,
    "a fabricated deadline would enter the client's on-time percentage — a number changed by an invention",
  );
  assert.equal(draft.sourceVisitId, "cal_1");
});

test("a dateless visit becomes a New job so it lands in the tray", () => {
  const draft = visits.jobDraftFromVisit({ ...standalone, startsOn: null });
  assert.equal(draft.status, "New");
  assert.equal(draft.scheduledDate, null);
});

test("an untitled visit still becomes a findable job", () => {
  const draft = visits.jobDraftFromVisit({ ...standalone, title: "" });
  assert.ok(draft.title.length > 0, "a blank title is an unsearchable row on the board");
  assert.match(draft.title, /Survey/);
});

test("converting CLEARS the row's own schedule as well as adding the link", () => {
  /*
   * The whole invariant in one assertion. Adding the link without clearing the
   * date produces exactly the two-answers row the model exists to forbid, and
   * "leave it just in case" is the tempting version of the bug.
   */
  const patch = visits.visitLinkPatchAfterJobCreated("req_42");
  assert.equal(patch.requestId, "req_42");
  assert.equal(patch.startsOn, null);
  assert.equal(patch.startsAtTime, null);

  const converted = { ...standalone, ...patch };
  assert.equal(visits.plannedVisitIntegrityIssue(converted), null);
  assert.equal(visits.visitScheduleTarget(converted).kind, "job");
});
