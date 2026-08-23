"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SignaturePad } from "./signature-pad";
import { ArrivalPack, type ArrivalPack as ArrivalPackData } from "./arrival-pack";

type Photo = {
  id: string;
  name: string;
  kind: string;
  contentType: string;
  url: string;
  thumbUrl: string;
};

/**
 * Where one kind of evidence is posted.
 *
 * Decided by the server, not here. `attachments.kind` and the board's file
 * columns are server vocabulary, and this page is a public document handed to
 * anyone with the URL — it should not carry a copy of either, and it should
 * not have to be redeployed when a board gains a column.
 */
type UploadSlot = {
  kind: string;
  storageKind: string;
  columnId: string | null;
};

type JobPayload = {
  requestId: string;
  job: {
    reference: string | null;
    title: string;
    description: string;
    location: string | null;
    status: string | null;
    priority: string | null;
    engineer: string | null;
    category: string | null;
    requestedAt: string | null;
    dueAt: string | null;
    completedAt: string | null;
    completionRequestedAt: string | null;
    completionRequestedBy: string | null;
  };
  site: {
    name: string;
    address: string;
    contact: string | null;
    /** L — every field nullable; the pack draws only what is recorded. */
    arrival?: ArrivalPackData | null;
  } | null;
  issuePhotos: Photo[];
  completionPhotos: Photo[];
  uploadSlots: UploadSlot[];
  permissions: {
    allowedKinds: string[];
    canComment: boolean;
    canRequestCompletion: boolean;
  };
  /** "viewer" is the Fix Tracker's read-only ticket link. */
  audience?: string;
  expiresAt: string;
};

type UploadState = { name: string; status: "uploading" | "done" | "failed"; error?: string };

const KIND_LABEL: Record<string, string> = {
  completion: "Photo of completed work",
  nameplate: "Equipment nameplate or model label",
  issue: "Photo of the problem",
  general: "Other file",
};

function formatDate(value: string | null) {
  if (!value) return null;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(when);
}

/**
 * A grid of photographs, thumbnails first.
 *
 * The originals in this workspace run to four and a half megabytes each, and
 * this page is read on mobile data in a service corridor. `?thumb=1` serves a
 * 96px WebP derivative — a couple of kilobytes — and the tile links to the full
 * image for anyone who wants it.
 *
 * `next/image` is deliberately not used, and its rule is disabled inline rather
 * than left to add a warning: the optimiser wants a known host and a known
 * size, and these bytes come out of R2 through the app's own file route at
 * whatever dimensions the engineer's phone produced. Every other photo surface
 * in this product renders a plain `<img>` for the same reason.
 */
function PhotoCard({ title, photos }: { title: string; photos: Photo[] }) {
  return (
    <section className="job-link__card">
      <h2>{title}</h2>
      <ul className="job-link__photos">
        {photos.map((photo) => (
          <li key={photo.id}>
            <a href={photo.url} target="_blank" rel="noreferrer" title={photo.name}>
              {photo.contentType.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo.thumbUrl} alt={photo.name} loading="lazy" />
              ) : (
                <span className="job-link__photo-file">{photo.name}</span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ContractorJobView({ token }: { token: string }) {
  const [data, setData] = useState<JobPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploads, setUploads] = useState<Record<string, UploadState[]>>({});
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [completedOn, setCompletedOn] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [blockedReason, setBlockedReason] = useState("Parts required");
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    const response = await fetch(`/api/job-link/${encodeURIComponent(token)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "This link is no longer valid.");
    return payload as JobPayload;
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await load();
        if (!cancelled) setData(payload);
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load this job. Check your connection.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function upload(slot: UploadSlot, files: FileList | null) {
    if (!files?.length || !data) return;
    const kind = slot.kind;
    for (const file of Array.from(files)) {
      setUploads((current) => ({
        ...current,
        [kind]: [...(current[kind] ?? []), { name: file.name, status: "uploading" }],
      }));

      const form = new FormData();
      form.append("file", file);
      /*
       * `requestId` — the whole reason contractor uploads never worked.
       *
       * `/api/files` answers 400 "A file and work order ID are required."
       * without it, and this page never sent one, so every upload from a
       * shared link failed. Proven against the running server: the same
       * request with the field is 201, without it 400.
       */
      form.append("requestId", data.requestId);
      /*
       * The STORAGE kind, not the slot's name. `attachments.kind` has three
       * values and "nameplate" is not one of them — `/api/files` coerces an
       * unknown kind to "issue" and then refuses it against a link that never
       * granted issue evidence. The server tells this page what to send.
       */
      form.append("kind", slot.storageKind);
      if (slot.columnId) form.append("columnId", slot.columnId);
      form.append("uploadToken", token);

      try {
        const response = await fetch("/api/files", { method: "POST", body: form });
        const ok = response.ok;
        const payload = ok ? null : await response.json().catch(() => ({}));
        setUploads((current) => ({
          ...current,
          [kind]: (current[kind] ?? []).map((entry) =>
            entry.name === file.name && entry.status === "uploading"
              ? {
                  ...entry,
                  status: ok ? "done" : "failed",
                  error: ok ? undefined : (payload?.error ?? "Upload failed"),
                }
              : entry,
          ),
        }));
      } catch {
        setUploads((current) => ({
          ...current,
          [kind]: (current[kind] ?? []).map((entry) =>
            entry.name === file.name && entry.status === "uploading"
              ? { ...entry, status: "failed", error: "Connection lost" }
              : entry,
          ),
        }));
      }
    }

    // Show what was actually stored, rather than only what was sent. An upload
    // that says "uploaded" but leaves the job looking unchanged is the thing
    // this page exists to avoid.
    try {
      setData(await load());
    } catch {
      // The upload is recorded; a failed refresh is cosmetic.
    }
  }

  /**
   * THE ONE SUBMIT.
   *
   * The page used to offer "Send this update" (the note path) beside "Mark
   * work complete" (the completion path), and an engineer writing the job up
   * on a phone had to decide which of two buttons the same form belonged to.
   * There is one button now. On a link that may request completion — the
   * normal contractor link — it IS the completion path: the server records
   * the note, the finish date and the signature together with the request,
   * so nothing the note button used to send is lost (see `completionUpdate`
   * in the route, which folds the note and the date into the comment). On a
   * comment-only link, where completion was never offered, the same button
   * sends the note as before.
   *
   * The evidence rule is the server's and is unchanged — a completion with
   * no photograph of the finished work is refused with the same message. The
   * page checks first only to save the round trip; the server is the rule.
   */
  async function submit() {
    if (!data) return;
    if (data.permissions.canRequestCompletion) {
      const sentCompletion = (uploads.completion ?? []).some((entry) => entry.status === "done");
      if (data.completionPhotos.length === 0 && !sentCompletion) {
        setError("Please upload a photo of the completed work before marking this done.");
        return;
      }
      await send("complete");
      return;
    }
    await send("note");
  }

  async function send(intent: "note" | "complete" | "blocked") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/job-link/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent,
          note,
          by: name,
          completedOn,
          /*
           * Only on a completion. A signature attached to a note or a blocked
           * report would be a mark against something nobody signed for.
           */
          ...(intent === "complete" && signature ? { signature } : {}),
          ...(intent === "blocked" ? { reason: blockedReason } : {}),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "That did not send.");
        return;
      }
      setSubmitted(
        payload.message ??
          (intent === "blocked"
            ? "Thanks — your coordinator has been told this could not be completed."
            : "Thanks, that has been sent."),
      );
      setBlockedOpen(false);
    } catch {
      setError("Could not send. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="job-link__status">Loading job…</p>;

  if (error && !data) {
    return (
      <div className="job-link__status job-link__status--error">
        <h1>Link not valid</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { job, site, issuePhotos, completionPhotos, uploadSlots, permissions } = data;
  const requested = formatDate(job.requestedAt);
  const due = formatDate(job.dueAt);
  const reportedDone = formatDate(job.completionRequestedAt);
  const expires = formatDate(data.expiresAt);
  /*
   * The Fix Tracker's Copy Link mints a "viewer" token: a read-only ticket.
   * Belt and braces with the grant itself — the scope carries no upload slots
   * and no write rights, and /api/job-link refuses every POST from it — but
   * drawing upload fields that can only fail would be showing controls that
   * lie, so none of the action sections render at all.
   */
  const readOnly =
    data.audience === "viewer" ||
    (uploadSlots.length === 0 && !permissions.canComment && !permissions.canRequestCompletion);

  return (
    <main className="job-link">
      <header className="job-link__head">
        <p className="job-link__brand">
          <span>MAINT</span>
          <strong>SUPP</strong>
        </p>
        {job.reference && <p className="job-link__ref">{job.reference}</p>}
        <h1>{job.title}</h1>
        {job.priority && (
          <span className={`job-link__priority is-${job.priority.toLowerCase()}`}>
            {job.priority}
          </span>
        )}
      </header>

      {(site || job.location) && (
        <section className="job-link__card">
          <h2>Where</h2>
          {/* The location as typed on the board comes first: it is the store
              the engineer was told to attend, and it does not always match the
              site record's name. */}
          <p className="job-link__site">{job.location || site?.name}</p>
          {site && job.location && job.location !== site.name && (
            <p className="job-link__muted">{site.name}</p>
          )}
          {site?.address && <p className="job-link__muted">{site.address}</p>}
          {site?.contact && <p className="job-link__muted">Contact: {site.contact}</p>}
          {site?.address && (
            <a
              className="job-link__map"
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                `${site.name} ${site.address}`,
              )}`}
              target="_blank"
              rel="noreferrer"
            >
              Open in Maps
            </a>
          )}
        </section>
      )}

      {/*
        L — how to get in, who to ask for, and what went wrong last time.
        
        Directly under "Where", because that is the order the questions arrive
        in: what is the address, then how do I get through the door. Collapsed
        by default so the job itself stays above the fold on a phone; the
        summary line says whether opening it is worth the tap.
      */}
      {site?.arrival && <ArrivalPack pack={site.arrival} />}

      <section className="job-link__card">
        <h2>What needs doing</h2>
        <p>{job.description || "No description was given."}</p>
        <dl className="job-link__facts">
          {job.status && (
            <>
              <dt>Status</dt>
              <dd>{job.status}</dd>
            </>
          )}
          {job.engineer && (
            <>
              <dt>Trade</dt>
              <dd>{job.engineer}</dd>
            </>
          )}
          {job.category && (
            <>
              <dt>Category</dt>
              <dd>{job.category}</dd>
            </>
          )}
          {requested && (
            <>
              <dt>Reported</dt>
              <dd>{requested}</dd>
            </>
          )}
          {due && (
            <>
              <dt>Due</dt>
              <dd>{due}</dd>
            </>
          )}
          {reportedDone && (
            <>
              <dt>Reported complete</dt>
              <dd>
                {reportedDone}
                {job.completionRequestedBy ? ` — ${job.completionRequestedBy}` : ""}
              </dd>
            </>
          )}
        </dl>
      </section>

      {issuePhotos.length > 0 && (
        <PhotoCard title="Photos of the problem" photos={issuePhotos} />
      )}

      {completionPhotos.length > 0 && (
        <PhotoCard
          /* A viewer did not send these; a contractor did. Say which is true. */
          title={readOnly ? "Photos of the completed work" : "Photos you have sent"}
          photos={completionPhotos}
        />
      )}

      {readOnly ? (
        <section className="job-link__card">
          <h2>View only</h2>
          <p>
            This link shows the job&apos;s status and photographs. It cannot upload,
            comment or mark work complete.
          </p>
        </section>
      ) : submitted ? (
        <section className="job-link__card job-link__card--done">
          <h2>Sent</h2>
          <p>{submitted}</p>
        </section>
      ) : (
        <>
          <section className="job-link__card">
            <h2>Upload your evidence</h2>
            {uploadSlots.map((slot) => (
              <div key={slot.kind} className="job-link__upload">
                <label htmlFor={`file-${slot.kind}`}>
                  {KIND_LABEL[slot.kind] ?? slot.kind}
                </label>
                {slot.kind === "nameplate" && (
                  <p className="job-link__hint">
                    A clear shot of the model plate saves a second visit next time
                    this fails.
                  </p>
                )}
                <input
                  id={`file-${slot.kind}`}
                  ref={(element) => {
                    inputs.current[slot.kind] = element;
                  }}
                  type="file"
                  accept="image/*,video/*"
                  capture="environment"
                  multiple
                  onChange={(event) => void upload(slot, event.target.files)}
                />
                <ul className="job-link__uploads">
                  {(uploads[slot.kind] ?? []).map((entry, index) => (
                    <li key={`${entry.name}-${index}`} className={`is-${entry.status}`}>
                      {entry.name}
                      {entry.status === "uploading" && " — uploading…"}
                      {entry.status === "done" && " — uploaded"}
                      {entry.status === "failed" && ` — ${entry.error}`}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <section className="job-link__card">
            <h2>Your details</h2>
            <label htmlFor="by">Your name</label>
            <input
              id="by"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
            />
            {/* The date the work was actually finished, which is not always
                the date this form is filled in — an engineer often writes the
                job up the following morning. Recorded as the completion date
                the contractor reported; the coordinator still closes the job. */}
            <label htmlFor="completedOn">Date the work was completed</label>
            <input
              id="completedOn"
              type="date"
              value={completedOn}
              onChange={(event) => setCompletedOn(event.target.value)}
            />
            {/*
              K — the mark that goes with the name and the time.
              
              Optional: a contractor who has done the work and photographed it
              must not be stranded by a canvas that will not cooperate on their
              device. Where it is given, the server records it with its own
              timestamp — a signing time the device could set is not a record
              of anything.
            */}
            {permissions.canRequestCompletion && (
              <SignaturePad onChange={setSignature} disabled={busy} />
            )}
            {permissions.canComment && (
              <>
                <label htmlFor="note">Notes (optional)</label>
                <textarea
                  id="note"
                  rows={4}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Anything the coordinator should know"
                />
              </>
            )}
          </section>

          {error && (
            <p className="job-link__error" role="alert">
              {error}
            </p>
          )}

          <div className="job-link__actions">
            {/* One primary action. The note, the date, the signature and the
                photographs all travel with it — see `submit` above. */}
            {(permissions.canRequestCompletion || permissions.canComment) && (
              <button
                type="button"
                className="job-link__primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                Submit
              </button>
            )}
            <button
              type="button"
              className="job-link__secondary"
              disabled={busy}
              onClick={() => setBlockedOpen(!blockedOpen)}
            >
              I could not complete this
            </button>
          </div>

          {blockedOpen && (
            <section className="job-link__card">
              <h2>What stopped you?</h2>
              <select
                aria-label="Reason"
                value={blockedReason}
                onChange={(event) => setBlockedReason(event.target.value)}
              >
                {[
                  "Parts required",
                  "No access",
                  "Needs a specialist",
                  "Further works needed",
                  "Health and safety concern",
                ].map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="job-link__primary"
                disabled={busy}
                onClick={() => void send("blocked")}
              >
                Send
              </button>
            </section>
          )}
        </>
      )}

      <footer className="job-link__foot">
        {expires && <p>This link works until {expires}.</p>}
        <p>Maintsupp · +44 7852 224644 · Mon–Fri 8:30am–5:30pm</p>
      </footer>
    </main>
  );
}
