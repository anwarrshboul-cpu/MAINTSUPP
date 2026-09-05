"use client";

/**
 * RECORDING A HOLD, AND APPROVING ONE — two different acts, two different
 * people.
 *
 * Module 4 §4.2 calls this "the single highest-value data change in this
 * module", and the August report says why in one sentence: the hold periods
 * were supplied separately, with no corresponding tracker field, which made
 * every adjusted duration in the document unauditable. A client reading "12
 * working days elapsed, 4 held, 8 adjusted" had no way to check the 4, and
 * neither did we.
 *
 * The table, the arithmetic and the API all existed before this panel did.
 * `job_holds` has been in the schema, `approvedHoldDays` has merged overlapping
 * windows and clamped them to the job's own duration, and `/api/reports/holds`
 * has served GET, POST and PATCH. What was missing was any way for a person to
 * enter one — so in practice the adjusted column was computed from a table
 * nobody could write to.
 *
 * ── WHY THE FORM CANNOT APPROVE ────────────────────────────────────────────
 *
 * POST records a hold and CANNOT approve it: the route writes `approved:
 * false` and has no parameter that changes that. Approval is a separate PATCH
 * behind a separate capability. The asymmetry is the whole point — an approved
 * hold is SUBTRACTED from the time a client judges the service by, so it has to
 * be somebody's decision with their name against it, not something typed into a
 * box by whoever happened to be closing the job.
 *
 * That is why this panel shows the two states so differently. An unapproved
 * hold is visibly not counting yet, and says so in words rather than by being a
 * slightly paler chip.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import holdsPanelCss from "./holds-panel.css?url";

export type JobHold = {
  id: string;
  requestId: string;
  startAt: string;
  endAt: string | null;
  reason: string | null;
  category: string | null;
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  note: string | null;
};

type Status = "idle" | "loading" | "saving" | "error";

/**
 * The categories a hold can be filed under.
 *
 * "Authorised exclusion" is deliberately in this list and is deliberately
 * different from the rest: `sla.ts` treats an APPROVED hold in that category as
 * taking the job out of the measurement entirely, rather than merely pausing
 * its clock. It is offered here so the choice is explicit and named, instead of
 * being something an operator discovers by typing the right string.
 */
const CATEGORIES = [
  "Awaiting parts",
  "Awaiting client decision",
  "Awaiting access",
  "Third party delay",
  "Awaiting payment",
  "Authorised exclusion",
] as const;

const AUTHORISED_EXCLUSION = "Authorised exclusion";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function HoldsPanel({
  requestId,
  reference,
  canApprove,
}: {
  requestId: string;
  reference?: string | null;
  /** `holds.approve`. The form is shown regardless; the button is not. */
  canApprove: boolean;
}) {
  const [holds, setHolds] = useState<JobHold[]>([]);
  /*
   * Starts as "loading" rather than being set to it inside the mount effect.
   *
   * The compiler lint refuses a setState that runs synchronously in an effect
   * body — it causes a cascading render — and the honest fix is not to suppress
   * it but to stop needing it: the first render IS the loading state, so it can
   * simply say so.
   */
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [startAt, setStartAt] = useState(todayIso());
  const [endAt, setEndAt] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      /* No setState before the first await — see the note on `status`. */
      const response = await fetch(
        `/api/reports/holds?requestId=${encodeURIComponent(requestId)}`,
      );
      const payload = (await response.json()) as { holds?: JobHold[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The holds could not be read.");
      setHolds(payload.holds ?? []);
      setStatus("idle");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The holds could not be read.");
      setStatus("error");
    }
  }, [requestId]);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits the fetch
     before it touches state, so nothing runs synchronously in the effect body;
     the rule cannot see through the promise. The same disable, with the same
     reasoning, is on the mount effect in `views/teams-manager.tsx`. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const totals = useMemo(() => {
    const approved = holds.filter((hold) => hold.approved).length;
    return { total: holds.length, approved, pending: holds.length - approved };
  }, [holds]);

  async function record() {
    if (!startAt) {
      setError("A hold needs a start date.");
      return;
    }
    if (endAt && endAt < startAt) {
      setError("The hold ends before it starts.");
      return;
    }
    setStatus("saving");
    try {
      const response = await fetch("/api/reports/holds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId,
          startAt,
          endAt: endAt || null,
          category,
          reason: reason.trim() || null,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The hold could not be recorded.");
      setEndAt("");
      setReason("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The hold could not be recorded.");
      setStatus("error");
    }
  }

  async function approve(hold: JobHold) {
    setStatus("saving");
    try {
      const response = await fetch("/api/reports/holds", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: hold.id, approved: true }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The hold could not be approved.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The hold could not be approved.");
      setStatus("error");
    }
  }

  return (
    <section className="holds-panel" aria-labelledby="holds-heading">
      <link rel="stylesheet" href={holdsPanelCss} />
      <header className="holds-panel__head">
        <h3 id="holds-heading">
          Holds{reference ? ` — ${reference}` : ""}
        </h3>
        <p className="holds-panel__summary">
          {totals.total === 0
            ? "No hold has been recorded against this job."
            : `${totals.total} recorded · ${totals.approved} approved and counting towards the adjusted duration · ${totals.pending} awaiting approval`}
        </p>
      </header>

      {error ? (
        <p className="holds-panel__error" role="alert">
          {error}
        </p>
      ) : null}

      <ol className="holds-panel__list">
        {holds.map((hold) => (
          <li
            key={hold.id}
            className={`holds-panel__item${hold.approved ? " holds-panel__item--approved" : ""}`}
          >
            <div className="holds-panel__dates">
              <strong>{hold.startAt}</strong>
              <span aria-hidden="true"> → </span>
              <strong>{hold.endAt ?? "open"}</strong>
              {hold.category ? <em className="holds-panel__category">{hold.category}</em> : null}
            </div>
            {hold.reason ? <p className="holds-panel__reason">{hold.reason}</p> : null}
            <p className="holds-panel__state">
              {hold.approved ? (
                <>
                  <span className="holds-panel__badge holds-panel__badge--approved">Approved</span>
                  {hold.category === AUTHORISED_EXCLUSION
                    ? " — this job is excluded from the SLA measurement entirely."
                    : " — these days are subtracted from the elapsed time."}
                  {hold.approvedBy ? ` Approved by ${hold.approvedBy}.` : ""}
                </>
              ) : (
                <>
                  <span className="holds-panel__badge">Not approved</span>
                  {" — recorded, but "}
                  <strong>not yet counting</strong>
                  {" towards the adjusted duration. It is reported as a data-quality finding until somebody approves it."}
                </>
              )}
            </p>
            {!hold.approved && canApprove ? (
              <button
                type="button"
                className="holds-panel__approve"
                onClick={() => void approve(hold)}
                disabled={status === "saving"}
              >
                Approve this hold
              </button>
            ) : null}
          </li>
        ))}
      </ol>

      <form
        className="holds-panel__form"
        onSubmit={(event) => {
          event.preventDefault();
          void record();
        }}
      >
        <h4>Record a hold</h4>
        <div className="holds-panel__fields">
          <label>
            <span>Start</span>
            <input
              type="date"
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
              required
            />
          </label>
          <label>
            <span>End</span>
            {/*
              Optional on purpose. An open-ended hold is the normal state of a
              job that is on hold RIGHT NOW, and forcing an end date would make
              somebody invent one — `holdWorkingDays` runs an open hold to the
              completion date, or to today for a job still open.
            */}
            <input
              type="date"
              value={endAt}
              onChange={(event) => setEndAt(event.target.value)}
              min={startAt || undefined}
            />
          </label>
          <label>
            <span>Category</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {CATEGORIES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="holds-panel__reason-field">
          <span>Reason</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            placeholder="Why the clock stopped. This is printed in the report."
          />
        </label>
        {category === AUTHORISED_EXCLUSION ? (
          <p className="holds-panel__warning">
            An approved <strong>Authorised exclusion</strong> removes this job from the SLA
            measurement altogether, rather than pausing its clock. Use it only where the parties
            agreed the job is not to be judged against the term.
          </p>
        ) : null}
        <button type="submit" disabled={status === "saving"}>
          {status === "saving" ? "Saving…" : "Record hold"}
        </button>
        <p className="holds-panel__note">
          Recording a hold does not approve it. Until an approver signs it off it changes no
          figure in the report.
        </p>
      </form>
    </section>
  );
}

export default HoldsPanel;
