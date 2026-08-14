"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../lib/api";
import {
  acceptAttribute,
  describeAccepted,
  useUploadQueue,
} from "../../../lib/uploads";

/**
 * What a contractor can do from a share link, with no account.
 *
 * The name field is required and is the only attribution this page can offer —
 * so it is asked for once and reused for all three actions, rather than
 * prompting three times for the same thing while somebody is standing in a shop
 * with one hand free.
 *
 * ── WHY THE PHOTOGRAPHS DO NOT APPEAR AFTER SENDING ────────────────────────
 *
 * The share token proves only that somebody was forwarded a URL, so an upload
 * through it lands `pending = true` and stays invisible until staff release it.
 * That is deliberate — without it, anyone ever sent a link can publish an image
 * into a client's record forever. But it means the one thing this page must not
 * do is stay silent: a photograph that is sent, accepted, and then nowhere to be
 * seen looks exactly like a failed upload, and the contractor's next move is to
 * send it four more times or give up and drive off. So each file keeps a visible
 * "Sent" state, and the rule is written under the control rather than left to be
 * inferred. It is also why sending pictures is the one action here that does NOT
 * call `router.refresh()` — a comment appears in the thread when the page
 * re-fetches, but a pending attachment is not in the payload, so refreshing
 * would replace the evidence that it arrived with nothing at all.
 */

export default function ShareActions({
  token,
  completed,
}: {
  token: string;
  completed: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<"comment" | "complete" | "photos" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const photos = useUploadQueue(`/public/job/${token}/upload`);
  const limits = photos.limits;

  async function submitComment(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!name.trim()) return setError("Add your name so the team knows who updated this.");
    if (!comment.trim()) return setError("Write an update first.");

    setPending("comment");
    setError(null);
    const result = await api(`/public/job/${token}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: comment, authorName: name }),
    });
    setPending(null);

    if (!result.ok) return setError(result.error);
    setComment("");
    setDone("Update sent.");
    // Re-fetches the server component so the new comment appears in the thread
    // above rather than only in a success message.
    router.refresh();
  }

  async function markComplete() {
    if (pending) return;
    if (!name.trim()) return setError("Add your name before marking the work complete.");

    setPending("complete");
    setError(null);
    const result = await api(`/public/job/${token}/complete`, {
      method: "POST",
      body: JSON.stringify({ authorName: name }),
    });
    setPending(null);

    if (!result.ok) return setError(result.error);
    setDone("Marked complete. The coordinators have been notified.");
    router.refresh();
  }

  async function sendPhotos() {
    if (pending) return;
    // The API requires a name on every share-link upload, and refuses without
    // one — asking here saves a round trip that can only end in "Add your name."
    if (!name.trim()) return setError("Add your name so the team knows who sent these.");
    if (photos.items.every((item) => item.state === "sent")) {
      return setError("Choose a picture first.");
    }

    setPending("photos");
    setError(null);
    setDone(null);

    const { sent, failed } = await photos.send({
      uploaderName: name.trim(),
      // The API defaults to completed works for a share link; saying so
      // explicitly means this control cannot start filing evidence of the
      // fault as evidence of the repair if that default ever changes.
      kind: "completed_picture",
    });

    setPending(null);
    if (sent > 0) {
      setDone(
        `${sent} picture${sent === 1 ? "" : "s"} received. They appear on the job once the team has checked them — they will not show on this page in the meantime.`,
      );
    }
    if (failed > 0) {
      setError(
        `${failed} picture${failed === 1 ? " did" : "s did"} not send. The reason is beside each one below.`,
      );
    }
  }

  return (
    <section className="card actions">
      <h2>Update this job</h2>

      <div aria-live="polite" aria-atomic="true">
        {error ? <p className="alert alert--bad" role="alert">{error}</p> : null}
        {done ? <p className="alert alert--good">{done}</p> : null}
      </div>

      <form onSubmit={submitComment}>
        <label htmlFor="share-name">Your name</label>
        <input
          id="share-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          placeholder="e.g. Dave (Acme Repairs)"
          required
        />

        <label htmlFor="share-comment">Update</label>
        <textarea
          id="share-comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          rows={4}
          placeholder="What did you find, what did you do, what is still outstanding?"
        />

        <button type="submit" className="btn" disabled={pending !== null}>
          {pending === "comment" ? "Sending…" : "Send update"}
        </button>
      </form>

      <label htmlFor="share-photos">Pictures of completed works</label>
      <input
        id="share-photos"
        type="file"
        multiple
        accept={acceptAttribute(limits)}
        /* `capture` is deliberately absent: on a phone this input offers the
           camera AND the roll, and the pictures worth sending are often the
           ones taken before the tablet came out. */
        disabled={pending !== null}
        onChange={(event) => {
          const rejected = photos.choose(event.currentTarget.files);
          setError(rejected || null);
          if (!rejected) setDone(null);
          // Cleared so picking the same file twice still fires a change event.
          event.currentTarget.value = "";
        }}
      />

      {photos.items.length > 0 ? (
        <ul className="sendq" aria-live="polite">
          {photos.items.map((item) => (
            <li key={item.id}>
              <span className="sendq__name">{item.file.name}</span>
              <span className={`sendq__st sendq__st--${item.state}`}>
                {item.state === "sending"
                  ? "Sending…"
                  : item.state === "sent"
                    ? "Sent — awaiting release"
                    : item.state === "failed"
                      ? "Failed"
                      : "Ready"}
              </span>
              {item.error ? <span className="sendq__why">{item.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        className="btn"
        onClick={sendPhotos}
        disabled={pending !== null || photos.items.length === 0}
      >
        {pending === "photos" ? "Sending…" : "Send pictures"}
      </button>

      <p className="muted small">
        {describeAccepted(limits)}
        {limits ? `, up to ${limits.maxMb}MB each` : ""}. Pictures sent from this
        link are checked by the coordinators before they appear on the job — so
        they will not show above straight away. That is not a failed upload.
      </p>

      {completed ? (
        <p className="muted">This job is already marked complete.</p>
      ) : (
        <button
          type="button"
          className="btn btn--done"
          onClick={markComplete}
          disabled={pending !== null}
        >
          {pending === "complete" ? "Marking…" : "Work completed"}
        </button>
      )}

      <p className="muted small">
        Marking work complete sets the job to <strong>Job Completed</strong> for
        the coordinators to verify. It does not close the job on its own.
      </p>
    </section>
  );
}
