"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components";
import type { BuilderForm } from "./form-builder-model";

/**
 * The Share form dialog — monday's, reproduced.
 *
 * Four switches and a link. The link is the interesting part: it is the only
 * thing in the builder that leaves the product, so everything here is arranged
 * around not handing somebody a URL that does not do what they think it does.
 *
 *  · The URL shown is the one the Copy button copies. Showing the long link and
 *    copying the short one (or the reverse) is the classic bug in this dialog.
 *  · "Deactivate form" is destructive to anybody holding the link, so it reads
 *    as a red action rather than a switch, exactly as monday draws it.
 *  · Turning a switch produces an immediate PATCH. There is no Save button in
 *    monday's dialog and adding one here would invent a state where the screen
 *    and the live form disagree.
 */
export default function FormShareDialog({
  form,
  onClose,
  onPatch,
  busy,
}: {
  form: BuilderForm;
  onClose: () => void;
  onPatch: (patch: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  /*
   * Escape closes, and focus starts on the close button rather than on the URL
   * field — a dialog that opens with a text input focused reads to a screen
   * reader as "edit text" before it has said what the dialog is.
   */
  useEffect(() => {
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* The "Copied" confirmation is transient and must not outlive the dialog. */
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(form.presentedUrl);
      setCopied(true);
    } catch {
      /*
       * Clipboard access is refused in some browsers without a user gesture
       * chain, and over plain HTTP. Selecting the text is the fallback that
       * always works, and is better than a silent no-op.
       */
      const field = document.getElementById("form-share-url") as HTMLInputElement | null;
      field?.select();
    }
  }

  const shortened = form.config.features.shortenedLink.enabled;

  return (
    <div className="form-share__backdrop" role="presentation" onClick={onClose}>
      <div
        className="form-share"
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-share-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="form-share__close"
          onClick={onClose}
          ref={closeRef}
          aria-label="Close"
        >
          <Icon name="close" size={18} />
        </button>

        <h2 id="form-share-title">Share form</h2>
        <p className="form-share__lede">
          <Icon name="shield" size={15} />
          <span>
            {form.active
              ? "This form is public and available to anyone with the link"
              : "This form is deactivated. The link will not open until you activate it."}
          </span>
        </p>

        <div className="form-share__link">
          <input id="form-share-url" readOnly value={form.presentedUrl} spellCheck={false} />
          <button type="button" className="form-share__copy" onClick={copy}>
            <Icon name={copied ? "check" : "link"} size={16} />
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>

        <section className="form-share__settings">
          <h3>
            <Icon name="share" size={15} /> Sharing settings
          </h3>

          <Row
            label="Shorten URL"
            hint="Shorten your URL to make sharing easier"
            checked={shortened}
            busy={busy}
            onChange={(next) =>
              onPatch({ features: { shortenedLink: { ...form.config.features.shortenedLink, enabled: next } } })
            }
          />

          <div className="form-share__row form-share__row--stack">
            <Row
              label="Password protection"
              hint="Keep your forms safe with a custom password"
              checked={form.hasPassword || passwordOpen}
              busy={busy}
              onChange={(next) => {
                if (next) {
                  setPasswordOpen(true);
                } else {
                  setPasswordOpen(false);
                  setPassword("");
                  onPatch({ password: null });
                }
              }}
            />
            {(passwordOpen || form.hasPassword) && (
              <form
                className="form-share__password"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!password) return;
                  onPatch({ password });
                  setPassword("");
                  setPasswordOpen(false);
                }}
              >
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={form.hasPassword ? "Change the password" : "Set a password"}
                  autoComplete="new-password"
                  minLength={12}
                />
                <button type="submit" disabled={!password || busy}>
                  {form.hasPassword ? "Change" : "Set"}
                </button>
              </form>
            )}
          </div>

          <Row
            label="Require sign-in"
            hint="Only people signed in to this workspace will be able to submit"
            checked={form.requireLogin}
            busy={busy}
            onChange={(next) => onPatch({ requireLogin: next })}
          />

          <div className="form-share__row form-share__row--access">
            <div>
              <strong>Form access</strong>
              <span>
                {form.active
                  ? "Form is active. Deactivate to block access to this form"
                  : "Form is deactivated. Activate to let people submit again"}
              </span>
            </div>
            <button
              type="button"
              className={form.active ? "form-share__danger" : "form-share__revive"}
              onClick={() => onPatch({ active: !form.active })}
              disabled={busy}
            >
              <Icon name={form.active ? "close" : "check"} size={15} />
              {form.active ? "Deactivate form" : "Activate form"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** One labelled switch. Kept local — nothing outside this dialog draws one. */
function Row({
  label,
  hint,
  checked,
  onChange,
  busy,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  busy: boolean;
}) {
  return (
    <label className="form-share__row">
      <div>
        <strong>{label}</strong>
        <span>{hint}</span>
      </div>
      {/*
        A real checkbox under the switch, not a div with a click handler: it
        gets keyboard focus, space to toggle and a correct role for free, and
        the visual switch is drawn from its :checked state in CSS.
      */}
      <input
        type="checkbox"
        className="form-switch"
        checked={checked}
        disabled={busy}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
