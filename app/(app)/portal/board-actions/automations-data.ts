"use client";

/**
 * The Automations screens' view of the API, and the one browser preference
 * they keep.
 */

import { useState } from "react";
import type { AutomationCatalog, CatalogAction, CatalogTrigger } from "../../../lib/automations/catalog";
import type { SentenceResolver } from "../../../lib/automations/sentence";

export type AutomationRuleView = {
  id: string;
  boardId: string;
  name: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  actionType: string;
  actionConfig: Record<string, unknown>;
  enabled: boolean;
  importance: string;
  description: string | null;
  createdBy: string | null;
  runCount: number;
  lastRunAt: string | null;
  lastSweepAt: string | null;
  createdAt: string;
  updatedAt: string;
  timeBased: boolean;
};

export type VocabularyColumn = {
  handle: string;
  id: string;
  key: string;
  title: string;
  type: string;
  system: boolean;
  settings: {
    choices?: Array<{ id: string; label: string; color?: string }>;
    people?: Array<{ id: string; label: string; color?: string }>;
  };
};

export type VocabularyGroup = { id: string; name: string; color: string; stageKey: string | null };

export type Vocabulary = {
  columns: VocabularyColumn[];
  groups: VocabularyGroup[];
  systemFields: string[];
};

export type AutomationTemplate = {
  key: string;
  title: string;
  blurb: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  actionType: string;
  actionConfig: Record<string, unknown>;
};

export type AutomationsPayload = {
  boardId: string;
  rules: AutomationRuleView[];
  counts: { total: number; enabled: number };
  canManage: boolean;
  vocabulary: Vocabulary;
  templates: AutomationTemplate[];
  sweep: { swept: boolean; reason?: string; evaluated: number; fired: number } | null;
};

export type RunView = {
  id: string;
  automationId: string;
  automationName: string | null;
  requestId: string | null;
  status: "success" | "failed" | "skipped";
  trigger: string | null;
  action: string | null;
  error: string | null;
  depth: number;
  chainId: string | null;
  actorEmail: string | null;
  createdAt: string;
};

export type UsageView = {
  rules: number;
  enabled: number;
  totalRuns: number;
  month: { since: string; runs: number; failed: number; skipped: number };
  lastRun: { at: string; status: string } | null;
  quota: null;
  note: string;
};

export type ConnectionView = {
  key: string;
  label: string;
  provider: string | null;
  connected: boolean;
  detail: string;
};

/** Status chips for the board's option-backed columns, from the registry. */
export type OptionValues = Record<string, Array<{ value: string; label: string; colourHex?: string }>>;

const OPTION_SET_BY_COLUMN: Record<string, string> = {
  status: "maintenance_status",
  label: "maintenance_label",
  engineer: "engineer_required",
  priority: "priority",
  storeLocation: "store_location",
};

async function json<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "That did not work.");
  return payload;
}

export async function loadAutomations(boardId: string): Promise<AutomationsPayload> {
  return json(await fetch(`/api/automations?boardId=${encodeURIComponent(boardId)}`));
}

export async function loadCatalog(): Promise<AutomationCatalog> {
  return json(await fetch("/api/automations/catalog"));
}

export async function loadRuns(boardId: string, automationId?: string): Promise<{ runs: RunView[] }> {
  const query = new URLSearchParams({ boardId });
  if (automationId) query.set("automationId", automationId);
  return json(await fetch(`/api/automations/runs?${query}`));
}

export async function loadUsage(boardId: string): Promise<UsageView> {
  return json(await fetch(`/api/automations/usage?boardId=${encodeURIComponent(boardId)}`));
}

export async function loadConnections(): Promise<{ connections: ConnectionView[]; note: string }> {
  return json(await fetch("/api/automations/connections"));
}

/**
 * The registry's option values, by board column key.
 *
 * `option_values` is the canonical store — the board chips mirror it — and a
 * rule keys on the VALUE, never the label, which is why the picker shows the
 * label and stores the value.
 */
export async function loadOptionValues(): Promise<OptionValues> {
  const payload = await json<{
    sets: Array<{ key: string; values: Array<{ value: string; label: string; colourHex?: string; active?: boolean }> }>;
  }>(await fetch("/api/options"));
  const out: OptionValues = {};
  for (const [column, setKey] of Object.entries(OPTION_SET_BY_COLUMN)) {
    const set = payload.sets.find((entry) => entry.key === setKey);
    out[column] = (set?.values ?? [])
      .filter((value) => value.active !== false)
      .map((value) => ({ value: value.value, label: value.label, colourHex: value.colourHex }));
  }
  return out;
}

export async function loadMembers(): Promise<Array<{ name: string; email: string }>> {
  const payload = await json<{ members: Array<{ name: string; email: string }> }>(
    await fetch("/api/board/members"),
  );
  return payload.members;
}

export async function createRule(input: {
  boardId: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  actionType: string;
  actionConfig: Record<string, unknown>;
  description?: string;
}): Promise<{ rule: AutomationRuleView }> {
  return json(
    await fetch("/api/automations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function patchRule(
  id: string,
  changes: Record<string, unknown>,
): Promise<{ rule: AutomationRuleView }> {
  return json(
    await fetch("/api/automations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...changes }),
    }),
  );
}

export async function deleteRule(id: string): Promise<{ ok: true }> {
  return json(await fetch(`/api/automations?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/** Tells the header its count may have moved. */
export function announceAutomationsChanged() {
  window.dispatchEvent(new Event("maintsupp:automations-changed"));
}

/** A preference kept in this browser, read once and written on change. */
export function useLocalPreference<T extends string>(key: string, fallback: T): [T, (next: T) => void] {
  // Read once, lazily. Every caller is a surface opened by a click in a
  // browser, so there is no server render to disagree with.
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    try {
      return (window.localStorage.getItem(key) as T | null) || fallback;
    } catch {
      return fallback; // Storage unavailable; the default stands.
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Storage unavailable; the choice lasts for this page.
    }
  };
  return [value, update];
}

/** Resolves ids to names for the sentence, from what the builder has loaded. */
export function clientResolver(vocabulary: Vocabulary | null, options: OptionValues, people: string[]): SentenceResolver {
  const columns = vocabulary?.columns ?? [];
  const groups = vocabulary?.groups ?? [];
  const find = (handle: string) =>
    columns.find((column) => column.handle === handle || column.id === handle || (column.system && column.key === handle));
  return {
    column: (key) => find(key)?.title ?? key,
    group: (id) => groups.find((group) => group.id === id)?.name ?? "a group",
    option: (column, value) => {
      const found = find(column);
      const registry = found?.system ? options[found.key] : undefined;
      const fromRegistry = registry?.find((entry) => entry.value === value);
      if (fromRegistry) return fromRegistry.label;
      const choice = [...(found?.settings.choices ?? []), ...(found?.settings.people ?? [])].find(
        (entry) => entry.id === value || entry.label === value,
      );
      return choice?.label ?? value;
    },
    person: (id) => people.find((name) => name === id) ?? id,
  };
}

export type CatalogPick = CatalogTrigger | CatalogAction;
