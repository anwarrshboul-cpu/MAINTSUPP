"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "../../../../lib/api";
import {
  acceptAttribute,
  describeAccepted,
  useUploadQueue,
} from "../../../../lib/uploads";
import {
  formatDate,
  formatDateTime,
  priorityChipClass,
  type JobRow,
} from "../../../../lib/portal";

/**
 * The contractor's screen. Everything a person on site can do, and nothing else.
 *
 * ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────────
 * No pricing, no quotes, no other contractors and no other clients. None of
 * that is hidden by this component — `GET /jobs` does not send a contractor the
 * money columns at all and `scopeFor()` restricts the rows to their own
 * `contractor_id`, so there is nothing here to leak. This file simply never
 * asks: there is no cost field to forget to guard, and the list it renders is
 * whatever the API decided they may see.
 *
 * ── THE FOUR PILES ────────────────────────────────────────────────────────
 * Grouped by what the contractor has to DO, not by the board's seven stages.
 * A stage-grouped view answers a coordinator's question ("where is everything")
 * and none of theirs ("what have I not answered", "where am I expected today",
 * "what still needs closing out"). Declined work keeps its own pile rather than
 * disappearing, so a mistap is visible and recoverable by asking for it back.
 */

type Pile = "offered" | "accepted" | "declined" | "done";

const PILES: { key: Pile; title: string; blurb: string }[] = [
  {
    key: "offered",
    title: "Waiting for your answer",
    blurb: "Accept these or say why you cannot take them.",
  },
  {
    key: "accepted",
    title: "Yours to do",
    blurb: "Give an ETA so the store knows when to expect you.",
  },
  {
    key: "declined",
    title: "You declined",
    blurb: "A coordinator has been told and will offer them to somebody else.",
  },
  { key: "done", title: "Finished", blurb: "Completed work, kept for the record." },
];

const pileOf = (job: JobRow): Pile => {
  if (job.stage === "Done") return "done";
  if (job.assignment_status === "declined") return "declined";
  if (job.assignment_status === "offered") return "offered";
  // `null` means the job was assigned before the offer flow existed. It is
  // theirs and it is live, so it belongs with the work rather than in limbo.
  return "accepted";
};

export default function ContractorJobs({
  jobs,
  showing,
  total,
}: {
  jobs: JobRow[];
  showing: number;
  total: number;
}) {
  return (
    <>
      {PILES.map((pile) => {
        const rows = jobs.filter((job) => pileOf(job) === pile.key);
        if (rows.length === 0) return null;
        return (
          <section className="p-section" key={pile.key}>
            <div className="p-section-head">
              <h2>{pile.title}</h2>
              <span className="p-group-count">{rows.length}</span>
            </div>
            <p className="p-lede">{pile.blurb}</p>
            <ul className="p-list">
              {rows.map((job) => (
                <li key={job.id}>
                  <ContractorJob job={job} pile={pile.key} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {showing < total ? (
        <p className="p-note">
          Showing the {showing} most recent of {total}.
        </p>
      ) : null}
    </>
  );
}

type Pending = "accept" | "decline" | "eta" | "complete" | "upload" | null;

function ContractorJob({ job, pile }: { job: JobRow; pile: Pile }) {
  const router = useRouter();
  /* One queue per job row, which is why each row is its own component: a hook
     cannot be called inside the map that draws them. */
  const queue = useUploadQueue(`/uploads/job/${job.id}`);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [etaAt, setEtaAt] = useState("");
  const [adding, setAdding] = useState(false);

  async function post(what: Exclude<Pending, null>, path: string, body?: unknown) {
    if (pending) return false;
    setPending(what);
    setError(null);
    setNotice(null);
    const result = await api(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    router.refresh();
    return true;
  }

  async function decline(event: React.FormEvent) {
    event.preventDefault();
    if (!reason.trim()) return setError("Say why — it goes to the coordinator.");
    const done = await post("decline", `/jobs/${job.id}/assignment/decline`, { reason });
    if (done) {
      setDeclining(false);
      setReason("");
    }
  }

  async function saveEta(event: React.FormEvent) {
    event.preventDefault();
    if (!etaAt) return setError("Pick a date and a time.");
    // The picker gives a wall time on the reader's own clock; converted to an
    // instant so the stored value means one moment rather than one server's
    // idea of nine o'clock.
    const instant = new Date(etaAt);
    if (Number.isNaN(instant.getTime())) return setError("That is not a valid time.");
    const done = await post("eta", `/jobs/${job.id}/assignment/eta`, {
      etaAt: instant.toISOString(),
    });
    if (done) {
      setEtaAt("");
      setNotice("ETA saved — the store can see it.");
    }
  }

  async function upload() {
    if (queue.busy || pending) return;
    if (queue.items.every((item) => item.state === "sent")) {
      return setError("Choose a photograph first.");
    }
    setError(null);
    setNotice(null);
    setPending("upload");
    const { sent, failed } = await queue.send({ kind: "completed_picture" });
    setPending(null);
    if (failed > 0) {
      setError(`${failed} file${failed === 1 ? "" : "s"} did not upload — see below.`);
    }
    if (sent > 0) {
      setNotice(`${sent} photograph${sent === 1 ? "" : "s"} added to the job.`);
      // Only clear when everything landed: a failure stays on screen with its
      // reason, and pressing Upload again retries just that file.
      if (failed === 0) queue.clear();
      router.refresh();
    }
  }

  return (
    <article className="p-row">
      <div className="p-row-head">
        <h3>{job.title}</h3>
        <span className="p-row-when">{formatDate(job.date_requested) ?? "—"}</span>
      </div>

      <div className="chips">
        <span className="chip chip--status p-mono">{job.reference}</span>
        {job.priority ? (
          <span className={priorityChipClass(job.priority)}>{job.priority}</span>
        ) : null}
        <span className="chip chip--status">{job.status}</span>
        {job.eta_at ? (
          <span className="chip chip--status">On site {formatDateTime(job.eta_at)}</span>
        ) : null}
      </div>

      <p className="p-jobcard-site">
        {job.site_name ?? job.location ?? "No site recorded"}
        {job.contact_number ? (
          <>
            {" · "}
            {/* The next action after reading a job is ringing the store, and
                this page is read on a phone in a car park. */}
            <a href={`tel:${job.contact_number.replace(/\s+/g, "")}`}>
              {job.contact_number}
            </a>
          </>
        ) : null}
      </p>

      <p className="body">{job.description}</p>

      {pile === "declined" && job.decline_reason ? (
        <p className="p-note">You declined this: {job.decline_reason}</p>
      ) : null}

      <div aria-live="polite" aria-atomic="true">
        {error ? (
          <p className="alert alert--bad" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="alert alert--good">{notice}</p> : null}
      </div>

      {pile === "offered" ? (
        <div className="p-btnrow" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="p-btn"
            disabled={pending !== null}
            onClick={() => post("accept", `/jobs/${job.id}/assignment/accept`)}
          >
            {pending === "accept" ? "Accepting…" : "Accept"}
          </button>
          <button
            type="button"
            className="p-btn p-btn--ghost p-btn--danger"
            disabled={pending !== null}
            aria-expanded={declining}
            onClick={() => setDeclining((open) => !open)}
          >
            Decline
          </button>
        </div>
      ) : null}

      {pile === "accepted" ? (
        <>
          <form onSubmit={saveEta} className="p-grid2">
            <label className="p-field">
              <span>{job.eta_at ? "Update your ETA" : "When will you attend?"}</span>
              <input
                className="p-input"
                type="datetime-local"
                value={etaAt}
                onChange={(event) => setEtaAt(event.target.value)}
                disabled={pending !== null}
              />
            </label>
            <div className="p-field">
              <span aria-hidden="true">&nbsp;</span>
              <div className="p-btnrow">
                <button className="p-btn" type="submit" disabled={pending !== null}>
                  {pending === "eta" ? "Saving…" : "Save ETA"}
                </button>
              </div>
            </div>
          </form>

          <div className="p-btnrow" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="p-btn"
              disabled={pending !== null}
              onClick={() => setAdding((open) => !open)}
              aria-expanded={adding}
            >
              Add photographs
            </button>
            <button
              type="button"
              className="p-btn p-btn--ghost"
              disabled={pending !== null}
              onClick={async () => {
                const done = await post("complete", `/jobs/${job.id}/status`, {
                  status: "Job Completed",
                });
                if (done) setNotice("Marked complete. A coordinator will verify it.");
              }}
            >
              {pending === "complete" ? "Saving…" : "Mark complete"}
            </button>
            <button
              type="button"
              className="p-btn p-btn--ghost p-btn--danger"
              disabled={pending !== null}
              aria-expanded={declining}
              onClick={() => setDeclining((open) => !open)}
            >
              Hand it back
            </button>
          </div>
        </>
      ) : null}

      {declining ? (
        <form onSubmit={decline} style={{ marginTop: 12 }}>
          <label className="p-field">
            <span>Why can you not take it?</span>
            <textarea
              className="p-textarea"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. No cherry picker available until Thursday."
              disabled={pending !== null}
            />
          </label>
          <div className="p-btnrow" style={{ marginTop: 10 }}>
            <button className="p-btn p-btn--danger" type="submit" disabled={pending !== null}>
              {pending === "decline" ? "Sending…" : "Confirm decline"}
            </button>
          </div>
        </form>
      ) : null}

      {adding && pile === "accepted" ? (
        <div style={{ marginTop: 12 }}>
          <label className="p-field">
            <span>Pictures of the completed works</span>
            <input
              className="p-input"
              type="file"
              multiple
              accept={acceptAttribute(queue.limits)}
              disabled={queue.busy}
              onChange={(event) => {
                const rejected = queue.choose(event.currentTarget.files);
                setError(rejected || null);
                // Cleared so the same file picked twice still fires a change.
                event.currentTarget.value = "";
              }}
            />
          </label>

          {queue.items.length > 0 ? (
            <ul className="sendq" aria-live="polite">
              {queue.items.map((item) => (
                <li key={item.id}>
                  <span className="sendq__name">{item.file.name}</span>
                  <span className={`sendq__st sendq__st--${item.state}`}>
                    {item.state === "sending"
                      ? "Uploading…"
                      : item.state === "sent"
                        ? "Added"
                        : item.state === "failed"
                          ? "Failed"
                          : "Ready"}
                  </span>
                  {item.error ? <span className="sendq__why">{item.error}</span> : null}
                  {item.state === "ready" ? (
                    <button
                      type="button"
                      className="p-btn p-btn--ghost p-btn--sm"
                      onClick={() => queue.drop(item.id)}
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="p-btnrow" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="p-btn"
              onClick={upload}
              disabled={queue.busy || queue.items.length === 0}
            >
              {queue.busy ? "Uploading…" : "Upload"}
            </button>
          </div>

          <p className="p-note">
            {describeAccepted(queue.limits)}
            {queue.limits ? `, up to ${queue.limits.maxMb}MB each` : ""}. Signed in
            through the portal, so these go straight onto the job — they do not
            wait to be released.
          </p>
        </div>
      ) : null}

      {/*
        A real control, not a line of underlined text.

        This was a bare inline link measuring 168×16px — and it is the ONLY way
        a contractor reaches the job from their own screen. The one role that
        works exclusively from a phone, on site, had a 16px-tall target as its
        sole route in; every other sub-44px element in the signed-in product
        was this same link on a different card.
      */}
      <Link className="p-btn p-btn--quiet p-open-job" href={`/portal/jobs/${job.id}`}>
        Open the full job {job.reference}
      </Link>
    </article>
  );
}
