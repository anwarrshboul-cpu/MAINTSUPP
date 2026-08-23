"use client";

/**
 * The Automations modal — "Automations · <board>".
 *
 *   Create | Manage / n      the two modes, as a segmented toggle
 *   Create automation ▾      from scratch, or from one of the store's
 *                            templates when the board has any
 *   Automations · Run history · My connections · Account usage
 *
 * Everything drawn here is read from `/api/automations` and its siblings;
 * the count in the header of the board is the same `counts.enabled`, and
 * every write here announces `maintsupp:automations-changed` so the header
 * re-reads it.
 *
 * `AutomationsModal` mounts `OpenAutomations` only while open, so each
 * opening starts on Manage › Automations with a fresh read — no effect has
 * to reset anything.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutomationCatalog } from "../../../lib/automations/catalog";
import { AnchoredPopover } from "../overlay/anchored";
import { AutomationBuilder } from "./automation-builder";
import {
  announceAutomationsChanged,
  createRule,
  deleteRule,
  loadAutomations,
  loadCatalog,
  patchRule,
  useLocalPreference,
  type AutomationTemplate,
  type AutomationsPayload,
} from "./automations-data";
import { RulesList, type RulesLayout } from "./automations-list";
import { Connections, RunHistory, Usage } from "./automations-panels";
import { ActionIcon } from "./board-icons";
import { BoardModal } from "./board-modal";

type Mode = "create" | "manage";
type Tab = "automations" | "runs" | "connections" | "usage";
type Filter = "all" | "enabled" | "disabled";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "automations", label: "Automations" },
  { key: "runs", label: "Run history" },
  { key: "connections", label: "My connections" },
  { key: "usage", label: "Account usage" },
];

const TITLE_ID = "ba-automations-title";

function OpenAutomations({ onClose, boardId, boardName }: { onClose: () => void; boardId: string; boardName: string }) {
  const [mode, setMode] = useState<Mode>("manage");
  const [tab, setTab] = useState<Tab>("automations");
  const [payload, setPayload] = useState<AutomationsPayload | null>(null);
  const [catalog, setCatalog] = useState<AutomationCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [layout, setLayout] = useLocalPreference<RulesLayout>("maintsupp:automations-layout", "classic");
  const [createOpen, setCreateOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [template, setTemplate] = useState<AutomationTemplate | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const createRef = useRef<HTMLButtonElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await loadAutomations(boardId);
      setPayload(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Automations could not be loaded.");
    }
  }, [boardId]);

  // Deferred through a timer, as the loads in portal-app.tsx are, so the
  // two reads start on a later tick rather than cascading a render.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
      void loadCatalog()
        .then(setCatalog)
        .catch((cause) => setError(cause instanceof Error ? cause.message : "The catalogue could not be loaded."));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const rules = useMemo(() => payload?.rules ?? [], [payload]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rules.filter((rule) => {
      if (filter === "enabled" && !rule.enabled) return false;
      if (filter === "disabled" && rule.enabled) return false;
      if (!needle) return true;
      return (
        rule.name.toLowerCase().includes(needle) ||
        (rule.description ?? "").toLowerCase().includes(needle) ||
        (rule.createdBy ?? "").toLowerCase().includes(needle)
      );
    });
  }, [rules, query, filter]);

  const canManage = payload?.canManage ?? false;
  const templates = payload?.templates ?? [];

  const afterWrite = useCallback(
    async (message: string) => {
      setNotice(message);
      setRefreshToken((token) => token + 1);
      announceAutomationsChanged();
      await reload();
    },
    [reload],
  );

  const withError = useCallback(async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work.");
    }
  }, []);

  const startCreate = (from: AutomationTemplate | null) => {
    setCreateOpen(false);
    setTemplatesOpen(false);
    setTemplate(from);
    setMode("create");
    setError(null);
  };

  const header = (
    <div className="ba-modal__head auto-head">
      <h2 id={TITLE_ID}>
        <ActionIcon name="bolt" size={20} />
        Automations <span className="auto-head__board">{boardName}</span>
      </h2>
      <div className="auto-head__mode" role="group" aria-label="Mode">
        <button
          type="button"
          className={`auto-segment${mode === "create" ? " is-active" : ""}`}
          aria-pressed={mode === "create"}
          disabled={!canManage}
          title={canManage ? undefined : "Only people who can edit the board can create automations"}
          onClick={() => startCreate(null)}
        >
          Create
        </button>
        <button
          type="button"
          className={`auto-segment${mode === "manage" ? " is-active" : ""}`}
          aria-pressed={mode === "manage"}
          onClick={() => setMode("manage")}
        >
          Manage
          {payload && <em className="board-header__count">{payload.counts.total}</em>}
        </button>
      </div>
      {canManage && (
        <>
          <button
            type="button"
            ref={createRef}
            className="ba-btn ba-btn--primary auto-head__create"
            aria-haspopup="menu"
            aria-expanded={createOpen}
            onClick={() => setCreateOpen((current) => !current)}
          >
            <ActionIcon name="plus" size={16} />
            Create automation
            <ActionIcon name="chevron-down" size={14} />
          </button>
          <AnchoredPopover open={createOpen} anchorRef={createRef} onClose={() => setCreateOpen(false)} placement="bottom-end" layer="popover-raised" label="Create automation">
            <div className="ba-menu">
              <button type="button" role="menuitem" className="ba-menu__item" onClick={() => startCreate(null)}>
                <ActionIcon name="edit" size={16} />
                <span>Create from scratch</span>
              </button>
              {/* Offered only when the store actually has templates for this
                  board — Store Documentation has none, and says nothing. */}
              {templates.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className="ba-menu__item"
                  onClick={() => {
                    setCreateOpen(false);
                    setTemplatesOpen(true);
                    setMode("manage");
                  }}
                >
                  <ActionIcon name="grid" size={16} />
                  <span>Create from templates</span>
                  <small>{templates.length}</small>
                </button>
              )}
            </div>
          </AnchoredPopover>
        </>
      )}
      <button type="button" className="ba-iconbtn" aria-label="Close" onClick={onClose}>
        <ActionIcon name="close" size={18} />
      </button>
    </div>
  );

  return (
    <BoardModal open onClose={onClose} title="Automations" titleId={TITLE_ID} header={header} className="auto-modal">
      {error && (
        <p className="ba-error auto-modal__error" role="alert">
          {error}
          <button type="button" className="ba-btn ba-btn--quiet ba-btn--small" onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
      {notice && (
        <p className="auto-modal__notice" role="status">
          {notice}
        </p>
      )}

      {mode === "create" && catalog && (
        <div className="ba-modal__body">
          <AutomationBuilder
            boardId={boardId}
            catalog={catalog}
            vocabulary={payload?.vocabulary ?? null}
            template={template}
            onCancel={() => setMode("manage")}
            onCreated={(rule) => {
              setMode("manage");
              setTab("automations");
              void afterWrite(`Created: ${rule.name}`);
            }}
          />
        </div>
      )}
      {mode === "create" && !catalog && <p className="ba-hint auto-panel__loading">Loading the catalogue…</p>}

      {mode === "manage" && (
        <>
          <div className="auto-tabs" role="tablist" aria-label="Automation screens">
            {TABS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                id={`auto-tab-${entry.key}`}
                aria-selected={tab === entry.key}
                aria-controls={`auto-panel-${entry.key}`}
                className={`auto-tab${tab === entry.key ? " is-active" : ""}`}
                onClick={() => setTab(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="ba-modal__body" role="tabpanel" id={`auto-panel-${tab}`} aria-labelledby={`auto-tab-${tab}`}>
            {tab === "automations" && (
              <>
                {templatesOpen && templates.length > 0 && (
                  <section className="auto-templates" aria-label="Templates">
                    <div className="auto-templates__head">
                      <h3>Templates</h3>
                      <button type="button" className="ba-btn ba-btn--quiet ba-btn--small" onClick={() => setTemplatesOpen(false)}>
                        Hide
                      </button>
                    </div>
                    <ul>
                      {templates.map((entry) => (
                        <li key={entry.key}>
                          <strong>{entry.title}</strong>
                          <span>{entry.blurb}</span>
                          <button type="button" className="ba-btn ba-btn--small" onClick={() => startCreate(entry)}>
                            Use this template
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <div className="auto-toolbar">
                  <div className="ba-search auto-toolbar__search">
                    <ActionIcon name="search" size={16} />
                    <input
                      className="ba-input"
                      type="search"
                      placeholder="Search automations"
                      aria-label="Search automations"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  <label className="auto-toolbar__filter">
                    <span className="visually-hidden">Show</span>
                    <select className="ba-select" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
                      <option value="all">All</option>
                      <option value="enabled">Enabled</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </label>
                  <div className="auto-toolbar__layout" role="group" aria-label="Layout">
                    <button
                      type="button"
                      className={`ba-iconbtn${layout === "classic" ? " is-active" : ""}`}
                      aria-pressed={layout === "classic"}
                      aria-label="Classic layout"
                      title="Classic"
                      onClick={() => setLayout("classic")}
                    >
                      <ActionIcon name="grid" size={18} />
                    </button>
                    <button
                      type="button"
                      className={`ba-iconbtn${layout === "compact" ? " is-active" : ""}`}
                      aria-pressed={layout === "compact"}
                      aria-label="Compact layout"
                      title="Compact"
                      onClick={() => setLayout("compact")}
                    >
                      <ActionIcon name="list" size={18} />
                    </button>
                  </div>
                </div>

                {!payload && !error && <p className="ba-hint auto-panel__loading">Loading automations…</p>}
                {payload && !canManage && (
                  <p className="ba-hint auto-readonly">Only people who can edit the board can manage its automations. You can read them.</p>
                )}
                {payload && rules.length === 0 && (
                  <div className="auto-empty">
                    <ActionIcon name="bolt" size={28} />
                    <strong>No automations on this board</strong>
                    <p>{canManage ? "Create one from scratch, or start from a template." : "Nobody has created one yet."}</p>
                  </div>
                )}
                {payload && rules.length > 0 && visible.length === 0 && (
                  <p className="ba-hint">Nothing matches that search.</p>
                )}
                {payload && visible.length > 0 && (
                  <RulesList
                    rules={visible}
                    layout={layout}
                    canManage={canManage}
                    onToggle={(rule, enabled) =>
                      withError(async () => {
                        await patchRule(rule.id, { enabled });
                        await afterWrite(`${enabled ? "Enabled" : "Disabled"}: ${rule.name}`);
                      })
                    }
                    onDescription={(rule, description) =>
                      withError(async () => {
                        await patchRule(rule.id, { description: description || null });
                        await afterWrite("Description saved.");
                      })
                    }
                    onImportance={(rule, importance) =>
                      withError(async () => {
                        await patchRule(rule.id, { importance });
                        await afterWrite(`Importance set to ${importance}.`);
                      })
                    }
                    onDuplicate={(rule) =>
                      withError(async () => {
                        await createRule({
                          boardId,
                          triggerType: rule.triggerType,
                          triggerConfig: rule.triggerConfig,
                          actionType: rule.actionType,
                          actionConfig: rule.actionConfig,
                          description: rule.description ?? undefined,
                        });
                        await afterWrite(`Duplicated: ${rule.name}`);
                      })
                    }
                    onDelete={(rule) =>
                      withError(async () => {
                        await deleteRule(rule.id);
                        await afterWrite(`Deleted: ${rule.name}`);
                      })
                    }
                  />
                )}
                {catalog && (
                  <p className="ba-hint auto-timenote">
                    <ActionIcon name="clock" size={14} /> {catalog.timeBasedNote}
                  </p>
                )}
              </>
            )}
            {tab === "runs" && <RunHistory boardId={boardId} refreshToken={refreshToken} />}
            {tab === "connections" && <Connections />}
            {tab === "usage" && <Usage boardId={boardId} refreshToken={refreshToken} />}
          </div>
        </>
      )}
    </BoardModal>
  );
}

export function AutomationsModal({
  open,
  onClose,
  boardId,
  boardName,
}: {
  open: boolean;
  onClose: () => void;
  boardId: string;
  boardName: string;
}) {
  if (!open) return null;
  return <OpenAutomations onClose={onClose} boardId={boardId} boardName={boardName} />;
}
