"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SignaturePad } from "./signature-pad";
import { ArrivalPack, type ArrivalPack as ArrivalPackData } from "./arrival-pack";
import { uploadEvidenceFile } from "../../../lib/client-upload";
import type { AttachmentKind } from "../../../lib/types";

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
  /*
   * The value `attachments.kind` will actually be written as — three values,
   * and "nameplate" is not one of them. Typed as `AttachmentKind` rather than
   * `string` because it is handed straight to `uploadEvidenceFile`, and a
   * widened string there would let a slot name reach the uploader as a storage
   * kind. `storageKindFor` on the server is what narrows it; this is the
   * client-side end of the same agreement.
   */
  storageKind: AttachmentKind;
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
  /**
   * "viewer" is a read-only ticket grant. Nothing in the product mints one
   * any more — the Fix Tracker's Copy Link used to, and the owner cancelled
   * that rule — but the grant is still honoured, because links issued under
   * the old rule are in people's hands and must keep behaving as promised.
   */
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
function PhotoCard({
  title,
  photos,
  empty,
}: {
  title: string;
  photos: Photo[];
  /*
   * What to say when there are none.
   *
   * A working link never passes this, and its two galleries still only render
   * when they have something in them — an engineer standing in front of the
   * fault does not need telling that nobody has photographed it yet. A
   * read-only ticket does: it is a record of a job, read rather than worked,
   * and "Photos of the problem" quietly not existing reads as "there were
   * none" when what is true is "none have been added". Absence and emptiness
   * are different facts and this component has to be able to say both.
   *
   * Only a `viewer` token reaches that branch now. The prop stays because
   * those tokens are still in circulation and the distinction it draws is
   * still the right one for them.
   */
  empty?: string;
}) {
  if (!photos.length) {
    if (!empty) return null;
    return (
      <section className="job-link__card">
        <h2>{title}</h2>
        <p className="job-link__muted">{empty}</p>
      </section>
    );
  }
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

      /*
       * THE SHARED UPLOADER, not a bare POST — which is what a phone photograph
       * needs and what this page was not doing.
       *
       * It used to build a FormData and `fetch("/api/files")` directly. That
       * works up to the platform's request ceiling and then stops dead:
       * measured through this page into the completion slot, 480 KB and 1.01 MB
       * were accepted and 1.92 MB and 3.99 MB came back 413, shown to the
       * contractor as "Upload failed" with no reason and no remedy. A photograph
       * off any current phone is 2–5 MB, so the ordinary case was the broken one.
       *
       * `uploadEvidenceFile` is the same helper the dashboard's file cell uses:
       * it sends anything over `DIRECT_UPLOAD_LIMIT` (900 KB) through
       * `/api/files/multipart` in chunks, retries a direct upload that 413s, and
       * offers a WebP thumbnail afterwards so the board draws a thumbnail rather
       * than the original. It also enforces the real size ceilings — 25 MB, or
       * 90 MB for video — with a sentence a human can act on.
       *
       * This was never a regression: the page always posted directly, and the
       * contractor link had the same ceiling. What changed is who is standing in
       * front of it. The Fix Tracker link is now a working link, so this is the
       * surface every recipient uses to send completion evidence from a phone,
       * and the failure that was rare became the default.
       *
       * `slot.storageKind` stays the value sent: `attachments.kind` has three
       * values and "nameplate" is not one of them — the server tells this page
       * which storage kind a slot writes, and the helper passes it through
       * unchanged.
       */
      try {
        await uploadEvidenceFile({
          file,
          requestId: data.requestId,
          kind: slot.storageKind,
          columnId: slot.columnId ?? undefined,
          uploadToken: token,
        });
        setUploads((current) => ({
          ...current,
          [kind]: (current[kind] ?? []).map((entry) =>
            entry.name === file.name && entry.status === "uploading"
              ? { ...entry, status: "done", error: undefined }
              : entry,
          ),
        }));
      } catch (error) {
        /*
         * The helper throws a message written for a person — "Files must be
         * 25 MB or smaller", or whatever the API refused with — so it is shown
         * rather than replaced with a generic failure. Only a genuinely
         * unlabelled throw falls back.
         */
        const reason =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Upload failed";
        setUploads((current) => ({
          ...current,
          [kind]: (current[kind] ?? []).map((entry) =>
            entry.name === file.name && entry.status === "uploading"
              ? { ...entry, status: "failed", error: reason }
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
   * A "viewer" token is a read-only ticket, and this is where the page stops
   * offering what such a token cannot do.
   *
   * It is belt and braces with the grant itself — the scope carries no upload
   * slots and no write rights, and /api/job-link refuses every POST from it —
   * but drawing upload fields that can only fail would be showing controls
   * that lie, so none of the action sections render at all.
   *
   * WHO STILL ARRIVES HERE READ-ONLY: only a `viewer` token. The Fix Tracker's
   * Copy Link minted one until the owner cancelled the view-only rule; it now
   * mints the same `contractor` grant a coordinator's own link uses, so a Fix
   * Tracker link takes the working branch below and gets the whole workflow.
   * Viewer links already sent out keep landing on this branch, which is the
   * reason it stays.
   *
   * The second clause is the fallback, and it is not decoration: a contractor
   * grant hand-narrowed to nothing would otherwise render an upload card with
   * no slots in it and a Submit button that refuses.
   */
  const readOnly =
    data.audience === "viewer" ||
    (uploadSlots.length === 0 && !permissions.canComment && !permissions.canRequestCompletion);

  return (
    /*
     * ONE PAGE, TWO AUDIENCES, AND THE MODIFIER THAT KEEPS THEM ONE PAGE.
     *
     * Every public job link is the same route rendering the same component
     * through the same stylesheet; the only difference between them is the
     * grant. Which means the read-only ticket was never a different design —
     * it was this design with three sections missing, ending on a card that
     * looked exactly like the job data above it.
     *
     * Since the owner cancelled the view-only rule the Fix Tracker's own links
     * are contractor grants, so they no longer take this modifier at all. It
     * remains for the viewer tokens that are still out there, and remains
     * scoped, so the day one is opened it is still a designed page and not a
     * subtraction.
     *
     * `job-link--readonly` is how the read-only composition gets to be a
     * first-class member of that design system rather than a subtraction from
     * it: every rule written for it is written under this class, so nothing on
     * the contractor page can move, and the two can never drift into two
     * stylesheets.
     */
    <main className={`job-link${readOnly ? " job-link--readonly" : ""}`}>
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
        {/*
          Said at the top, not only at the bottom.
          
          The "View only" card at the foot of this page is the explanation;
          this is the label. A reader who has been sent a ticket should not have
          to scroll past five cards looking for a button before finding out
          there was never going to be one.
          
          Deliberately a sibling of the priority pill rather than a wrapper
          around both: the contractor page renders this header too, and giving
          it a new flex parent would have moved its pill by whatever the line
          box and the flex box disagree about. Nothing the contractor sees may
          move, so nothing the contractor sees is re-parented.
        */}
        {readOnly && <span className="job-link__viewonly">View only</span>}
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

      <PhotoCard
        title="Photos of the problem"
        photos={issuePhotos}
        empty={readOnly ? "None have been added to this job yet." : undefined}
      />

      <PhotoCard
        /* A viewer did not send these; a contractor did. Say which is true. */
        title={readOnly ? "Photos of the completed work" : "Photos you have sent"}
        photos={completionPhotos}
        empty={readOnly ? "None have been added to this job yet." : undefined}
      />

      {readOnly ? (
        /*
         * THE PLAIN CARD, deliberately — and this reverses an earlier judgement
         * of mine, on the owner's instruction.
         *
         * It was a tinted `--note` block with a coloured left edge, reasoned
         * from the fact that this is the only section on the page which is not
         * a fact about the job. That reasoning is not wrong in isolation, but
         * it made this page's closing block the ONE container on either public
         * link that belongs to neither page's vocabulary — which is exactly
         * what "the shared link still looks like its own old thing" means when
         * the rest of the page is already identical to the contractor's.
         *
         * So it takes the same white ground, the same border, the same radius,
         * the same padding and the same heading treatment as every other card
         * here, and sits in the same slot the contractor's action area sits in.
         * The read-only fact is carried where it belongs instead: by the "View
         * only" pill beside the priority in the header, which is stated once,
         * up front, before the reader has scrolled anywhere.
         */
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
