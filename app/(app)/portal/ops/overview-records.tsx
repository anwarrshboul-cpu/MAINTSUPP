"use client";

/**
 * THE RECORDS BEHIND A FOOTNOTE.
 *
 * §1.5 requires every "Fix these →" to work, and most of them do it by drilling
 * to the Jobs list: a site, a status, a priority are all things that list can
 * express. Six are not.
 *
 * "14 jobs excluded — no request date recorded", "N jobs have a cost but no
 * contractor named", "N jobs have a zero or negative cost" — the board's filter
 * bar has no vocabulary for any of these, and giving it one would be a larger
 * change to a busier screen than the footnote is worth. So the Overview answers
 * them itself, from one endpoint, in a panel that can also act on what it finds.
 *
 * The panel is deliberately NOT a second Jobs list. It shows what the sentence
 * counted, in the order the sentence implies, and every row opens the real
 * record. Anything more would be a second place to manage jobs, which is how a
 * product ends up with two answers again.
 */

import { useOpsQuery } from "./ops-url-state";
import { EmptyState, SkeletonRow } from "./ops-primitives";
import type { RecordsPayload, RecordsQuery } from "./overview-contract";

/**
 * What each query is called on screen.
 *
 * The endpoint returns its own `title` — it knows the cohort and the axis — and
 * this is the fallback for the moment before it answers, so the panel opens
 * with a heading rather than with a blank.
 */
const FALLBACK_TITLE: Record<RecordsQuery, string> = {
  missing_measure_date: "Jobs the period cannot see",
  no_site: "Jobs that point at no site in the register",
  no_cost: "Jobs in this period with no cost recorded",
  completed_without_cost: "Completed jobs with no cost recorded",
  cost_without_contractor: "Jobs with a cost but no contractor named",
  zero_or_negative_cost: "Jobs with a zero or negative cost",
  stuck: "Every job waiting for approval, parts, payment or a decision",
};

export function OverviewRecordsPanel({
  query,
  search,
  onClose,
  onOpenJob,
}: {
  query: RecordsQuery;
  /** The page's own filter state, so the panel counts the same cohort. */
  search: string;
  onClose: () => void;
  onOpenJob: (id: string) => void;
}) {
  const suffix = search.replace(/^\?/, "");
  const state = useOpsQuery<RecordsPayload>(
    "/api/dashboard/records",
    `query=${encodeURIComponent(query)}${suffix ? `&${suffix}` : ""}`,
  );
  const data = state.data;
  const title = data?.title ?? FALLBACK_TITLE[query];

  return (
    <div
      className="ops-sheet ovw-records"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ops-sheet__panel ovw-records__panel">
        <div className="ops-sheet__head">
          <h2>{title}</h2>
          <button type="button" className="ops-menu__button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {state.error ? (
          <p className="ops-error" role="alert">
            {state.error}{" "}
            <button type="button" className="ops-link" onClick={state.reload}>
              Retry
            </button>
          </p>
        ) : !data ? (
          <SkeletonRow lines={8} height={280} />
        ) : data.rows.length === 0 ? (
          <EmptyState>Nothing here — this gap is closed.</EmptyState>
        ) : (
          <>
            <p className="ovw-records__count">
              {data.total} record{data.total === 1 ? "" : "s"}
              {data.truncated ? `, showing the first ${data.rows.length}` : ""}.
            </p>
            <ul className="ovw-records__list">
              {data.rows.map((row) => (
                <li key={row.id} className="ovw-records__row">
                  <button type="button" className="ops-link" onClick={() => onOpenJob(row.id)}>
                    {row.reference ?? row.id} — {row.title}
                  </button>
                  <dl className="ovw-records__meta">
                    <div>
                      <dt>Site</dt>
                      <dd>{row.siteName}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{row.status}</dd>
                    </div>
                    <div>
                      <dt>Requested</dt>
                      {/* A missing date prints a dash, never today's. §1.5. */}
                      <dd>{row.requestedAt ? row.requestedAt.slice(0, 10) : "—"}</dd>
                    </div>
                    <div>
                      <dt>Completed</dt>
                      <dd>{row.completedAt ? row.completedAt.slice(0, 10) : "—"}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
