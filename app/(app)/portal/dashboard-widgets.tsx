"use client";

/**
 * The dashboard's arrangeable panels.
 *
 * The eight insight panels were rendered inline, in a fixed order, in
 * portal-app.tsx. That is fine until two people want different things at the
 * top — a coordinator wants ageing and attention, a finance lead wants spend —
 * and neither can have it without the other losing out.
 *
 * This renders the same panels from a registry, in the order the person has
 * saved, with the ones they have hidden left out. Nothing about what a panel
 * COMPUTES changes; only which panels appear and in what order.
 *
 * WHY BUTTONS AND NOT DRAG-AND-DROP
 *
 * Move up / move down, not a drag surface. Three reasons, in order of weight:
 * a drag needs a pointer, and this product is used on a phone in a shop; a
 * drag is invisible to a keyboard and to a screen reader without a parallel
 * implementation that ends up being these buttons anyway; and the whole
 * feature is then a few hundred lines lighter, which matters when the eight
 * panels underneath it are the part that has to be right. monday offers drag;
 * this offers the same outcome by a route that works everywhere.
 *
 * THE STORED LAYOUT IS AN ARRANGEMENT, NEVER AN INVENTORY
 *
 * `mergeLayout` below is the whole point. A saved layout records order and
 * hidden-ness for the panels it knows about. Existence comes from the registry.
 * A panel added in a later release is appended and visible for someone whose
 * saved layout has never heard of it — the alternative, treating the stored
 * list as the complete set, means every new panel is invisible to every
 * existing user and nobody ever finds out.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components";
import { VersionHistory } from "./views/version-history";
import { useUnsavedChanges } from "../../lib/use-unsaved-changes";
import { WidgetConfigProvider } from "./widget-config";
import {
  WIDGET_TITLE_LIMIT,
  cleanWidgetConfig,
  mergeLayout,
  type LayoutItem,
  type WidgetConfig,
} from "./widget-layout";

/* The arrangement's rules live in a module with no React in it, so the tests
   can call them; re-exported here because this is where callers look for them. */
export { mergeLayout, type LayoutItem, type WidgetConfig };

export type DashboardWidget = {
  key: string;
  /** What the edit list calls it. Should match the panel's own heading. */
  label: string;
  /** Rendered when visible. */
  render: () => React.ReactNode;
  /** Spans the full row — a six-month matrix needs more than a third. */
  wide?: boolean;
};



export function DashboardWidgets({
  surface,
  widgets,
  canSetWorkspaceDefault = false,
  onNotify,
  barSlot,
}: {
  surface: "overview" | "reports";
  widgets: DashboardWidget[];
  /** Whether to offer "save for everyone". The server checks this too. */
  canSetWorkspaceDefault?: boolean;
  onNotify?: (message: string) => void;
  /**
   * Where to draw the "Edit layout" bar, if not here.
   *
   * The owner asked for Reports' control to sit in the page header beside the
   * portfolio and period pickers rather than float under the Spend trend
   * chart. Moving the whole component up there would move the panels with it;
   * moving only the STATE up would give the arrangement two owners. So the bar
   * is portalled into a node `AnalyticsToolbar` renders, and everything about
   * which panels exist, their order and their saving stays exactly here.
   *
   * Three states, and the difference between the last two matters:
   *   undefined — no slot was asked for. Draw the bar in place. This is
   *               Overview and every other surface, unchanged.
   *   null      — a slot was asked for and has not mounted yet. Draw nothing,
   *               rather than drawing the bar in place for one commit and
   *               yanking it into the header on the next.
   *   element   — portal into it.
   */
  barSlot?: HTMLElement | null;
}) {
  const usesSlot = barSlot !== undefined;
  const [layout, setLayout] = useState<LayoutItem[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  /* §69 — this editor saves as you go, so the only thing to lose is a save still
     in flight; leaving while one is asks first. */
  useUnsavedChanges(saving);

  useEffect(() => {
    let active = true;
    fetch(`/api/dashboard-layout?surface=${surface}`, {
      headers: { Accept: "application/json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { items?: LayoutItem[]; workspaceDefault?: LayoutItem[] } | null) => {
        if (!active) return;
        // Mine, then the workspace default, then the built-in order — the same
        // three layers the sidebar uses.
        const saved = payload?.items?.length
          ? payload.items
          : payload?.workspaceDefault ?? [];
        setLayout(mergeLayout(widgets, saved));
      })
      .catch(() => {
        // A layout that will not load must not take the dashboard with it.
        if (active) setLayout(mergeLayout(widgets, []));
      });
    return () => {
      active = false;
    };
    // `widgets` is rebuilt every render by the caller; keying the effect on it
    // would refetch forever. The surface is what identifies this layout.
  }, [surface]); // eslint-disable-line react-hooks/exhaustive-deps

  const byKey = useMemo(
    () => new Map(widgets.map((widget) => [widget.key, widget])),
    [widgets],
  );

  const persist = useCallback(
    async (next: LayoutItem[], scope: "user" | "workspace") => {
      setSaving(true);
      try {
        const response = await fetch("/api/dashboard-layout", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ surface, items: next, scope }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "That layout could not be saved.");
        }
        onNotify?.(
          scope === "workspace"
            ? "Saved as the workspace default."
            : "Dashboard layout saved.",
        );
      } catch (error) {
        onNotify?.(error instanceof Error ? error.message : "That layout could not be saved.");
      } finally {
        setSaving(false);
      }
    },
    [onNotify, surface],
  );

  const move = (index: number, direction: -1 | 1) => {
    setLayout((current) => {
      if (!current) return current;
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      void persist(next, "user");
      return next;
    });
  };

  /* Decision O — one panel's own configuration, saved the moment it changes,
     to the person's own layout exactly as a move or a hide is. */
  const configure = (index: number, change: WidgetConfig) => {
    setLayout((current) => {
      if (!current) return current;
      const next = current.map((item, position) => {
        if (position !== index) return item;
        const config = cleanWidgetConfig({ ...item.config, ...change });
        const updated: LayoutItem = { key: item.key, hidden: item.hidden };
        if (config) updated.config = config;
        return updated;
      });
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      void persist(next, "user");
      return next;
    });
  };

  const toggle = (index: number) => {
    setLayout((current) => {
      if (!current) return current;
      const next = current.map((item, position) =>
        position === index ? { ...item, hidden: !item.hidden } : item,
      );
      void persist(next, "user");
      return next;
    });
  };

  /* §77 item 17 — the workspace default can be taken away, not only replaced. It
     stays in the history below, so the version before the removal restores it. */
  const removeDefault = async () => {
    if (
      !window.confirm(
        "Remove the workspace default layout? Everyone without their own arrangement goes back to the built-in order. It stays in the history and can be restored.",
      )
    ) {
      return;
    }
    const response = await fetch(`/api/dashboard-layout?surface=${surface}&scope=workspace`, { method: "DELETE" }).catch(
      () => null,
    );
    const body = response ? ((await response.json().catch(() => ({}))) as { error?: string }) : {};
    onNotify?.(
      response?.ok
        ? "The workspace default was removed; the built-in order applies to anyone without their own layout."
        : body.error ?? "The workspace default could not be removed.",
    );
  };

  const reset = async () => {
    await fetch(`/api/dashboard-layout?surface=${surface}`, { method: "DELETE" }).catch(
      () => undefined,
    );
    setLayout(mergeLayout(widgets, []));
    onNotify?.("Dashboard reset to the default arrangement.");
  };

  // Until the saved layout arrives, draw the built-in order rather than nothing.
  // A dashboard that flashes empty on every load is worse than one that
  // occasionally reorders itself a moment after painting.
  const effective = layout ?? mergeLayout(widgets, []);
  const visible = effective.filter((item) => !item.hidden);
  const hiddenCount = effective.length - visible.length;

  const bar = (
    <div className={`widget-bar${usesSlot ? " widget-bar--in-toolbar" : ""}`}>
      <button
        className="secondary-button"
        type="button"
        onClick={() => setEditing((current) => !current)}
        aria-expanded={editing}
      >
        <Icon name={editing ? "check" : "settings"} size={16} />
        {editing ? "Done" : "Edit layout"}
      </button>
      {hiddenCount > 0 && !editing && (
        <span className="widget-bar__note">
          {hiddenCount} panel{hiddenCount === 1 ? "" : "s"} hidden
        </span>
      )}
      {saving && <span className="widget-bar__note">Saving…</span>}
    </div>
  );

  return (
    <>
      {usesSlot ? barSlot && createPortal(bar, barSlot) : bar}

      {editing && (
        <div className="widget-editor panel">
          <p className="widget-editor__hint">
            Tick a panel to add it to your dashboard and untick it to remove it;
            move it with the arrows; rename it, or set how wide it sits. Changes
            save as you make them and apply to your account only — use
            <strong> Save as the workspace default</strong> to give everybody the
            same arrangement.
          </p>
          <ul className="widget-editor__list">
            {effective.map((item, index) => {
              const widget = byKey.get(item.key);
              if (!widget) return null;
              return (
                <li key={item.key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!item.hidden}
                      onChange={() => toggle(index)}
                    />
                    <span>{widget.label}</span>
                  </label>
                  <span className="widget-editor__config">
                    {/* The built-in name stays in the row above, so a renamed
                        panel never leaves a reader guessing what it measures. */}
                    <input
                      type="text"
                      defaultValue={item.config?.title ?? ""}
                      maxLength={WIDGET_TITLE_LIMIT}
                      placeholder={widget.label}
                      aria-label={`Name for ${widget.label}`}
                      onBlur={(event) => configure(index, { title: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                    <select
                      value={item.config?.width ?? "default"}
                      aria-label={`Width of ${widget.label}`}
                      onChange={(event) =>
                        configure(index, {
                          width:
                            event.target.value === "full" || event.target.value === "half"
                              ? event.target.value
                              : undefined,
                        })
                      }
                    >
                      <option value="default">Default width</option>
                      <option value="half">Half width</option>
                      <option value="full">Full width</option>
                    </select>
                  </span>
                  <span className="widget-editor__moves">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${widget.label} up`}
                    >
                      <Icon name="chevron" size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === effective.length - 1}
                      aria-label={`Move ${widget.label} down`}
                    >
                      <Icon name="chevron" size={15} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="widget-editor__actions">
            <button className="secondary-button" type="button" onClick={reset}>
              Reset to default
            </button>
            {canSetWorkspaceDefault && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => persist(effective, "workspace")}
              >
                Save as the workspace default
              </button>
            )}
            {canSetWorkspaceDefault && (
              <button className="secondary-button" type="button" onClick={() => void removeDefault()}>
                Remove the workspace default
              </button>
            )}
          </div>
          {/* §38 — the workspace default's versions. A person's own layout, if
              they have one, still takes priority over whichever is restored. */}
          {canSetWorkspaceDefault && (
            <VersionHistory
              subject="dashboard"
              subjectKey={surface}
              title={`Workspace default ${surface} history`}
              onRestored={() => window.location.reload()}
            />
          )}
        </div>
      )}

      <section className="insight-grid">
        {visible.map((item) => {
          const widget = byKey.get(item.key);
          if (!widget) return null;
          /* The configured width wins over the panel's own default; with none
             set, the panel decides, exactly as it did before. */
          const wide = item.config?.width ? item.config.width === "full" : Boolean(widget.wide);
          return (
            <div className={wide ? "insight-grid__wide" : "insight-grid__cell"} key={item.key}>
              <WidgetConfigProvider config={item.config ?? null}>{widget.render()}</WidgetConfigProvider>
            </div>
          );
        })}
        {!visible.length && (
          <p className="widget-empty">
            Every panel is hidden. Use <strong>Edit layout</strong> to bring some
            back.
          </p>
        )}
      </section>
    </>
  );
}
