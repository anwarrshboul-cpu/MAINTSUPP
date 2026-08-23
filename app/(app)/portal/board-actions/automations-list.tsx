"use client";

/**
 * The Manage list — the board's rules as cards (Classic) or rows (Compact),
 * with the per-rule switch and the ⋯ menu.
 *
 * No "Rename": the rule's name is the sentence the server composes from its
 * configuration, so a hand-typed name would stop describing the rule the
 * moment it was typed. The menu offers the description instead, which is
 * the free-text field a person actually owns.
 */

import { useMemo, useState, type RefObject } from "react";
import { AnchoredPopover } from "../overlay/anchored";
import type { AutomationRuleView } from "./automations-data";
import { ActionIcon } from "./board-icons";
import { BoardModal } from "./board-modal";

export type RulesLayout = "classic" | "compact";

export const IMPORTANCE_LABEL: Record<string, string> = {
  minor: "Minor",
  major: "Major",
  critical: "Critical",
};

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? `${iso.replace(" ", "T")}Z` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ownerOf(rule: AutomationRuleView) {
  return rule.createdBy ?? "—";
}

function RuleMenu({
  rule,
  anchorRef,
  open,
  onClose,
  onDescription,
  onImportance,
  onDuplicate,
  onDelete,
}: {
  rule: AutomationRuleView;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  onDescription: () => void;
  onImportance: (value: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <AnchoredPopover open={open} anchorRef={anchorRef} onClose={onClose} placement="bottom-end" label={`Options for ${rule.name}`} layer="popover-raised">
      <div className="ba-menu">
        <button type="button" role="menuitem" className="ba-menu__item" onClick={() => { onClose(); onDescription(); }}>
          <ActionIcon name="edit" size={16} />
          <span>Edit description</span>
        </button>
        <div className="ba-menu__sep" />
        <div className="ba-menu__title">Importance</div>
        {Object.entries(IMPORTANCE_LABEL).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={rule.importance === value}
            className="ba-menu__item"
            onClick={() => { onClose(); onImportance(value); }}
          >
            <ActionIcon name={rule.importance === value ? "check" : "alert"} size={16} style={rule.importance === value ? undefined : { opacity: 0.35 }} />
            <span>{label}</span>
          </button>
        ))}
        <div className="ba-menu__sep" />
        <button type="button" role="menuitem" className="ba-menu__item" onClick={() => { onClose(); onDuplicate(); }}>
          <ActionIcon name="copy" size={16} />
          <span>Duplicate</span>
        </button>
        <button type="button" role="menuitem" className="ba-menu__item is-destructive" onClick={() => { onClose(); onDelete(); }}>
          <ActionIcon name="trash" size={16} />
          <span>Delete</span>
        </button>
      </div>
    </AnchoredPopover>
  );
}

function DescriptionDialog({
  rule,
  onClose,
  onSave,
}: {
  rule: AutomationRuleView | null;
  onClose: () => void;
  onSave: (description: string) => Promise<void>;
}) {
  const [value, setValue] = useState(rule?.description ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <BoardModal open={Boolean(rule)} onClose={onClose} title="Edit description" titleId="auto-description-title" size="sm">
      <div className="ba-modal__body ba-form">
        <p className="ba-hint" style={{ marginTop: 0 }}>{rule?.name}</p>
        <label className="ba-field">
          <span>Description</span>
          <textarea className="ba-textarea" value={value} maxLength={600} onChange={(event) => setValue(event.target.value)} data-autofocus />
        </label>
      </div>
      <div className="ba-modal__foot">
        <button type="button" className="ba-btn ba-btn--quiet" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="ba-btn ba-btn--primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onSave(value.trim()).finally(() => setBusy(false));
          }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </BoardModal>
  );
}

function ConfirmDelete({ rule, onClose, onConfirm }: { rule: AutomationRuleView | null; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <BoardModal open={Boolean(rule)} onClose={onClose} title="Delete this automation?" titleId="auto-delete-title" size="sm">
      <div className="ba-modal__body">
        <p style={{ margin: 0 }}>
          <strong>{rule?.name}</strong>
        </p>
        <p className="ba-hint">Its run history is kept. The rule itself cannot be recovered.</p>
      </div>
      <div className="ba-modal__foot">
        <button type="button" className="ba-btn ba-btn--quiet" onClick={onClose} data-autofocus>Cancel</button>
        <button
          type="button"
          className="ba-btn ba-btn--danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().finally(() => setBusy(false));
          }}
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </BoardModal>
  );
}

export function RulesList({
  rules,
  layout,
  canManage,
  onToggle,
  onDescription,
  onImportance,
  onDuplicate,
  onDelete,
}: {
  rules: AutomationRuleView[];
  layout: RulesLayout;
  canManage: boolean;
  onToggle: (rule: AutomationRuleView, enabled: boolean) => Promise<void>;
  onDescription: (rule: AutomationRuleView, description: string) => Promise<void>;
  onImportance: (rule: AutomationRuleView, importance: string) => Promise<void>;
  onDuplicate: (rule: AutomationRuleView) => Promise<void>;
  onDelete: (rule: AutomationRuleView) => Promise<void>;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [describing, setDescribing] = useState<AutomationRuleView | null>(null);
  const [deleting, setDeleting] = useState<AutomationRuleView | null>(null);
  // One RefObject per rule for its menu to anchor to, made together whenever
  // the list changes — read in render, never mutated there.
  const anchors = useMemo(
    () => new Map<string, RefObject<HTMLButtonElement | null>>(rules.map((rule) => [rule.id, { current: null }])),
    [rules],
  );
  const anchorFor = (id: string): RefObject<HTMLButtonElement | null> => anchors.get(id) ?? { current: null };

  const menuButton = (rule: AutomationRuleView) => (
    <button
      type="button"
      ref={(node) => {
        anchorFor(rule.id).current = node;
      }}
      className="ba-iconbtn auto-rule__more"
      aria-label={`Options for ${rule.name}`}
      aria-haspopup="menu"
      aria-expanded={menuFor === rule.id}
      disabled={!canManage}
      title={canManage ? undefined : "Only people who can edit the board can manage automations"}
      onClick={() => setMenuFor(menuFor === rule.id ? null : rule.id)}
    >
      <ActionIcon name="more" size={18} />
    </button>
  );

  const toggle = (rule: AutomationRuleView) => (
    <button
      type="button"
      role="switch"
      aria-checked={rule.enabled}
      aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
      className="ba-switch"
      disabled={!canManage}
      title={canManage ? (rule.enabled ? "Enabled" : "Disabled") : "Only people who can edit the board can manage automations"}
      onClick={() => void onToggle(rule, !rule.enabled)}
    />
  );

  const menus = rules.map((rule) => (
    <RuleMenu
      key={rule.id}
      rule={rule}
      anchorRef={anchorFor(rule.id)}
      open={menuFor === rule.id}
      onClose={() => setMenuFor(null)}
      onDescription={() => setDescribing(rule)}
      onImportance={(value) => void onImportance(rule, value)}
      onDuplicate={() => void onDuplicate(rule)}
      onDelete={() => setDeleting(rule)}
    />
  ));

  const dialogs = (
    <>
      {describing && (
        <DescriptionDialog
          key={describing.id}
          rule={describing}
          onClose={() => setDescribing(null)}
          onSave={async (description) => {
            await onDescription(describing, description);
            setDescribing(null);
          }}
        />
      )}
      <ConfirmDelete
        rule={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await onDelete(deleting);
          setDeleting(null);
        }}
      />
    </>
  );

  if (layout === "compact") {
    return (
      <>
        <div className="auto-table__scroll">
          <table className="auto-table">
            <thead>
              <tr>
                <th scope="col"><span className="visually-hidden">Options</span></th>
                <th scope="col"><span className="visually-hidden">Enabled</span></th>
                <th scope="col">Automation</th>
                <th scope="col">Description</th>
                <th scope="col">Importance</th>
                <th scope="col">Owner</th>
                <th scope="col" title="Times this rule has run">Runs</th>
                <th scope="col" title="Last time this rule ran">Last run</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className={rule.enabled ? "" : "is-disabled"} data-rule-id={rule.id}>
                  <td>{menuButton(rule)}</td>
                  <td>{toggle(rule)}</td>
                  <td className="auto-table__name" title={rule.name}>
                    {rule.name}
                    {rule.timeBased && <em className="auto-chip auto-chip--time" title="Checked when the board is opened">time-based</em>}
                  </td>
                  <td className="auto-table__desc" title={rule.description ?? undefined}>{rule.description ?? "—"}</td>
                  <td><em className={`auto-chip auto-chip--${rule.importance}`}>{IMPORTANCE_LABEL[rule.importance] ?? rule.importance}</em></td>
                  <td title={ownerOf(rule)}>{ownerOf(rule)}</td>
                  <td>{rule.runCount}</td>
                  <td title={rule.lastRunAt ?? "Never"}>{formatWhen(rule.lastRunAt)}</td>
                  <td title={rule.updatedAt}>{formatWhen(rule.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {menus}
        {dialogs}
      </>
    );
  }

  return (
    <>
      <ul className="auto-cards">
        {rules.map((rule) => (
          <li key={rule.id} className={`auto-rule${rule.enabled ? "" : " is-disabled"}`} data-rule-id={rule.id}>
            <div className="auto-rule__head">
              <ActionIcon name="bolt" size={18} className="auto-rule__bolt" />
              <p className="auto-rule__sentence">{rule.name}</p>
              {toggle(rule)}
              {menuButton(rule)}
            </div>
            {rule.description && <p className="auto-rule__desc">{rule.description}</p>}
            <dl className="auto-rule__meta">
              <div>
                <dt>Importance</dt>
                <dd><em className={`auto-chip auto-chip--${rule.importance}`}>{IMPORTANCE_LABEL[rule.importance] ?? rule.importance}</em></dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>{ownerOf(rule)}</dd>
              </div>
              <div>
                <dt>Runs</dt>
                <dd>{rule.runCount}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd title={rule.updatedAt}>{formatWhen(rule.updatedAt)}</dd>
              </div>
              {rule.timeBased && (
                <div>
                  <dt>Checked</dt>
                  <dd>when the board is opened</dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>
      {menus}
      {dialogs}
    </>
  );
}
