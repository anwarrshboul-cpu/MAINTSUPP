"use client";

/**
 * AN ASSET'S PHOTOGRAPHS, MANUALS AND DATASHEETS.
 *
 * ── NO SECOND FILE SYSTEM ──────────────────────────────────────────────────
 *
 * Every byte here goes through `uploadEvidenceFile`, and that is not a
 * preference. That helper owns three things a hand-rolled `fetch("/api/files")`
 * silently loses: the ~1 MiB ceiling the Workers form parser enforces with a
 * bare-text 413 carrying no JSON `error`, the multipart fallback above
 * `DIRECT_UPLOAD_LIMIT`, and the WebP thumbnail the register's 40px squares are
 * drawn from. A photograph taken on a phone is over the direct limit every
 * time, so a screen that skipped the helper would work in testing with small
 * files and fail for every real user.
 *
 * The anchor is `unitId`. `attachments.unit_id` already exists, already has an
 * index, and `anchorReferencesRefusal` already proves the unit belongs to the
 * caller's workspace before a single byte reaches the bucket — so an asset's
 * files are tenant-isolated by the same check that protects a job's evidence,
 * rather than by a new one written here.
 *
 * `siteId` travels with it so the document is filed against the store as well,
 * which is what puts an asset's datasheet in that site's Documents tab.
 */

import { useRef, useState } from "react";
import { Icon } from "../../../components";
import { uploadEvidenceFile } from "../../../lib/client-upload";
import { api, formatDate } from "../sites/site-types";
import { fileSize, isImage, type AssetFileRow } from "./asset-types";

export function AssetFiles({
  assetId,
  siteId,
  files,
  primaryImageId,
  canEdit,
  onChanged,
  onNotify,
}: {
  assetId: string;
  siteId: string;
  files: AssetFileRow[];
  primaryImageId: string | null;
  canEdit: boolean;
  onChanged: () => void;
  onNotify: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function upload(list: FileList | null) {
    if (!list || !list.length) return;
    setBusy(true);
    setProblem("");
    try {
      for (const file of Array.from(list)) {
        await uploadEvidenceFile({
          file,
          kind: "general",
          unitId: assetId,
          siteId,
          title: file.name,
        });
      }
      onNotify(`${list.length} file${list.length === 1 ? "" : "s"} added.`);
      onChanged();
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The upload did not complete.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function makePrimary(fileId: string) {
    try {
      await api("/api/assets", {
        method: "PATCH",
        body: { id: assetId, data: { primaryImageId: fileId } },
      });
      onNotify("Primary image set.");
      onChanged();
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "That image could not be set.");
    }
  }

  /*
   * ARCHIVE, not delete. The bytes and the row survive, the document simply
   * stops being live, and it can be brought back — which is the same promise
   * every other document surface in the product makes. Permanent removal lives
   * behind `data.delete` on `DELETE /api/files/[id]`, and is deliberately not
   * offered from here.
   */
  async function archive(file: AssetFileRow) {
    if (
      !window.confirm(
        `Remove "${file.title ?? file.originalName}" from this asset?\n\n` +
          "It is archived rather than destroyed, so it can be brought back.",
      )
    ) {
      return;
    }
    try {
      await api(`/api/files/${encodeURIComponent(file.id)}`, {
        method: "PATCH",
        body: { archived: true },
      });
      onNotify("File removed.");
      onChanged();
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The file could not be removed.");
    }
  }

  return (
    <div className="asset-files">
      {canEdit ? (
        <div className="asset-files__actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => input.current?.click()}
            disabled={busy}
          >
            <Icon name="upload" size={15} /> {busy ? "Uploading…" : "Add photos or files"}
          </button>
          {/*
            NOT A TAB STOP. The visible button above is the control; leaving
            this focusable put a keyboard user on an invisible input with no
            focus ring, which is the WCAG 2.4.7 dead stop the Sites screen
            documents on its own CSV picker.
          */}
          <input
            ref={input}
            type="file"
            multiple
            tabIndex={-1}
            className="visually-hidden"
            onChange={(event) => upload(event.target.files)}
          />
          <p className="ops-card__note">
            Photographs, manuals, datasheets, warranty documents and supplier PDFs. Set one
            photograph as the primary image and it becomes the asset&rsquo;s thumbnail on the
            register.
          </p>
        </div>
      ) : null}

      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}

      {files.length === 0 ? (
        <p className="ops-empty">No photos or files yet.</p>
      ) : (
        <ul className="asset-files__list">
          {files.map((file) => {
            const primary = file.id === primaryImageId;
            return (
              <li key={file.id} className="asset-files__item">
                {isImage(file.contentType) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="asset-files__thumb"
                    src={`/api/files/${file.id}?thumb=1`}
                    alt={file.title ?? file.originalName}
                    width={56}
                    height={56}
                    loading="lazy"
                  />
                ) : (
                  <span className="asset-files__thumb asset-files__thumb--doc" aria-hidden="true">
                    <Icon name="document" size={20} />
                  </span>
                )}
                <div className="asset-files__meta">
                  <a className="ops-link" href={file.downloadUrl}>
                    {file.title ?? file.originalName}
                  </a>
                  <span className="asset-subline">
                    {[fileSize(file.byteSize), formatDate(file.createdAt), file.uploadedByEmail]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {primary ? <span className="asset-files__badge">Primary image</span> : null}
                </div>
                {canEdit ? (
                  <div className="asset-files__row-actions">
                    {isImage(file.contentType) && !primary ? (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => makePrimary(file.id)}
                      >
                        Make primary
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => archive(file)}
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
