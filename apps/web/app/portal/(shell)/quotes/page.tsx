import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewerState, serverFetch } from "../../../../lib/session";
import { canSeeMoney, type PendingQuotes } from "../../../../lib/portal";
import QuoteDecisions from "./quote-decisions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Quotes awaiting approval" };

export default async function QuotesPage() {
  const state = await getViewerState();
  if (state.kind !== "ok") return null;

  /*
   * The nav does not draw this for a contractor, but the URL is typeable — so
   * the page checks too. Not as the security boundary: `GET /jobs/quotes/
   * pending` answers 403 to a contractor whatever this file does. This only
   * decides whether somebody sees a refusal or the page that is theirs.
   */
  if (!canSeeMoney(state.viewer.actor)) redirect("/portal/dashboard");

  const result = await serverFetch<PendingQuotes>("/jobs/quotes/pending");

  if (!result.ok) {
    return (
      <div className="card card--empty">
        <h1>Quotes awaiting approval</h1>
        <p className="muted">{result.error}</p>
      </div>
    );
  }

  const { quotes, canDecide } = result.data;

  return (
    <>
      <h1 className="p-h1">Quotes awaiting approval</h1>
      <p className="p-lede">
        {quotes.length === 0
          ? "Nothing is waiting on a decision."
          : canDecide
            ? `${quotes.length} quote${quotes.length === 1 ? "" : "s"} waiting on you. Approving one is what lets the work be booked in.`
            : `${quotes.length} quote${quotes.length === 1 ? "" : "s"} waiting on your organisation's admin to decide.`}
      </p>

      {quotes.length === 0 ? (
        <div className="card card--empty">
          <p className="muted">
            New quotes appear here the moment a coordinator raises one against
            your work.
          </p>
        </div>
      ) : (
        <QuoteDecisions quotes={quotes} canDecide={canDecide} />
      )}
    </>
  );
}
