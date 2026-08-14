"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "../../../../lib/api";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  type PendingQuote,
} from "../../../../lib/portal";

/**
 * The client admin's approvals queue.
 *
 * ── ONE DECISION, TWO BUTTONS, NO UNDO ────────────────────────────────────
 * `POST /jobs/quotes/:id/decide` only acts on a quote that is still `pending`,
 * so a decision cannot be revised from here — a second press answers 404. That
 * is the right behaviour for a financial approval and it is why Reject asks for
 * a confirmation press rather than acting on the first click: an approval
 * someone did not mean to give is a mis-tap that costs real money, and the
 * recovery is a phone call to a coordinator.
 *
 * ── THE ROW STAYS ─────────────────────────────────────────────────────────
 * A decided quote keeps its place with its outcome and a link to the job, and
 * is only gone on the next load. Removing it at the moment of decision takes
 * away the link to the thing the reader is about to want to look at.
 */

type Settled = { decision: "approved" | "rejected" };

export default function QuoteDecisions({
  quotes,
  canDecide,
}: {
  quotes: PendingQuote[];
  /** False for a client_user: they may read the queue, not act on it. */
  canDecide: boolean;
}) {
  const [settled, setSettled] = useState<Record<string, Settled>>({});

  return (
    <ul className="p-list">
      {quotes.map((quote) => (
        <li key={quote.id}>
          <QuoteRow
            quote={quote}
            canDecide={canDecide}
            settled={settled[quote.id]}
            onSettled={(outcome) =>
              setSettled((previous) => ({ ...previous, [quote.id]: outcome }))
            }
          />
        </li>
      ))}
    </ul>
  );
}

function QuoteRow({
  quote,
  canDecide,
  settled,
  onSettled,
}: {
  quote: PendingQuote;
  canDecide: boolean;
  settled: Settled | undefined;
  onSettled: (outcome: Settled) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<"approved" | "rejected" | null>(null);
  const [confirming, setConfirming] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * `amount_pence` is a bigint, and the two database drivers disagree about
   * what that is in JavaScript — PGlite hands back a number, `postgres` hands
   * back a string so values above 2^53 survive. `formatMoney` uses
   * Number.isFinite, which is false for a string, so an uncoerced value renders
   * every quote on this page as a dash IN PRODUCTION ONLY. Coerced here.
   */
  const amount = formatMoney(Number(quote.amount_pence));

  async function decide(decision: "approved" | "rejected") {
    if (pending) return;
    setPending(decision);
    setError(null);
    const result = await api(`/jobs/quotes/${quote.id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
    setPending(null);
    setConfirming(null);
    if (!result.ok) return setError(result.error);
    onSettled({ decision });
    router.refresh();
  }

  return (
    <article className="p-row">
      <div className="p-row-head">
        <h3>{amount ?? "—"}</h3>
        <span className="p-row-when">{formatDateTime(quote.created_at) ?? "—"}</span>
      </div>

      <div className="chips">
        <span className="chip chip--status p-mono">{quote.reference}</span>
        <span className="chip chip--status">{quote.status}</span>
        {quote.valid_until ? (
          <span className="chip chip--status">
            Valid until {formatDate(quote.valid_until)}
          </span>
        ) : null}
      </div>

      <p className="p-jobcard-title">{quote.title}</p>
      <p className="p-jobcard-site">
        {quote.site_name ?? "No site recorded"}
        {quote.organisation_name ? ` · ${quote.organisation_name}` : ""}
      </p>

      {quote.description ? <p className="body">{quote.description}</p> : null}

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {settled ? (
        <p className="alert alert--good">
          {settled.decision === "approved" ? "Approved" : "Rejected"}.{" "}
          <Link href={`/portal/jobs/${quote.job_id}`}>Open {quote.reference}</Link>
        </p>
      ) : canDecide ? (
        <>
          <div className="p-btnrow" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="p-btn"
              disabled={pending !== null}
              onClick={() =>
                confirming === "approved" ? decide("approved") : setConfirming("approved")
              }
            >
              {pending === "approved"
                ? "Approving…"
                : confirming === "approved"
                  ? `Confirm ${amount ?? "this quote"}`
                  : "Approve"}
            </button>
            <button
              type="button"
              className="p-btn p-btn--ghost p-btn--danger"
              disabled={pending !== null}
              onClick={() =>
                confirming === "rejected" ? decide("rejected") : setConfirming("rejected")
              }
            >
              {pending === "rejected"
                ? "Rejecting…"
                : confirming === "rejected"
                  ? "Confirm rejection"
                  : "Reject"}
            </button>
            {confirming ? (
              <button
                type="button"
                className="p-btn p-btn--ghost"
                disabled={pending !== null}
                onClick={() => setConfirming(null)}
              >
                Cancel
              </button>
            ) : null}
          </div>
          <p className="p-note">
            {confirming
              ? "Press again to confirm. A decision cannot be changed from here."
              : "A decision is recorded against your name and cannot be undone in the portal."}
          </p>
        </>
      ) : (
        <p className="p-note">
          Your organisation&rsquo;s admin approves quotes.{" "}
          <Link href={`/portal/jobs/${quote.job_id}`}>Open {quote.reference}</Link>
        </p>
      )}
    </article>
  );
}
