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

  const week = q("period=7");
  assert.equal(week.matches(job({ requestedAt: "2026-09-10T23:00:00.000Z" })), true, "today");
  assert.equal(week.matches(job({ requestedAt: "2026-09-03T00:00:00.000Z" })), true, "the first day");
  assert.equal(week.matches(job({ requestedAt: "2026-09-02T23:59:59.000Z" })), false, "the day before");
  assert.equal(week.matches(job({ requestedAt: "2026-09-11T09:00:00.000Z" })), false, "tomorrow is out");

  /* All time is not a window and must not narrow anything by date. */
  assert.equal(q("period=all&site=store-aldgate").matches(job({ requestedAt: "2019-01-01" })), true);
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
