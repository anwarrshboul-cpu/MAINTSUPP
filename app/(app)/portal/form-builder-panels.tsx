"use client";

import * as React from "react";
import { DraftArea, DraftInput, Section, Switch } from "./form-builder-controls";
import type { BuilderForm } from "./form-builder-model";

/**
 * The Design and Settings panels.
 *
 * Both take the same three props — the form, a patch function and `busy` — and
 * neither holds state of its own. Every control writes straight through to
 * `/api/board/form`, because monday's builder has no Save button and inventing
 * one would create a window where the panel and the live form disagree about
 * what the form is.
 *
 * ── WHAT MOVED OUT OF THIS FILE, AND WHY ──────────────────────────────────
 *
 * The Edit panel used to be here too, and the header said the three belonged
 * together because they were one screen sharing one visual language of rows,
 * switches and section cards. That was true of three lists of switches. Edit is
 * no longer a list: it has a page model, three reordering gestures, an
 * insertion control, a shared field picker and an intake report, and it is made
 * of two components of its own. It lives in `form-edit-panel.tsx` with them.
 *
 * The three shared controls went to `form-builder-controls.tsx` in the same
 * move, so the Edit surface can use `DraftInput` without importing a module
 * that also draws two unrelated panels. Copying it was the alternative and the
 * wrong one: the focus fix inside it is subtle, was found in a browser rather
 * than in review, and a second copy would drift out of it silently.
 */

type PanelProps = {
  form: BuilderForm;
  patch: (patch: Record<string, unknown>) => void;
  busy: boolean;
  /** The board's real groups, for "Group for answers". */
  groups?: Array<{ id: string; name: string }>;
};

/* ── Design ──────────────────────────────────────────────────────────────── */

const FONTS = ["Poppins", "Figtree", "Inter", "Manrope", "Rubik", "Roboto"];

export function FormDesignPanel({ form, patch, busy }: PanelProps) {
  const { appearance } = form.config;

  function setAppearance(changes: Record<string, unknown>) {
    patch({ appearance: { ...appearance, ...changes } });
  }

  return (
    <div className="form-panel form-panel--design">
      <Section icon="grid" title="Format">
        <div className="form-panel__choices" role="group" aria-label="Layout">
          {(["CARD", "CLASSIC"] as const).map((type) => (
            <button
              key={type}
              type="button"
              className={appearance.layout.type === type ? "is-active" : undefined}
              disabled={busy}
              onClick={() => setAppearance({ layout: { ...appearance.layout, type } })}
            >
              {type === "CARD" ? "Card" : "Classic"}
            </button>
          ))}
        </div>

        <div className="form-panel__choices" role="group" aria-label="Alignment">
          {(["Left", "Center", "Right"] as const).map((alignment) => (
            <button
              key={alignment}
              type="button"
              className={appearance.layout.alignment === alignment ? "is-active" : undefined}
              disabled={busy}
              onClick={() => setAppearance({ layout: { ...appearance.layout, alignment } })}
            >
              {alignment}
            </button>
          ))}
        </div>
      </Section>

      <Section icon="spark" title="Customize">
        <label className="form-panel__field">
          <span>Accent colour</span>
          <input
            type="color"
            /*
             * `defaultValue`, NOT `value`. The intent below is right and
             * unchanged — commit on blur, because a colour picker fires per
             * drag tick and `onChange` here was one PATCH per pixel of mouse
             * travel. But `value` with no `onChange` is a CONTROLLED input
             * React cannot update: it warns "you provided a `value` prop to a
             * form field without an `onChange` handler … this will render a
             * read-only field", and holds the DOM value back to the prop on
             * every render. The swatch only moved because nothing re-rendered
             * mid-drag, which is luck, not design.
             *
             * Uncontrolled is what "the native picker owns the live value and
             * we take it once at the end" actually means. The `key` re-seeds it
             * when the stored colour changes from somewhere else — Reset to the
             * workspace accent, just below — since a `defaultValue` alone is
             * only read at mount.
             */
            key={appearance.primaryColor ?? "accent-default"}
            defaultValue={appearance.primaryColor ?? "#0b7a72"}
            aria-busy={busy || undefined}
            onBlur={(event) => setAppearance({ primaryColor: event.target.value })}
          />
        </label>
        {appearance.primaryColor && (
          <button
            type="button"
            className="form-panel__link"
            disabled={busy}
            onClick={() => setAppearance({ primaryColor: null })}
          >
            Reset to the workspace accent
          </button>
        )}

        {/*
          TEXT COLOUR — the one appearance field the renderer already honours
          and the panel never offered.

          `Shell` in form-renderer.tsx assigns `appearance.text.color` to the
          `--pf-ink` custom property on the form's own element, so it has always
          worked; there was simply no way to set it. It matters most on a form
          whose Background has been set to a dark colour, where the default ink
          is unreadable and an operator's only recourse was to give up on the
          background.

          Uncontrolled and keyed for the same reason as the accent above: a
          colour picker fires on every drag tick, `value` without `onChange` is
          a React-controlled field with no way to update, and a `defaultValue`
          alone is read once at mount and would not re-seed when Reset clears it.
        */}
        <label className="form-panel__field">
          <span>Text colour</span>
          <input
            type="color"
            key={appearance.text.color ?? "ink-default"}
            defaultValue={appearance.text.color ?? "#132537"}
            aria-busy={busy || undefined}
            onBlur={(event) =>
              setAppearance({ text: { ...appearance.text, color: event.target.value } })
            }
          />
        </label>
        {appearance.text.color && (
          <button
            type="button"
            className="form-panel__link"
            disabled={busy}
            onClick={() => setAppearance({ text: { ...appearance.text, color: null } })}
          >
            Reset the text to the default ink
          </button>
        )}

        <label className="form-panel__field">
          <span>Background</span>
          <select
            value={appearance.background.type}
            disabled={busy}
            onChange={(event) =>
              setAppearance({
                background: {
                  type: event.target.value as "None" | "Color" | "Image",
                  value: event.target.value === "None" ? null : appearance.background.value,
                },
              })
            }
          >
            <option value="None">None</option>
            <option value="Color">Colour</option>
            <option value="Image">Image</option>
          </select>
        </label>
        {appearance.background.type === "Color" && (
          <label className="form-panel__field">
            <span>Background colour</span>
            <input
              type="color"
              /* Uncontrolled for the same reason as the accent above. */
              key={appearance.background.value ?? "background-default"}
              defaultValue={appearance.background.value ?? "#f4f7f8"}
              aria-busy={busy || undefined}
              onBlur={(event) =>
                setAppearance({ background: { type: "Color", value: event.target.value } })
              }
            />
          </label>
        )}
        {appearance.background.type === "Image" && (
          <label className="form-panel__field form-panel__field--stack">
            <span>Image URL</span>
            <DraftInput
              type="url"
              value={appearance.background.value ?? ""}
              placeholder="https://…"
              busy={busy}
              onCommit={(next) =>
                setAppearance({ background: { type: "Image", value: next || null } })
              }
            />
          </label>
        )}

        <label className="form-panel__field form-panel__field--stack">
          <span>Logo URL</span>
          <DraftInput
            type="url"
            value={appearance.logo.url ?? ""}
            placeholder="Leave empty for the MAINTSUPP mark"
            busy={busy}
            onCommit={(next) =>
              setAppearance({ logo: { ...appearance.logo, url: next || null } })
            }
          />
        </label>

        {/*
          WHAT THE LOGO SAYS, for somebody who cannot see it.

          `accessibility.logoAltText` has been in the stored configuration since
          the monday import with nothing writing it and nothing reading it. It
          is offered here because a logo is very often the only thing on a form
          that names the organisation, and "image" is what a screen reader says
          instead.

          This note used to say the value was recorded and not yet used, because
          the renderer drew the logo with `alt=""` and nothing read the setting.
          That is no longer true: `Shell` takes `logoAlt` and the public link and
          the Preview both announce it. The wording is corrected rather than
          deleted, because a control that once did nothing and now does is worth
          saying so — and because this panel still carries genuinely inert
          settings (Save as draft, reCAPTCHA, AI translation) whose notes must
          stay honest.
        */}
        <label className="form-panel__field form-panel__field--stack">
          <span>Logo description</span>
          <DraftInput
            type="text"
            value={form.config.accessibility.logoAltText ?? ""}
            placeholder="For example: Sunnamusk UK"
            maxLength={120}
            busy={busy}
            onCommit={(next) =>
              patch({
                accessibility: {
                  ...form.config.accessibility,
                  logoAltText: next.trim() || null,
                },
              })
            }
          />
        </label>
        <p className="form-panel__note">
          Read aloud in place of the image. Leave it empty and the logo is
          treated as decorative and skipped, which is the right answer when the
          form's title already names you.
        </p>

        <label className="form-panel__field">
          <span>Font</span>
          <select
            value={appearance.text.font}
            disabled={busy}
            onChange={(event) =>
              setAppearance({ text: { ...appearance.text, font: event.target.value } })
            }
          >
            {FONTS.map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
        </label>

        <label className="form-panel__field">
          <span>Text size</span>
          <select
            value={appearance.text.size}
            disabled={busy}
            onChange={(event) =>
              setAppearance({
                text: {
                  ...appearance.text,
                  size: event.target.value as "Small" | "Medium" | "Large",
                },
              })
            }
          >
            <option value="Small">Small</option>
            <option value="Medium">Medium</option>
            <option value="Large">Large</option>
          </select>
        </label>
      </Section>

      <Section icon="settings" title="Display">
        <Switch
          label="Progress bar"
          hint="Show the submitter's progress in the form"
          checked={appearance.showProgressBar}
          busy={busy}
          onChange={(next) => setAppearance({ showProgressBar: next })}
        />
        <Switch
          label="MAINTSUPP branding"
          hint="Show the MAINTSUPP mark at the foot of the form"
          checked={!appearance.hideBranding}
          busy={busy}
          onChange={(next) => setAppearance({ hideBranding: !next })}
        />
        <label className="form-panel__field form-panel__field--stack">
          <span>Submit button text</span>
          <DraftInput
            type="text"
            value={appearance.submitButton.text ?? ""}
            placeholder="Submit"
            maxLength={40}
            busy={busy}
            onCommit={(next) => setAppearance({ submitButton: { text: next || null } })}
          />
        </label>
      </Section>
    </div>
  );
}

/* ── Settings ────────────────────────────────────────────────────────────── */

export function FormSettingsPanel({ form, patch, busy, groups = [] }: PanelProps) {
  const { features } = form.config;

  function setFeatures(changes: Record<string, unknown>) {
    patch({ features: { ...features, ...changes } });
  }

  return (
    <div className="form-panel form-panel--settings">
      <Section icon="settings" title="General settings">
        <Switch
          label="Submit multiple forms"
          hint="Show a button to submit additional entries upon form completion"
          checked={features.afterSubmissionView.allowResubmit}
          busy={busy}
          onChange={(next) =>
            setFeatures({
              afterSubmissionView: { ...features.afterSubmissionView, allowResubmit: next },
            })
          }
        />
        <Switch
          label="Save as draft"
          hint="Allow submitters to save and share their draft for later completion"
          checked={features.draftSubmission.enabled}
          busy={busy}
          note="Recorded, but drafts are not stored yet — a submitter sees no draft button."
          onChange={(next) => setFeatures({ draftSubmission: { enabled: next } })}
        />
        <Switch
          label="Anonymous form"
          hint="Keep answers of submitters anonymous"
          checked={!features.board.includeNameQuestion}
          busy={busy}
          onChange={(next) =>
            setFeatures({ board: { ...features.board, includeNameQuestion: !next } })
          }
        />
        <Switch
          label="reCAPTCHA challenge"
          hint="Make sure no bots are answering the form"
          checked={features.reCaptchaChallenge}
          busy={busy}
          note="Recorded, but no challenge is served — this needs a reCAPTCHA site key."
          onChange={(next) => setFeatures({ reCaptchaChallenge: next })}
        />

        <div className="form-panel__row form-panel__row--stack">
          <Switch
            label="Response limit"
            hint="Limit the amount of responses you receive"
            checked={form.responseLimit !== null}
            busy={busy}
            onChange={(next) => patch({ responseLimit: next ? 100 : null })}
          />
          {form.responseLimit !== null && (
            <label className="form-panel__inline">
              <span>Stop after</span>
              <DraftInput
                type="number"
                min={1}
                value={String(form.responseLimit)}
                busy={busy}
                /* Committed on blur, so an empty box mid-edit is never POSTed
                   as 0 — which the API refuses outright. */
                onCommit={(next) => {
                  const limit = Number(next);
                  if (Number.isInteger(limit) && limit >= 1) patch({ responseLimit: limit });
                }}
              />
              <span>responses — {form.responseCount} received</span>
            </label>
          )}
        </div>

        <div className="form-panel__row form-panel__row--stack">
          <Switch
            label="Schedule a close date"
            hint="Set a closing date for your form"
            checked={form.closeAt !== null}
            busy={busy}
            onChange={(next) =>
              patch({
                closeAt: next
                  ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                  : null,
              })
            }
          />
          {form.closeAt !== null && (
            <label className="form-panel__inline">
              <span>Closes on</span>
              <DraftInput
                type="date"
                value={form.closeAt.slice(0, 10)}
                busy={busy}
                onCommit={(next) => {
                  if (next) patch({ closeAt: next });
                }}
              />
            </label>
          )}
        </div>

        <Switch
          label="Translate form with AI"
          hint="Allow users to choose which language their form is shown in"
          checked={features.aiTranslate.enabled}
          badge="Beta"
          busy={busy}
          note="Recorded, but no translation is performed — this needs a translation service."
          onChange={(next) => setFeatures({ aiTranslate: { enabled: next } })}
        />

        <label className="form-panel__field">
          <span>Form language</span>
          <select
            value={form.config.accessibility.language ?? "English (English)"}
            disabled={busy}
            onChange={(event) =>
              patch({
                accessibility: { ...form.config.accessibility, language: event.target.value },
              })
            }
          >
            <option>English (English)</option>
            <option>Arabic (العربية)</option>
            <option>French (Français)</option>
            <option>Spanish (Español)</option>
          </select>
        </label>
      </Section>

      {/*
        THE WELCOME PAGE — monday's `preSubmissionView`, which the captured
        configuration has carried since the import with no control behind it.

        WHAT IT IS FOR. A form sent to a store manager opens on question one,
        so the first thing a submitter reads is "Location". A welcome page is
        where the sentence that stops the wrong request being raised goes —
        "photographs are required", "this is for maintenance, not stock" — and
        it is the difference between a triage queue and an intake.

        WHY IT NEEDED NO NEW FIELD. `preSubmissionView` is a key of `features`,
        and `features` is already a section of `PatchBody` that the route MERGES
        and that `formUndoBody()` already sends whole. So the welcome page
        persists, restores and undoes with no route change and no new hole in
        the undo contract — `tests/form-undo.test.mjs` reads both lists and
        would fail the day they disagreed. Every switch below is the same
        merge-one-key-of-`features` write the rest of this panel makes.
      */}
      <Section icon="document" title="Welcome page">
        <Switch
          label="Show a welcome page"
          hint="Open the form on a message, with a button to begin"
          checked={features.preSubmissionView.enabled}
          busy={busy}
          onChange={(next) =>
            setFeatures({
              preSubmissionView: { ...features.preSubmissionView, enabled: next },
            })
          }
        />
        {features.preSubmissionView.enabled && (
          <>
            <label className="form-panel__field form-panel__field--stack">
              <span>Heading</span>
              <DraftInput
                type="text"
                value={features.preSubmissionView.title ?? ""}
                placeholder={form.title}
                maxLength={120}
                busy={busy}
                onCommit={(next) =>
                  setFeatures({
                    preSubmissionView: {
                      ...features.preSubmissionView,
                      title: next.trim() || null,
                    },
                  })
                }
              />
            </label>
            <label className="form-panel__field form-panel__field--stack">
              <span>Message</span>
              <DraftArea
                rows={4}
                value={features.preSubmissionView.description ?? ""}
                placeholder="What a submitter should know before they start."
                maxLength={1200}
                busy={busy}
                onCommit={(next) =>
                  setFeatures({
                    preSubmissionView: {
                      ...features.preSubmissionView,
                      description: next.trim() || null,
                    },
                  })
                }
              />
            </label>
            <label className="form-panel__field form-panel__field--stack">
              <span>Button</span>
              <DraftInput
                type="text"
                value={features.preSubmissionView.startButton.text ?? ""}
                placeholder="Start"
                maxLength={40}
                busy={busy}
                onCommit={(next) =>
                  setFeatures({
                    preSubmissionView: {
                      ...features.preSubmissionView,
                      startButton: { text: next.trim() || null },
                    },
                  })
                }
              />
            </label>
            <p className="form-panel__note">
              Shown in Preview exactly as it will appear. The public link needs the
              same block in its renderer before a submitter sees it.
            </p>
          </>
        )}
      </Section>

      <Section icon="check" title="After submission">
        <label className="form-panel__field form-panel__field--stack">
          <span>Confirmation heading</span>
          <DraftInput
            type="text"
            value={features.afterSubmissionView.title ?? ""}
            placeholder="Thank you!"
            maxLength={120}
            busy={busy}
            onCommit={(next) =>
              setFeatures({
                afterSubmissionView: {
                  ...features.afterSubmissionView,
                  title: next.trim() || null,
                },
              })
            }
          />
        </label>
        <label className="form-panel__field form-panel__field--stack">
          <span>Confirmation message</span>
          <DraftArea
            rows={3}
            value={features.afterSubmissionView.description ?? ""}
            placeholder="Left empty, the form names the work order it created."
            maxLength={600}
            busy={busy}
            onCommit={(next) =>
              setFeatures({
                afterSubmissionView: {
                  ...features.afterSubmissionView,
                  description: next.trim() || null,
                },
              })
            }
          />
        </label>
        {/*
          Both of the above and the switch below are read by `DoneScreen` in
          form-renderer.tsx through the shared projection, so what is typed here
          is what a submitter reads — no renderer change is owed for these three.
        */}
        <Switch
          label="Success image"
          hint="Show the tick above the confirmation message"
          checked={features.afterSubmissionView.showSuccessImage}
          busy={busy}
          onChange={(next) =>
            setFeatures({
              afterSubmissionView: { ...features.afterSubmissionView, showSuccessImage: next },
            })
          }
        />
        <Switch
          label="Response viewing"
          hint="Allow submitters to view and download their submissions"
          checked={features.afterSubmissionView.allowViewSubmission}
          busy={busy}
          onChange={(next) =>
            setFeatures({
              afterSubmissionView: {
                ...features.afterSubmissionView,
                allowViewSubmission: next,
              },
            })
          }
        />
        <div className="form-panel__row form-panel__row--stack">
          <Switch
            label="Redirect URL"
            hint="Send users to a different page after submission"
            checked={features.afterSubmissionView.redirectAfterSubmission.enabled}
            busy={busy}
            onChange={(next) =>
              setFeatures({
                afterSubmissionView: {
                  ...features.afterSubmissionView,
                  redirectAfterSubmission: {
                    ...features.afterSubmissionView.redirectAfterSubmission,
                    enabled: next,
                  },
                },
              })
            }
          />
          {features.afterSubmissionView.redirectAfterSubmission.enabled && (
            <label className="form-panel__inline form-panel__inline--wide">
              <span>Go to</span>
              <DraftInput
                type="url"
                placeholder="https://…"
                value={features.afterSubmissionView.redirectAfterSubmission.redirectUrl ?? ""}
                busy={busy}
                /* On blur, so a half-typed "htt" is never POSTed — the API
                   refuses anything that is not http(s), so this field could
                   never be filled in one character at a time. */
                onCommit={(next) =>
                  setFeatures({
                    afterSubmissionView: {
                      ...features.afterSubmissionView,
                      redirectAfterSubmission: { enabled: true, redirectUrl: next || null },
                    },
                  })
                }
              />
            </label>
          )}
        </div>
      </Section>

      <Section icon="folder" title="Board">
        <Switch
          label="Sync questions and column titles"
          hint="When enabled, question and column titles will be synced"
          checked={features.board.syncQuestionAndColumnsTitles}
          busy={busy}
          onChange={(next) =>
            setFeatures({ board: { ...features.board, syncQuestionAndColumnsTitles: next } })
          }
        />
        <Switch
          label="Allow creating items via form"
          hint="Add option in main board to create new items via form"
          checked={features.board.allowCreatingItems}
          busy={busy}
          onChange={(next) =>
            setFeatures({ board: { ...features.board, allowCreatingItems: next } })
          }
        />
        {/*
          A real selector. This was a paragraph asserting that answers go to
          "Incoming requests" — which was true only because the submit route
          hard-coded it and never read the setting at all.
        */}
        <label className="form-panel__field">
          <span>Group for answers</span>
          <select
            value={features.board.itemGroupId ?? ""}
            disabled={busy || !groups.length}
            onChange={(event) =>
              setFeatures({
                board: { ...features.board, itemGroupId: event.target.value || null },
              })
            }
          >
            {/* Empty means "the board's top group" — the documented default. */}
            <option value="">Incoming requests (default)</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      </Section>
    </div>
  );
}
