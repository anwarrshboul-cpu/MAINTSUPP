import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState, serverFetch } from "../../../../lib/session";
import { canTriage, type IntakeRequest, type Scopes } from "../../../../lib/portal";
import TriageQueue from "./triage-queue";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Incoming requests" };

export default async function RequestsPage() {
  const state = await getViewerState();
  if (state.kind !== "ok") return null;

  /*
   * The nav does not draw this link for a non-staff role, but the URL is still
   * typeable — so the page checks too. Not as the security boundary: the API
   * refuses `/jobs/intake/pending` with 403 regardless. This only decides
   * whether someone sees a refusal or the page they were entitled to.
   */
  if (!canTriage(state.viewer.actor)) redirect("/portal/dashboard");

  const [pending, scopes] = await Promise.all([
    serverFetch<{ requests: IntakeRequest[] }>("/jobs/intake/pending"),
    serverFetch<Scopes>("/members/scopes"),
  ]);

  if (!pending.ok) {
    return (
      <div className="card card--empty">
        <h1>Incoming requests</h1>
        <p className="muted">{pending.error}</p>
      </div>
    );
  }

  const requests = pending.data.requests;

  return (
    <>
      <h1 className="p-h1">Incoming requests</h1>
      <p className="p-lede">
        Reported from the public form and not yet triaged. Converting one creates
        a job and moves its photographs across; rejecting one records why.
      </p>

      {requests.length === 0 ? (
        <div className="card card--empty">
          <p className="muted">Nothing waiting. New reports land here.</p>
        </div>
      ) : (
        <TriageQueue
          requests={requests}
          organisations={scopes.ok ? scopes.data.organisations : []}
          sites={scopes.ok ? scopes.data.sites : []}
        />
      )}
    </>
  );
}
