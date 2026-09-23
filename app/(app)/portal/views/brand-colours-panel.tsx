"use client";

/**
 * Settings → Brand colours — the workspace's palette, not the viewer's.
 *
 * WHY THIS IS NOT PART OF `appearance-panel.tsx`
 *
 * They look like the same screen and they are opposite things. Appearance is a
 * PER-PERSON, per-device choice between dark and light; it applies on click,
 * saves to `users.theme_preference`, and nobody else ever sees the result. This
 * is a PER-WORKSPACE decision that repaints the product for every colleague and
 * every client in it, needs `settings.edit`, and is written to the audit log.
 * Folding them together would put an "applies to you" control and an "applies to
 * everyone" control in one card with one Save button, which is exactly the
 * confusion worth spending a second card to avoid.
 *
 * WHY THE SWATCHES ARE `<input type="color">`
 *
 * Ten other places in this product already use it for data colours — option
 * values, status maps, site groups, calendar events — so it is the control
 * people here already know. It also constrains the value to a hex by
 * construction, which means the common path never reaches the server's refusal.
 * The server validates anyway and does not trust this at all; see
 * `validateThemeToken`.
 *
 * WHAT "DEFAULT" MEANS ON THIS SCREEN, AND WHY RESET IS A DELETE
 *
 * A token with no stored row is painted from the shipped palette. So "Reset"
 * deletes the row rather than writing the MAINTSUPP teal into it. The difference
 * matters the day the shipped palette changes: a workspace that reset stays with
 * the product, and one that had the old value written in would be silently
 * frozen on a colour nobody chose.
 */

import { useCallback, useEffect, useState } from "react";

import { Icon } from "../../../components";
import "./brand-colours-panel.css";
import { VersionHistory } from "./version-history";
import { useUnsavedChanges } from "../../../lib/use-unsaved-changes";

type ThemeToken = {
  key: string;
  label: string;
  group: string;
  description: string;
  /*
   * Colour, typeface or bounded choice, decided by the SERVER. Read rather than
   * inferred from the key, so a token added later cannot be mis-rendered by this
   * file guessing from its name.
   */
  kind: "colour" | "font" | "choice";
  value: string;
  isDefault: boolean;
  seedInput: string;
  /*
   * What a non-colour token may be set to: the typefaces for a font token, the
   * corner or depth options for a choice token. The server owns the
   * list because it is the same list `validateThemeToken` refuses anything outside
   * — a copy here would be a second source of truth for what is really a safety
   * boundary, and the first divergence would be a select offering something the API
   * rejects. `note` is the server's own sentence about an option, for the same
   * reason: one vocabulary, in one place.
   */
  choices: Array<{ key: string; label: string; note?: string }> | null;
};

type ContrastWarning = {
  mode: "light" | "dark";
  property: string;
  ratio: number;
  required: number;
  message: string;
};

type ThemeResponse = {
  canEdit: boolean;
  tokens: ThemeToken[];
  warnings: ContrastWarning[];
  error?: string;
};

export function BrandColoursPanel() {
  const [state, setState] = useState<ThemeResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/theme", { cache: "no-store" });
      const body = (await response.json()) as ThemeResponse;
      if (!response.ok) {
        setFailure(body.error ?? "Could not load the brand colours.");
        return;
      }
      setState(body);
      setDraft({});
      setFailure(null);
    } catch {
      setFailure("Could not load the brand colours.");
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- `load` awaits the fetch
     before it touches state, so nothing here sets state synchronously in the
     effect body; the rule cannot see through the promise. The same disable, for
     the same reason, sits over the identical pattern in `views/audit-log.tsx`.
     Reading the workspace's stored palette on mount is exactly the
     external-system synchronisation an effect is for. */
  useEffect(() => {
    void load();
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* §69 — leaving with colours or fonts chosen but not saved asks first. Worked
     out here, before the early returns, so the hook runs on every render. */
  useUnsavedChanges(
    Object.entries(draft).some(([key, value]) => state?.tokens.find((token) => token.key === key)?.value !== value),
  );

  if (failure && !state) {
    return (
      <section className="panel settings-card">
        <div className="settings-card__heading">
          <span>
            <Icon name="image" size={19} />
          </span>
          <div>
            <h2>Brand colours, typeface and surface style</h2>
            <p>{failure}</p>
          </div>
        </div>
      </section>
    );
  }

  if (!state) return null;

  const { canEdit, tokens, warnings } = state;
  /* Only what actually changed is sent, so pressing Save without touching
     anything is a no-op rather than a write of every token. */
  const pending = Object.entries(draft).filter(
    ([key, value]) => tokens.find((token) => token.key === key)?.value !== value,
  );

  const save = async (payload: Record<string, string | null>) => {
    setBusy(true);
    setStatus(null);
    setFailure(null);
    try {
      const response = await fetch("/api/theme", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokens: payload }),
      });
      const body = (await response.json()) as ThemeResponse;
      if (!response.ok) {
        setFailure(body.error ?? "Could not save the brand colours.");
        return;
      }
      setState(body);
      setDraft({});
      /*
       * The stamped `<style>` element is server-rendered by
       * `app/(app)/layout.tsx`, so the page in front of the person is still
       * painted with the previous palette until the document is fetched again.
       * Saying so, and reloading, is the honest option — the alternative is a
       * saved setting that appears to have done nothing.
       */
      setStatus("Saved. Reloading so the new colours take effect…");
      setTimeout(() => window.location.reload(), 600);
    } catch {
      setFailure("Could not save the brand colours.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel settings-card">
      <div className="settings-card__heading">
        <span>
          <Icon name="image" size={19} />
        </span>
        <div>
          <h2>Brand colours, typeface and surface style</h2>
          <p>
            {canEdit
              ? "Applies to everyone in this workspace, on both the dark and light themes."
              : "Applies to everyone in this workspace. You do not have permission to change these."}
          </p>
          {/*
           * THIS SENTENCE USED TO SAY THE OPPOSITE, and the change is the whole of
           * the chart-token phase.
           *
           * It read: "Charts and meters keep the MAINTSUPP palette for now — they
           * are drawn from their own colour set, which is not yet configurable
           * here." That was true and it was also the "configuration that does not
           * affect components" this product is not allowed to ship — somebody
           * changed their brand and the donut stayed teal.
           *
           * The dashboards now read `--chart-*`, which every brand and status token
           * derives alongside its own family, so the series follow. What still does
           * not follow is named below rather than left for somebody to discover: the
           * greys that mean "not recorded", and the two ordinal ramps, which need a
           * derivation this product does not have yet. Naming them is the honest
           * half of the claim.
           */}
          <p className="brand-colours__scope">
            The dashboard charts follow these colours too. Two things deliberately
            do not: the greys that mean “not recorded”, so an absence can never be
            mistaken for a category, and the graded teal scales on the spend
            matrix.
          </p>
          {/*
            * THE TYPEFACE'S OWN BOUNDARY, said here rather than discovered.
            *
            * Every face offered resolves on the reader's own machine, so choosing
            * one costs no download and shifts no layout. What is NOT offered is a
            * text size: the product sets over two thousand sizes individually, so a
            * size control would move a handful of them and leave the rest — and the
            * form fields are deliberately pinned at 16px because a smaller one makes
            * iPhones zoom in and never zoom back out.
            */}
          <p className="brand-colours__scope">
            The typeface applies across the portal. Text <em>sizes</em> are not
            configurable — they are set per surface so the board and the dashboards
            stay legible at their own densities. Code and monospaced figures keep
            their own face, and the pages handed to contractors and to people
            accepting an invitation keep the MAINTSUPP face.
          </p>
          {/*
            * THE SURFACE GROUP'S OWN BOUNDARY, on the same principle as the two
            * paragraphs above: what a control reaches is a promise, so what it does
            * NOT reach is said here rather than left for somebody to hunt for.
            *
            * Corners reach the 249 border-radius rules that read the product's
            * radius scale (measured 2026-09-23), the Overview's cards among them.
            * Corners written as their own measurement elsewhere, and everything
            * deliberately circular — avatars, pills — keep their own shape: a pill
            * that squared off with the panels would read as a bug, not a style.
            *
            * Spacing and row height are not offered, for the reasons
            * `theme-tokens.ts` measures: the product sets padding per surface in
            * 1,833 places and twelve of them read a variable, and the job board's
            * row heights are literals a variable could not reach.
            */}
          <p className="brand-colours__scope">
            Corner style and panel depth apply to the panels, cards, buttons,
            inputs and dialogs that share the product’s own scales; anything drawn
            deliberately round — avatars, status pills — stays round. Neither
            changes the size of anything you tap or type into. General spacing is
            not configurable.
          </p>
        </div>
      </div>

      <div className="brand-colours">
        {tokens.map((token) => {
          const value = draft[token.key] ?? token.value;
          return (
            <div className="brand-colour" key={token.key}>
              {/*
                 * RE-POINTED, not widened by accident: this used to read
                 * `token.kind === "font"`. A `choice` token — corners, depth — is
                 * chosen from a list for exactly the same
                 * safety reason a face is, so the two share one control and the test
                 * that pinned the font branch now pins this one. A COLOUR is still
                 * the only kind that gets a swatch.
                 */}
              {token.kind !== "colour" ? (
                /*
                 * A SELECT, not a text field, and that is the safety boundary made
                 * visible. `validateThemeToken` accepts only a key from
                 * `FONT_STACKS` and stores the KEY — the stack is looked up on the
                 * server at render, so no part of what is typed here could ever
                 * reach the `<style>` element. A free-text font field would be a
                 * much harder string to make safe than a hex.
                 *
                 * Native `<select>` rather than a custom listbox: it is one control
                 * with keyboard, screen-reader and mobile behaviour already correct,
                 * and this panel has six of them at most.
                 */
                <div className="brand-colour__face">
                  {/*
                    * `aria-label` rather than a visually-hidden `<span>`: the row
                    * already shows `token.label` in its body, so a second copy would
                    * be read twice by a screen reader — and the only
                    * visually-hidden utility in this product lives in
                    * `section-manager.css`, which this panel does not import, so the
                    * span would simply have rendered as visible text.
                    */}
                  <select
                    aria-label={token.label}
                    id={`tt-${token.key}`}
                    value={value}
                    disabled={!canEdit || busy}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [token.key]: event.target.value,
                      }))
                    }
                  >
                    {(token.choices ?? []).map((choice) => (
                      <option key={choice.key} value={choice.key}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <label className="brand-colour__swatch" htmlFor={`tt-${token.key}`}>
                  {/* The swatch label wraps nothing but the picker, so it names
                      nothing: the name comes from the token, as the font select's does. */}
                  <input
                    aria-label={token.label}
                    id={`tt-${token.key}`}
                    type="color"
                    value={value}
                    disabled={!canEdit || busy}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [token.key]: event.target.value,
                      }))
                    }
                  />
                </label>
              )}
              <div className="brand-colour__body">
                <strong>{token.label}</strong>
                <small>{token.description}</small>
                {/* What the CHOSEN option does, in the server's own words. A face
                    has no note; corners and depth do, and reading it
                    under the control is how somebody knows what they picked
                    without saving to find out. */}
                {token.kind === "choice"
                  ? (() => {
                      const note = token.choices?.find((choice) => choice.key === value)?.note;
                      return note ? <small className="brand-colour__note">{note}</small> : null;
                    })()
                  : null}
                {/* A hex is worth showing literally; a font KEY is not — the
                    select already shows the label, and "inter" underneath it would
                    be noise. */}
                {token.kind === "colour" ? <code>{value}</code> : null}
              </div>
              {canEdit && !token.isDefault ? (
                <button
                  type="button"
                  className="brand-colour__reset"
                  disabled={busy}
                  onClick={() => void save({ [token.key]: null })}
                >
                  Reset
                </button>
              ) : (
                /* Said plainly rather than left blank, so "we have not chosen
                   one" is distinguishable from "we chose this and it happens to
                   match". */
                <span className="brand-colour__default">MAINTSUPP default</span>
              )}
            </div>
          );
        })}
      </div>

      {warnings.length > 0 ? (
        <ul className="brand-colours__warnings">
          {warnings.map((warning) => (
            <li key={`${warning.mode}-${warning.property}`}>
              <Icon name="alert" size={15} />
              <span>{warning.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {canEdit ? (
        <div className="brand-colours__actions">
          <button
            type="button"
            /* The same class the Settings screen's own Save uses, so the two
               buttons on one page are one control rather than two designs. */
            className="primary-button"
            disabled={busy || pending.length === 0}
            onClick={() => void save(Object.fromEntries(pending))}
          >
            <Icon name="check" size={17} />
            {busy ? "Saving…" : "Save brand colours"}
          </button>
          {status ? <span className="brand-colours__status">{status}</span> : null}
          {failure ? (
            <span className="brand-colours__failure" role="alert">
              {failure}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* §38 — every saved palette, and a way back to any of them. The page
          reloads after a restore for the reason `save` gives above. */}
      {canEdit ? (
        <VersionHistory
          subject="theme"
          subjectKey="tokens"
          title="Colour and typeface history"
          onRestored={() => window.location.reload()}
        />
      ) : null}
    </section>
  );
}

export default BrandColoursPanel;
