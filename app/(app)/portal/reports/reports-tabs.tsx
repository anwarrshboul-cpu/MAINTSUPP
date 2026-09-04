"use client";

/**
 * Three tabs INSIDE /dashboard/reports, and nothing else moves.
 *
 * WHAT THIS IS NOT
 *
 * Not a route, not a sidebar entry, not a second Reports nav item, not a
 * parallel design system. The owner's brief was explicit that Spend and
 * reporting keeps its sidebar, its workspace selector, its header, Live
 * Workspace, Refresh, Manage data, the public request form, New request, its
 * permissions and its dark visual language — so the addition is a tablist under
 * the existing heading and three panels below it. `ReportsView` in
 * portal-app.tsx keeps every line it had; its existing body becomes the first
 * panel.
 *
 * WHY THE TAB LIVES IN THE URL HASH AND IN STORAGE
 *
 * A reader who is halfway through preparing an invoice and opens the Jobs board
 * to check a figure comes back to Spend Overview if the tab is `useState`,
 * because leaving the section unmounts it — the same failure the date range had
 * before `useStoredPeriod`, and the fix is the same mechanism, one key per
 * section. The hash is carried as well so a link to a specific tab can be
 * pasted to a colleague; the hash wins on first paint, because a link somebody
 * clicked is a stronger statement of intent than what they last looked at.
 *
 * EACH TAB OWNS ITS OWN PERIOD
 *
 * Deliberate, and it is why this file exports `reportTabPeriodKey` rather
 * than holding a period itself. Spend Overview opens on Last 12 months because
 * it answers "is this year worse than last"; the generator opens on this month
 * because an invoice is a month. Sharing one period would mean choosing which
 * of those two questions to get wrong. They are separate `useStoredPeriod`
 * keys, so neither can move the other.
 */

import { useCallback, useSyncExternalStore } from "react";
import { Icon, type IconName } from "../../../components";
import { periodStorageKey } from "../period-picker";

import "./reports.css";

export const REPORT_TABS = ["overview", "generator", "documents"] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

interface TabDefinition {
  id: ReportTab;
  label: string;
  icon: IconName;
  hint: string;
}

export const REPORT_TAB_DEFINITIONS: TabDefinition[] = [
  {
    id: "overview",
    label: "Spend Overview",
    icon: "chart",
    hint: "Maintenance spend across the portfolio. Service fees are not counted here.",
  },
  {
    id: "generator",
    label: "Invoice & Report Generator",
    icon: "document",
    hint: "Build the combined invoice and maintenance performance document for a client and a period.",
  },
  {
    id: "documents",
    label: "Generated Documents",
    icon: "folder",
    hint: "Every document raised for this workspace, and the files produced from it.",
  },
];

/**
 * The period-storage key for each tab.
 *
 * Spend Overview keeps the key `ReportsView` already used — the section id
 * itself — so an existing reader's remembered range survives this change
 * untouched. That is the whole reason this is a function rather than three
 * constants: the overview's key is not ours to rename.
 */
export function reportTabPeriodKey(sectionKey: string, tab: ReportTab): string {
  return tab === "overview" ? sectionKey : `${sectionKey}:${tab}`;
}

/** The default window each tab opens on. */
export const REPORT_TAB_DEFAULT_PERIOD: Record<ReportTab, string> = {
  overview: "12m",
  generator: "mtd",
  documents: "12m",
};

function isReportTab(value: unknown): value is ReportTab {
  return typeof value === "string" && (REPORT_TABS as readonly string[]).includes(value);
}

const TAB_NAMESPACE = "maintsupp:reports-tab:";

/**
 * The choice for this session when storage refuses it, and the subscription
 * that announces a change.
 *
 * Both lifted verbatim in shape from `useStoredPeriod` in period-picker.tsx,
 * for the reasons its header gives: `setItem` throws in a private window and
 * under blocked storage, and without an in-memory fallback the control appears
 * inert there — the click writes nowhere and the snapshot reads the default
 * straight back. `storage` fires only in OTHER tabs, so same-tab writes are
 * announced through the listener set.
 */
const tabMemory = new Map<string, ReportTab>();
const tabListeners = new Set<() => void>();

function subscribeToTab(onChange: () => void) {
  tabListeners.add(onChange);
  window.addEventListener("storage", onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    tabListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
    window.removeEventListener("hashchange", onChange);
  };
}

/**
 * Which tab is showing, remembered per section and linkable by hash.
 *
 * `useSyncExternalStore` rather than an effect that calls `setState`, which is
 * the pattern `useStoredPeriod`, the theme toggle and the sort control all use
 * here — and for the same two reasons its header gives: the server render and
 * the first client render agree, and there is no cascading re-render on mount.
 * An effect would also paint the default tab for one frame before correcting
 * itself, which on this screen is a visible flash of the wrong panel.
 *
 * The hash wins over storage. A link somebody clicked is a stronger statement
 * of intent than what they last looked at.
 */
export function useReportTab(sectionKey: string): [ReportTab, (next: ReportTab) => void] {
  const storageKey = `${TAB_NAMESPACE}${periodStorageKey(sectionKey)}`;

  const read = useCallback((): ReportTab => {
    const fromHash = window.location.hash.replace(/^#/, "");
    if (isReportTab(fromHash)) return fromHash;
    const remembered = tabMemory.get(storageKey);
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (isReportTab(saved)) return saved;
    } catch {
      // Storage blocked. The in-memory choice, or the default, still applies.
    }
    return remembered ?? "overview";
  }, [storageKey]);

  // The server has no hash and no storage, so it renders the default.
  const readOnServer = useCallback((): ReportTab => "overview", []);

  const tab = useSyncExternalStore(subscribeToTab, read, readOnServer);

  const choose = useCallback(
    (next: ReportTab) => {
      tabMemory.set(storageKey, next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Kept in memory above, so the control still works for this session.
      }
      try {
        // `replaceState`, not a hash assignment: assigning to `location.hash`
        // pushes a history entry, so Back would walk the reader through every
        // tab they had looked at instead of leaving the page. It also fires
        // `hashchange`, which would re-enter the subscription below.
        window.history.replaceState(null, "", `#${next}`);
      } catch {
        // Some embedded contexts refuse history writes. Nothing depends on it.
      }
      for (const listener of tabListeners) listener();
    },
    [storageKey],
  );

  return [tab, choose];
}

/**
 * The tablist.
 *
 * A real `role="tablist"` with arrow-key movement and `aria-controls`, because
 * three buttons that look like tabs and behave like unrelated buttons are worse
 * for a screen-reader user than three plain links. The panels are rendered by
 * the caller — `ReportsView` owns its own content — so this component draws the
 * control and announces the relationship, and nothing else.
 */
export function ReportTabNav({
  value,
  onChange,
  counts,
}: {
  value: ReportTab;
  onChange: (next: ReportTab) => void;
  /** Optional badge per tab — the number of saved documents, typically. */
  counts?: Partial<Record<ReportTab, number>>;
}) {
  const move = (direction: 1 | -1) => {
    const index = REPORT_TABS.indexOf(value);
    const next = REPORT_TABS[(index + direction + REPORT_TABS.length) % REPORT_TABS.length]!;
    onChange(next);
    // Focus follows selection, which is the expected behaviour for a tablist
    // whose panels are cheap to switch between.
    window.requestAnimationFrame(() => {
      document.getElementById(`reports-tab-${next}`)?.focus();
    });
  };

  return (
    <div className="reports-tabs" role="tablist" aria-label="Spend and reporting sections">
      {REPORT_TAB_DEFINITIONS.map((definition) => {
        const selected = definition.id === value;
        const count = counts?.[definition.id];
        return (
          <button
            key={definition.id}
            id={`reports-tab-${definition.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`reports-panel-${definition.id}`}
            tabIndex={selected ? 0 : -1}
            title={definition.hint}
            className={`reports-tabs__tab${selected ? " is-selected" : ""}`}
            onClick={() => onChange(definition.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                move(-1);
              }
            }}
          >
            <Icon name={definition.icon} size={16} />
            <span>{definition.label}</span>
            {typeof count === "number" && count > 0 && (
              <span className="reports-tabs__count">{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel wrapper, so every panel carries the same ARIA wiring. */
export function ReportTabPanel({
  tab,
  active,
  children,
}: {
  tab: ReportTab;
  active: boolean;
  children: React.ReactNode;
}) {
  if (!active) return null;
  return (
    <div
      id={`reports-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`reports-tab-${tab}`}
      tabIndex={0}
      className="reports-panel"
    >
      {children}
    </div>
  );
}
