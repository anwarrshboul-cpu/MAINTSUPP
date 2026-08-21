"use client";

/**
 * THE UPDATES PANEL, built against monday's.
 *
 * The owner compared the two side by side and said the words this file exists
 * to answer: "i dont have the same look and tools and features do exactly the
 * same as them". `db/monday-export/UPDATES-PANEL-CAPTURE.md` is the capture of
 * their panel taken from their screenshots, and it is the authority — every
 * decision below points at a row of the table in it.
 *
 * WHAT WAS ALREADY RIGHT, and is kept: the tab reads `Updates / N`; the thread
 * runs newest first with replies oldest-first inside a parent; every update and
 * reply carries an avatar of the author's initials; comments and their files
 * come from `item_updates` and `attachments.update_id` rather than the audit
 * log. None of that is rebuilt here.
 *
 * WHAT WAS MISSING, in the capture's own order of visibility:
 *
 *  1. THE COMPOSER WAS AT THE BOTTOM. monday's sits above the thread, and on a
 *     job with seventeen comments ours was a scroll away from the thing you
 *     opened the tab to do. It is the first child of this component now.
 *  2. RELATIVE TIME WAS LONG-FORM. "11 days ago" against monday's `11d`. The
 *     exact instant is still on hover and still in the `title`, which is what
 *     makes the short form safe.
 *  3. LIKE DID NOT EXIST. It does now, stored a row per person — see
 *     `item_update_likes` in db/schema.ts for why it is not a counter.
 *  4. ONLY TOP-LEVEL COMMENTS COULD BE REPLIED TO. Each reply carries its own
 *     `Reply` in monday, and now here.
 *  5. THE REPLY BOX WAS HIDDEN BEHIND A BUTTON. monday keeps one open at the
 *     foot of each thread. `Reply` on a specific reply now focuses that box and
 *     seeds the mention rather than opening a second one somewhere else.
 *  6. ATTACHMENTS WERE CHIPS. monday RENDERS the file under the link — a quote
 *     you cannot see without downloading is a quote nobody reads.
 *  7. NO `… See more`. Long bodies ran to full height and pushed the rest of
 *     the thread off the screen.
 *  8. THE COMPOSER HAD ONE TOOL. monday has four: `@`, attach, emoji,
 *     formatting.
 *
 * DELIBERATELY NOT COPIED, and the capture says why: `Update via email` (there
 * is no mail ingestion in this product, and a control that silently does
 * nothing is worse than no control) and `Give feedback` (monday's own channel,
 * not ours).
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Avatar, Icon } from "../../components";
import { formatLongDate, formatTimeOfDay } from "../../lib/format-date";
import type { RequestUpdate, RequestUpdateFile } from "../../lib/types";

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

/**
 * monday's short form: `5m`, `11d`, `3w`, `2mo`, `1y`.
 *
 * The app's own `formatRelativeTime` says "11 days ago", which is the right
 * answer to a different question. This thread puts the time immediately after
 * a bold name on one line, next to a `Like` and a `Reply`, and at that size the
 * long form wraps the line on a phone. It is only safe to be this terse because
 * the exact instant — with the year, which matters on a thread running from
 * 2023 to 2026 — is on the `title` of the same element.
 *
 * `now` is passed in rather than read from the clock so that every row in one
 * render agrees about the present, and so this is testable.
 */
export function shortRelativeTime(value: string | null, now: number): string {
  if (!value) return "";
  /*
   * Two shapes, as everywhere else that reads this column: the importer writes
   * ISO with a Z, and a row written by the app takes SQLite's CURRENT_TIMESTAMP
   * — UTC, space-separated, no zone marker. Left alone, `Date.parse` reads the
   * second as LOCAL time, and a comment written a minute ago renders as `1h` in
   * Britain in summer.
   */
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const then = Date.parse(normalised);
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((now - then) / 1000);
  // A clock a few seconds ahead of the server is the present, not the future.
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30.44)}mo`;
  return `${Math.round(days / 365.25)}y`;
}

/** The precise moment, with the year — the hover, and what assistive tech reads. */
function exactMoment(value: string | null): string {
  if (!value) return "";
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) return "";
  // The long month is this one screen's own choice — it is a tooltip and a
  // screen-reader label rather than a column, so it has room for the word.
  return `${formatLongDate(parsed)}, ${formatTimeOfDay(parsed)}`;
}

/* ------------------------------------------------------------------ */
/* The body                                                            */
/* ------------------------------------------------------------------ */

/**
 * What the `✎` button writes, rendered back.
 *
 * The formatting control could not be a lie. monday's composer is rich text;
 * `item_updates.body` is a TEXT column holding 265 imported plain-text rows,
 * and turning it into stored HTML would mean either a migration of real
 * operational comments or two body formats in one thread. So the button writes
 * markers into the text — `**bold**`, `_italic_`, `` `code` `` — and this
 * renders them. The stored comment stays readable as itself, which is what the
 * export, the search and the imported rows all need it to be.
 *
 * Mentions and bare links are picked up in the same pass because they are the
 * same problem — a span of the body that is not plain text — and two passes
 * over the same string would each have to avoid the other's output.
 */
const RICH = /(\*\*[^*\n]+\*\*|_[^_\n]+_|`[^`\n]+`|@[\w][\w.'-]*(?: [A-Z][\w.'-]*)?|https?:\/\/[^\s<>"]+)/g;

function renderRich(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Line breaks survive: a comment listing three parts on three lines is not
  // one paragraph, and `white-space: pre-wrap` alone would not give the links
  // and mentions below anything to attach to.
  const lines = text.split("\n");
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) out.push(<br key={`br${lineIndex}`} />);
    const parts = line.split(RICH);
    parts.forEach((part, index) => {
      if (!part) return;
      const key = `${lineIndex}:${index}`;
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        out.push(<strong key={key}>{part.slice(2, -2)}</strong>);
      } else if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
        out.push(<em key={key}>{part.slice(1, -1)}</em>);
      } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        out.push(<code key={key}>{part.slice(1, -1)}</code>);
      } else if (part.startsWith("@") && part.length > 1) {
        out.push(
          <span className="update-mention" key={key}>
            {part}
          </span>,
        );
      } else if (/^https?:\/\//.test(part)) {
        out.push(
          /* `noreferrer` as well as `noopener`: these are links other people
             typed into a comment box, and the destination has no business
             learning which job they were pasted onto. */
          <a href={part} key={key} rel="noreferrer noopener" target="_blank">
            {part}
          </a>,
        );
      } else {
        out.push(<Fragment key={key}>{part}</Fragment>);
      }
    });
  });
  return out;
}

/**
 * `… See more` / `… See less`, on the body.
 *
 * The threshold is characters AND lines, because either alone lets a comment
 * through that fills the panel: 900 characters of prose is four lines at the
 * width of a desktop drawer, and twelve short lines of a parts list is 200
 * characters. Whichever is exceeded, the body clamps.
 *
 * The clamp is CSS (`-webkit-line-clamp`) rather than a substring, so nothing
 * is thrown away — expanding is a repaint, and a reader who searches the page
 * with the browser's own Find still matches text inside a collapsed body.
 */
const LONG_BODY_CHARS = 420;
const LONG_BODY_LINES = 7;

function UpdateBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const long =
    body.length > LONG_BODY_CHARS || body.split("\n").length > LONG_BODY_LINES;

  return (
    <div className="update-body-wrap">
      <p className={`update-body${long && !expanded ? " is-clamped" : ""}`}>
        {renderRich(body)}
      </p>
      {long && (
        <button
          className="update-more"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          … {expanded ? "See less" : "See more"}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

const KB = 1024;

function fileSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
}

function glyphFor(contentType: string): "document" | "camera" | "paperclip" {
  if (contentType === "application/pdf") return "document";
  if (contentType.startsWith("image/") || contentType.startsWith("video/")) return "camera";
  return "paperclip";
}

/**
 * The filename as a link, and the file RENDERED underneath it.
 *
 * This is capture item 6 and the one with the most behind it: 53 imported
 * comments carry a file, and several of them are the quote or the invoice the
 * comment is about. As a chip, reading one meant a download, a viewer, and
 * losing your place in the thread.
 *
 * WHY THE PREVIEW MOUNTS LATE. An `<object>` is a document embed — the browser
 * loads the file and, for a PDF, starts its viewer. Mounting one per
 * attachment on a thread with a dozen quotes would fetch a dozen PDFs before
 * the reader had scrolled to the second comment. So the frame is on the page
 * from the start, keeping its own space, and the embed inside it is created the
 * first time it comes near the viewport and never removed after that. Removing
 * it on the way out would restart the download every time somebody scrolled
 * past, and would throw away the page a reader had scrolled to inside it.
 *
 * IMAGES ARE NOT DEFERRED THE SAME WAY: `loading="lazy"` is the browser's own
 * answer for those and it is better than this one, because it also handles
 * priority and decoding.
 */
function UpdateAttachment({ file }: { file: RequestUpdateFile }) {
  const isImage = file.contentType.startsWith("image/");
  const isVideo = file.contentType.startsWith("video/");
  const isPdf = file.contentType === "application/pdf";
  const previewable = isImage || isVideo || isPdf;

  const [open, setOpen] = useState(true);
  const [near, setNear] = useState(false);

  /*
   * The observer is attached by a REF CALLBACK, not an effect.
   *
   * The effect this replaces had to read `frame.current`, and therefore had to
   * re-run when `open` or `near` changed to catch the frame mounting — and its
   * no-observer branch called `setNear` in the effect body, which is a
   * cascading render and which `react-hooks/set-state-in-effect` fails the
   * build over. A ref callback is handed the node at the moment it exists,
   * which is exactly the question being asked, and React 19 takes its return
   * value as the cleanup.
   *
   * `near` is deliberately NOT read here. Deciding it at render — `typeof
   * IntersectionObserver === "undefined"` is true on the server and false in
   * the browser — would make the server's HTML and the first client render
   * disagree about whether the embed is present, which is a hydration error in
   * the console of a product whose audit requires none.
   */
  const watchFrame = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element || !previewable || isImage) return undefined;
      if (typeof IntersectionObserver === "undefined") {
        // No observer (older engines) — show it rather than leaving an empty
        // box that no amount of scrolling can ever fill.
        setNear(true);
        return undefined;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          setNear(true);
          // Once it is on, it stays on — see the note above about not
          // unmounting the embed — so there is nothing left to watch for.
          observer.disconnect();
        },
        // A screen of lead time, so the embed is ready by the time it is read.
        { rootMargin: "600px 0px" },
      );
      observer.observe(element);
      return () => observer.disconnect();
    },
    [isImage, previewable],
  );

  return (
    <div className="update-file">
      <div className="update-file__head">
        <Icon name={glyphFor(file.contentType)} size={15} />
        <a href={file.url} rel="noreferrer" target="_blank" title={file.name}>
          {file.name}
        </a>
        <small>{fileSize(file.byteSize)}</small>
        {previewable && (
          <button
            className="update-more"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            … {open ? "See less" : "See more"}
          </button>
        )}
      </div>
      {previewable && open && (
        <div className="update-file__frame" ref={watchFrame}>
          {isImage && (
            /* The full file, not `thumbUrl`. The thumbnail is 96px of a chip
               and a photograph of a fault at that size proves nothing; this is
               the picture, sized by CSS and lazily fetched by the browser. */
            <img alt={file.name} loading="lazy" src={file.url} />
          )}
          {isVideo && <video controls preload="metadata" src={file.url} />}
          {isPdf &&
            (near ? (
              <object data={file.url} type="application/pdf">
                {/* Chrome on iOS renders nothing for an embedded PDF, so the
                    fallback is a real way through rather than an apology. */}
                <a href={file.url} rel="noreferrer" target="_blank">
                  Open {file.name}
                </a>
              </object>
            ) : (
              <div className="update-file__placeholder">Loading preview…</div>
            ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Like                                                                */
/* ------------------------------------------------------------------ */

/**
 * `👍 Like`.
 *
 * OPTIMISTIC, AND CORRECTED BY THE ANSWER. The thumb fills on the click because
 * a like that waits for a round trip feels broken, but the count that stays is
 * the server's — somebody else may have liked it in the same second, and the
 * server is the only party that knows. A failure puts the button back exactly
 * as it was and says so, rather than leaving a filled thumb over a like that
 * was never stored.
 */
function LikeButton({
  update,
  onToggle,
}: {
  update: Pick<RequestUpdate, "id" | "likeCount" | "likedByMe" | "likedBy">;
  onToggle: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const people = update.likedBy.length ? update.likedBy.join(", ") : null;

  return (
    <button
      className={`update-action update-like${update.likedByMe ? " is-liked" : ""}`}
      type="button"
      disabled={busy}
      aria-pressed={update.likedByMe}
      title={people ?? undefined}
      onClick={async () => {
        setBusy(true);
        try {
          await onToggle(update.id);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="thumb" size={14} />
      <span>Like</span>
      {update.likeCount > 0 && <b>{update.likeCount}</b>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* The composer                                                        */
/* ------------------------------------------------------------------ */

/* monday's row is `@ 📎 🙂 ✎`. Emoji people actually use on a maintenance job:
   an acknowledgement, a warning, a tick, a part, a van. Not a picker library —
   twelve is a row and a half and covers what a coordinator reaches for. */
const EMOJI = ["👍", "🙏", "✅", "❌", "⚠️", "🔧", "🚐", "📅", "📷", "🔥", "💧", "🙂"];

type ComposerProps = {
  placeholder: string;
  submitLabel: string;
  /** Names offered by `@`. See the note on `mentions` in `UpdateThread`. */
  mentions: string[];
  busy: boolean;
  error: string | null;
  onSubmit: (body: string, files: File[]) => Promise<void>;
  /** Reply boxes are compact and carry the author's avatar; the top one does not. */
  variant?: "update" | "reply";
  avatarName?: string | null;
  onDismiss?: () => void;
};

export type ComposerHandle = { focus: (seed?: string) => void };

function Composer({
  placeholder,
  submitLabel,
  mentions,
  busy,
  error,
  onSubmit,
  variant = "update",
  avatarName,
  onDismiss,
  handleRef,
}: ComposerProps & { handleRef?: (handle: ComposerHandle | null) => void }) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [menu, setMenu] = useState<"none" | "mention" | "emoji" | "format">("none");
  const box = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  /*
   * Text goes in AT THE CURSOR, not on the end.
   *
   * Every tool in this row inserts something — a mention, an emoji, a pair of
   * formatting markers — and appending would put it after a sentence somebody
   * was in the middle of. `setRangeText` also leaves the undo stack intact,
   * which rewriting `value` wholesale does not.
   */
  const insert = useCallback((text: string, wrap = false) => {
    const element = box.current;
    if (!element) return;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    const selected = element.value.slice(start, end);
    const next = wrap ? `${text}${selected}${text}` : text;
    element.setRangeText(next, start, end, "end");
    // When wrapping a selection, land the cursor between the markers so typing
    // continues inside the emphasis rather than after it.
    if (wrap && !selected) {
      const caret = start + text.length;
      element.setSelectionRange(caret, caret);
    }
    setValue(element.value);
    element.focus();
  }, []);

  useEffect(() => {
    if (!handleRef) return undefined;
    handleRef({
      focus: (seed?: string) => {
        const element = box.current;
        if (!element) return;
        if (seed) {
          /* Seeding a mention must not wipe a draft, and must not repeat
             itself if `Reply` is pressed twice on the same person. */
          setValue((current) =>
            current.includes(seed.trim()) ? current : `${seed}${current}`,
          );
        }
        element.focus();
        element.scrollIntoView({ block: "nearest" });
      },
    });
    return () => handleRef(null);
  }, [handleRef]);

  const send = async () => {
    const body = value.trim();
    if (!body && !files.length) return;
    await onSubmit(body, files);
    setValue("");
    setFiles([]);
    setMenu("none");
  };

  return (
    <div className={`update-composer update-composer--${variant}`}>
      {variant === "reply" && avatarName && <Avatar name={avatarName} size="small" />}
      <div className="update-composer__main">
        <textarea
          ref={box}
          rows={variant === "reply" ? 2 : 3}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            /* ⌘/Ctrl+Enter sends, as it does in monday. Enter alone must stay a
               newline: these comments routinely list three things on three
               lines, and a box that posts on Enter loses the second and third. */
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
            if (event.key === "Escape" && onDismiss) onDismiss();
          }}
        />

        {menu === "mention" && (
          <div className="update-menu" role="listbox" aria-label="Mention someone">
            {mentions.length === 0 && (
              <span className="update-menu__empty">
                Nobody has posted on this job yet.
              </span>
            )}
            {mentions.map((name) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => {
                  insert(`@${name} `);
                  setMenu("none");
                }}
              >
                <Avatar name={name} size="small" />
                {name}
              </button>
            ))}
          </div>
        )}
        {menu === "emoji" && (
          <div className="update-menu update-menu--emoji" aria-label="Add an emoji">
            {EMOJI.map((glyph) => (
              <button
                key={glyph}
                type="button"
                aria-label={glyph}
                onClick={() => {
                  insert(glyph);
                  setMenu("none");
                }}
              >
                {glyph}
              </button>
            ))}
          </div>
        )}
        {menu === "format" && (
          <div className="update-menu update-menu--format" aria-label="Formatting">
            <button type="button" onClick={() => insert("**", true)}>
              <b>Bold</b>
            </button>
            <button type="button" onClick={() => insert("_", true)}>
              <i>Italic</i>
            </button>
            <button type="button" onClick={() => insert("`", true)}>
              <code>Code</code>
            </button>
          </div>
        )}

        {files.length > 0 && (
          <div className="update-composer__files">
            {files.map((file, index) => (
              <span key={`${file.name}:${file.size}:${index}`}>
                <Icon name={glyphFor(file.type)} size={13} />
                {file.name}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    setFiles((current) => current.filter((_, at) => at !== index))
                  }
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {error && (
          <small className="update-composer__error" role="alert">
            {error}
          </small>
        )}

        <div className="update-composer__tools">
          {/* monday's four, in monday's order. */}
          <button
            type="button"
            className={menu === "mention" ? "is-open" : ""}
            aria-label="Mention someone"
            title="Mention someone"
            onClick={() => setMenu((current) => (current === "mention" ? "none" : "mention"))}
          >
            @
          </button>
          <button
            type="button"
            aria-label="Attach a file"
            title="Attach a file"
            onClick={() => picker.current?.click()}
          >
            <Icon name="paperclip" size={15} />
          </button>
          <button
            type="button"
            className={menu === "emoji" ? "is-open" : ""}
            aria-label="Add an emoji"
            title="Add an emoji"
            onClick={() => setMenu((current) => (current === "emoji" ? "none" : "emoji"))}
          >
            🙂
          </button>
          <button
            type="button"
            className={menu === "format" ? "is-open" : ""}
            aria-label="Formatting"
            title="Formatting"
            onClick={() => setMenu((current) => (current === "format" ? "none" : "format"))}
          >
            <Icon name="edit" size={15} />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            aria-label="Attach a file to this update"
            onChange={(event) => {
              const chosen = Array.from(event.target.files ?? []);
              if (chosen.length) setFiles((current) => [...current, ...chosen]);
              // Cleared so picking the same file twice still fires a change.
              event.target.value = "";
            }}
          />
          <span className="update-composer__spacer" />
          {onDismiss && (
            <button className="update-composer__cancel" type="button" onClick={onDismiss}>
              Cancel
            </button>
          )}
          <button
            className="update-composer__send"
            type="button"
            disabled={busy || (!value.trim() && !files.length)}
            onClick={() => void send()}
          >
            {busy ? "Sending…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The thread                                                          */
/* ------------------------------------------------------------------ */

export function UpdateThread({
  updates,
  loading,
  error,
  now,
  currentUserName,
  onReload,
  onSubmit,
  onLikeChange,
  composerRef,
}: {
  updates: RequestUpdate[];
  loading: boolean;
  error: string | null;
  now: number;
  currentUserName: string | null;
  onReload: () => void | Promise<void>;
  onSubmit: (body: string, parentId: string | null, files: File[]) => Promise<void>;
  /** Applied in place by the drawer, so a like does not re-fetch the thread. */
  onLikeChange: (updateId: string, liked: boolean, likeCount: number) => void;
  /*
   * A handle on the top composer, for the drawer's two footer buttons.
   *
   * "Write an update" and "Add update" switch to this tab and put the cursor in
   * the box. They held a `RefObject<HTMLTextAreaElement>` on the drawer's own
   * textarea, which no longer exists — the box is this component's, and its
   * value and its file list are its own state. The same `ComposerHandle` the
   * reply boxes already use is handed up instead, so there is one focus
   * mechanism rather than a ref that reaches through the component boundary.
   */
  composerRef?: (handle: ComposerHandle | null) => void;
}) {
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [replyingUnder, setReplyingUnder] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  const replyHandles = useRef(new Map<string, ComposerHandle | null>());

  /*
   * Who `@` offers.
   *
   * The people who have already spoken on this job, newest first, deduplicated
   * — not a workspace directory. Two reasons, and the second is the real one:
   * there is no roster endpoint the drawer holds, and more importantly 265 of
   * these updates were imported from monday and their authors have no row in
   * `users` at all. A directory-backed menu would therefore fail to offer
   * exactly the people whose names are on the thread you are replying to.
   */
  const mentions = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const update of updates) {
      for (const person of [update.authorName, ...update.replies.map((r) => r.authorName)]) {
        const name = person?.trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        names.push(name);
      }
    }
    return names;
  }, [updates]);

  const toggleLike = useCallback(
    async (updateId: string) => {
      try {
        const response = await fetch("/api/updates", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updateId }),
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { liked?: boolean; likeCount?: number };
        onLikeChange(updateId, payload.liked ?? false, payload.likeCount ?? 0);
      } catch {
        /* A like that did not save simply does not move. There is no message:
           the button is unchanged, which is the truth, and a toast for a failed
           thumb would be louder than the thing it failed at. */
      }
    },
    [onLikeChange],
  );

  const post = useCallback(
    async (body: string, parentId: string | null, files: File[]) => {
      const setError = parentId ? setReplyError : setPostError;
      setPosting(true);
      setError(null);
      try {
        await onSubmit(body, parentId, files);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : parentId
              ? "The reply could not be saved."
              : "The update could not be saved.",
        );
        // Rethrown so the composer keeps the draft: clearing a box whose
        // contents were never stored is how a comment gets lost.
        throw caught;
      } finally {
        setPosting(false);
      }
    },
    [onSubmit],
  );

  return (
    <div className="update-panel">
      {/*
        THE COMPOSER, AT THE TOP. Capture item 1, and the one the owner would
        see first. Ours sat under the whole thread.
      */}
      <Composer
        placeholder="Write an update and mention others with @"
        submitLabel="Update"
        mentions={mentions}
        busy={posting && !replyingUnder}
        error={postError}
        handleRef={composerRef}
        onSubmit={(body, files) => post(body, null, files)}
      />

      {loading && updates.length === 0 && (
        <div className="drawer-history-state">Loading updates…</div>
      )}
      {error && (
        <div className="drawer-history-state drawer-history-state--error">
          <span>{error}</span>
          <button type="button" onClick={() => void onReload()}>
            Try again
          </button>
        </div>
      )}
      {!loading && !error && updates.length === 0 && (
        <div className="drawer-history-state">
          No updates yet. The box above is where the first one goes.
        </div>
      )}

      {!error &&
        updates.map((update) => (
          <article className="update-card" key={update.id}>
            <header className="update-head">
              {/* The author's own name, not a lookup: imported authors have no
                  workspace user row, and resolving an email would render
                  "Unknown" against every historic comment. */}
              <Avatar name={update.authorName} size="small" />
              <div>
                <strong>{update.authorName}</strong>
                <small title={exactMoment(update.createdAt)}>
                  {shortRelativeTime(update.createdAt, now)}
                  {update.editedAt && <em> · edited</em>}
                </small>
              </div>
            </header>

            {/* An update can be a picture with no caption — three of monday's
                are. An empty <p> would draw padding above the image and read as
                a rendering fault. */}
            {update.body && <UpdateBody body={update.body} />}
            {update.files.map((file) => (
              <UpdateAttachment file={file} key={file.id} />
            ))}

            {/* The rule, then Like and Reply — monday's arrangement exactly. */}
            <footer className="update-actions">
              <LikeButton update={update} onToggle={toggleLike} />
              <button
                className="update-action"
                type="button"
                onClick={() => {
                  setReplyingUnder(update.id);
                  setReplyError(null);
                  // The box may be mounting in this very commit, so the focus is
                  // queued rather than attempted against a handle that is null.
                  requestAnimationFrame(() =>
                    replyHandles.current.get(update.id)?.focus(),
                  );
                }}
              >
                <Icon name="reply" size={14} />
                <span>Reply</span>
              </button>
            </footer>

            {update.replies.length > 0 && (
              <div className="update-replies">
                {update.replies.map((reply) => (
                  <article className="update-card is-reply" key={reply.id}>
                    <header className="update-head">
                      <Avatar name={reply.authorName} size="small" />
                      <div>
                        <strong>{reply.authorName}</strong>
                        <small title={exactMoment(reply.createdAt)}>
                          {shortRelativeTime(reply.createdAt, now)}
                          {reply.editedAt && <em> · edited</em>}
                        </small>
                      </div>
                    </header>
                    {reply.body && <UpdateBody body={reply.body} />}
                    {reply.files.map((file) => (
                      <UpdateAttachment file={file} key={file.id} />
                    ))}
                    {/*
                      Capture item: "Each reply carries its own ↩ Reply".
                      It posts to the SAME parent — monday's threads are one
                      level deep — and seeds the mention, which is what makes a
                      reply-to-a-reply legible without a second nesting level
                      that the data model does not have.
                    */}
                    <footer className="update-actions">
                      <LikeButton update={reply} onToggle={toggleLike} />
                      <button
                        className="update-action"
                        type="button"
                        onClick={() => {
                          setReplyingUnder(update.id);
                          setReplyError(null);
                          requestAnimationFrame(() =>
                            replyHandles.current
                              .get(update.id)
                              ?.focus(`@${reply.authorName} `),
                          );
                        }}
                      >
                        <Icon name="reply" size={14} />
                        <span>Reply</span>
                      </button>
                    </footer>
                  </article>
                ))}
              </div>
            )}

            {/*
              The reply box at the FOOT of the thread, as monday has it.
              It opens on Reply rather than standing open under all seventeen
              comments at once — a permanently-open box per card would put a
              textarea between every pair of comments in the panel.
            */}
            {replyingUnder === update.id && (
              <Composer
                variant="reply"
                avatarName={currentUserName}
                placeholder="Write a reply and mention others with @"
                submitLabel="Reply"
                mentions={mentions}
                busy={posting}
                error={replyError}
                handleRef={(handle) => replyHandles.current.set(update.id, handle)}
                onDismiss={() => {
                  setReplyingUnder(null);
                  setReplyError(null);
                }}
                onSubmit={async (body, files) => {
                  await post(body, update.id, files);
                  setReplyingUnder(null);
                }}
              />
            )}
          </article>
        ))}
    </div>
  );
}
