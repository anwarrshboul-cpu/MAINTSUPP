"use client";

/**
 * Settings → Job types — the organisation's classification of work, edited in
 * place.
 *
 * Every job is Reactive, Planned, Project, a type the administrator added, or
 * Unclassified. This card is where those types are named, ordered, added and
 * retired. It writes through `/api/job-types` and nothing else, and it never
 * touches a job: a job stores the type's id, so a rename moves the words on
 * every job and every Reports figure at once and moves no job anywhere.
 *
 * WHAT IT DELIBERATELY DOES NOT OFFER
 *
 *   · DELETE. A type is deactivated, never removed — hidden from new work, kept
 *     on every job already filed under it, still counted in Reports. The route
 *     has no DELETE handler, so the absence here is not a missing button.
 *   · A CODE. The three defaults carry a stable meaning Reports groups by;
 *     "Default" beside a name says so, and renaming one keeps its figures.
 *   · A COLOUR PICKER. The route accepts `colourHex`, but a native colour input
 *     always holds a colour, so it could not say "use the Reports palette",
 *     which is what a null colour means. Left to the API until a design needs
 *     it.
 *
 * Hidden unless the reader holds `settings.edit` — the capability every write
 * behind it enforces — and hidden (not disabled) while that answer is still
 * loading, because a card that appears and then vanishes reads as a fault.
 *
 * After every successful write it primes the shared store with the answer,
 * announces `maintsupp:job-types-changed` so every picker on the page re-reads,
 * and calls `announceDataChanged()` so the Overview and Reports re-read labels
 * they have already drawn.
 */

import { useState } from "react";
import { Icon } from "../../../components";
import { useCapability } from "../../../lib/client-capabilities";
import type { JobType } from "../../../lib/job-type-contract";
import { announceDataChanged } from "../ops/ops-url-state";
import { announceJobTypesChanged, primeJobTypes, useJobTypes } from "../use-job-types";
import "./job-types-settings.css";

/** The same ceiling the route refuses above. Mirrored so the input stops there too. */
const LABEL_LIMIT = 60;

type WriteResult = { ok: true; jobTypes: JobType[] } | { ok: false; error: string };

async function write(method: "POST" | "PATCH", body: Record<string, unknown>): Promise<WriteResult> {
  try {
    const response = await fetch("/api/job-types", {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      jobTypes?: JobType[];
      error?: string;
    };
    if (!response.ok || !Array.isArray(payload.jobTypes)) {
      return { ok: false, error: payload.error ?? "The job types could not be saved." };
    }
    return { ok: true, jobTypes: payload.jobTypes };
  } catch {
    return { ok: false, error: "The job types could not be saved. Check the connection and try again." };
  }
}

export function JobTypesSettings() {
  const canEdit = useCapability("settings.edit");
  /* Only an administrator's page fetches the list for this card; everyone
     else's Settings screen costs nothing extra. */
  const { jobTypes, loaded, error: readError } = useJobTypes(canEdit === true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  if (canEdit !== true) return null;

  const run = async (
    key: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    done: string,
  ): Promise<boolean> => {
    setBusy(key);
    setProblem(null);
    setNotice("");
    const result = await write(method, body);
    setBusy(null);
    if (!result.ok) {
      setProblem(result.error);
      return false;
    }
    primeJobTypes(result.jobTypes);
    announceJobTypesChanged();
    announceDataChanged();
    /* Said once, in the card's own live region, rather than also as a toast —
       two announcements of one save is noise to a screen reader. */
    setNotice(done);
    return true;
  };

  const draftFor = (type: JobType) => drafts[type.id] ?? type.label;
  const forgetDraft = (id: string) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });

  const rename = async (type: JobType) => {
    const label = draftFor(type).trim();
    if (!label || label === type.label) {
      forgetDraft(type.id);
      return;
    }
    if (await run(type.id, "PATCH", { id: type.id, label }, `Renamed "${type.label}" to "${label}".`)) {
      forgetDraft(type.id);
    }
  };

  const toggle = (type: JobType) =>
    run(
      type.id,
      "PATCH",
      { id: type.id, active: !type.active },
      type.active
        ? `"${type.label}" is no longer offered for new jobs. Jobs filed under it keep it.`
        : `"${type.label}" is offered again.`,
    );

  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= jobTypes.length) return;
    const order = jobTypes.map((type) => type.id);
    [order[index], order[target]] = [order[target], order[index]];
    void run("order", "PATCH", { order }, `Moved "${jobTypes[index].label}" ${by < 0 ? "up" : "down"}.`);
  };

  const add = async () => {
    const label = newLabel.trim();
    if (!label) return;
    if (await run("new", "POST", { label }, `Added the job type "${label}".`)) setNewLabel("");
  };

  return (
    <section className="panel settings-card job-types-card" aria-labelledby="job-types-title">
      <div className="settings-card__heading">
        <span>
          <Icon name="list" size={19} />
        </span>
        <div>
          <h2 id="job-types-title">Job types</h2>
          <p>
            How every job is classified. Reports&apos; Reactive, Planned and Projects figures follow
            the three defaults whatever you call them. A deactivated type is no longer offered for
            new jobs; jobs already filed under it keep it.
          </p>
        </div>
      </div>

      {problem || (readError && !loaded) ? (
        <p className="job-types-message job-types-message--error" role="alert">
          {problem ?? readError}
        </p>
      ) : null}

      {!loaded && !readError ? (
        <p className="job-types-message">Loading job types…</p>
      ) : (
        <ol className="job-types-list" aria-label="Job types, in the order they are offered">
          {jobTypes.map((type, index) => {
            const draft = draftFor(type);
            const dirty = draft.trim() !== type.label;
            const inputId = `job-type-name-${type.id}`;
            return (
              <li key={type.id} className={`job-types-row${type.active ? "" : " is-inactive"}`}>
                <div className="job-types-row__name">
                  <label className="visually-hidden" htmlFor={inputId}>
                    {`Name of the ${type.label} job type`}
                  </label>
                  <input
                    id={inputId}
                    value={draft}
                    maxLength={LABEL_LIMIT}
                    disabled={busy !== null}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [type.id]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void rename(type);
                      } else if (event.key === "Escape") {
                        forgetDraft(type.id);
                      }
                    }}
                  />
                  <span className="job-types-row__tags">
                    <span className="job-types-tag">{type.code ? "Default" : "Custom"}</span>
                    <span className={`job-types-tag ${type.active ? "is-on" : "is-off"}`}>
                      {type.active ? "Active" : "Deactivated"}
                    </span>
                  </span>
                </div>
                <div className="job-types-row__actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!dirty || !draft.trim() || busy !== null}
                    onClick={() => void rename(type)}
                  >
                    {busy === type.id && dirty ? "Saving…" : "Save name"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button job-types-move"
                    aria-label={`Move ${type.label} up`}
                    disabled={index === 0 || busy !== null}
                    onClick={() => move(index, -1)}
                  >
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button
                    type="button"
                    className="secondary-button job-types-move"
                    aria-label={`Move ${type.label} down`}
                    disabled={index === jobTypes.length - 1 || busy !== null}
                    onClick={() => move(index, 1)}
                  >
                    <span aria-hidden="true">↓</span>
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy !== null}
                    onClick={() => void toggle(type)}
                  >
                    {type.active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <form
        className="job-types-add"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label htmlFor="job-type-new">Add a job type</label>
        <div className="job-types-add__row">
          <input
            id="job-type-new"
            value={newLabel}
            maxLength={LABEL_LIMIT}
            placeholder="For example, Emergency call-out"
            disabled={busy !== null}
            onChange={(event) => setNewLabel(event.target.value)}
          />
          <button type="submit" className="primary-button" disabled={!newLabel.trim() || busy !== null}>
            <Icon name="plus" size={16} />
            {busy === "new" ? "Adding…" : "Add"}
          </button>
        </div>
      </form>

      <p className="job-types-message job-types-message--notice" role="status" aria-live="polite">
        {notice}
      </p>
    </section>
  );
}

export default JobTypesSettings;
