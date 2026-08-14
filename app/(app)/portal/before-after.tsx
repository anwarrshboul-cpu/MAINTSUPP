"use client";

/**
 * The fault, and the same thing fixed — side by side.
 *
 * The board has carried two picture columns since the monday import: "Pictures
 * of Maintenance Issue" and "Picture of completed works". 1,149 photographs in
 * one and 1,616 in the other, and until now the only way to compare them was to
 * open the evidence panel, scroll, remember what the first one looked like, and
 * scroll back. That is the comparison the whole pair exists for — it is what an
 * invoice is checked against, and what a client asks for when they doubt a job
 * was done.
 *
 * Shown on every job that has either kind, not only completed ones: a job in
 * progress with three fault photographs and no completion photograph is telling
 * you something too, and the empty half says which half is missing rather than
 * hiding.
 *
 * The images are thumbnails (`?thumb=1`) and open the full viewer on click, so
 * this costs a kilobyte a picture rather than the four megabytes an original
 * costs — the same decision the board cells make.
 */

import { useEffect, useState } from "react";
import { Icon } from "../../components";
import { MediaViewer, type MediaViewerFile } from "./media-viewer";
import type { AttachmentRecord } from "../../lib/types";

/** Photographs only. A PDF quote in the issue column is not a "before". */
function pictures(files: AttachmentRecord[], kind: string) {
  return files.filter(
    (file) => file.kind === kind && file.contentType.startsWith("image/"),
  );
}

function Half({
  title,
  hint,
  files,
  emptyLabel,
  onOpen,
}: {
  title: string;
  hint: string;
  files: AttachmentRecord[];
  emptyLabel: string;
  onOpen: (fileId: string) => void;
}) {
  return (
    <div className="before-after__half">
      <div className="before-after__head">
        <strong>{title}</strong>
        <span>{files.length}</span>
      </div>
      {files.length ? (
        <ul className="before-after__grid">
          {files.map((file) => (
            <li key={file.id}>
              <button
                type="button"
                title={file.originalName}
                onClick={(event) => {
                  // Focused explicitly so closing the viewer returns the ring
                  // here — Safari does not focus a button on tap.
                  event.currentTarget.focus();
                  onOpen(file.id);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${file.inlineUrl}?thumb=1`}
                  alt={file.originalName}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="before-after__empty">{emptyLabel}</p>
      )}
      <small className="before-after__hint">{hint}</small>
    </div>
  );
}

export function BeforeAfter({
  requestId,
  reference,
  refreshToken = 0,
}: {
  requestId: string;
  /** Named on the viewer so somebody knows which job they are looking at. */
  reference: string;
  /** Bumped by the drawer after an upload, so the pair re-reads. */
  refreshToken?: number;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [files, setFiles] = useState<AttachmentRecord[]>([]);

  /*
   * Its own fetch, rather than a prop.
   *
   * The drawer does not hold the attachment list — `EvidenceManager` fetches it
   * when opened, and it is not open when this panel is. Threading the list
   * through the drawer would mean loading every job's files on open for a
   * panel most readers scroll past; one request when this panel is on screen is
   * cheaper and keeps the two components independent.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch(
          `/api/files?requestId=${encodeURIComponent(requestId)}`,
          { headers: { accept: "application/json" } },
        );
        if (!response.ok || !live) return;
        const payload = (await response.json()) as { files?: AttachmentRecord[] };
        if (live) setFiles(payload.files ?? []);
      } catch {
        // The pair simply does not draw. The evidence panel is still the way
        // in, and an error banner here would be noise on a job with no photos.
      }
    })();
    return () => {
      live = false;
    };
  }, [requestId, refreshToken]);

  const before = pictures(files, "issue");
  const after = pictures(files, "completion");

  // Nothing to compare and nothing to say. The evidence panel still lists
  // whatever else is attached.
  if (!before.length && !after.length) return null;

  /*
   * One carousel across both halves, in order, so a swipe on a phone goes
   * fault → fault → fixed → fixed rather than stopping at the boundary. That
   * is the sequence somebody actually wants to move through.
   */
  const carousel: MediaViewerFile[] = [...before, ...after];

  return (
    <section className="before-after">
      <div className="before-after__title">
        <span className="drawer-label">Before and after</span>
        <span>
          {before.length} fault · {after.length} completed
        </span>
      </div>

      <div className="before-after__pair">
        <Half
          title="The fault"
          hint="Pictures of Maintenance Issue"
          files={before}
          emptyLabel="No photograph of the fault was filed."
          onOpen={setOpenId}
        />
        <div className="before-after__arrow" aria-hidden="true">
          <Icon name="arrow" size={18} />
        </div>
        <Half
          title="Completed"
          hint="Picture of completed works"
          files={after}
          emptyLabel="No photograph of the finished work yet."
          onOpen={setOpenId}
        />
      </div>

      {openId && (
        <MediaViewer
          files={carousel}
          currentId={openId}
          contextLabel={`${reference} — before and after`}
          onNavigate={setOpenId}
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  );
}
