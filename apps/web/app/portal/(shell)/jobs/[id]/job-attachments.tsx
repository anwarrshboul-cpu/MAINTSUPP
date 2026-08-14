"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../../../lib/api";
import {
  acceptAttribute,
  describeAccepted,
  useUploadQueue,
} from "../../../../../lib/uploads";
import type { JobAttachment } from "../../../../../lib/portal";
import { SignedFileButton, SignedImage } from "../../../../../components/signed-media";

/**
 * The photographs on a job: shown, added, and — for staff — reviewed.
 *
 * ── SHOWN ─────────────────────────────────────────────────────────────────
 * The bucket is private and `object_key` is a key, not a location, so each
 * tile mints its own short-lived signed URL in the browser when it comes into
 * view. See `components/signed-media.tsx`; the whole reason this page listed
 * filenames before is that nothing was calling that endpoint.
 *
 * ── REVIEWED ──────────────────────────────────────────────────────────────
 * An upload through a share link lands `pending`, invisible to the client,
 * until staff release it. This is the ONLY screen in the product where those
 * rows are visible — `GET /jobs/:id` filters them out and `GET /uploads/job/:id`
 * only returns them to staff — so if the release and discard controls are not
 * here, they have no caller anywhere and a contractor's photograph sits
 * unreviewed forever.
 *
 * Everything re-renders from the server after a write rather than patching
 * local state: whether a row is pending, and whether it may be seen at all, is
 * the API's answer to give.
 */

const KIND_LABEL: Record<JobAttachment["kind"], string> = {
  issue_picture: "Picture of the issue",
  completed_picture: "Picture of completed works",
  file: "Document",
};

export default function JobAttachments({
  jobId,
  attachments,
  canReview,
}: {
  jobId: string;
  attachments: JobAttachment[];
  /** Staff only. The uploader is not the reviewer — that is the point of the flag. */
  canReview: boolean;
}) {
  const router = useRouter();
  const queue = useUploadQueue(`/uploads/job/${jobId}`);
  const [kind, setKind] = useState<JobAttachment["kind"]>("completed_picture");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The row a release or discard is in flight for, so only its buttons lock. */
  const [reviewing, setReviewing] = useState<string | null>(null);

  const isImage = (file: JobAttachment) => file.content_type.startsWith("image/");
  const released = attachments.filter((file) => !file.pending);
  const awaiting = attachments.filter((file) => file.pending);
  const issue = released.filter((file) => file.kind === "issue_picture" && isImage(file));
  const done = released.filter((file) => file.kind === "completed_picture" && isImage(file));
  const documents = released.filter((file) => !isImage(file));

  async function review(id: string, action: "release" | "discard") {
    if (reviewing) return;
    setReviewing(id);
    setError(null);
    setNotice(null);
    const result = await api(`/uploads/${id}/${action}`, { method: "POST" });
    setReviewing(null);
    if (!result.ok) return setError(result.error);
    setNotice(
      action === "release"
        ? "Released. It is now part of the job record."
        : "Discarded. The file has been deleted.",
    );
    router.refresh();
  }

  async function upload() {
    if (queue.busy) return;
    if (queue.items.every((item) => item.state === "sent")) {
      return setError("Choose a file first.");
    }
    setError(null);
    setNotice(null);

    const { sent, failed } = await queue.send({ kind });
    if (failed > 0) {
      setError(`${failed} file${failed === 1 ? "" : "s"} did not upload — see below.`);
    }
    if (sent > 0) {
      setNotice(`${sent} file${sent === 1 ? "" : "s"} added.`);
      // Only the ones that arrived are forgotten; a failure stays on screen
      // with its reason, and pressing Upload again retries just those.
      if (failed === 0) queue.clear();
      router.refresh();
    }
  }

  const tile = (file: JobAttachment, note?: string) => (
    <SignedImage
      key={file.id}
      path={`/uploads/${file.id}/url`}
      name={file.original_name}
      note={note}
    >
      {file.pending && canReview ? (
        <span className="p-btnrow p-shotbtns">
          <button
            type="button"
            className="p-btn p-btn--sm"
            disabled={reviewing !== null}
            onClick={() => review(file.id, "release")}
          >
            Release
          </button>
          <button
            type="button"
            className="p-btn p-btn--ghost p-btn--danger p-btn--sm"
            disabled={reviewing !== null}
            onClick={() => review(file.id, "discard")}
          >
            Discard
          </button>
        </span>
      ) : null}
    </SignedImage>
  );

  return (
    <>
      {awaiting.length ? (
        <section className="p-panel">
          <h2>Awaiting release</h2>
          <p className="p-note">
            Uploaded through a share link, so nobody has verified who sent it.
            {canReview
              ? " Released files join the job record and become visible to the client; discarded ones are deleted from storage."
              : " A coordinator checks these before they appear on the job."}
          </p>
          <ul className="shots">
            {awaiting.map((file) =>
              isImage(file) ? (
                tile(file, `${file.uploaded_by_name ?? "Unknown"} · awaiting release`)
              ) : (
                <li key={file.id} className="p-files-row">
                  <span>{file.original_name}</span>
                  {canReview ? (
                    <span className="p-btnrow">
                      <button
                        type="button"
                        className="p-btn p-btn--sm"
                        disabled={reviewing !== null}
                        onClick={() => review(file.id, "release")}
                      >
                        Release
                      </button>
                      <button
                        type="button"
                        className="p-btn p-btn--ghost p-btn--danger p-btn--sm"
                        disabled={reviewing !== null}
                        onClick={() => review(file.id, "discard")}
                      >
                        Discard
                      </button>
                    </span>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        </section>
      ) : null}

      {issue.length ? (
        <section className="p-panel">
          <h2>Issue pictures</h2>
          <ul className="shots">{issue.map((file) => tile(file))}</ul>
        </section>
      ) : null}

      {done.length ? (
        <section className="p-panel">
          <h2>Completed works</h2>
          <ul className="shots">
            {done.map((file) =>
              tile(file, file.via_share_link ? "via share link" : undefined),
            )}
          </ul>
        </section>
      ) : null}

      {documents.length ? (
        <section className="p-panel">
          <h2>Files</h2>
          <ul className="p-files">
            {documents.map((file) => (
              <li key={file.id}>
                <span>{file.original_name}</span>
                <span className="p-muted p-small">
                  {Math.max(1, Math.round(Number(file.byte_size) / 1024))} KB
                </span>
                {/* Minted on the click, never with the page: a five-minute URL
                    rendered into HTML is dead before anyone scrolls to it. */}
                <SignedFileButton path={`/uploads/${file.id}/url`} name={file.original_name} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="p-panel">
        <h2>Add photographs</h2>

        <div aria-live="polite" aria-atomic="true">
          {error ? (
            <p className="alert alert--bad" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? <p className="alert alert--good">{notice}</p> : null}
        </div>

        <div className="p-grid2">
          <label className="p-field">
            <span>What is it</span>
            <select
              className="p-select"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as JobAttachment["kind"])
              }
              disabled={queue.busy}
            >
              {(Object.keys(KIND_LABEL) as JobAttachment["kind"][]).map((value) => (
                <option key={value} value={value}>
                  {KIND_LABEL[value]}
                </option>
              ))}
            </select>
          </label>

          <label className="p-field">
            <span>File</span>
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
        </div>

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
          {queue.limits ? `, up to ${queue.limits.maxMb}MB each` : ""}. Files added
          here are visible on the job immediately — they do not wait for release.
        </p>
      </section>
    </>
  );
}
