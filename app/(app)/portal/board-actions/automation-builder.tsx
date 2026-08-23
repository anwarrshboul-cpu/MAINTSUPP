"use client";

/**
 * "Create from scratch" — the two-step sentence builder.
 *
 *     When this happens          ← opens the trigger picker
 *            ↓
 *     Then do this               ← opens the action picker
 *            ↓
 *     [ Create automation ]
 *
 * Each heading is a button; choosing an entry swaps the heading for the
 * entry's label and unfolds the fields it needs, built from the board's
 * vocabulary. The sentence under the form is composed by the same
 * `composeSentence` the server uses to name the rule, resolved against the
 * same names, so what is previewed is what is saved. Errors from
 * `POST /api/automations` are shown inline beneath the button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutomationCatalog, CatalogAction, CatalogTrigger } from "../../../lib/automations/catalog";
import { composeSentence } from "../../../lib/automations/sentence";
import {
  clientResolver,
  createRule,
  loadMembers,
  loadOptionValues,
  type AutomationRuleView,
  type AutomationTemplate,
  type OptionValues,
  type Vocabulary,
} from "./automations-data";
import { FieldControls, type FieldConfig } from "./automation-fields";
import { ActionIcon, catalogIcon } from "./board-icons";
import { CatalogPicker } from "./catalog-picker";

function asFieldConfig(config: Record<string, unknown>): FieldConfig {
  const out: FieldConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && value) out[key] = value;
    else if (typeof value === "number") out[key] = String(value);
  }
  return out;
}

export function AutomationBuilder({
  boardId,
  catalog,
  vocabulary,
  template,
  onCreated,
  onCancel,
}: {
  boardId: string;
  catalog: AutomationCatalog;
  vocabulary: Vocabulary | null;
  /** A template to start from, or null for a blank rule. */
  template: AutomationTemplate | null;
  onCreated: (rule: AutomationRuleView) => void;
  onCancel: () => void;
}) {
  // Seeded from the template, when one is handed in. The builder is mounted
  // fresh each time Create is entered, so initial state is the whole story.
  const [trigger, setTrigger] = useState<CatalogTrigger | null>(() =>
    template ? catalog.triggers.find((entry) => entry.type === template.triggerType) ?? null : null,
  );
  const [action, setAction] = useState<CatalogAction | null>(() =>
    template ? catalog.actions.find((entry) => entry.type === template.actionType) ?? null : null,
  );
  const [triggerConfig, setTriggerConfig] = useState<FieldConfig>(() => (template ? asFieldConfig(template.triggerConfig) : {}));
  const [actionConfig, setActionConfig] = useState<FieldConfig>(() => (template ? asFieldConfig(template.actionConfig) : {}));
  const [description, setDescription] = useState(template?.blurb ?? "");
  const [picker, setPicker] = useState<null | "trigger" | "action">(null);
  const [options, setOptions] = useState<OptionValues>({});
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadOptionValues()
      .then((values) => !cancelled && setOptions(values))
      .catch(() => undefined);
    void loadMembers()
      .then((members) => !cancelled && setPeople(members.map((member) => member.name)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const resolver = useMemo(() => clientResolver(vocabulary, options, people), [vocabulary, options, people]);

  const sentence = useMemo(() => {
    if (!trigger || !action) return null;
    return composeSentence(trigger.type, triggerConfig, action.type, actionConfig, resolver);
  }, [trigger, action, triggerConfig, actionConfig, resolver]);

  const itemlessClash = Boolean(trigger?.itemless && action?.needsItem);

  const submit = useCallback(async () => {
    if (!trigger || !action) return;
    setBusy(true);
    setError(null);
    try {
      const { rule } = await createRule({
        boardId,
        triggerType: trigger.type,
        triggerConfig,
        actionType: action.type,
        actionConfig,
        description: description.trim() || undefined,
      });
      onCreated(rule);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The automation could not be created.");
    } finally {
      setBusy(false);
    }
  }, [trigger, action, triggerConfig, actionConfig, description, boardId, onCreated]);

  return (
    <div className="auto-builder">
      <div className="auto-builder__step">
        <button
          type="button"
          ref={triggerRef}
          className={`auto-builder__heading${trigger ? " is-chosen" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={picker === "trigger"}
          onClick={() => setPicker(picker === "trigger" ? null : "trigger")}
        >
          {trigger ? (
            <>
              <ActionIcon name={catalogIcon(trigger.icon)} size={18} />
              <span>{trigger.label}</span>
              <small>change</small>
            </>
          ) : (
            <span>When this happens</span>
          )}
        </button>
        {trigger && (
          <FieldControls
            entry={trigger}
            config={triggerConfig}
            vocabulary={vocabulary}
            options={options}
            people={people}
            onChange={setTriggerConfig}
          />
        )}
        {trigger?.timeBased && (
          <p className="auto-builder__note">
            <ActionIcon name="clock" size={14} /> {catalog.timeBasedNote}
          </p>
        )}
      </div>

      <div className="auto-builder__arrow" aria-hidden="true">
        <ActionIcon name="chevron-down" size={22} />
      </div>

      <div className="auto-builder__step">
        <button
          type="button"
          ref={actionRef}
          className={`auto-builder__heading${action ? " is-chosen" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={picker === "action"}
          onClick={() => setPicker(picker === "action" ? null : "action")}
        >
          {action ? (
            <>
              <ActionIcon name={catalogIcon(action.icon)} size={18} />
              <span>{action.label}</span>
              <small>change</small>
            </>
          ) : (
            <span>Then do this</span>
          )}
        </button>
        {action && (
          <FieldControls
            entry={action}
            config={actionConfig}
            vocabulary={vocabulary}
            options={options}
            people={people}
            onChange={setActionConfig}
          />
        )}
        {itemlessClash && trigger && action && (
          <p className="ba-error" role="alert">
            “{trigger.label}” fires without an item, so it cannot {action.label.toLowerCase()}. Choose an action that
            creates something instead.
          </p>
        )}
      </div>

      <div className="auto-builder__arrow" aria-hidden="true">
        <ActionIcon name="chevron-down" size={22} />
      </div>

      {sentence && (
        <p className="auto-builder__sentence" aria-live="polite">
          <ActionIcon name="bolt" size={16} /> {sentence}
        </p>
      )}

      <label className="ba-field auto-builder__description">
        <span>Description (optional)</span>
        <input
          className="ba-input"
          value={description}
          maxLength={600}
          placeholder="What this rule is for"
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>

      <div className="auto-builder__actions">
        <button type="button" className="ba-btn ba-btn--quiet" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ba-btn ba-btn--primary auto-builder__create"
          disabled={!trigger || !action || itemlessClash || busy}
          onClick={() => void submit()}
        >
          {busy ? "Creating…" : "Create automation"}
        </button>
      </div>
      {error && (
        <p className="ba-error" role="alert">
          {error}
        </p>
      )}

      {catalog.omitted.length > 0 && (
        <details className="auto-builder__omitted">
          <summary>What is deliberately not offered</summary>
          <ul>
            {catalog.omitted.map((entry) => (
              <li key={entry.label}>
                <strong>{entry.label}</strong> — {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <CatalogPicker
        open={picker === "trigger"}
        anchorRef={triggerRef}
        onClose={() => setPicker(null)}
        entries={catalog.triggers}
        mostUsed={catalog.mostUsedTriggers}
        selectedType={trigger?.type ?? null}
        label="Triggers"
        onPick={(entry) => {
          if (entry.type !== trigger?.type) setTriggerConfig({});
          setTrigger(entry);
          setPicker(null);
        }}
      />
      <CatalogPicker
        open={picker === "action"}
        anchorRef={actionRef}
        onClose={() => setPicker(null)}
        entries={catalog.actions}
        mostUsed={catalog.mostUsedActions}
        selectedType={action?.type ?? null}
        label="Actions"
        onPick={(entry) => {
          if (entry.type !== action?.type) setActionConfig({});
          setAction(entry);
          setPicker(null);
        }}
      />
    </div>
  );
}
