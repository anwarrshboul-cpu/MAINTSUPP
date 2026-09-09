"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components";
import FormActivity from "./form-activity";
import type { BuilderColumn } from "./form-bindings";
import { FormDesignPanel, FormSettingsPanel } from "./form-builder-panels";
import { FormEditPanel } from "./form-edit-panel";
import FormPreview from "./form-preview";
import FormShareDialog from "./form-share-dialog";
import type { BuilderForm, BuilderMode } from "./form-builder-model";
import { formSaveLabel, useFormSave } from "./form-builder-save";
import { FormView } from "./views/board-views";
import "./form-builder.css";

/**
 * The four PATCH sections that can arrive in a burst, and are therefore worth
 * coalescing. See `patch` below for why the list is short rather than long.
 */
const DEBOUNCED_SECTIONS = new Set(["title", "description", "appearance", "accessibility"]);

/**
 * The four editing surfaces, and their words, in one place.
 *
 * A tuple list rather than a string array with a ternary chain beside it: the
 * chain was already two levels deep for three modes and would have been three
 * for four, which is the shape that eventually labels a button wrong. `editing`
 * below is derived from this same list, so a mode added here cannot be one the
 * "Back to view" button has forgotten about — which would strand a phone inside
 * a panel with no way out, the exact failure the removed `matchMedia` reset
 * used to cause.
 */
const EDITING_MODES: ReadonlyArray<readonly [BuilderMode, string]> = [
  ["edit", "Edit"],
  ["design", "Design"],
  ["settings", "Settings"],
  ["activity", "Activity"],
];

/**
 * The Form tab: monday's form builder over our own live form.
 *
 * WHAT THIS ADDS AND WHAT IT DELIBERATELY DOES NOT REPLACE
 *
 * The Form tab already rendered a working, fillable request form — `FormView` —
 * and that is still exactly what a reader sees by default. This wraps it in
 * monday's builder chrome: the Back / Preview / Edit / Design / Settings strip
 * and the Share form button. `FormView` is untouched; it is rendered here as
 * the "view" and "preview" modes, so the questions a coordinator fills in are
 * the same component the product has always used.
 *
 * EDITING IS NO LONGER DESKTOP ONLY — AND IT IS THE SAME CONFIGURATION
 *
 * It was, and the reasoning was sound at the time: editing a form on a 360px
 * screen is a bad idea, so `.form-builder__bar` carried a single
 * `display: none` below 768px. The owner has since asked for the opposite, on
 * the grounds that the people holding a phone are the ones standing in a store
 * when a question turns out to be wrong.
 *
 * So the toolbar is drawn at every width. What has NOT changed is where the
 * settings live: there is one configuration and one way to save it. Every
 * control in every panel still writes straight through to
 * `PATCH /api/board/form` and still replaces its state from that response, so
 * a change made on a phone and a change made on a desktop are the same write
 * to the same row, visible in the public form immediately. There is no mobile
 * form model, no second draft, and nothing to reconcile — which is the whole
 * reason this was a CSS change rather than a new screen.
 *
 * The CSS-not-JavaScript rule still holds for anything width-dependent here:
 *
 *  1. This is a server-rendered app. A width-dependent render is a hydration
 *     mismatch — the server has no viewport — and React would either warn or,
 *     worse, flash a control in before removing it.
 *  2. `display: none` removes an element from the accessibility tree as well as
 *     from the page, so a screen reader does not announce controls that are not
 *     there. A JS check that merely skipped the render would be no better and a
 *     CSS `visibility: hidden` would be worse.
 *
 * SHARING ON A PHONE IS STILL ITS OWN CONTROL, and it is the SAME link
 *
 * The phone share strip predates this and stays. Handing somebody the link is
 * the thing a person on site does most, and a one-tap field beats opening the
 * Share dialog to reach the same string — so on a phone the toolbar's Share
 * pair steps aside for it rather than drawing the same action twice.
 *
 * It mints NOTHING. It shares `form.presentedUrl` — the exact string the
 * desktop Share dialog displays and its Copy button copies, produced by
 * `presentedShareUrl()` in `/api/board/form`, pointing at the public
 * `/f/:token` route. That route already carries its own access model: the
 * form's `active` switch, an optional password, and `requireLogin`. Sharing
 * the authenticated dashboard URL, or inventing a second unauthenticated way
 * in, would both be new exposure; reusing the link the product already mints
 * is none.
 *
 * Same CSS-not-JavaScript rule as the toolbar, for the same two reasons: a
 * width-dependent render is a hydration mismatch, and `display: none` takes
 * the control out of the accessibility tree so a desktop screen reader does
 * not announce a button nobody can see.
 */
export default function FormBuilder({
  boardId,
  onSubmitted,
}: {
  /*
   * WHICH BOARD'S FORM. Required, and that is the fix.
   *
   * Both fetches below asked `/api/board/form` with no board at all, so the
   * server fell back to the default and the Form tab on a workspace section's
   * register rendered THE JOB BOARD'S PUBLIC FORM — its title, its questions,
   * and a Location list naming all 39 real stores — with a working Submit. A
   * PATCH from that screen then rewrote the maintenance form. Making it a
   * required prop means a caller that forgets is a compile error rather than a
   * silent leak.
   */
  boardId: string;
  onSubmitted?: () => void;
}) {
  const [form, setForm] = useState<BuilderForm | null>(null);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  /*
   * EVERY COLUMN OF THIS BOARD, not the subset the form happens to ask about.
   *
   * The Content panel could only ever offer the questions already in the stored
   * configuration, so a column added to the board after the form was created
   * was simply unreachable from the builder: there was no control anywhere that
   * could put it on the form. `/api/board/form` does not carry the column list
   * (it sends the form and the board's groups), and it is not this batch's file
   * to change — but `GET /api/board/columns` has always returned exactly this,
   * live columns only, scoped to the organisation and the board, in the board's
   * own order. So the builder asks it.
   *
   * FETCHED HERE, IN THE SHELL, and handed down. The panels must not reach the
   * network on their own — `tests/stage-twentynine-form-builder.test.mjs` holds
   * that, and it is right: a panel that fetches is a panel that re-fetches on
   * every re-render of a canvas that re-renders on every keystroke.
   */
  const [columns, setColumns] = useState<BuilderColumn[]>([]);
  /*
   * This register has no form YET, and one can be made for it — the server's
   * `canCreate` on the 404. Kept apart from `form === null`, which also covers
   * "the request failed": offering to mint a public link because a fetch timed
   * out would be the wrong thing to do quietly.
   */
  const [creatable, setCreatable] = useState(false);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<BuilderMode>("view");
  const [sharing, setSharing] = useState(false);
  /* `error` is now ONLY the load and create path. A failed SAVE is a different
     thing with a different remedy and lives on `saver.failure`, which carries a
     Retry — see `useFormSave`. Sharing one banner between them is how a
     transient pooler refusal came to look like a broken form. */
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /*
   * `[boardId]`, not `[]`.
   *
   * The dependency array was empty while the body reads `boardId`, so the
   * builder kept whichever board it first mounted with: moving between two
   * registers without remounting left the Form tab editing — and sharing —
   * the previous one's form. The same correction is made on `patch` below,
   * where the consequence was a SAVE against the wrong board.
   */
  useEffect(() => {
    let active = true;
    fetch(`/api/board/form?board=${encodeURIComponent(boardId)}`, {
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          form?: BuilderForm;
          groups?: Array<{ id: string; name: string }>;
          error?: string;
          canCreate?: boolean;
        };
        if (!active) return;
        if (!response.ok || !payload.form) {
          /*
           * A REGISTER WITH NO FORM IS OFFERED ONE OF ITS OWN.
           *
           * This used to fall through to `FormView`, which is the job board's
           * live form: the Form tab on a section's register drew "Maintenance
           * Request", its questions and a Location list naming 39 real stores,
           * with a Submit that filed the job onto the job board. The answer is
           * not to hide the tab — it is for the register to have a form of its
           * own, which is what the button below creates.
           */
          setCreatable(Boolean(payload.canCreate));
          setForm(null);
          return;
        }
        setForm(payload.form);
        setGroups(payload.groups ?? []);
      })
      .catch(() => {
        /*
         * A builder that cannot load is not an error the reader needs to see.
         * It is also not evidence that the board has no form, so nothing is
         * offered here.
         */
        if (active) setForm(null);
      });
    return () => {
      active = false;
    };
  }, [boardId]);

  /*
   * `[boardId]` for the same reason the form's own load has it: the column list
   * belongs to one register, and offering another register's columns in the
   * field picker would bind a question to a column this board does not have.
   *
   * A failure here is silent on purpose. The columns are what the picker and
   * the "has nowhere to save its answer" check are built from; without them the
   * picker says "Loading the board's columns…" and the binding check stands
   * down (see `boundIds` in form-intake-warnings.ts) rather than accusing every
   * question on the form of being unbound because a second request timed out.
   */
  useEffect(() => {
    let active = true;
    fetch(`/api/board/columns?board=${encodeURIComponent(boardId)}`, {
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { columns?: BuilderColumn[] };
        if (active && Array.isArray(payload.columns)) setColumns(payload.columns);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [boardId]);

  /*
   * THE MODE RESET IS GONE, and its absence is the change.
   *
   * There used to be a `matchMedia("(max-width: 767px)")` effect here that
   * forced `mode` back to `"view"` on every crossing of the phone boundary. It
   * was correct for the rule it served: the toolbar was `display: none` below
   * 768px, so narrowing the window while a panel was open would hide the only
   * way out and strand somebody inside it.
   *
   * The toolbar is on a phone now, so there is no stranding to prevent — and
   * the effect had become the thing standing between a phone and the panels.
   * It ran on mount as well as on change, so any mobile route into Edit would
   * have been snapped straight back to `view` before a finger left the screen.
   *
   * Nothing replaces it. `Back to view` is drawn in the toolbar in every
   * editing mode, at every width, which is the way out it was substituting for.
   */

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /**
   * One PATCH per change, applied optimistically only after the server agrees.
   *
   * The server is the one that validates a password, a limit or a close date,
   * and it returns the whole saved form — so taking its answer rather than the
   * locally guessed one means the panel can never drift from what was stored.
   */
  const saver = useFormSave({ boardId, form, setForm });

  /*
   * WHICH CHANGES WAIT, AND WHICH DO NOT.
   *
   * The brief asks for a debounce on typing and none on a discrete action, and
   * those are not the same request against this editor. Every existing call
   * site is ALREADY a discrete commit — `DraftInput` holds a local draft and
   * writes on blur or Enter, switches fire once — so a blanket 800ms delay
   * would make toggling Required feel broken while buying nothing.
   *
   * These four are the sections that can arrive in a burst: the title and
   * description as somebody edits and re-edits them, and `appearance` /
   * `accessibility` because a colour input and a size slider emit while they
   * are being dragged. Coalescing those is the difference between one save and
   * forty, against a pooler that is already the bottleneck. Everything else —
   * add, remove, reorder, every toggle — is one decision and goes at once,
   * because a decision sitting in a timer is a decision that can be lost.
   */
  /* What the panels have always meant by `busy`: a write is in the air, so an
     input should say so. Derived rather than tracked twice. */
  const busy = saver.state === "saving";

  const patch = useCallback(
    (body: Record<string, unknown>) => {
      const keys = Object.keys(body);
      const bursty = keys.length > 0 && keys.every((key) => DEBOUNCED_SECTIONS.has(key));
      saver.save(body, { immediate: !bursty });
    },
    [saver],
  );

  /**
   * Give this register a form of its own — W2 requirement B.
   *
   * A plain POST to the same endpoint. Everything about the new form comes from
   * the server: its questions are derived from THIS board's columns, its share
   * token is minted fresh, and its settings are its own. Nothing here names a
   * board other than the one the tab is open on.
   */
  const createForm = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(`/api/board/form?board=${encodeURIComponent(boardId)}`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const payload = (await response.json()) as {
        form?: BuilderForm;
        groups?: Array<{ id: string; name: string }>;
        error?: string;
      };
      if (!response.ok || !payload.form) {
        throw new Error(payload.error || "The form could not be created.");
      }
      setForm(payload.form);
      setGroups(payload.groups ?? []);
      setCreatable(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The form could not be created.");
    } finally {
      setCreating(false);
    }
  }, [boardId]);

  async function copyLink() {
    if (!form) return;
    try {
      await navigator.clipboard.writeText(form.presentedUrl);
      setCopied(true);
    } catch {
      setSharing(true);
    }
  }

  /**
   * The phone's Share link: the native sheet where there is one, the clipboard
   * where there is not.
   *
   * `navigator.share` is preferred because it is the only path that reaches
   * WhatsApp, Messages and Mail — which is what "share this form with the
   * contractor" means on site — and because it is the affordance the reader
   * already knows. It is feature-detected rather than assumed: it is absent on
   * every desktop Firefox, on Chrome for Linux, and on any page that is not a
   * secure context.
   */
  async function shareLink() {
    if (!form) return;
    const url = form.presentedUrl;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: form.title, url });
        return;
      } catch (caught) {
        /*
         * Dismissing the sheet rejects with AbortError, and that is a decision,
         * not a failure — copying a link somebody just declined to send would
         * be the wrong thing to do quietly. Anything else (an Android WebView
         * that advertises share() and then refuses) falls through to the
         * clipboard rather than leaving the tap with no result at all.
         */
        if (caught instanceof Error && caught.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      /*
       * The clipboard is refused without a gesture chain and over plain HTTP.
       * The URL is on screen beside the button for exactly this case, so
       * selecting it is a fallback that always works — the same one the
       * desktop Share dialog uses.
       */
      const field = document.getElementById(
        "form-mobile-share-url",
      ) as HTMLInputElement | null;
      field?.select();
    }
  }

  /*
   * WHOSE FORM IS IN STATE.
   *
   * `boardId` can change without this component unmounting, and until the
   * fetch for the new register answers, what is held is the PREVIOUS one's
   * form — its questions, its response count and, worst, its Share link, drawn
   * under the new register's name. Clearing the state at the top of the effect
   * is the obvious fix and is exactly what `react-hooks/set-state-in-effect`
   * refuses, because it is a cascading render. Asking the form which board it
   * belongs to costs nothing and cannot get out of step with the prop.
   */
  const pending = Boolean(form && form.boardKey && form.boardKey !== boardId);

  /*
   * NO FORM ON THIS BOARD.
   *
   * `FormView` is deliberately NOT the fallback any more. It fetches
   * `/api/context` and posts to `/api/maintenance`, neither of which takes a
   * board, so on anything but the job board it rendered another register's
   * questions over another register's estate with a working Submit. A register
   * without a form is offered one; a load that merely failed says so.
   */
  if (!form || pending) {
    const offer = creatable && !pending;
    return (
      <div className="form-builder">
        <p className="form-builder__banner">
          <Icon name="document" size={15} />
          {pending
            ? "Loading this register’s form…"
            : offer
              ? "This register does not have a form yet. Creating one gives it its own questions, taken from this board’s own columns, and its own shareable link."
              : "This register’s form could not be loaded."}
        </p>
        {error && !pending && (
          <p className="form-builder__banner form-builder__banner--error" role="alert">
            <Icon name="alert" size={15} />
            {error}
          </p>
        )}
        {offer && (
          <div className="form-builder__stage">
            <button
              type="button"
              className="form-builder__sharebtn"
              onClick={createForm}
              disabled={creating}
            >
              <Icon name="document" size={15} />
              {creating ? "Creating the form…" : "Create a form for this register"}
            </button>
          </div>
        )}
      </div>
    );
  }

  const editing = EDITING_MODES.some(([value]) => value === mode);

  return (
    <div className="form-builder">
      <div className="form-builder__bar">
        {editing || mode === "preview" ? (
          <button type="button" className="form-builder__back" onClick={() => setMode("view")}>
            <Icon name="arrow" size={15} />
            Back to view
          </button>
        ) : (
          <span className="form-builder__title">
            <Icon name="document" size={15} />
            {form.title}
          </span>
        )}

        <button
          type="button"
          className={`form-builder__preview${mode === "preview" ? " is-active" : ""}`}
          onClick={() => setMode(mode === "preview" ? "view" : "preview")}
        >
          <Icon name="upload" size={15} />
          Preview
        </button>

        <div className="form-builder__modes" role="group" aria-label="Form builder">
          {EDITING_MODES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "is-active" : undefined}
              aria-pressed={mode === value}
              onClick={() => setMode(mode === value ? "view" : value)}
            >
              {label}
            </button>
          ))}
        </div>

        {/*
          THE SAVE STATE, VISIBLE AT ALL TIMES.

          The editor has always autosaved and never had a Save button, which is
          right. What it had no way of saying was whether a save had happened:
          `busy` reached an `aria-busy` and a disabled switch, and nothing else.
          On a write path whose measured failure mode is the connection pooler
          refusing outright, an editor that cannot say "not saved" is an editor
          that loses work silently.

          `role="status"` rather than `aria-live="assertive"`: this is an
          ambient fact, and interrupting a screen reader mid-sentence on every
          keystroke's save would be worse than not announcing it.
        */}
        <p
          className="form-builder__savestate"
          data-state={saver.state}
          role="status"
          aria-live="polite"
        >
          <Icon
            name={
              saver.state === "saved"
                ? "check"
                : saver.state === "saving"
                  ? "upload"
                  : "alert"
            }
            size={14}
          />
          {formSaveLabel(saver.state)}
          {/*
            Undo sits with the state it undoes. Offered only once there is a
            saved definition to go back to — a button that would restore
            nothing is worse than no button. `canUndo` is false both when the
            stack is empty and when everything on it belongs to the register
            somebody has just navigated away from, because restoring one
            board's definition onto another is not an undo, it is a leak.

            The keyboard shortcut is NAMED on the control rather than left to
            be discovered. It is registered on `window` by `useFormSave`, so
            this button is the only place in the product a reader could learn
            that it exists; `aria-keyshortcuts` carries the same fact to a
            screen reader, which cannot read a tooltip.
          */}
          {saver.canUndo && saver.state !== "saving" && (
            <button
              type="button"
              className="form-builder__undo"
              onClick={saver.undo}
              title="Undo the last saved change (Ctrl+Z)"
              aria-keyshortcuts="Control+Z Meta+Z"
            >
              Undo
            </button>
          )}
        </p>

        <div className="form-builder__share">
          <button
            type="button"
            className="form-builder__sharebtn"
            onClick={() => setSharing(true)}
          >
            <Icon name="share" size={15} />
            Share form
          </button>
          <button
            type="button"
            className="form-builder__copy"
            onClick={copyLink}
            aria-label="Copy form link"
            title={copied ? "Copied" : "Copy form link"}
          >
            <Icon name={copied ? "check" : "link"} size={15} />
          </button>
        </div>
      </div>

      {/*
        PHONE ONLY, by stylesheet — `.form-builder__mshare` is `display: none`
        until 767px, the same boundary that hides the toolbar above. Rendered
        unconditionally so the server and the first client render agree.

        The link is shown as well as shared. It is what the button will hand
        over, it is selectable when the clipboard refuses, and a reader who is
        about to send a stranger a URL is entitled to see which one.
      */}
      <div className="form-builder__mshare">
        <input
          id="form-mobile-share-url"
          className="form-builder__mshare-url"
          readOnly
          value={form.presentedUrl}
          spellCheck={false}
          aria-label="Public form link"
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="form-builder__mshare-btn"
          onClick={shareLink}
        >
          <Icon name={copied ? "check" : "share"} size={15} />
          {copied ? "Link copied" : "Share link"}
        </button>
      </div>

      {!form.active && (
        <p className="form-builder__banner">
          <Icon name="alert" size={15} />
          This form is deactivated — the shared link will not open until it is activated
          again.
        </p>
      )}
      {/*
        A FAILED SAVE, NAMED, WITH THE CHANGE STILL IN HAND.

        Its own banner rather than the load/create one, because the two need
        different things from the reader. This one is persistent — no timeout —
        keeps the edit in `pending` so Retry re-sends exactly what failed, and
        arms the browser's unsaved-changes warning until it is resolved. The
        reason comes from the server, so "You do not have permission to edit
        this form" and "the workspace database is out of connections right now"
        arrive as the different problems they are, and only the second offers a
        button, because only the second can work.
      */}
      {saver.failure && (
        <p className="form-builder__banner form-builder__banner--error" role="alert">
          <Icon name="alert" size={15} />
          {saver.failure.message}
          {saver.failure.retryable && (
            <button type="button" onClick={saver.retry}>
              Retry
            </button>
          )}
          <button type="button" onClick={saver.dismiss} aria-label="Dismiss">
            ×
          </button>
        </p>
      )}
      {error && (
        <p className="form-builder__banner form-builder__banner--error" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}

      <div className="form-builder__stage" data-mode={mode}>
        {mode === "edit" && (
          <FormEditPanel form={form} patch={patch} busy={busy} columns={columns} />
        )}
        {mode === "design" && <FormDesignPanel form={form} patch={patch} busy={busy} />}
        {mode === "settings" && (
          <FormSettingsPanel form={form} patch={patch} busy={busy} groups={groups} />
        )}
        {mode === "activity" && <FormActivity log={saver.log} canUndo={saver.canUndo} />}
        {/*
          THE LIVE FILLABLE FORM, ONLY WHERE IT WOULD FILE HERE.

          `FormView` posts to `/api/maintenance`, which takes no board and files
          onto the default one. On any other register that is a form that
          submits somewhere else — the same class of leak as the builder asking
          `/api/board/form` with no board. The server answers the question
          (`filesIntoThisBoard`), because it is the side that knows which board
          is the default one; elsewhere this register's own form is rendered
          through the shared public renderer instead, which is exactly what the
          link serves.
        */}
        {mode === "view" &&
          (form.filesIntoThisBoard === false ? (
            <FormPreview form={form} />
          ) : (
            <FormView onSubmitted={onSubmitted} />
          ))}
        {mode === "preview" && (
          /*
           * PREVIEW IS THE PUBLIC FORM'S OWN RENDERER, mounted here.
           *
           * Not `FormView` (a different component that drifted), and not an
           * iframe of the live route — `worker/index.ts` sends
           * `X-Frame-Options: DENY` on every response, deliberately, so a
           * frame is refused everywhere and weakening the header for a
           * preview would be the wrong trade. `FormPreview` renders the same
           * components over the same shared projection with the same option
           * substitution the public endpoint serves, so what the operator
           * sees is what the link shows — as one implementation, not a hope.
           */
          <FormPreview form={form} />
        )}
      </div>

      {sharing && (
        <FormShareDialog
          form={form}
          busy={busy}
          onClose={() => setSharing(false)}
          onPatch={patch}
        />
      )}
    </div>
  );
}
