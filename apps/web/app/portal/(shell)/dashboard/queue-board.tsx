"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "../../../../lib/api";
import {
  BOARD_PAGE_SIZE,
  formatDate,
  formatMoney,
  priorityChipClass,
  type JobRow,
  type JobsPage,
  type Site,
  type StageSeed,
} from "../../../../lib/portal";
import {
  needsAttention,
  QUEUE_ORDER,
  QUEUE_STAGES,
  type JobStage,
  type QueueName,
} from "../../../../lib/job-stages";

type StageState = {
  rows: JobRow[];
  /** No further pages. See the note on `fetchStage`. */
  done: boolean;
  loading: boolean;
  error: string | null;
};

type StageMap = Partial<Record<JobStage, StageState>>;

/**
 * Fetches one page of one stage.
 *
 * Whether more remain is decided by the size of the page that came back, not by
 * the API's `hasMore`. `GET /jobs` computes `total` over everything the caller
 * may see and applies no stage, site or search filter to that count — so under
 * any filter `hasMore` stays true long after the last matching row, and a board
 * that trusted it would offer a "Show more" that returns nothing, for ever.
 */
async function fetchStage(
  stage: JobStage,
  offset: number,
  siteId: string,
  q: string,
): Promise<{ rows: JobRow[]; done: boolean; error: string | null }> {
  const params = new URLSearchParams({
    stage,
    limit: String(BOARD_PAGE_SIZE),
    offset: String(offset),
  });
  if (siteId) params.set("siteId", siteId);
  if (q) params.set("q", q);

  const result = await api<JobsPage>(`/jobs?${params}`);
  if (!result.ok) return { rows: [], done: true, error: result.error };
  const rows = result.data.jobs ?? [];
  return { rows, done: rows.length < BOARD_PAGE_SIZE, error: null };
}

export default function QueueBoard({
  initialQueue,
  seed,
  byStage,
  sites,
  showMoney,
}: {
  initialQueue: QueueName;
  seed: Partial<Record<JobStage, StageSeed>>;
  byStage: Record<string, number>;
  sites: Site[];
  showMoney: boolean;
}) {
  const [queue, setQueue] = useState<QueueName>(initialQueue);
  const [siteId, setSiteId] = useState("");
  const [term, setTerm] = useState(""); // what is in the box
  const [applied, setApplied] = useState(""); // what has been searched for

  const [stages, setStages] = useState<StageMap>(() => {
    const initial: StageMap = {};
    for (const [stage, page] of Object.entries(seed)) {
      initial[stage as JobStage] = {
        rows: page.rows,
        done: page.rows.length < BOARD_PAGE_SIZE,
        loading: false,
        error: page.error,
      };
    }
    return initial;
  });

  /*
   * Every load carries a ticket number, and a reply is only applied if its
   * ticket is still the current one. Without it, a slow response for "Aldgate"
   * can land after a fast one for the cleared filter and repopulate a board the
   * user has already moved on from.
   */
  const ticket = useRef(0);

  const load = useCallback(
    async (nextQueue: QueueName, nextSite: string, nextTerm: string) => {
      const id = ++ticket.current;
      const wanted = QUEUE_STAGES[nextQueue];

      setStages(
        Object.fromEntries(
          wanted.map((stage) => [
            stage,
            { rows: [], done: false, loading: true, error: null },
          ]),
        ) as StageMap,
      );

      const pages = await Promise.all(
        wanted.map((stage) => fetchStage(stage, 0, nextSite, nextTerm)),
      );
      if (id !== ticket.current) return;

      setStages(
        Object.fromEntries(
          wanted.map((stage, index) => [
            stage,
            { ...pages[index], loading: false },
          ]),
        ) as StageMap,
      );
    },
    [],
  );

  // The first render is already populated by the server, so the effect skips it
  // — otherwise every visit would fetch the same page twice and flash empty.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    void load(queue, siteId, applied);
  }, [queue, siteId, applied, load]);

  async function showMore(stage: JobStage) {
    const current = stages[stage];
    if (!current || current.loading || current.done) return;

    const id = ticket.current;
    setStages((prev) => ({ ...prev, [stage]: { ...current, loading: true } }));
    const page = await fetchStage(stage, current.rows.length, siteId, applied);
    if (id !== ticket.current) return; // filters changed while this was in flight

    setStages((prev) => {
      const latest = prev[stage] ?? current;
      return {
        ...prev,
        [stage]: {
          rows: [...latest.rows, ...page.rows],
          done: page.done,
          loading: false,
          error: page.error,
        },
      };
    });
  }

  const filtered = siteId !== "" || applied !== "";
  const stagesShown = QUEUE_STAGES[queue];
  const attentionQueue = queue === "Needs Attention";

  /** Rows a group draws: everything, unless this is the cross-cut queue. */
  const visibleRows = useCallback(
    (rows: JobRow[]) => (attentionQueue ? rows.filter(needsAttention) : rows),
    [attentionQueue],
  );

  const attention = useMemo(() => {
    const rows = Object.values(stages).flatMap((state) => state?.rows ?? []);
    const flagged = rows.filter(needsAttention).length;
    // Exact only when this queue is open and every one of its stages has been
    // paged to the end; otherwise it is a floor, and is labelled as one.
    const exact =
      attentionQueue && stagesShown.every((stage) => stages[stage]?.done);
    return { flagged, exact };
  }, [stages, attentionQueue, stagesShown]);

  /**
   * The number on a tab.
   *
   * Exact counts come from `GET /jobs/summary`, which counts by stage over the
   * whole board. Two cases have no exact answer and must not invent one:
   * Needs Attention is not a stage, and a filtered board has no server-side
   * count at all — so those show a floor, or nothing.
   */
  function queueCount(name: QueueName): string | null {
    if (name === "Needs Attention") {
      if (attention.flagged === 0 && !attention.exact) return null;
      return attention.exact ? String(attention.flagged) : `${attention.flagged}+`;
    }
    if (filtered) return null;
    const total = QUEUE_STAGES[name].reduce(
      (sum, stage) => sum + Number(byStage[stage] ?? 0),
      0,
    );
    return String(total);
  }

  const nothingVisible = stagesShown.every((stage) => {
    const state = stages[stage];
    return !state || (!state.loading && visibleRows(state.rows).length === 0);
  });
  const stillLoading = stagesShown.some((stage) => stages[stage]?.loading);
  // "Nothing matched" and "nothing loaded" look identical on screen and are not
  // the same news, so the empty card stands down when a column reported an error.
  const anyError = stagesShown.some((stage) => stages[stage]?.error);

  return (
    <>
      <div className="p-queues" role="tablist" aria-label="Job queues">
        {QUEUE_ORDER.map((name) => {
          const count = queueCount(name);
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={queue === name}
              aria-controls="p-board"
              className={`p-queue${queue === name ? " is-on" : ""}`}
              onClick={() => setQueue(name)}
            >
              {name}
              {count ? <span className="p-count">{count}</span> : null}
            </button>
          );
        })}
      </div>

      <form
        className="p-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(term.trim());
        }}
      >
        <label className="p-field">
          <span>Search</span>
          <input
            className="p-input"
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="the shutter at Aldgate"
            autoCapitalize="none"
            /* Submitted rather than searched-as-you-type: each keystroke would
               be one request per stage in the queue. */
            enterKeyHint="search"
          />
        </label>

        {sites.length > 0 ? (
          <label className="p-field">
            <span>Site</span>
            <select
              className="p-select"
              value={siteId}
              onChange={(event) => setSiteId(event.target.value)}
            >
              <option value="">All sites</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="p-btnrow">
          <button className="p-btn" type="submit">
            Search
          </button>
          {filtered ? (
            <button
              type="button"
              className="p-btn p-btn--ghost"
              onClick={() => {
                setTerm("");
                setApplied("");
                setSiteId("");
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      </form>

      {filtered ? (
        <p className="p-note">
          Filtered. Tab counts are hidden because the API counts stages across
          the whole board, not across a filter — a number here would be the
          wrong one.
        </p>
      ) : null}

      <div className="p-board" id="p-board">
        {stagesShown.map((stage) => {
          const state = stages[stage];
          const rows = state ? visibleRows(state.rows) : [];

          /*
           * In the cross-cut queue the stage columns are incidental — an empty
           * one is noise, not information. A column that FAILED is not empty
           * though, and hiding it would turn "the API is unreachable" into a
           * board that quietly looks like there is no work to do.
           */
          if (attentionQueue && rows.length === 0 && !state?.loading && !state?.error) {
            return null;
          }

          const loaded = state?.rows.length ?? 0;
          const stageTotal = Number(byStage[stage] ?? 0);
          const countLabel = attentionQueue
            ? `${rows.length} of ${loaded} loaded`
            : filtered
              ? `${loaded} shown`
              : `${loaded} of ${stageTotal}`;

          return (
            <section className="p-group" key={stage}>
              <div className="p-group-head">
                <h3>{stage}</h3>
                <span className="p-group-count">{countLabel}</span>
              </div>

              {state?.error ? (
                <p className="alert alert--bad" role="alert">
                  {state.error}
                </p>
              ) : null}

              {rows.length === 0 ? (
                <p className="p-empty">{state?.loading ? "Loading…" : "Nothing here."}</p>
              ) : (
                <ul className="p-cards">
                  {rows.map((job) => (
                    <li key={job.id}>
                      <JobCard job={job} showMoney={showMoney} />
                    </li>
                  ))}
                </ul>
              )}

              {state && !state.done ? (
                <button
                  type="button"
                  className="p-more"
                  onClick={() => showMore(stage)}
                  disabled={state.loading}
                >
                  {state.loading ? "Loading…" : `Show ${BOARD_PAGE_SIZE} more`}
                </button>
              ) : null}
            </section>
          );
        })}
      </div>

      {nothingVisible && !stillLoading && !anyError ? (
        <div className="card card--empty">
          <p className="muted">
            {filtered
              ? "No jobs match that search in this queue."
              : "This queue is empty."}
          </p>
        </div>
      ) : null}
    </>
  );
}

function JobCard({ job, showMoney }: { job: JobRow; showMoney: boolean }) {
  // `cost_of_works_pence` is absent, not null, for a contractor — the API drops
  // the column rather than sending an empty one, so this must never assume it.
  const cost = showMoney ? formatMoney(job.cost_of_works_pence) : null;

  return (
    /*
     * `prefetch={false}`: a board draws up to a hundred of these, and Next
     * prefetches every link that scrolls into view. Each prefetch is a full
     * server render of the job page, which is a `GET /jobs/:id` against the
     * API — so an idle board would fire a hundred authenticated requests
     * nobody asked for, on a phone, on mobile data. The page is fast enough to
     * fetch when it is actually opened.
     */
    <Link className="p-jobcard" href={`/portal/jobs/${job.id}`} prefetch={false}>
      <div className="p-jobcard-top">
        <span className="p-jobcard-ref">{job.reference}</span>
        <span className="p-jobcard-date">{formatDate(job.date_requested) ?? "—"}</span>
      </div>

      <p className="p-jobcard-title">{job.title}</p>
      <p className="p-jobcard-site">{job.site_name ?? job.location ?? "No site recorded"}</p>

      <div className="chips">
        {job.priority ? (
          <span className={priorityChipClass(job.priority)}>{job.priority}</span>
        ) : null}
        <span className="chip chip--status">{job.status}</span>
        {cost ? <span className="chip chip--status">{cost}</span> : null}
      </div>
    </Link>
  );
}
