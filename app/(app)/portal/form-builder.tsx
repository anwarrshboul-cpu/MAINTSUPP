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
 */
export default function FormBuilder({ onSubmitted }: { onSubmitted?: () => void }) {
  const [form, setForm] = useState<BuilderForm | null>(null);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [mode, setMode] = useState<BuilderMode>("view");
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/board/form", { headers: { Accept: "application/json" } })
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
      const response = await fetch("/api/board/form", {
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
