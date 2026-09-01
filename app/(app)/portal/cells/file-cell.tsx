"use client";

/**
 * FileCell — the board cell for a `files`-type column.
 *
 * The Store Documentation UK board carries twelve of these (RAMS, the Fire Risk
 * Assessment, PLI, PAT, the electrical certificate and so on), so the cell is
 * the primary way a compliance document is filed. monday renders one small
 * document chip per attached file and a faint "+" on an empty cell; this
 * reproduces that behaviour in the MAINTSUPP palette.
 *
 * It is a leaf component in the sense the other board cells are: it owns no
 * board state, takes the files it should draw and reports the new list back
 * through `onSave`. What it does own is the transfer itself — an upload has
 * progress and can fail, and neither of those belongs in the board reducer.
 *
 * It never receives, holds or renders an R2 object key or an upload token. The
 * `FileCellFile` shape below is a deliberate narrowing of `AttachmentRecord`
 * that excludes `objectKey`, so a storage path cannot reach the DOM even by
 * accident, and nothing here logs.
 */

import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Icon, type IconName } from "../../../components";
import { uploadEvidenceFile } from "../../../lib/client-upload";
import type {
  AttachmentRecord,
  MaintenanceBoardFilePreview,
  MaintenanceRequest,
} from "../../../lib/types";
import { MobileBoardContext } from "../board-primitives";
/*
 * ONE RULE FOR WHAT A DOCUMENT IS CALLED, and it does not live here.
 *
 * This cell printed `originalName` — the storage filename, straight off the
 * column. Renaming a certificate in the Documents register writes `title`, so
 * the register showed "PAT certificate 2026" and the board cell beside it went
 * on showing "IMG_4471.jpg" for the same row, for ever, including after a hard
 * reload. `documentName` is the register's own rule and is now this cell's
 * too, so the two surfaces cannot disagree about the name of one document.
 */
import { documentName } from "../views/document-register";
import { MediaViewer, openTargetFor } from "../media-viewer";
import cellsCss from "./cells.css?url";

/**
 * The subset of an attachment a cell may see. `AttachmentRecord` satisfies it,
 * so the board can pass its own rows straight through.
 */
export type FileCellFile = Pick<
  AttachmentRecord,
  | "id"
  | "originalName"
  | "contentType"
  | "byteSize"
  | "inlineUrl"
  | "downloadUrl"
  // The viewer prints both under the filename; a chip that opens it has to
  // carry them.
  | "createdAt"
> & {
  /**
   * The name somebody gave this document, when they gave it one.
   *
   * OPTIONAL, and that is deliberate rather than lazy. Every path that reaches
   * this cell can supply it — `attachmentPayload` has served `title` since
   * W07-02, and the board payload's file preview carries it — but a cached
   * board response served before that field existed does not, and a client
   * that treated its absence as an error would draw an empty chip for a real
   * certificate. Absent means "no title", which `documentName` already
   * answers with the filename.
   */
  title?: string | null;
};

/**
 * `chips` is monday's default and what every Store Documentation column now
 * uses. `count` — one badge carrying the number rather than one chip per file —
 * is kept for a caller that wants it, but nothing on the board picks it.
 *
 * It used to be selected by `column.key === "rams"`, on the strength of
 * `summary: "count"` beside RAMS in `db/monday-board-spec.ts`. That field is
 * monday's GROUP FOOTER aggregation, not a cell renderer: the same field
 * carries "battery", "min", "max" and "sum" on the maintenance columns, none of
 * which is a way to draw a cell. And the capture types all twelve document
 * columns identically — every one is `"type": "file"` in
 * `db/monday-export/api-pull/store-documentation.json`, RAMS included — so
 * RAMS drawing a document icon and a number while its eleven siblings drew
 * chips was a misreading, not a requirement.
 */
export type FileCellSummary = "chips" | "count";

/**
 * A board file cell's `preview` rows as the files this cell draws.
 *
 * `/api/board` sends `MaintenanceBoardFilePreview` — id, type, name, size and
 * upload time — and deliberately no URLs, because both are `/api/files/<id>`
 * and derivable, and because the object key must never travel. This is the one
 * place that derivation happens, so a storage path cannot be introduced by a
 * caller building the URL some other way.
 *
 * The Store Documentation board passed `files={[]}` into `FileCell` while these
 * previews sat unused in the same render. With an empty list `visible` is
 * empty, so `overflowMark` collapses from "+N" to `String(total)` and the whole
 * cell becomes one grey digit: no filename, no type glyph, nothing to click.
 * 45 populated document cells across the board rendered that way, and the
 * certificates behind them were downloadable the entire time.
 */
export function boardFileCellFiles(
  preview: readonly (MaintenanceBoardFilePreview & {
    /*
     * Read structurally rather than demanded, so this decoder is correct
     * whether or not the payload it is handed carries the field. A board
     * response cached before `title` was added to the preview simply has no
     * title, and `documentName` falls back to the filename — which is what
     * this cell showed before, so the worst case is the old behaviour rather
     * than a blank chip.
     */
    title?: string | null;
  })[],
): FileCellFile[] {
  return preview.map((file) => ({
    id: file.id,
    originalName: file.originalName,
    title: file.title ?? null,
    contentType: file.contentType,
    byteSize: file.byteSize,
    createdAt: file.createdAt,
    inlineUrl: `/api/files/${file.id}`,
    downloadUrl: `/api/files/${file.id}?download=1`,
  }));
}

type GlyphKind = "pdf" | "word" | "sheet" | "image" | "generic";

type Glyph = {
  kind: GlyphKind;
  /** Spoken in the chip's accessible name, e.g. "PDF document". */
  label: string;
  /** Drawn in the chip. A letter mark for Office files, an icon otherwise. */
  mark: string | IconName;
};

const imageExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"]);
const wordExtensions = new Set(["doc", "docx", "rtf", "odt"]);
const sheetExtensions = new Set(["xls", "xlsx", "csv", "ods"]);
const wordTypes = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
]);
const sheetTypes = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

/**
 * The chip's type mark, from the MIME type first and the extension second. R2
 * stores `application/octet-stream` for anything the browser could not sniff,
 * which is common for certificates emailed as attachments, so the extension has
 * to be a real fallback rather than a tiebreaker.
 */
function fileGlyph(file: FileCellFile): Glyph {
  const type = file.contentType.toLowerCase();
  /*
   * THE GLYPH READS THE STORED FILENAME, NOT THE DISPLAY NAME — on purpose.
   * A title is prose somebody typed ("PAT certificate 2026"); the extension
   * that says which of five glyphs to draw is a property of the bytes. Reading
   * a title here would make a PDF renamed without ".pdf" draw a generic mark.
   */
  const extension = file.originalName.split(".").pop()?.toLowerCase() ?? "";

  if (type === "application/pdf" || extension === "pdf") {
    return { kind: "pdf", label: "PDF document", mark: "PDF" };
  }
  if (type.startsWith("image/") || imageExtensions.has(extension)) {
    return { kind: "image", label: "Image", mark: "image" };
  }
  if (wordTypes.has(type) || wordExtensions.has(extension)) {
    return { kind: "word", label: "Word document", mark: "W" };
  }
  if (sheetTypes.has(type) || sheetExtensions.has(extension)) {
    return { kind: "sheet", label: "Spreadsheet", mark: "X" };
  }
  return {
    kind: "generic",
    label: extension ? `${extension.toUpperCase()} file` : "File",
    mark: "document",
  };
}

function humanSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(value > 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function fileCountLabel(count: number) {
  return `${count} file${count === 1 ? "" : "s"}`;
}

/**
 * The cell's stylesheet.
 *
 * This codebase links stylesheets rather than importing them for their side
 * effect — see `app/(app)/layout.tsx`, where globals, brand overrides and board
 * metrics all arrive as `?url` plus a `<link>`, because the RSC build only emits
 * CSS reached that way. React 19 hoists a `<link rel="stylesheet">` carrying a
 * precedence into the head and dedupes it by href, so a board showing a hundred
 * file cells still fetches this once. Wiring it into the layout instead would
 * work equally well; keeping it here means the cell has no external setup step.
 */
function CellStyles() {
  return <link rel="stylesheet" href={cellsCss} precedence="default" />;
}

function GlyphMark({ glyph }: { glyph: Glyph }) {
  if (glyph.mark === "image" || glyph.mark === "document") {
    return <Icon name={glyph.mark} size={13} />;
  }
  return <b>{glyph.mark}</b>;
}

export function FileCell({
  title,
  requestId,
  columnId,
  files,
  count,
  summary = "chips",
  readOnly = false,
  maxChips = 3,
  onSave,
  onRequestChange,
  onOpen,
  onNotify,
}: {
  /** Column title. Every accessible name in the cell is built from it. */
  title: string;
  /** Work order the documents hang off — the API scopes uploads to it. */
  requestId: string;
  /** Board column id. Files the API into this column rather than loose evidence. */
  columnId?: string;
  /** The files to draw. The cell invents nothing it was not given. */
  files: FileCellFile[];
  /**
   * Authoritative total, for boards whose snapshot carries `fileCounts` but not
   * the rows themselves. Defaults to `files.length`.
   */
  count?: number;
  summary?: FileCellSummary;
  readOnly?: boolean;
  /** Chips drawn before the overflow badge takes over. */
  maxChips?: number;
  /** Receives the new list after an upload or a removal. */
  onSave: (files: FileCellFile[]) => void;
  /** The work order the API returns, whose attachment counters have moved. */
  onRequestChange?: (request: MaintenanceRequest) => void;
  /** Opens the full evidence manager. Drives the mobile tap and the overflow badge. */
  onOpen?: () => void;
  onNotify?: (message: string) => void;
}) {
  const mobile = useContext(MobileBoardContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  /* Which picture the viewer is showing, if any. */
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const total = count ?? files.length;
  const busy = progress !== null || removingId !== null;
  const editable = !readOnly;

  /**
   * Uploads are not optimistic, unlike the text and date cells.
   *
   * Those cells already hold the value they are about to save; here the id and
   * the URLs only exist once R2 has the bytes, so a provisional chip would be a
   * compliance document you can click and not open. The progress bar is the
   * feedback instead, and the chip appears when it is genuinely retrievable.
   */
  const uploadSelected = useCallback(
    async (selected: File[]) => {
      if (!selected.length || readOnly) return;
      setError(null);
      setProgress(0);

      const added: FileCellFile[] = [];
      const failures: string[] = [];
      let latestRequest: MaintenanceRequest | null = null;

      for (const [index, file] of selected.entries()) {
        try {
          const payload = await uploadEvidenceFile({
            file,
            requestId,
            // The API forces `general` on any upload carrying a column id;
            // sending it explicitly keeps the client and the route in step.
            kind: "general",
            columnId,
            onProgress: (value) =>
              mountedRef.current &&
              setProgress(
                Math.round(((index + value / 100) / selected.length) * 100),
              ),
          });
          added.push(payload.file);
          if (payload.request) latestRequest = payload.request;
        } catch (caught) {
          failures.push(
            caught instanceof Error
              ? caught.message
              : `${file.name} could not be uploaded.`,
          );
        }
      }

      if (!mountedRef.current) return;
      setProgress(null);
      if (inputRef.current) inputRef.current.value = "";

      if (added.length) {
        onSave([...added, ...files]);
        if (latestRequest) onRequestChange?.(latestRequest);
        onNotify?.(`${fileCountLabel(added.length)} added to ${title}.`);
      }
      // Never silent: a partial batch still surfaces what did not land.
      if (failures.length) setError(failures.join(" "));
      // Focus returns to the control that started the upload so a keyboard user
      // is not dropped at the top of the board.
      addButtonRef.current?.focus();
    },
    [columnId, files, onNotify, onRequestChange, onSave, readOnly, requestId, title],
  );

  async function removeFile(file: FileCellFile) {
    // These are compliance documents and the API deletes the stored object, so
    // the confirm is deliberate rather than decorative.
    if (
      !window.confirm(
        `Remove ${documentName(file)} from ${title}? The document is deleted permanently and the compliance record will show this slot as empty.`,
      )
    ) {
      return;
    }
    setRemovingId(file.id);
    setError(null);
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as {
        request?: MaintenanceRequest | null;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "The document could not be removed.");
      }
      if (!mountedRef.current) return;
      onSave(files.filter((item) => item.id !== file.id));
      if (payload.request) onRequestChange?.(payload.request);
      onNotify?.(`${documentName(file)} removed from ${title}.`);
    } catch (caught) {
      if (!mountedRef.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "The document could not be removed.",
      );
    } finally {
      if (mountedRef.current) setRemovingId(null);
    }
  }

  const openPicker = () => inputRef.current?.click();

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!editable) return;
    void uploadSelected(Array.from(event.dataTransfer.files));
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!editable) return;
    event.preventDefault();
    setDragging(true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Escape backs out of whatever the cell is showing rather than the board,
    // matching the text and option cells.
    if (event.key !== "Escape") return;
    if (error) {
      event.stopPropagation();
      setError(null);
      return;
    }
    if (expanded) {
      event.stopPropagation();
      setExpanded(false);
    }
  };

  const visible = expanded ? files : files.slice(0, maxChips);
  const canExpand = files.length > visible.length;
  const overflow = Math.max(total - visible.length, 0);
  // A board that only carries `fileCounts` gives us a total and no rows, so the
  // badge stands alone and reads "3", not "+3".
  const overflowMark = visible.length ? `+${overflow}` : String(overflow);

  const cellClassName = [
    "file-cell",
    dragging ? "is-dragging" : "",
    busy ? "is-busy" : "",
    total ? "has-files" : "is-empty",
  ]
    .filter(Boolean)
    .join(" ");

  const picker = editable ? (
    <input
      ref={inputRef}
      className="file-cell__input"
      type="file"
      multiple
      tabIndex={-1}
      aria-hidden="true"
      accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
      onChange={(event) =>
        void uploadSelected(Array.from(event.currentTarget.files ?? []))
      }
    />
  ) : null;

  const status = (
    <>
      {progress !== null && (
        <div
          className="file-cell__progress"
          role="progressbar"
          aria-label={`Uploading to ${title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-valuetext={`${progress}% uploaded`}
        >
          <span className="file-cell__track">
            <i style={{ width: `${progress}%` }} />
          </span>
          <small>Uploading {progress}%</small>
        </div>
      )}
      {error && (
        <div className="file-cell__error" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
          <button
            type="button"
            aria-label={`Dismiss the ${title} upload message`}
            onClick={() => setError(null)}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
    </>
  );

  /**
   * On the mobile board a cell is a tap target, not a workspace: the chips are
   * too small to hit reliably and the evidence manager already does upload,
   * preview and delete at full size. So the whole cell opens it, exactly as the
   * other mobile board fields do.
   */
  if (mobile && onOpen) {
    return (
      <div className={`${cellClassName} is-mobile`}>
        <CellStyles />
        <button
          className="file-cell__open"
          type="button"
          aria-label={
            total
              ? `${title}: ${fileCountLabel(total)}. Open to manage documents.`
              : `${title}: no documents. Open to add one.`
          }
          onClick={onOpen}
        >
          {total ? (
            <>
              <span className="file-cell__chips" aria-hidden="true">
                {visible.map((file) => {
                  const glyph = fileGlyph(file);
                  return (
                    <span
                      className={`file-cell__glyph is-${glyph.kind}`}
                      key={file.id}
                    >
                      <GlyphMark glyph={glyph} />
                    </span>
                  );
                })}
              </span>
              <strong>{fileCountLabel(total)}</strong>
            </>
          ) : (
            <span className="file-cell__add-mark" aria-hidden="true">
              <Icon name="plus" size={16} />
            </span>
          )}
        </button>
        {status}
      </div>
    );
  }

  if (summary === "count") {
    return (
      <div
        className={`${cellClassName} is-count`}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onKeyDown={handleKeyDown}
      >
        <CellStyles />
        <button
          className="file-cell__count"
          type="button"
          disabled={busy}
          title={total ? `${title}: ${fileCountLabel(total)}` : `Add a file to ${title}`}
          aria-label={
            total
              ? `${title}: ${fileCountLabel(total)}. ${onOpen ? "Open to manage documents." : "Add another document."}`
              : `Add a file to ${title}`
          }
          onClick={() => {
            if (total && onOpen) onOpen();
            else if (editable) openPicker();
          }}
        >
          {total ? (
            <>
              <Icon name="document" size={13} />
              <b>{total}</b>
            </>
          ) : (
            <Icon name="plus" size={15} />
          )}
        </button>
        {picker}
        {status}
      </div>
    );
  }

  return (
    <div
      className={cellClassName}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onKeyDown={handleKeyDown}
    >
      <CellStyles />
      {total > 0 && (
        <ul className="file-cell__chips" aria-label={`${title} documents`}>
          {visible.map((file) => {
            const glyph = fileGlyph(file);
            const removing = removingId === file.id;
            /* Resolved once: the union is discriminated, so reading `.href`
               off a fresh call in each branch does not narrow. */
            const target = openTargetFor(file);
            return (
              <li className={`file-cell__chip is-${glyph.kind}`} key={file.id}>
                {/*
                  A picture opens the viewer; a PDF opens in its own tab; a
                  spreadsheet downloads. `openTargetFor` decides, so this cell
                  and the board's photo cells cannot disagree about what a
                  given file does — the Store Documentation board is mostly
                  PDFs, which is exactly why the occasional photograph in it
                  used to land in a raw browser tab with no way to zoom.
                */}
                {target.mode === "viewer" ? (
                  <button
                    className="file-cell__chip-open"
                    type="button"
                    title={documentName(file)}
                    aria-label={`Open ${title}: ${documentName(file)}, ${glyph.label}, ${humanSize(file.byteSize)}`}
                    onClick={(event) => {
                      event.currentTarget.focus();
                      setViewing(file.id);
                    }}
                  >
                    <span className="file-cell__glyph" aria-hidden="true">
                      <GlyphMark glyph={glyph} />
                    </span>
                  </button>
                ) : (
                  <a
                    className="file-cell__chip-open"
                    href={target.href}
                    /* A download is a navigation to the same origin, not a new
                       window — opening a blank tab that immediately closes is
                       what the old `_blank` did for spreadsheets. */
                    target={target.mode === "tab" ? "_blank" : undefined}
                    rel={target.mode === "tab" ? "noreferrer" : undefined}
                    /*
                     * BARE `download`, SO THE SERVER NAMES THE FILE.
                     *
                     * A `download` attribute WITH a value overrides
                     * `Content-Disposition` for a same-origin URL, and
                     * `/api/files/[id]` now builds that header from the same
                     * display-name rule this chip draws — the title with the
                     * stored extension kept, and " (vN)" on a superseded
                     * version. Naming the file here too would put a second,
                     * disagreeing naming rule in the client: the chip would say
                     * "PAT certificate 2026" and the file on disk would say
                     * IMG_4471.jpg. Empty means "download, and take the name
                     * from the response", which is the one place it is decided.
                     */
                    download={target.mode === "download" ? "" : undefined}
                    title={documentName(file)}
                    aria-label={`Open ${title}: ${documentName(file)}, ${glyph.label}, ${humanSize(file.byteSize)}`}
                  >
                    <span className="file-cell__glyph" aria-hidden="true">
                      <GlyphMark glyph={glyph} />
                    </span>
                  </a>
                )}
                {editable && (
                  <button
                    className="file-cell__chip-remove"
                    type="button"
                    disabled={busy}
                    aria-label={`Remove ${title}: ${documentName(file)}`}
                    onClick={() => void removeFile(file)}
                  >
                    {removing ? (
                      <span className="file-cell__spinner" aria-hidden="true" />
                    ) : (
                      <Icon name="close" size={11} />
                    )}
                  </button>
                )}
              </li>
            );
          })}
          {overflow > 0 &&
            (canExpand || onOpen ? (
              <li className="file-cell__chip is-overflow">
                <button
                  type="button"
                  aria-label={
                    canExpand
                      ? `Show all ${fileCountLabel(total)} in ${title}`
                      : `Open ${title} to see ${fileCountLabel(total)}`
                  }
                  aria-expanded={canExpand ? expanded : undefined}
                  onClick={() => {
                    if (canExpand) setExpanded(true);
                    else onOpen?.();
                  }}
                >
                  {overflowMark}
                </button>
              </li>
            ) : (
              // Nothing to expand and nowhere to open: the badge is a label, so
              // it carries real text for a screen reader rather than an
              // aria-label on a generic element, which AT may drop.
              <li className="file-cell__chip is-overflow">
                <span title={`${title}: ${fileCountLabel(total)}`}>
                  <span aria-hidden="true">{overflowMark}</span>
                  <span className="file-cell__sr">
                    {visible.length
                      ? `${overflow} more in ${title}`
                      : `${title}: ${fileCountLabel(total)}`}
                  </span>
                </span>
              </li>
            ))}
        </ul>
      )}

      {/*
        Carousel of the pictures in this cell only, so a swipe stays inside the
        column that was opened. Non-images are excluded rather than rendered as
        a slide: this board is mostly PDFs, and a swipe that lands on a broken
        image is worse than a swipe that stops.
      */}
      {viewing && (
        <MediaViewer
          files={files.filter((file) => openTargetFor(file).mode === "viewer")}
          currentId={viewing}
          contextLabel={title}
          onNavigate={setViewing}
          onClose={() => setViewing(null)}
        />
      )}

      {editable && (
        <button
          ref={addButtonRef}
          className="file-cell__add"
          type="button"
          disabled={busy}
          title={total ? `Add a file to ${title}` : `Add the first file to ${title}`}
          aria-label={
            total
              ? `Add another file to ${title}. ${fileCountLabel(total)} attached.`
              : `Add a file to ${title}`
          }
          onClick={openPicker}
        >
          <span className="file-cell__add-mark" aria-hidden="true">
            <Icon name="plus" size={15} />
          </span>
        </button>
      )}
      {!editable && total === 0 && (
        <span className="file-cell__none">{`No ${title} document`}</span>
      )}
      {picker}
      {status}
    </div>
  );
}
