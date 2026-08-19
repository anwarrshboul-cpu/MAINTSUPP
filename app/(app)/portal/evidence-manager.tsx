"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components";
import { uploadEvidenceFile } from "../../lib/client-upload";
import {
  MediaViewer,
  glyphFor,
  humanSize,
  isViewableMedia,
  openTargetFor,
} from "./media-viewer";
import type {
  AttachmentKind,
  AttachmentRecord,
  MaintenanceBoardFilePreview,
  MaintenanceRequest,
} from "../../lib/types";

const tabs: Array<{ value: AttachmentKind | "all"; label: string }> = [
  { value: "all", label: "All files" },
  { value: "issue", label: "Issue evidence" },
  { value: "completion", label: "Completed works" },
  { value: "general", label: "Other files" },
];

/**
 * Send a file where it can actually be read.
 *
 * A PDF goes to its own tab and a .docx or a .zip downloads — neither has any
 * business being handed to an `<img>`. An anchor is created and clicked rather
 * than calling `window.open`, because `window.open` is what pop-up blockers
 * look for and this is a plain navigation either way.
 */
function followFileTarget(target: { mode: "tab" | "download"; href: string }) {
  const anchor = document.createElement("a");
  anchor.href = target.href;
  if (target.mode === "tab") {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  } else {
    anchor.download = "";
  }
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function kindLabel(kind: AttachmentKind) {
  return {
    issue: "Issue evidence",
    completion: "Completed works",
    general: "Other file",
  }[kind];
}

function FilePreview({
  file,
  compact = false,
}: {
  file: AttachmentRecord;
  compact?: boolean;
}) {
  if (file.contentType.startsWith("image/")) {
    /*
     * The 96px WebP derivative, not the original.
     *
     * These tiles are 155px tall and there can be dozens of them in one
     * section. Pointing them at `inlineUrl` meant opening a work order with
     * twenty photographs pulled twenty full-size camera JPEGs — measured at
     * 146 KB becoming 1.1 KB per tile. `?thumb=1` degrades to the original
     * when no derivative was generated, so a new upload is heavier, never
     * broken.
     */
    return (
      <img
        src={`/api/files/${file.id}?thumb=1`}
        alt={file.originalName}
        loading="lazy"
        decoding="async"
      />
    );
  }
  if (file.contentType.startsWith("video/")) {
    return (
      <video
        src={file.inlineUrl}
        muted
        playsInline
        preload="metadata"
        onMouseEnter={(event) => event.currentTarget.play().catch(() => undefined)}
        onMouseLeave={(event) => {
          event.currentTarget.pause();
          event.currentTarget.currentTime = 0;
        }}
      />
    );
  }
  return (
    <span className={compact ? "evidence-document is-compact" : "evidence-document"}>
      {/* The right glyph, not a generic one: a PDF, a spreadsheet and a zip
          are three different things to someone scanning a section. */}
      <Icon name={glyphFor(file.contentType)} size={compact ? 20 : 34} />
      <small>{file.originalName.split(".").pop()?.toUpperCase() || "FILE"}</small>
    </span>
  );
}

export function EvidenceManager({
  request,
  initialKind = "all",
  columnId,
  columnTitle,
  onClose,
  onRequestChange,
  onFileCountChange,
  onNotify,
}: {
  request: MaintenanceRequest;
  initialKind?: AttachmentKind | "all";
  columnId?: string;
  columnTitle?: string;
  onClose: () => void;
  onRequestChange: (request: MaintenanceRequest) => void;
  onFileCountChange?: (count: number) => void;
  onNotify: (message: string) => void;
}) {
  const [files, setFiles] = useState<AttachmentRecord[]>([]);
  const [tab, setTab] = useState<AttachmentKind | "all">(initialKind);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const fileCountCallbackRef = useRef(onFileCountChange);

  useEffect(() => {
    fileCountCallbackRef.current = onFileCountChange;
  }, [onFileCountChange]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/files?requestId=${encodeURIComponent(request.id)}${
            columnId ? `&columnId=${encodeURIComponent(columnId)}` : ""
          }`,
          { headers: { Accept: "application/json" } },
        );
        const payload = (await response.json()) as {
          files?: AttachmentRecord[];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || "Files could not be loaded.");
        if (active) {
          const nextFiles = payload.files ?? [];
          setFiles(nextFiles);
          fileCountCallbackRef.current?.(nextFiles.length);
        }
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Files could not be loaded.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [columnId, request.id]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      // The viewer is a surface on top of this one and stops the event at the
      // window when it handles it. This guard is the belt to that braces: one
      // press closes one surface, innermost first, in either order of setup.
      if (event.key === "Escape" && !viewerId) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, viewerId]);

  const visibleFiles = useMemo(
    () =>
      columnId || tab === "all"
        ? files
        : files.filter((file) => file.kind === tab),
    [columnId, files, tab],
  );
  /*
   * What the viewer may page through.
   *
   * Only the pictures and video in the section that was opened, so a swipe
   * can never land on a Word document rendered as a broken image. The other
   * files are still in the grid behind, where tapping one downloads it or
   * opens it in its own tab.
   */
  const viewableFiles = useMemo(
    () => visibleFiles.filter((file) => isViewableMedia(file.contentType)),
    [visibleFiles],
  );
  const viewer = viewableFiles.find((file) => file.id === viewerId) ?? null;
  const uploadKind: AttachmentKind =
    columnId || tab === "all" ? "general" : tab;

  /** Open a file the way its type deserves. */
  function openFile(file: AttachmentRecord) {
    const target = openTargetFor(file);
    if (target.mode === "viewer") setViewerId(file.id);
    else followFileTarget(target);
  }

  async function uploadSelected(selected: File[]) {
    if (!selected.length) return;
    setUploading(true);
    setUploadProgress(0);
    setError(null);
    let latestRequest = request;
    let completed = 0;
    const failures: string[] = [];
    for (const [index, file] of selected.entries()) {
      try {
        const payload = await uploadEvidenceFile({
          file,
          requestId: request.id,
          kind: uploadKind,
          columnId,
          onProgress: (progress) =>
            setUploadProgress(
              Math.round(((index + progress / 100) / selected.length) * 100),
            ),
        });
        setFiles((current) => {
          const next = [payload.file, ...current];
          onFileCountChange?.(next.length);
          return next;
        });
        if (payload.request) latestRequest = payload.request;
        completed += 1;
      } catch (caught) {
        failures.push(
          caught instanceof Error ? caught.message : `Could not upload ${file.name}.`,
        );
      }
    }
    if (completed) {
      onRequestChange(latestRequest);
      onNotify(`${completed} file${completed === 1 ? "" : "s"} added to ${request.id}.`);
      /*
       * The board's thumbnail strips draw from `fileCounts[].preview`, which
       * only arrives with the board payload — so a new photograph used to stay
       * invisible until a full page reload. This is the app's own refresh
       * convention (see live-board.tsx, raise-ticket.tsx): the board re-fetches
       * its data and repaints in place, previews included, for the system photo
       * columns as well as custom ones. Not a page reload.
       */
      window.dispatchEvent(new Event("maintsupp:refresh-board"));
    }
    if (failures.length) setError(failures.join(" "));
    setUploading(false);
    setUploadProgress(0);
    if (inputRef.current) inputRef.current.value = "";
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (mediaInputRef.current) mediaInputRef.current.value = "";
    if (documentInputRef.current) documentInputRef.current.value = "";
  }

  async function deleteFile(file: AttachmentRecord) {
    if (!window.confirm(`Delete ${file.originalName}? This cannot be undone.`)) return;
    setMenuId(null);
    try {
      const response = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
      const payload = (await response.json()) as {
        request?: MaintenanceRequest;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "The file could not be deleted.");
      setFiles((current) => {
        const next = current.filter((item) => item.id !== file.id);
        onFileCountChange?.(next.length);
        return next;
      });
      if (payload.request) onRequestChange(payload.request);
      /* A removed photo must leave the board's thumbnail strip too. */
      window.dispatchEvent(new Event("maintsupp:refresh-board"));
      if (viewerId === file.id) {
        // Deleting from inside the viewer moves to the next picture rather
        // than throwing you back to the grid, which is what monday does and
        // what anyone clearing out a bad batch expects.
        const at = viewableFiles.findIndex((item) => item.id === file.id);
        const successor = viewableFiles[at + 1] ?? viewableFiles[at - 1] ?? null;
        setViewerId(successor?.id ?? null);
      }
      onNotify(`${file.originalName} deleted.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be deleted.");
    }
  }

  return (
    <div className="evidence-manager" role="dialog" aria-modal="true">
      <button className="evidence-manager__scrim" type="button" onClick={onClose} />
      <section className="evidence-manager__panel">
        <header className="evidence-manager__header">
          <div>
            <span>
              {request.id} · {columnTitle || "Files & evidence"}
            </span>
            <h2>{request.title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close files">
            <Icon name="close" size={21} />
          </button>
        </header>

        <div className="evidence-manager__toolbar">
          {columnId ? (
            <div className="evidence-custom-column">
              <span><Icon name="folder" size={16} /></span>
              <div>
                <strong>{columnTitle || "Files"}</strong>
                <small>{files.length} file{files.length === 1 ? "" : "s"}</small>
              </div>
            </div>
          ) : (
            <div className="evidence-tabs">
              {tabs.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={tab === item.value ? "is-active" : ""}
                  onClick={() => setTab(item.value)}
                >
                  {item.label}
                  <small>
                    {item.value === "all"
                      ? files.length
                      : files.filter((file) => file.kind === item.value).length}
                  </small>
                </button>
              ))}
            </div>
          )}
          <label className="primary-button evidence-upload">
            <Icon name="upload" size={17} />
            {uploading ? `Uploading ${uploadProgress}%` : "Add files"}
            <input
              ref={inputRef}
              type="file"
              multiple
              disabled={uploading}
              accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
              onChange={(event) =>
                uploadSelected(Array.from(event.currentTarget.files ?? []))
              }
            />
          </label>
        </div>

        <p className="evidence-manager__hint">
          Upload images, videos, PDFs, Office files or ZIPs. Standard files up to 25 MB;
          videos up to 90 MB. Large videos upload safely in smaller parts.
        </p>
        <div className="evidence-mobile-actions" aria-label="Add files from this device">
          <label>
            <span><Icon name="camera" size={20} /></span>
            <strong>Take photo</strong>
            <small>Use the camera</small>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              disabled={uploading}
              onChange={(event) =>
                void uploadSelected(Array.from(event.currentTarget.files ?? []))
              }
            />
          </label>
          <label>
            <span><Icon name="image" size={20} /></span>
            <strong>Photos & videos</strong>
            <small>Choose from gallery</small>
            <input
              ref={mediaInputRef}
              type="file"
              multiple
              accept="image/*,video/*"
              disabled={uploading}
              onChange={(event) =>
                void uploadSelected(Array.from(event.currentTarget.files ?? []))
              }
            />
          </label>
          <label>
            <span><Icon name="document" size={20} /></span>
            <strong>Browse files</strong>
            <small>Documents or ZIPs</small>
            <input
              ref={documentInputRef}
              type="file"
              multiple
              accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
              disabled={uploading}
              onChange={(event) =>
                void uploadSelected(Array.from(event.currentTarget.files ?? []))
              }
            />
          </label>
          {uploading && (
            <div className="evidence-mobile-progress" role="status">
              <span><i style={{ width: `${uploadProgress}%` }} /></span>
              <strong>Uploading… {uploadProgress}%</strong>
            </div>
          )}
        </div>
        {error && (
          <div className="form-error evidence-error" role="alert">
            <Icon name="alert" size={17} />
            {error}
          </div>
        )}

        <div className="evidence-manager__content">
          {loading ? (
            <div className="evidence-empty">Loading files…</div>
          ) : visibleFiles.length ? (
            <div className="evidence-grid">
              {visibleFiles.map((file) => (
                <article className="evidence-card" key={file.id}>
                  <button
                    className="evidence-card__preview"
                    type="button"
                    /*
                     * Focus itself before opening.
                     *
                     * The viewer restores focus to whatever was focused when
                     * it opened, and a tap does not reliably focus a button —
                     * Safari on macOS and iOS both leave `activeElement` on
                     * the body. Without this, closing with Esc dropped a
                     * keyboard user at the top of the document instead of
                     * back on the thumbnail they had just been looking at.
                     */
                    onClick={(event) => {
                      event.currentTarget.focus();
                      openFile(file);
                    }}
                    title={`Open ${file.originalName}`}
                  >
                    <FilePreview file={file} />
                    {file.contentType.startsWith("video/") && (
                      <span className="evidence-play">▶</span>
                    )}
                  </button>
                  <button
                    className="evidence-card__menu-button"
                    type="button"
                    aria-label={`Actions for ${file.originalName}`}
                    onClick={() => setMenuId((current) => current === file.id ? null : file.id)}
                  >
                    <Icon name="more" size={18} />
                  </button>
                  {menuId === file.id && (
                    <div className="evidence-card__menu">
                      <button type="button" onClick={() => { openFile(file); setMenuId(null); }}>
                        <Icon name="grid" size={15} />
                        {isViewableMedia(file.contentType)
                          ? "Preview file"
                          : file.contentType === "application/pdf"
                            ? "Open in a new tab"
                            : "Open file"}
                      </button>
                      <a href={file.downloadUrl} download>
                        <Icon name="download" size={15} /> Download file
                      </a>
                      <button type="button" className="is-danger" onClick={() => deleteFile(file)}>
                        <Icon name="close" size={15} /> Delete file
                      </button>
                    </div>
                  )}
                  <footer>
                    <strong title={file.originalName}>{file.originalName}</strong>
                    <span>
                      {columnTitle || kindLabel(file.kind)} · {humanSize(file.byteSize)}
                    </span>
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            <div className="evidence-empty">
              <span><Icon name="folder" size={26} /></span>
              <strong>No files in this section yet</strong>
              <p>Add photos, videos, documents or other evidence directly from here.</p>
              <button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}>
                <Icon name="plus" size={16} /> Add first file
              </button>
            </div>
          )}
        </div>
      </section>

      {viewer && (
        <MediaViewer
          files={viewableFiles}
          currentId={viewer.id}
          /*
           * The column, not the work order's id. `request.id` is a 32-character
           * hex string on this estate, and it ate the whole quiet line on a
           * phone — pushing out the size, the uploader and the date, which are
           * the three things the line is for. The panel behind still names the
           * work order.
           */
          contextLabel={columnTitle || kindLabel(viewer.kind)}
          onNavigate={setViewerId}
          onClose={() => setViewerId(null)}
          onDelete={(fileId) => {
            const target = files.find((file) => file.id === fileId);
            if (target) void deleteFile(target);
          }}
        />
      )}
    </div>
  );
}

/**
 * The board's file cell.
 *
 * monday draws the photographs themselves — small tiles of the actual images,
 * with a "+N" once there are more than fit. This drew `<Icon name="image">`
 * placeholders instead: three identical grey squares whatever was attached, so
 * a cell holding the wrong photo looked exactly like a cell holding the right
 * one. With 2,765 photographs now on the board that is the difference between
 * a column you can read and a column you have to open.
 *
 * `preview` comes down with the board payload, so the tiles are drawn without
 * a request per cell. The hover card still fetches, because it wants the full
 * record and only one cell is ever hovered.
 */
/** The hover card's fixed width; position maths depends on knowing it. */
const HOVER_CARD_WIDTH = 248;
/**
 * Roughly the card at its tallest — the 170px preview pane plus the three text
 * rows. Only used to decide whether the card fits ABOVE the cell; the card
 * itself sizes to its content.
 */
const HOVER_CARD_ESTIMATE = 240;

export function FileHoverPreview({
  requestId,
  kind,
  columnId,
  count,
  columnTitle,
  preview = [],
  mondayMediaStyle = false,
  onOpen,
}: {
  requestId: string;
  kind?: AttachmentKind;
  columnId?: string;
  count: number;
  /**
   * The column this cell belongs to, for the accessible name. A row carries
   * two photo columns — the issue and the completed work — and without it a
   * screen reader reads both cells as the identical "3 files".
   */
  columnTitle?: string;
  /** First few files, from the board payload. Empty is handled. */
  preview?: MaintenanceBoardFilePreview[];
  mondayMediaStyle?: boolean;
  onOpen: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [files, setFiles] = useState<AttachmentRecord[] | null>(null);
  /*
   * Where the card goes, in VIEWPORT coordinates, decided when the hover
   * starts. The card used to be an absolutely-positioned child of the cell,
   * which had two consequences monday's does not have: `.live-board-scroll` is
   * an `overflow: auto` container, so the card was CLIPPED for any row near
   * the top of the board, and it could never flip below the cell when there
   * was no room above. Rendering into a portal at `position: fixed` escapes
   * the clip; the flip is decided here from the measured rect.
   */
  const [placement, setPlacement] = useState<{
    left: number;
    top: number;
    below: boolean;
  } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | null>(null);

  const openCard = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const below = rect.top < HOVER_CARD_ESTIMATE + 16;
    setPlacement({
      left: Math.min(
        Math.max(rect.left + rect.width / 2 - HOVER_CARD_WIDTH / 2, 8),
        window.innerWidth - HOVER_CARD_WIDTH - 8,
      ),
      top: below ? rect.bottom + 8 : rect.top - 8,
      below,
    });
    setHovered(true);
  };

  /*
   * The card is no longer a child of the cell, so moving the pointer from the
   * cell onto the card fires the cell's pointerleave. A short grace period
   * keeps the card up across that hop — cancel on arriving, close on leaving
   * either — so "Open & manage" stays clickable exactly as it was.
   */
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setHovered(false), 120);
  };
  useEffect(() => cancelClose, []);

  /* A fixed-position card must not drift from its cell: any scroll closes it. */
  useEffect(() => {
    if (!hovered) return;
    const close = () => setHovered(false);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", close, { capture: true });
  }, [hovered]);

  useEffect(() => {
    if (!hovered || files !== null || count < 1) return;
    let active = true;
    const kindQuery = kind ? `&kind=${kind}` : "";
    const columnQuery = columnId
      ? `&columnId=${encodeURIComponent(columnId)}`
      : "";
    fetch(
      `/api/files?requestId=${encodeURIComponent(requestId)}${kindQuery}${columnQuery}&limit=3`,
    )
      .then((response) => response.json())
      .then((payload: { files?: AttachmentRecord[] }) => {
        if (active) setFiles(payload.files ?? []);
      })
      .catch(() => {
        if (active) setFiles([]);
      });
    return () => {
      active = false;
    };
  }, [columnId, count, files, hovered, kind, requestId]);

  return (
    <span
      ref={wrapRef}
      className="sheet-file-wrap"
      /*
       * Pointer events, not mouse events, and only for a mouse.
       *
       * A phone synthesises `mouseenter` from a tap. The hover card was
       * therefore opening on every tap at the same moment the tap opened the
       * files panel — a card fetching three records, drawing itself over the
       * board and then being left behind the panel, with no pointer-out event
       * ever coming to take it away. It was work nobody asked for and a stuck
       * overlay when the panel was closed. `pointerType` is the only reliable
       * way to tell a finger from a mouse at the moment of the event.
       */
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") {
          cancelClose();
          openCard();
        }
      }}
      onPointerLeave={scheduleClose}
      onPointerCancel={scheduleClose}
    >
      <button
        className={`sheet-file-cell${count ? " has-files" : ""}${
          mondayMediaStyle ? " is-monday-media" : ""
        }`}
        type="button"
        aria-label={
          columnTitle
            ? `${count ? `${count} file${count === 1 ? "" : "s"} in` : "Add a file to"} ${columnTitle}`
            : undefined
        }
        onClick={() => {
          // A tap that opens the panel must not leave the desktop hover card
          // hanging over it.
          setHovered(false);
          onOpen();
        }}
      >
        <span className="sheet-file-cell__label">
          <Icon name={count ? "document" : "plus"} size={15} />
          {count ? `${count} file${count === 1 ? "" : "s"}` : "Add"}
        </span>
        {mondayMediaStyle && (
          <span className="sheet-file-cell__media" aria-hidden="true">
            {count ? (
              <>
                {/*
                  Three real tiles, then the overflow badge.

                  `loading="lazy"` is what makes this affordable: the board
                  renders 744 rows and two photo columns, so eager decoding
                  would fetch thousands of images nobody has scrolled to. The
                  browser fetches a tile when it approaches the viewport.

                  A file with no thumbnail — a PDF, a Word document, a zip —
                  keeps a glyph, chosen by type rather than shown as a generic
                  square, because "there is a document here" is the honest
                  render for something that has no picture.
                */}
                {preview.slice(0, 3).map((file) => (
                  <span className="sheet-file-cell__media-tile" key={file.id}>
                    {file.contentType.startsWith("image/") ? (
                      <img
                        // `?thumb=1` serves a 96px WebP derivative and falls
                        // back to the original when one has not been generated,
                        // so a new upload still draws — heavier, never broken.
                        // Measured: 146 KB of JPEG becomes 1.1 KB of WebP.
                        src={`/api/files/${file.id}?thumb=1`}
                        alt=""
                        width={22}
                        height={26}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <Icon name={glyphFor(file.contentType)} size={13} />
                    )}
                  </span>
                ))}
                {/*
                  Fall back to plain squares only when the payload carried no
                  preview — an older snapshot, or a cell whose files arrived
                  after the board loaded. Better a square than a gap.
                */}
                {!preview.length &&
                  Array.from({ length: Math.min(count, 3) }, (_, index) => (
                    <span className="sheet-file-cell__media-tile" key={index}>
                      <Icon name="image" size={13} />
                    </span>
                  ))}
                {count > 3 && <small>+{count - 3}</small>}
              </>
            ) : (
              <span className="sheet-file-cell__media-add">
                <Icon name="plus" size={14} />
              </span>
            )}
          </span>
        )}
      </button>
      {hovered &&
        count > 0 &&
        placement &&
        createPortal(
          <span
            className={`sheet-file-hover${placement.below ? " is-below" : ""}`}
            style={{ left: placement.left, top: placement.top }}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
          >
            {files === null ? (
              <small>Loading preview…</small>
            ) : files[0] ? (
              <>
                <span className="sheet-file-hover__preview">
                  {/*
                    The ORIGINAL image, not the 96px thumbnail. The thumbnail
                    generator centre-crops to a square, so scaling it up here
                    reproduced the squashed-crop look this card exists to fix —
                    the true aspect ratio only exists in the original. One
                    image, fetched for the one cell being hovered.
                  */}
                  {files[0].contentType.startsWith("image/") ? (
                    <img
                      src={`/api/files/${files[0].id}`}
                      alt={files[0].originalName}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <FilePreview file={files[0]} compact />
                  )}
                </span>
                <strong>{files[0].originalName}</strong>
                <small>{count > 1 ? `+${count - 1} more file${count === 2 ? "" : "s"}` : kindLabel(files[0].kind)}</small>
                <button type="button" onClick={onOpen}>Open & manage</button>
              </>
            ) : (
              <small>Open to manage these files</small>
            )}
          </span>,
          document.body,
        )}
    </span>
  );
}
