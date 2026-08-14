import type { Metadata } from "next";
import { getViewerState, serverFetch } from "../../../../lib/session";
import type { JobRow, JobsPage, Site, StageSeed } from "../../../../lib/portal";
import { BOARD_PAGE_SIZE, canSeeMoney } from "../../../../lib/portal";
import { QUEUE_STAGES, type JobStage } from "../../../../lib/job-stages";
import QueueBoard from "./queue-board";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Board" };

/** The tab the board opens on — the first queue, as the monday board reads. */
const DEFAULT_QUEUE = "Incoming Requests" as const;

type Summary = { byStage: Record<string, number> };

export default async function DashboardPage() {
  const state = await getViewerState();
  // The shell layout has already redirected anyone who is not active; this is
  // only here so the type narrows and the page never renders actor-less.
  if (state.kind !== "ok") return null;

  const stages = QUEUE_STAGES[DEFAULT_QUEUE];

  /*
   * One request per stage, in parallel, alongside the counts and the site list.
   *
   * The stage split is not a performance trick — it is what makes each column
   * of the board page independently, so "show more" in Scheduling does not drag
   * a hundred completed jobs along with it.
   */
  const [summary, siteList, ...pages] = await Promise.all([
    serverFetch<Summary>("/jobs/summary"),
    serverFetch<{ sites: Site[] }>("/jobs/meta/sites"),
    ...stages.map((stage) =>
      serverFetch<JobsPage>(
        `/jobs?${new URLSearchParams({ stage, limit: String(BOARD_PAGE_SIZE), offset: "0" })}`,
      ),
    ),
  ]);

  const seed: Partial<Record<JobStage, StageSeed>> = {};
  stages.forEach((stage, index) => {
    const page = pages[index];
    seed[stage] = page.ok
      ? { rows: page.data.jobs as JobRow[], error: null }
      : { rows: [], error: page.error };
  });

  const byStage = summary.ok ? summary.data.byStage : {};
  const total = Object.values(byStage).reduce((sum, n) => sum + Number(n || 0), 0);

  return (
    <>
      <h1 className="p-h1">Board</h1>
      <p className="p-lede">
        {summary.ok
          ? `${total} ${total === 1 ? "job" : "jobs"} you can see, across every stage.`
          : "Stage counts are unavailable right now."}
      </p>

      <QueueBoard
        initialQueue={DEFAULT_QUEUE}
        seed={seed}
        byStage={byStage}
        sites={siteList.ok ? siteList.data.sites : []}
        showMoney={canSeeMoney(state.viewer.actor)}
      />
    </>
  );
}
