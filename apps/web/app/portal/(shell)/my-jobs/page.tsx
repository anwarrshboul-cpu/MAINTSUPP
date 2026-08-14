import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState, serverFetch } from "../../../../lib/session";
import type { JobsPage } from "../../../../lib/portal";
import ContractorJobs from "./contractor-jobs";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "My jobs" };

/** Enough for a busy week on one firm's list; the API caps it at 500 anyway. */
const PAGE = 100;

export default async function MyJobsPage() {
  const state = await getViewerState();
  if (state.kind !== "ok") return null;

  /*
   * This screen is a contractor's, and only a contractor's.
   *
   * Not a permission — `GET /jobs` would happily answer an admin here — but the
   * page has no meaning for anyone else: it is built entirely out of "jobs
   * assigned to me", and `scopeFor` gives staff every job in the system. An
   * admin landing on a list of 744 jobs titled "My jobs" would be reading a
   * lie, so they are sent to the board, which is theirs.
   */
  if (state.viewer.actor.role !== "contractor") redirect("/portal/dashboard");

  const result = await serverFetch<JobsPage>(`/jobs?limit=${PAGE}&offset=0`);

  if (!result.ok) {
    return (
      <div className="card card--empty">
        <h1>My jobs</h1>
        <p className="muted">{result.error}</p>
      </div>
    );
  }

  const { jobs, total } = result.data;

  return (
    <>
      <h1 className="p-h1">My jobs</h1>
      <p className="p-lede">
        {total === 0
          ? "Nothing has been assigned to you yet."
          : `${total} job${total === 1 ? "" : "s"} assigned to you. Accept what you can take, say why if you cannot, and add photographs when the work is done.`}
      </p>

      {jobs.length === 0 ? (
        <div className="card card--empty">
          <p className="muted">
            A coordinator assigns work to you here. You will see a job the moment
            it is offered.
          </p>
        </div>
      ) : (
        <ContractorJobs
          jobs={jobs}
          showing={jobs.length}
          total={total}
        />
      )}
    </>
  );
}
