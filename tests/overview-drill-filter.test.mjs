/**
 * The drill-through, and the two duplications it makes.
 *
 * Every chart on the Overview navigates to the Jobs list carrying its own
 * filter state. Until this release the board read none of it — `live-board.tsx`
 * touches `searchParams` exactly once, to set `?item=` — so a meter tile landed
 * on the unfiltered board and the reader was left to find 17 rows among 981.
 *
 * `board-drill-filter.ts` applies the filter to the rows on their way INTO the
 * board, which is what lets the board's own meters, groups, views and search
 * stay consistent with what is on screen. Doing it there rather than inside the
 * board is forced: `live-board.tsx` is held under 5,600 lines by
 * `tests/workstream-seven-official-document-ui.test.mjs` and sits at 5,593.
 *
 * TWO RULES ARE DUPLICATED FROM THE SERVER, and both are pinned here against
 * the server's own definition rather than against a remembered copy:
 *
 *   · planned-versus-reactive — `plannedCondition` in `dashboard-filters.ts` is
 *     a drizzle `sql` fragment and cannot be evaluated against a plain object;
 *   · the period window — `resolveWindow` in the same module is server-shaped.
 *
 * A duplicate nobody checks is how a filtered board comes to disagree with the
 * tile that filtered it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = async (file) => (await readFile(path.join(root, file), "utf8")).replace(/\r\n/g, "\n");

const { readDrillFilter, DRILL_KEYS } = await import(
  "../app/(app)/portal/board-drill-filter.ts"
);

const NOW = new Date("2026-09-10T12:00:00.000Z");

const job = (over = {}) => ({
  id: over.id ?? "job-1",
  reference: "MN-1",
  title: "A job",
  siteId: "store-aldgate",
  category: "Lights",
  engineer: "Handyman",
  tier: 2,
  priority: "Medium",
  stage: "Incoming",
  status: "Pending Approval",
  contractor: null,
  contractorId: null,
  requestedAt: "2026-09-01T09:00:00.000Z",
  completedAt: null,
  ...over,
});

const q = (search) => readDrillFilter(new URLSearchParams(search), NOW);

test("an empty query string filters nothing at all", () => {
  const filter = q("");
  assert.equal(filter.empty, true);
  assert.equal(filter.chips.length, 0);
  assert.equal(filter.matches(job()), true);
  /* A parameter this filter does not understand must not accidentally narrow
     the board — the Overview sends `split` and `measure` on every drill. */
  assert.equal(q("split=priority").empty, true);
});

test("a meter tile sends one chip named after the meter, not five status names", () => {
  /*
   * §2.3: "showing one chip named after the meter, not five status names". The
   * meter key is what the chip is NAMED after; the pipe-joined status list is
   * what selects the rows, so this screen does not need to know the meter model.
   */
  const filter = q(
    "meter=waiting_approval&status=Pending Approval|Quote requested|Quote approved",
  );
  assert.deepEqual(
    filter.chips.map((chip) => `${chip.label}=${chip.value}`),
    ["Meter=waiting approval"],
    "one chip, and it names the meter",
  );
  assert.equal(filter.matches(job({ status: "Pending Approval" })), true);
  assert.equal(filter.matches(job({ status: "Quote approved" })), true);
  assert.equal(filter.matches(job({ status: "Job Completed" })), false);
});

test("statuses are matched on a normalised copy, so a spreadsheet round trip still lands", () => {
  const filter = q("status=Job In Progress");
  assert.equal(filter.matches(job({ status: "job in  progress" })), true);
  assert.equal(filter.matches(job({ status: "  Job In Progress  " })), true);
  assert.equal(filter.matches(job({ status: "In progress" })), false, "a different label");
});

test("the unassigned sentinel catches a blank site AND the dangling placeholder", () => {
  /*
   * 80 of the development board's 111 live jobs point at `site-unassigned`, an
   * id with no row in `sites`. `unassignedSiteCondition` treats a dangling
   * reference as unassigned; so must this, or the drill-through from the data
   * quality row would come back empty on the estate that has the problem.
   */
  const filter = q("site=__unassigned__");
  assert.equal(filter.matches(job({ siteId: "" })), true);
  assert.equal(filter.matches(job({ siteId: "site-unassigned" })), true);
  assert.equal(filter.matches(job({ siteId: "store-aldgate" })), false);
});

test("priority is matched on the normalised key, including the importer's artefact", () => {
  const urgent = q("priority=urgent");
  assert.equal(urgent.matches(job({ priority: "Urgent" })), true);
  assert.equal(urgent.matches(job({ priority: "P1" })), true);
  assert.equal(urgent.matches(job({ priority: "Medium" })), false);

  const missing = q("priority=not_recorded");
  assert.equal(missing.matches(job({ priority: "[object Object]" })), true);
  assert.equal(missing.matches(job({ priority: "" })), true);
  assert.equal(missing.matches(job({ priority: "Low" })), false);
});

test("a contractor filter accepts both shapes the Overview keys by", () => {
  /* `loadCost` keys a contractor bucket as an id, or `name:<lowercased>` when
     the job carries typed text only. Both have to select here. */
  const byId = q("contractor=contractor-uk-safety");
  assert.equal(byId.matches(job({ contractorId: "contractor-uk-safety" })), true);
  assert.equal(byId.matches(job({ contractor: "UK Safety" })), false);

  const byName = q("contractor=name:uk safety");
  assert.equal(byName.matches(job({ contractor: "UK Safety" })), true);
  assert.equal(byName.matches(job({ contractor: "Saed Electrical" })), false);
});

test("nature is the same inference the server makes", async () => {
  /*
   * The rule, from `plannedCondition`: a category naming compliance, or tier 4
   * and above. Pinned against the server's own source so the two cannot drift —
   * a board that disagreed with the chart segment that filtered it is exactly
   * the class of defect this whole page was rebuilt to remove.
   */
  const filters = await read("app/lib/dashboard-filters.ts");
  assert.match(
    filters,
    /export const plannedCondition = sql`\(lower\(coalesce\(\$\{maintenanceRequests\.category\}, ''\)\) like '%compliance%' or \$\{maintenanceRequests\.tier\} >= 4\)`/,
    "the server rule is still category-like-compliance OR tier >= 4",
  );

  const planned = q("nature=planned");
  assert.equal(planned.matches(job({ category: "Fire compliance" })), true);
  assert.equal(planned.matches(job({ category: "Lights", tier: 4 })), true);
  assert.equal(planned.matches(job({ category: "Lights", tier: 2 })), false);

  const reactive = q("nature=reactive");
  assert.equal(reactive.matches(job({ category: "Lights", tier: 2 })), true);
  assert.equal(reactive.matches(job({ category: "Compliance check" })), false);
});

test("the stage axis filters, and `open` is not a synonym for in progress", () => {
  /*
   * `family` sat in DRILL_KEYS — so "Clear" stripped it — while nothing read
   * it. Three call sites send it meaning "open", and unread, each drilled to a
   * list that included completed jobs: the list was always longer than the
   * figure that opened it.
   *
   * The model is completed / in_progress / attention, so "open" must be BOTH
   * of the last two. Filtering `open` to `in_progress` alone would under-report
   * the figure instead of over-reporting it — a different wrong answer, not a
   * fix.
   */
  const done = job({ status: "Completed", completedAt: "2026-09-05" });
  const doing = job({ status: "In Progress" });
  const stuck = job({ status: "On Hold" });

  const open = q("family=open");
  assert.equal(open.matches(done), false, "a completed job is not open");
  assert.equal(open.matches(doing), true, "in progress is open");
  assert.equal(open.matches(stuck), true, "needing attention is open too");

  assert.equal(q("family=completed").matches(done), true);
  assert.equal(q("family=completed").matches(doing), false);
  assert.equal(q("family=in_progress").matches(stuck), false, "attention is its own family");

  /* It draws a chip, so the reader can see the list was narrowed and undo it. */
  const chip = open.chips.find((entry) => entry.key === "family");
  assert.ok(chip, "the stage axis names itself in the chip row");
  assert.equal(chip.value, "open");
  assert.ok(DRILL_KEYS.includes("family"), "and Clear still strips it");
});
test("overdue is a dimension, and a bare due date is not late on the day itself", () => {
  /*
   * The Overview's Overdue tile and its SLA speedometer both mean "open work
   * past its date", and this filter had no due-date dimension — so the only
   * honest thing they could send was `family=open`, a superset. On the estate
   * they were built against that is a tile reading 73 opening a board of 98.
   *
   * The day-versus-instant rule is the subtle half, and it is `overdueOpenSql`'s
   * own: `due_at` holds a bare `YYYY-MM-DD` for work booked to a day and a full
   * timestamp for work booked to a time. Treating a bare day as UTC midnight
   * marks everything due today as already late for every reader west of
   * Greenwich, which is why the two are compared differently.
   */
  const overdue = q("overdue=1");

  /* NOW is 2026-09-10T12:00Z. */
  assert.equal(overdue.matches(job({ dueAt: "2026-09-09" })), true, "yesterday is late");
  assert.equal(overdue.matches(job({ dueAt: "2026-09-10" })), false, "today is not late yet");
  assert.equal(overdue.matches(job({ dueAt: "2026-09-11" })), false, "tomorrow is not late");

  /* A timestamp is compared as an instant, so earlier today IS late. */
  assert.equal(
    overdue.matches(job({ dueAt: "2026-09-10T09:00:00.000Z" })),
    true,
    "an hour that has passed is late even though the day has not",
  );
  assert.equal(overdue.matches(job({ dueAt: "2026-09-10T18:00:00.000Z" })), false);

  /* A job nobody gave a date cannot be late, and a finished one never is. */
  assert.equal(overdue.matches(job({ dueAt: null })), false, "no date, no judgement");
  assert.equal(
    overdue.matches(job({ dueAt: "2026-01-01", status: "Job Completed", completedAt: "2026-01-02" })),
    false,
    "a closed job is not overdue, however late it was",
  );

  /* It draws a chip and Clear strips it, like every other dimension. */
  assert.ok(overdue.chips.some((chip) => chip.key === "overdue"));
  assert.ok(DRILL_KEYS.includes("overdue"), "Clear strips it rather than leaving it in the bar");
});

test("the drilled list is the same population the figure was counted over", () => {
  /*
   * Two ways the drill used to be WIDER than the tile that opened it. Measured
   * on one estate at `period=90`: the Pulse "urgent open" figure read 15 and
   * the board it opened showed 20.
   *
   * 1. ARCHIVED AND SUB-ITEM ROWS. `liveWorkOrderCondition` drops binned,
   *    archived and sub-item rows before the aggregate counts anything; this
   *    filter dropped none of them. Five of the 23 urgent non-completed jobs in
   *    that window were archived.
   *
   * 2. TWO DIFFERENT DEFINITIONS OF CLOSED. `closedJobSql` is
   *    `stage = 'Completed' OR status IN completedStatuses`, while `family`
   *    reads `STATUS_FAMILY`, whose fallback for an unknown label is
   *    `in_progress`. So a job whose STAGE says completed but whose status
   *    label nobody has mapped was closed to the aggregate and open to the
   *    drill.
   */
  const archived = job({ status: "In Progress", archived: true });
  const subItem = job({ status: "In Progress", parentId: "MN-1" });
  const live = job({ status: "In Progress" });

  const open = q("family=open");
  assert.equal(open.matches(live), true);
  assert.equal(open.matches(archived), false, "an archived job is not in the cohort");
  assert.equal(open.matches(subItem), false, "and neither is a sub-item");

  /* The exclusion is not specific to the stage axis: any drill must open the
     population its figure was counted over. */
  const bySite = q("site=store-aldgate");
  assert.equal(bySite.matches(live), true);
  assert.equal(bySite.matches(archived), false, "every drill drops archived work");

  /* Stage beats an unmapped label, exactly as `closedJobSql` has it. */
  const stageClosed = job({ status: "Some Label Nobody Mapped", stage: "Completed" });
  assert.equal(
    open.matches(stageClosed),
    false,
    "a stage-completed job is closed however its status label is spelled",
  );
  assert.equal(
    q("family=completed").matches(job({ status: "Job Completed" })),
    true,
    "and the named families still read the family model",
  );
});

test("the period window matches the server's, end exclusive and one day of grace", async () => {
  /*
   * `resolveWindow`'s end is TOMORROW and exclusive, because a job raised an
   * hour ago must be inside "the last 7 days" and a same-day exclusive bound
   * would drop it. Pinned against the sentence in the server module that says
   * so, and then exercised on both edges.
   */
  const filters = await read("app/lib/dashboard-filters.ts");
  assert.match(
    filters,
    /EXCLUSIVE last day — always the day after the last day in the window/,
    "the server still uses an exclusive end",
  );

  /*
   * THIS ASSERTION USED TO ENCODE AN OFF-BY-ONE, and it is worth saying why,
   * because it hid a real defect for a whole release cycle.
   *
   * The server computes the start as `shiftDay(tomorrow, -days)` — CALENDAR
   * arithmetic away from an exclusive end — so a 7-day window on 2026-09-10 is
   * 09-04 … 09-11, which is seven days. The drill originally computed it as
   * `now - days * 86_400_000`, i.e. seven days back from the CURRENT INSTANT,
   * landing on 09-03 and quietly making the drilled list eight days wide. The
   * test was written from the drill rather than from the server, so it pinned
   * the bug in place and reported it as agreement.
   *
   * Now pinned to the server's own expression, so the two cannot drift again:
   * a change to `resolveWindow` that this module does not follow fails here.
   */
  assert.match(
    filters,
    /return bounded\(shiftDay\(tomorrow, -days\), tomorrow, `\$\{days\} days`\);/,
    "the server still counts back from the exclusive end, by calendar days",
  );

  const week = q("period=7");
  assert.equal(week.matches(job({ requestedAt: "2026-09-10T23:00:00.000Z" })), true, "today");
  assert.equal(week.matches(job({ requestedAt: "2026-09-04T00:00:00.000Z" })), true, "the first day");
  assert.equal(
    week.matches(job({ requestedAt: "2026-09-03T23:59:59.000Z" })),
    false,
    "the day before — seven days means seven, not eight",
  );
  assert.equal(week.matches(job({ requestedAt: "2026-09-11T09:00:00.000Z" })), false, "tomorrow is out");

  /*
   * All time has no start, but it does have an end: a job dated in the future
   * is not part of it, on either side of the drill. `resolveWindow` returns
   * `start: null, endExclusive: tomorrow` and this now does the same.
   */
  assert.equal(q("period=all&site=store-aldgate").matches(job({ requestedAt: "2019-01-01" })), true);
  assert.equal(
    q("period=all&site=store-aldgate").matches(job({ requestedAt: "2027-01-01" })),
    false,
    "a future-dated job is outside all time too",
  );

  /*
   * THE THREE NAMED PRESETS, which `resolveDays` used to fall through on:
   * `month`, `last-month` and `ytd` all returned no window at all, so a drill
   * from any of them showed the whole history under a chip claiming a month.
   */
  const month = q("period=month");
  assert.equal(month.matches(job({ requestedAt: "2026-09-01T00:00:00.000Z" })), true, "the 1st");
  assert.equal(month.matches(job({ requestedAt: "2026-08-31T23:59:59.000Z" })), false, "August is out");

  const lastMonth = q("period=last-month");
  assert.equal(lastMonth.matches(job({ requestedAt: "2026-08-01" })), true, "the 1st of August");
  assert.equal(lastMonth.matches(job({ requestedAt: "2026-08-31" })), true, "the 31st of August");
  assert.equal(lastMonth.matches(job({ requestedAt: "2026-09-01" })), false, "September is out");

  const ytd = q("period=ytd");
  assert.equal(ytd.matches(job({ requestedAt: "2026-01-01" })), true, "new year's day");
  assert.equal(ytd.matches(job({ requestedAt: "2025-12-31" })), false, "last year is out");
});

test("the completed axis cuts on the completion date and excludes the blanks", () => {
  /*
   * §1.1: "Never impute a date." A job with no completion date is not in a
   * cohort of jobs completed in a period, and the board must agree with the
   * tile that sent the reader there.
   */
  const filter = q("period=30&measure=completed");
  assert.equal(
    filter.matches(job({ requestedAt: "2026-09-01", completedAt: "2026-09-05" })),
    true,
  );
  assert.equal(
    filter.matches(job({ requestedAt: "2026-09-01", completedAt: null })),
    false,
    "no completion date means it is not in a completed cohort",
  );
  assert.equal(
    filter.matches(job({ requestedAt: "2026-09-01", completedAt: "2026-01-05" })),
    false,
    "completed before the window",
  );
  assert.match(filter.chips.map((chip) => chip.label).join(" "), /Completed/);
});

test("dimensions are ANDed and values within one dimension are ORed", () => {
  const filter = q("site=store-aldgate&site=store-bristol&priority=urgent");
  assert.equal(filter.matches(job({ siteId: "store-aldgate", priority: "Urgent" })), true);
  assert.equal(filter.matches(job({ siteId: "store-bristol", priority: "Urgent" })), true);
  assert.equal(filter.matches(job({ siteId: "store-aldgate", priority: "Low" })), false);
  assert.equal(filter.matches(job({ siteId: "store-solihull", priority: "Urgent" })), false);
});

test("Show every job strips exactly what a drill-through put there", () => {
  /* Not `params.clear()`: another screen's deep-link parameter must survive a
     control that was never about it. */
  assert.ok(DRILL_KEYS.includes("meter"));
  assert.ok(DRILL_KEYS.includes("measure"));
  assert.ok(DRILL_KEYS.includes("period"));
  assert.ok(!DRILL_KEYS.includes("item"), "the deep-link to one row must survive");
  assert.ok(!DRILL_KEYS.includes("view"), "the board's own tab must survive");
});

test("the shell hands the board the filtered rows, and says that it has", async () => {
  const shell = await read("app/(app)/portal/portal-app.tsx");
  assert.match(shell, /const boardRequests = useMemo\(/);
  assert.match(shell, /requests=\{boardRequests\}/, "the board receives the filtered list");
  assert.match(shell, /className="board-drill"/, "and the reader is told why it is short");
  /*
   * `pushState` fires no event, so a drill-through arriving that way would be
   * invisible to the shell's URL subscriber and the board would keep the
   * unfiltered list while the address bar said otherwise.
   */
  assert.match(shell, /window\.dispatchEvent\(new Event\(URL_CHANGED\)\)/);
});
