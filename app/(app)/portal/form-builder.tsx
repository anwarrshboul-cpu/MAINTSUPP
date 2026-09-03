"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components";
import { FormDesignPanel, FormEditPanel, FormSettingsPanel } from "./form-builder-panels";
import FormPreview from "./form-preview";
import FormShareDialog from "./form-share-dialog";
import type { BuilderForm, BuilderMode } from "./form-builder-model";
import { FormView } from "./views/board-views";
import "./form-builder.css";

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
 * DESKTOP ONLY, AND ENFORCED IN CSS RATHER THAN IN JAVASCRIPT
 *
 * The brief is that editing and sharing are desktop-only while the public link
 * works everywhere. That is done with a single `display: none` below 768px on
 * `.form-builder__bar`, NOT with a `matchMedia` check, for two reasons:
 *
 *  1. This is a server-rendered app. A width-dependent render is a hydration
 *     mismatch — the server has no viewport — and React would either warn or,
 *     worse, flash the toolbar in before removing it.
 *  2. `display: none` removes an element from the accessibility tree as well as
 *     from the page, so a phone screen reader does not announce controls that
 *     are not there. A JS check that merely skipped the render would be no
 *     better and a CSS `visibility: hidden` would be worse.
 *
 * The mode is reset to `view` at the same breakpoint by the effect below, so a
 * narrow window cannot strand somebody inside a panel with no way back.
 *
 * SHARING IS THE ONE THING A PHONE GETS BACK, and it is the SAME link
 *
 * "Editing and sharing are desktop-only" was one sentence covering two very
 * different acts. Editing a form on a 360px screen is a bad idea; handing
 * somebody the link is the thing a person on site actually wants to do, and
 * they are the ones holding the phone. So a single Share link control is drawn
 * below the (hidden) toolbar on phones only.
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
  const [mode, setMode] = useState<BuilderMode>("view");
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
        };
        if (!response.ok || !payload.form) throw new Error(payload.error || "Unavailable");
        if (active) {
          setForm(payload.form);
          setGroups(payload.groups ?? []);
        }
      })
      .catch(() => {
        /*
         * A builder that cannot load is not an error the reader needs to see —
         * the form itself still works. The toolbar simply does not appear.
         */
        if (active) setForm(null);
      });
    return () => {
      active = false;
    };
  }, []);

  /*
   * Leaving a builder panel open and then narrowing the window would hide the
   * toolbar — the only way out — while the panel stayed on screen. Watching the
   * same 768px boundary the stylesheet uses keeps the two in step.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(max-width: 767px)");
    function sync(narrow: boolean) {
      if (narrow) setMode((current) => (current === "view" ? current : "view"));
    }
    sync(query.matches);
    const onChange = (event: MediaQueryListEvent) => sync(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

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
  const patch = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/board/form?board=${encodeURIComponent(boardId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { form?: BuilderForm; error?: string };
      if (!response.ok) throw new Error(payload.error || "That change could not be saved.");
      if (payload.form) setForm(payload.form);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That change could not be saved.");
    } finally {
      setBusy(false);
    }
  }, []);

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

  /* No form configured for this board: the live form, exactly as before. */
  if (!form) return <FormView onSubmitted={onSubmitted} />;

  const editing = mode === "edit" || mode === "design" || mode === "settings";

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
          {(["edit", "design", "settings"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "is-active" : undefined}
              aria-pressed={mode === value}
              onClick={() => setMode(mode === value ? "view" : value)}
            >
              {value === "edit" ? "Edit" : value === "design" ? "Design" : "Settings"}
            </button>
          ))}
        </div>

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
      {error && (
        <p className="form-builder__banner form-builder__banner--error" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}

      <div className="form-builder__stage" data-mode={mode}>
        {mode === "edit" && <FormEditPanel form={form} patch={patch} busy={busy} />}
        {mode === "design" && <FormDesignPanel form={form} patch={patch} busy={busy} />}
        {mode === "settings" && (
          <FormSettingsPanel form={form} patch={patch} busy={busy} groups={groups} />
        )}
        {mode === "view" && <FormView onSubmitted={onSubmitted} />}
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
