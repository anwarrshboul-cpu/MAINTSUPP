import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState, serverFetch } from "../../../../lib/session";
import { canReportJob, type Site } from "../../../../lib/portal";
import ReportForm from "./report-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Report a job" };

export default async function ReportPage() {
  const state = await getViewerState();
  if (state.kind !== "ok") return null;

  /*
   * Staff and contractors are sent away, and it is a menu decision rather than
   * a permission — `POST /public/report-a-job` is open to the internet and
   * would take a submission from anybody. A coordinator does not report faults
   * into their own triage queue (they raise the job directly), and a contractor
   * reporting a new fault at a client's store is not a workflow this product
   * has. Both would land in Incoming Requests looking like a member of the
   * public, which is worse than not offering the page.
   */
  if (!canReportJob(state.viewer.actor)) redirect("/portal/dashboard");

  const sites = await serverFetch<{ sites: Site[] }>("/jobs/meta/sites");

  const { actor, fullName, phone } = state.viewer;

  return (
    <>
      <h1 className="p-h1">Report a job</h1>
      <p className="p-lede">
        One fault per report, with photographs. It goes to the coordinators as a
        request — they check it and turn it into a job with a reference.
      </p>

      <ReportForm
        sites={sites.ok ? sites.data.sites : []}
        sitesError={sites.ok ? null : sites.error}
        /* Pre-filled from the profile, so a store manager is not retyping who
           they are and where they work on every report. All three stay
           editable: the person reporting is not always the person on the
           account, and the API takes what is submitted. */
        contactName={fullName ?? ""}
        phone={phone ?? ""}
        email={actor.email}
      />
    </>
  );
}
