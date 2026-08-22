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
const HOVER_CARD_WIDTH = 264;
/**
 * Roughly the card at its tallest — the 190px preview pane plus the name row
 * and padding. Only used to decide whether the card fits ABOVE the anchor;
 * the card itself sizes to its content.
 */
const HOVER_CARD_ESTIMATE = 240;
/** The "+N" overflow list's width and per-row height, for the same maths. */
const OVERFLOW_LIST_WIDTH = 280;
const OVERFLOW_ROW_HEIGHT = 40;
/** The per-file "…" menu: its width and a four-verb height estimate. */
const FILE_MENU_WIDTH = 180;
const FILE_MENU_ESTIMATE = 148;
/**
 * The strip's geometry, shared with the CSS: 32×24 tiles with a 4px gap, and
 * a 20px "+N" circle plus its gap — measured off the reference screenshots,
 * then trimmed once seen on the board, where they sat heavier than monday's.
 * monday does not draw a fixed number of thumbnails — it fits as many as the
 * column's width allows and
 * folds the rest into "+N" (three at the default width, which this geometry
 * reproduces on the default 175px photo column). The strip measures itself
 * and applies the same rule, so resizing a photo column refits the tiles
 * live.
 */
const TILE_WIDTH = 32;
const TILE_GAP = 4;
const BADGE_RESERVE = 24;

/*
 * ONE ResizeObserver for every strip on the board. Two photo columns across
 * hundreds of rendered rows would otherwise mean hundreds of observer
 * instances; a single observer with a callback map costs one, and the fit
 * rule still reacts while a column-resize handle is mid-drag.
 */
const stripCallbacks = new WeakMap<Element, (width: number) => void>();
const stripObserver =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) {
          stripCallbacks.get(entry.target)?.(entry.contentRect.width);
        }
      });

/**
 * The exact order the board payload builds `preview[]` with — chronological,
 * then id as the tiebreaker (see /api/board's note on same-second uploads).
 * The overflow list sorts its fetched rows with the SAME comparator, so the
 * strip and the list can never disagree about which files are the hidden ones.
 */
function stripOrder(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
) {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  return left.id < right.id ? -1 : 1;
}

/** What the hover UI is currently showing, and for which exact file. */
type HoverTarget =
  | { target: "file"; file: MaintenanceBoardFilePreview }
  | { target: "overflow" };

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
  /*
   * EVERY THUMBNAIL IS ITS OWN HOVER TARGET, showing ITS OWN file.
   *
   * The first cut of this card had one hover zone — the whole cell — and it
   * always previewed files[0], so hovering the third photograph showed the
   * first. monday's rule, and this component's now: hover tile 2, see file 2;
   * hover "+N", see a list of exactly the N files the strip did not draw.
   * `hover` carries the identity; nothing below ever falls back to [0].
   */
  const [hover, setHover] = useState<HoverTarget | null>(null);
  /*
   * Where the floating surface goes, in VIEWPORT coordinates, decided when the
   * hover starts. A child of the cell would be clipped by the board's
   * `overflow: auto` scroller and could never flip below when the row is near
   * the top — so both surfaces render into a portal at `position: fixed`,
   * flipping and clamping against the measured rect.
   */
  const [placement, setPlacement] = useState<{
    left: number;
    top: number;
    below: boolean;
  } | null>(null);
  /*
   * The full file list, fetched once per overflow-hover and re-fetched after
   * the strip changes (upload, delete — the signature effect below). The
   * TILES never need it: the payload's preview entries already carry id,
   * name, type and size, which is everything a card shows.
   */
  const [allFiles, setAllFiles] = useState<AttachmentRecord[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /*
   * The per-file "…" menu — monday's. At most one is open, it belongs to ONE
   * exact file, and it can be asked for from the hover card's corner button
   * or from any overflow row. Position is viewport coordinates, portalled
   * like the other surfaces.
   */
  const [menu, setMenu] = useState<{
    file: { id: string; originalName: string; contentType: string };
    left: number;
    top: number;
  } | null>(null);
  /* The strip's measured width — null until the first layout. */
  const [stripWidth, setStripWidth] = useState<number | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const mediaRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | null>(null);
  /* A tap on a tile opens the tile's surface, not the manage panel; the flag
     swallows the click the browser fires right after that pointerup. */
  const touchTapRef = useRef(false);

  /*
   * Pointer events, not mouse events, and only for a mouse — in ONE place.
   *
   * A phone synthesises `mouseenter` from a tap, so without the guard every
   * tap would open a hover surface under the panel the same tap opens, with
   * no pointer-out ever coming to remove it. `pointerType` is the only
   * reliable way to tell a finger from a mouse at the moment of the event,
   * and every hover target below routes through this one guard.
   */
  const mouseOnly = (event: React.PointerEvent, open: () => void) => {
    if (event.pointerType === "mouse") {
      cancelClose();
      open();
    }
  };

  /*
   * The matching guard for LEAVING. A tap fires pointerup and then
   * pointerleave in the same gesture, so an ungated scheduleClose would
   * shut the surface the tap just opened 140ms later. Touch surfaces close
   * on the outside-pointerdown listener below instead.
   */
  const mouseLeave = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse") scheduleClose();
  };

  /* Measure the strip, and keep measuring while a column resize drags it. */
  useEffect(() => {
    if (!mondayMediaStyle) return;
    const node = mediaRef.current;
    if (!node) return;
    const apply = (width: number) => {
      const rounded = Math.round(width);
      setStripWidth((current) => (current === rounded ? current : rounded));
    };
    apply(node.clientWidth);
    if (!stripObserver) return;
    stripCallbacks.set(node, apply);
    stripObserver.observe(node);
    return () => {
      stripObserver.unobserve(node);
      stripCallbacks.delete(node);
    };
  }, [mondayMediaStyle]);

  /*
   * monday's visible-thumbnail rule, measured rather than assumed: fit as
   * many tiles as the strip's width allows; when the files outnumber what
   * fits — or outnumber the payload's preview entries — reserve room for the
   * "+N" circle and fold the rest behind it. Until the first measurement the
   * strip assumes three, the count monday's default column width shows, so
   * the first paint is right on the untouched board.
   */
  const tileSpan = TILE_WIDTH + TILE_GAP;
  const fitPlain =
    stripWidth === null
      ? 3
      : Math.max(1, Math.floor((stripWidth + TILE_GAP) / tileSpan));
  const fitBadged =
    stripWidth === null
      ? 3
      : Math.max(1, Math.floor((stripWidth - BADGE_RESERVE + TILE_GAP) / tileSpan));
  const availableTiles = preview.length > 0 ? Math.min(preview.length, count) : count;
  const visibleTiles =
    count > fitPlain || availableTiles < count
      ? Math.max(1, Math.min(fitBadged, availableTiles))
      : availableTiles;
  const badgeCount = count - visibleTiles;

  /*
   * Open (or toggle shut) the "…" menu for ONE exact file, beside the control
   * that asked: to the right when there is room, flipped left at the viewport
   * edge, clamped vertically. The menu is the only path to the file verbs, so
   * it works from the card and from every overflow row alike.
   */
  const toggleMenuAt = (
    anchor: Element,
    file: { id: string; originalName: string; contentType: string },
  ) => {
    if (menu?.file.id === file.id) {
      setMenu(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    let left = rect.right + 6;
    if (left + FILE_MENU_WIDTH > window.innerWidth - 8) {
      left = Math.max(8, rect.left - FILE_MENU_WIDTH - 6);
    }
    const top = Math.min(
      Math.max(rect.top - 4, 8),
      Math.max(8, window.innerHeight - FILE_MENU_ESTIMATE - 8),
    );
    setActionError(null);
    setMenu({ file, left, top });
  };

  const openAt = (anchor: Element, target: HoverTarget) => {
    const rect = anchor.getBoundingClientRect();
    const width = target.target === "overflow" ? OVERFLOW_LIST_WIDTH : HOVER_CARD_WIDTH;
    const estimate =
      target.target === "overflow"
        ? Math.min(Math.max(count - visibleTiles, 1), 6) * OVERFLOW_ROW_HEIGHT + 28
        : HOVER_CARD_ESTIMATE;
    const below = rect.top < estimate + 16;
    setPlacement({
      left: Math.min(
        Math.max(rect.left + rect.width / 2 - width / 2, 8),
        window.innerWidth - width - 8,
      ),
      top: below ? rect.bottom + 8 : rect.top - 8,
      below,
    });
    setActionError(null);
    setHover(target);
  };

  /*
   * The surfaces are not children of the cell, so moving the pointer from a
   * tile onto the card fires the tile's pointerleave. A short grace period
   * keeps the surface up across that hop — cancel on arriving, close on
   * leaving either — so the actions stay clickable and nothing flickers.
   */
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setHover(null), 140);
  };
  useEffect(() => cancelClose, []);

  /* A fixed-position surface must not drift from its cell: scroll closes it. */
  useEffect(() => {
    if (!hover && !menu) return;
    const close = () => {
      setHover(null);
      setMenu(null);
    };
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", close, { capture: true });
  }, [hover, menu]);

  /* The "…" menu never outlives the surface it was opened from. */
  useEffect(() => {
    if (!hover) setMenu(null);
  }, [hover]);

  /*
   * Touch has no pointerleave, and a click-away should dismiss the menu on
   * any device: a pointerdown landing outside this cell and outside every
   * floating surface closes whatever is open.
   */
  useEffect(() => {
    if (!hover && !menu) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (wrapRef.current?.contains(target)) return;
      if (target.closest(".sheet-file-hover, .sheet-file-overflow, .sheet-file-menu")) {
        return;
      }
      setHover(null);
      setMenu(null);
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onDown, { capture: true });
  }, [hover, menu]);

  /*
   * The strip changed — a file arrived or left. Whatever list was cached no
   * longer describes the cell, so it is dropped and the next overflow hover
   * fetches fresh. This is what keeps the "+N" list honest across the
   * no-reload upload and delete flows.
   */
  const stripSignature = `${count}:${preview.map((file) => file.id).join(",")}`;
  useEffect(() => {
    setAllFiles(null);
  }, [stripSignature]);

  /* Fetch the full list only when the overflow list actually opens. */
  useEffect(() => {
    if (hover?.target !== "overflow" || allFiles !== null || count < 1) return;
    let active = true;
    const kindQuery = kind ? `&kind=${kind}` : "";
    const columnQuery = columnId ? `&columnId=${encodeURIComponent(columnId)}` : "";
    fetch(`/api/files?requestId=${encodeURIComponent(requestId)}${kindQuery}${columnQuery}`)
      .then((response) => response.json())
      .then((payload: { files?: AttachmentRecord[] }) => {
        if (active) setAllFiles([...(payload.files ?? [])].sort(stripOrder));
      })
      .catch(() => {
        if (active) setAllFiles([]);
      });
    return () => {
      active = false;
    };
  }, [allFiles, columnId, count, hover, kind, requestId]);

  /*
   * The three real actions, each against the EXACT file it was invoked on.
   * URLs are derived from the id the same way `boardFileCellFiles` derives
   * them — an object key never travels. "Open" coerces viewer-capable media
   * to a browser tab, which renders images, video and PDF natively; anything
   * the browser cannot show falls back to a download. No pretend actions.
   */
  const fileAct = (
    file: { id: string; originalName: string; contentType: string },
    mode: "open" | "download" | "delete",
  ) => {
    const inlineUrl = `/api/files/${file.id}`;
    const downloadUrl = `/api/files/${file.id}?download=1`;
    if (mode === "open") {
      const target = openTargetFor({ ...file, inlineUrl, downloadUrl });
      followFileTarget(
        target.mode === "viewer" ? { mode: "tab", href: inlineUrl } : target,
      );
      return;
    }
    if (mode === "download") {
      followFileTarget({ mode: "download", href: downloadUrl });
      return;
    }
    if (!window.confirm(`Delete ${file.originalName}? This cannot be undone.`)) return;
    void fetch(inlineUrl, { method: "DELETE" })
      .then((response) => {
        if (!response.ok) throw new Error();
        /* The list repaints now; the strip repaints on the board's refetch. */
        setAllFiles((current) =>
          current ? current.filter((entry) => entry.id !== file.id) : current,
        );
        if (hover?.target === "file") setHover(null);
        window.dispatchEvent(new Event("maintsupp:refresh-board"));
      })
      .catch(() => setActionError("The file could not be deleted."));
  };

  /*
   * The files the strip did NOT draw — matched by id against the visible
   * tiles rather than sliced by index, so the list can never repeat a file
   * that is already on screen even if the two sources momentarily disagree.
   */
  const visibleIds = new Set(preview.slice(0, visibleTiles).map((file) => file.id));
  const hiddenFiles = allFiles?.filter((file) => !visibleIds.has(file.id)) ?? null;

  /* The large card for ONE file — the one whose tile is being hovered. */
  const hoveredFile = hover?.target === "file" ? hover.file : null;

  return (
    <span
      ref={wrapRef}
      className="sheet-file-wrap"
      /*
       * The CELL-level hover survives only for cells with no thumbnail strip
       * (the plain "Files" column): there is nothing narrower to aim at, so
       * hovering the cell previews its first file. Strip cells hand hovering
       * to their tiles instead — see below — because a whole-cell target
       * cannot answer "which photograph is this".
       */
      onPointerEnter={(event) => {
        if (!mondayMediaStyle && preview[0]) {
          mouseOnly(event, () =>
            openAt(event.currentTarget, { target: "file", file: preview[0] }),
          );
        }
      }}
      onPointerLeave={mouseLeave}
      onPointerCancel={mouseLeave}
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
          // A tap that opens the panel must not leave the desktop hover
          // surfaces hanging over it.
          setHover(null);
          onOpen();
        }}
      >
        <span className="sheet-file-cell__label">
          <Icon name={count ? "document" : "plus"} size={15} />
          {count ? `${count} file${count === 1 ? "" : "s"}` : "Add"}
        </span>
        {mondayMediaStyle && (
          <span className="sheet-file-cell__media" aria-hidden="true" ref={mediaRef}>
            {count ? (
              <>
                {/*
                  As many real tiles as the measured width fits, then the
                  overflow circle — and EACH TILE is its own hover target
                  carrying its own file, so hovering the second photograph
                  previews the second photograph. A tap does the same, because
                  a phone has no hover: pointerup opens the tile's card and
                  the flag swallows the click that would open the panel.

                  `loading="lazy"` is what makes this affordable: the board
                  renders 744 rows and two photo columns, so eager decoding
                  would fetch thousands of images nobody has scrolled to. The
                  browser fetches a tile when it approaches the viewport.

                  A file with no thumbnail — a PDF, a Word document, a zip —
                  keeps a glyph, chosen by type rather than shown as a generic
                  square, because "there is a document here" is the honest
                  render for something that has no picture.
                */}
                {preview.slice(0, visibleTiles).map((file) => (
                  <span
                    className="sheet-file-cell__media-tile"
                    key={file.id}
                    onPointerEnter={(event) =>
                      mouseOnly(event, () =>
                        openAt(event.currentTarget, { target: "file", file }),
                      )
                    }
                    onPointerLeave={mouseLeave}
                    onPointerCancel={mouseLeave}
                    onPointerUp={(event) => {
                      if (event.pointerType !== "mouse") {
                        touchTapRef.current = true;
                        openAt(event.currentTarget, { target: "file", file });
                      }
                    }}
                    onClick={(event) => {
                      if (!touchTapRef.current) return;
                      touchTapRef.current = false;
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {file.contentType.startsWith("image/") ? (
                      <img
                        // `?thumb=1` serves a 96px WebP derivative and falls
                        // back to the original when one has not been generated,
                        // so a new upload still draws — heavier, never broken.
                        // Measured: 146 KB of JPEG becomes 1.1 KB of WebP.
                        src={`/api/files/${file.id}?thumb=1`}
                        alt=""
                        width={32}
                        height={24}
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
                  Array.from({ length: Math.min(count, visibleTiles) }, (_, index) => (
                    <span className="sheet-file-cell__media-tile" key={index}>
                      <Icon name="image" size={13} />
                    </span>
                  ))}
                {badgeCount > 0 && (
                  <small
                    className="sheet-file-cell__media-more"
                    onPointerEnter={(event) =>
                      mouseOnly(event, () =>
                        openAt(event.currentTarget, { target: "overflow" }),
                      )
                    }
                    onPointerLeave={mouseLeave}
                    onPointerCancel={mouseLeave}
                    onPointerUp={(event) => {
                      if (event.pointerType !== "mouse") {
                        touchTapRef.current = true;
                        openAt(event.currentTarget, { target: "overflow" });
                      }
                    }}
                    onClick={(event) => {
                      if (!touchTapRef.current) return;
                      touchTapRef.current = false;
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    +{badgeCount}
                  </small>
                )}
              </>
            ) : (
              /*
                An empty cell is EMPTY, the way monday's is. No dashed box, no
                standing plus, no "Add" — the column reads as a column of
                photographs with gaps in it, rather than a column of buttons.
                The affordance arrives on hover (and stays put on touch, where
                there is no hover to arrive) — see the CSS for the reveal.
              */
              <span className="sheet-file-cell__media-add" aria-hidden="true">
                <Icon name="plus" size={11} />
                <Icon name="document" size={13} />
              </span>
            )}
          </span>
        )}
      </button>

      {/* ── The large per-file card ─────────────────────────────────────── */}
      {hoveredFile &&
        placement &&
        createPortal(
          <span
            className={`sheet-file-hover${placement.below ? " is-below" : ""}`}
            style={{ left: placement.left, top: placement.top }}
            onPointerEnter={cancelClose}
            onPointerLeave={mouseLeave}
          >
            <span className="sheet-file-hover__preview">
              {/*
                The ORIGINAL, not the 96px thumbnail. The thumbnail generator
                centre-crops to a square, so scaling it up here would
                reproduce the squashed-crop look this card exists to fix —
                the true aspect ratio only exists in the original. One
                object, fetched for the one file being hovered. Video gets a
                metadata-only element with controls: nothing heavy moves until
                the person presses play.
              */}
              {hoveredFile.contentType.startsWith("image/") ? (
                <img
                  src={`/api/files/${hoveredFile.id}`}
                  alt={hoveredFile.originalName}
                  loading="lazy"
                  decoding="async"
                />
              ) : hoveredFile.contentType.startsWith("video/") ? (
                <video
                  src={`/api/files/${hoveredFile.id}`}
                  preload="metadata"
                  controls
                  muted
                  playsInline
                />
              ) : (
                <span className="sheet-file-hover__doc">
                  <Icon name={glyphFor(hoveredFile.contentType)} size={34} />
                  <small>
                    {hoveredFile.originalName.split(".").pop()?.toUpperCase() || "FILE"}
                  </small>
                </span>
              )}
            </span>
            {/*
              monday's card corner: one "…" button over the preview, opening
              the file-verb menu for THE file the card is showing. The verbs
              moved off the card face and into the menu so the card reads as
              monday's does — picture, then filename.
            */}
            <button
              type="button"
              className="sheet-file-hover__more"
              aria-label={`Actions for ${hoveredFile.originalName}`}
              aria-haspopup="menu"
              aria-expanded={menu?.file.id === hoveredFile.id}
              onClick={(event) => toggleMenuAt(event.currentTarget, hoveredFile)}
            >
              <Icon name="more" size={15} />
            </button>
            <span className="sheet-file-hover__name">
              <strong title={hoveredFile.originalName}>{hoveredFile.originalName}</strong>
              <small>{humanSize(hoveredFile.byteSize)}</small>
            </span>
            {actionError && <small className="sheet-file-hover__error">{actionError}</small>}
          </span>,
          document.body,
        )}

      {/* ── The "+N" overflow list — ONLY the files the strip hid ───────── */}
      {hover?.target === "overflow" &&
        placement &&
        createPortal(
          <span
            className={`sheet-file-overflow${placement.below ? " is-below" : ""}`}
            style={{ left: placement.left, top: placement.top }}
            onPointerEnter={cancelClose}
            onPointerLeave={mouseLeave}
            role="list"
            aria-label={columnTitle ? `More files in ${columnTitle}` : "More files"}
          >
            {hiddenFiles === null ? (
              <small className="sheet-file-overflow__note">Loading files…</small>
            ) : hiddenFiles.length === 0 ? (
              <small className="sheet-file-overflow__note">
                Everything is already on show.
              </small>
            ) : (
              hiddenFiles.map((file) => (
                <span className="sheet-file-overflow__row" key={file.id} role="listitem">
                  <span className="sheet-file-overflow__thumb">
                    {file.contentType.startsWith("image/") ? (
                      <img
                        src={`/api/files/${file.id}?thumb=1`}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <Icon name={glyphFor(file.contentType)} size={14} />
                    )}
                  </span>
                  <span className="sheet-file-overflow__name" title={file.originalName}>
                    {file.originalName}
                  </span>
                  {/*
                    monday's row affordance: ONE "…" revealed on the row,
                    opening the verb menu for THIS row's file. The verbs
                    themselves live in the menu, so a mis-aimed click on a
                    row can no longer delete anything.
                  */}
                  <button
                    type="button"
                    className={`sheet-file-overflow__menu${
                      menu?.file.id === file.id ? " is-open" : ""
                    }`}
                    aria-label={`Actions for ${file.originalName}`}
                    aria-haspopup="menu"
                    aria-expanded={menu?.file.id === file.id}
                    onClick={(event) => toggleMenuAt(event.currentTarget, file)}
                  >
                    <Icon name="more" size={14} />
                  </button>
                </span>
              ))
            )}
            {actionError && (
              <small className="sheet-file-overflow__note">{actionError}</small>
            )}
          </span>,
          document.body,
        )}

      {/* ── The per-file "…" menu — real verbs only, for ONE exact file ──── */}
      {menu &&
        createPortal(
          <span
            className="sheet-file-menu"
            role="menu"
            aria-label={`Actions for ${menu.file.originalName}`}
            style={{ left: menu.left, top: menu.top }}
            onPointerEnter={cancelClose}
            onPointerLeave={mouseLeave}
          >
            {/*
              Every verb closes the menu and then acts on `menu.file` — the
              file whose "…" was clicked, never a neighbour, never files[0].
              These are the four things MAINTSUPP can genuinely do to a file;
              monday's versioning/updates/extract verbs have no backend here
              and are deliberately absent rather than decorative.
            */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const chosen = menu.file;
                setMenu(null);
                fileAct(chosen, "open");
              }}
            >
              <Icon name="arrow" size={13} />
              Open File
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const chosen = menu.file;
                setMenu(null);
                fileAct(chosen, "download");
              }}
            >
              <Icon name="download" size={13} />
              Download File
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const chosen = menu.file;
                setMenu(null);
                fileAct(chosen, "delete");
              }}
            >
              <Icon name="trash" size={13} />
              Delete File
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setHover(null);
                onOpen();
              }}
            >
              <Icon name="folder" size={13} />
              Manage files
            </button>
          </span>,
          document.body,
        )}
    </span>
  );
}
