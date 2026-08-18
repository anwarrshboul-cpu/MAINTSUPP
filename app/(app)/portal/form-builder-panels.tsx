"use client";

import { Icon, type IconName } from "../../components";
import {
  orderedQuestions,
  questionGlyph,
  type BuilderForm,
} from "./form-builder-model";

/**
 * The Edit, Design and Settings panels.
 *
 * All three take the same two props — the form and a patch function — and none
 * of them holds state of its own. Every control writes straight through to
 * `/api/board/form`, because monday's builder has no Save button and inventing
 * one would create a window where the panel and the live form disagree about
 * what the form is.
 *
 * The panels are one file because they are one screen: the toolbar swaps
 * between them and they share the whole visual language of rows, switches and
 * section cards. Splitting them into three would triple the CSS import surface
 * for no reviewability gain — this file is long but it is a list, not a graph.
 */

type PanelProps = {
  form: BuilderForm;
  patch: (patch: Record<string, unknown>) => void;
  busy: boolean;
  /** The board's real groups, for "Group for answers". */
  groups?: Array<{ id: string; name: string }>;
};

/* ── A few shared controls ───────────────────────────────────────────────── */

function Switch({
  label,
  hint,
  checked,
  onChange,
  busy,
  badge,
  note,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  busy: boolean;
  badge?: string;
  /** Shown when a toggle records intent that this build cannot yet act on. */
  note?: string;
}) {
  return (
    <label className="form-panel__row">
      <div>
        <strong>
          {label}
          {badge && <em className="form-panel__badge">{badge}</em>}
        </strong>
        {hint && <span>{hint}</span>}
        {note && <span className="form-panel__note">{note}</span>}
      </div>
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

function Section({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="form-panel__section">
      <h3>
        <Icon name={icon} size={15} /> {title}
      </h3>
      <div className="form-panel__body">{children}</div>
    </section>
  );
}

/* ── Edit — the Content list and the form canvas ─────────────────────────── */

/**
 * monday's Edit tab: a Content sidebar naming every question, and the canvas.
 *
 * REORDERING IS BUTTONS, NOT DRAG-AND-DROP, AND THAT IS DELIBERATE.
 * monday uses drag handles. A pointer-only reorder is unusable by keyboard and
 * by anyone using a screen reader, and this panel already only renders on
 * desktop — so the accessible control is the one that ships. The move buttons
 * write the same `order` array a drag would.
 */
export function FormEditPanel({ form, patch, busy }: PanelProps) {
  const questions = orderedQuestions(form.config);

  function move(id: string, direction: -1 | 1) {
    const order = questions.map((question) => question.id);
    const from = order.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    /*
     * The page block leads the stored order and is not in this list, so it is
     * put back at the front rather than being dropped by the round trip.
     */
    const pageBlocks = form.config.order.filter((entry) =>
      form.config.questions.some(
        (question) => question.id === entry && question.type === "PAGE_BLOCK",
      ),
    );
    patch({ order: [...pageBlocks, ...order] });
  }

  /**
   * Merge one question's settings.
   *
   * Merged rather than replaced so setting "include time" cannot wipe "today
   * as default" that was set a moment earlier — each control owns one key.
   */
  function setSetting(id: string, changes: Record<string, unknown>) {
    patch({
      questions: form.config.questions.map((question) =>
        question.id === id
          ? { ...question, settings: { ...(question.settings ?? {}), ...changes } }
          : question,
      ),
    });
  }

  function update(id: string, changes: Record<string, unknown>) {
    patch({
      questions: form.config.questions.map((question) =>
        question.id === id ? { ...question, ...changes } : question,
      ),
    });
  }

  return (
    <div className="form-edit">
      <aside className="form-edit__content" aria-label="Form content">
        <header>
          <Icon name="chevron" size={14} />
          <strong>Content</strong>
        </header>
        <p className="form-edit__page">Page 1</p>
        <ol>
          {questions.map((question) => {
            const glyph = questionGlyph(question.type);
            return (
              <li
                key={question.id}
                className={question.visible ? undefined : "is-hidden"}
                title={question.visible ? question.title : `${question.title} — hidden`}
              >
                <span className={`form-edit__glyph form-edit__glyph--${glyph.tone}`}>
                  <Icon name={glyph.icon} size={12} />
                </span>
                <span className="form-edit__name">{question.title}</span>
                {!question.visible && <Icon name="close" size={12} />}
              </li>
            );
          })}
        </ol>
      </aside>

      <div className="form-edit__canvas">
        <div className="form-edit__card form-edit__card--head">
          <h2>{form.title}</h2>
          {form.description && <p>{form.description}</p>}
        </div>

        {questions.map((question, index) => {
          const glyph = questionGlyph(question.type);
          return (
            <article
              key={question.id}
              className={`form-edit__card${question.visible ? "" : " is-hidden"}`}
            >
              <div className="form-edit__cardhead">
                <span className={`form-edit__glyph form-edit__glyph--${glyph.tone}`}>
                  <Icon name={glyph.icon} size={12} />
                </span>
                <strong>{question.title}</strong>
                {question.required && <em aria-label="Required">*</em>}
                <div className="form-edit__cardtools">
                  <button
                    type="button"
                    onClick={() => move(question.id, -1)}
                    disabled={busy || index === 0}
                    aria-label={`Move ${question.title} up`}
                  >
                    <Icon name="chevron" size={14} />
                  </button>
                  <button
                    type="button"
                    className="is-down"
                    onClick={() => move(question.id, 1)}
                    disabled={busy || index === questions.length - 1}
                    aria-label={`Move ${question.title} down`}
                  >
                    <Icon name="chevron" size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => update(question.id, { visible: !question.visible })}
                    disabled={busy}
                    aria-pressed={question.visible}
                    aria-label={
                      question.visible ? `Hide ${question.title}` : `Show ${question.title}`
                    }
                  >
                    <Icon name={question.visible ? "check" : "close"} size={14} />
                  </button>
                </div>
              </div>

              {question.description && (
                <p className="form-edit__help">{question.description}</p>
              )}

              {/*
                QUESTION SETTINGS — monday's per-question panel, inline.
                Every control here changes what a submitter sees, and each one
                is rendered only for the question types it means anything for:
                a "today as default" switch on a text question would be a
                control that does nothing, which is the thing being fixed.
              */}
              <div className="form-edit__settings">
                {(question.type === "Date" || question.type === "DateRange") && (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={question.settings?.defaultCurrentDate === true}
                        disabled={busy || !question.visible}
                        onChange={(event) =>
                          setSetting(question.id, { defaultCurrentDate: event.target.checked })
                        }
                      />
                      Today as default
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={question.settings?.includeTime === true}
                        disabled={busy || !question.visible}
                        onChange={(event) =>
                          setSetting(question.id, { includeTime: event.target.checked })
                        }
                      />
                      Include time
                    </label>
                  </>
                )}

                {question.type === "SingleSelect" && (
                  <>
                    <label className="form-edit__setting">
                      <span>Display</span>
                      <select
                        value={question.settings?.display ?? "Dropdown"}
                        disabled={busy || !question.visible}
                        onChange={(event) =>
                          setSetting(question.id, {
                            display: event.target.value as "Dropdown" | "Vertical" | "Horizontal",
                          })
                        }
                      >
                        <option value="Dropdown">Show options in a dropdown</option>
                        <option value="Vertical">List the options</option>
                        <option value="Horizontal">List the options side by side</option>
                      </select>
                    </label>
                    <label className="form-edit__setting">
                      <span>Options order</span>
                      <select
                        value={question.settings?.optionsOrder ?? "Custom"}
                        disabled={busy || !question.visible}
                        onChange={(event) =>
                          setSetting(question.id, {
                            optionsOrder: event.target.value as "Custom" | "Alphabetical",
                          })
                        }
                      >
                        <option value="Custom">Custom</option>
                        <option value="Alphabetical">Alphabetical</option>
                      </select>
                    </label>
                  </>
                )}

                {(question.type === "ShortText" || question.type === "LongText") && (
                  <label className="form-edit__setting form-edit__setting--wide">
                    <span>Pre-fill value</span>
                    <input
                      type="text"
                      value={question.settings?.defaultAnswer ?? ""}
                      placeholder="Leave empty for none"
                      maxLength={200}
                      disabled={busy || !question.visible}
                      onChange={(event) =>
                        setSetting(question.id, { defaultAnswer: event.target.value || null })
                      }
                    />
                  </label>
                )}
              </div>

              <div className="form-edit__cardfoot">
                <label>
                  <input
                    type="checkbox"
                    checked={question.required}
                    disabled={busy || !question.visible}
                    onChange={(event) =>
                      update(question.id, { required: event.target.checked })
                    }
                  />
                  Required
                </label>
                {question.options && (
                  <span className="form-edit__count">
                    {question.options.filter((option) => option.visible && option.active).length}{" "}
                    options
                  </span>
                )}
                {!question.visible && <span className="form-edit__count">Hidden</span>}
              </div>
            </article>
          );
        })}

        <div className="form-edit__card form-edit__card--submit">
          <span>{form.config.appearance.submitButton.text || "Submit"}</span>
        </div>
      </div>
    </div>
  );
}

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
            value={appearance.primaryColor ?? "#0b7a72"}
            disabled={busy}
            onChange={(event) => setAppearance({ primaryColor: event.target.value })}
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
              value={appearance.background.value ?? "#f4f7f8"}
              disabled={busy}
              onChange={(event) =>
                setAppearance({
                  background: { type: "Color", value: event.target.value },
                })
              }
            />
          </label>
        )}
        {appearance.background.type === "Image" && (
          <label className="form-panel__field form-panel__field--stack">
            <span>Image URL</span>
            <input
              type="url"
              value={appearance.background.value ?? ""}
              placeholder="https://…"
              disabled={busy}
              onChange={(event) =>
                setAppearance({
                  background: { type: "Image", value: event.target.value || null },
                })
              }
            />
          </label>
        )}

        <label className="form-panel__field form-panel__field--stack">
          <span>Logo URL</span>
          <input
            type="url"
            value={appearance.logo.url ?? ""}
            placeholder="Leave empty for the MAINTSUPP mark"
            disabled={busy}
            onChange={(event) =>
              setAppearance({ logo: { ...appearance.logo, url: event.target.value || null } })
            }
          />
        </label>

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
          <input
            type="text"
            value={appearance.submitButton.text ?? ""}
            placeholder="Submit"
            maxLength={40}
            disabled={busy}
            onChange={(event) =>
              setAppearance({ submitButton: { text: event.target.value || null } })
            }
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
              <input
                type="number"
                min={1}
                value={form.responseLimit}
                disabled={busy}
                onChange={(event) => patch({ responseLimit: Number(event.target.value) })}
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
              <input
                type="date"
                value={form.closeAt.slice(0, 10)}
                disabled={busy}
                onChange={(event) => patch({ closeAt: event.target.value })}
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

      <Section icon="check" title="After submission">
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
              <input
                type="url"
                placeholder="https://…"
                value={features.afterSubmissionView.redirectAfterSubmission.redirectUrl ?? ""}
                disabled={busy}
                onChange={(event) =>
                  setFeatures({
                    afterSubmissionView: {
                      ...features.afterSubmissionView,
                      redirectAfterSubmission: {
                        enabled: true,
                        redirectUrl: event.target.value || null,
                      },
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
