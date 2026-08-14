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

export type DashboardWidget = {
  key: string;
  /** What the edit list calls it. Should match the panel's own heading. */
  label: string;
  /** Rendered when visible. */
  render: () => React.ReactNode;
  /** Spans the full row — a six-month matrix needs more than a third. */
  wide?: boolean;
};

export type LayoutItem = { key: string; hidden: boolean };

/**
 * The order to draw in, given what is saved and what exists.
 *
 * Saved entries keep their order and their hidden flag, but only if the
 * registry still has them — a panel removed from the product must not leave a
 * gap in everyone's dashboard. Anything the registry has and the layout does
 * not is appended, visible.
 */
export function mergeLayout(
  widgets: DashboardWidget[],
  saved: LayoutItem[],
): LayoutItem[] {
  const known = new Map(widgets.map((widget) => [widget.key, widget]));
  const merged: LayoutItem[] = [];
  const placed = new Set<string>();

  for (const item of saved) {
    if (!known.has(item.key) || placed.has(item.key)) continue;
    merged.push({ key: item.key, hidden: item.hidden });
    placed.add(item.key);
  }
  for (const widget of widgets) {
    if (placed.has(widget.key)) continue;
    merged.push({ key: widget.key, hidden: false });
  }
  return merged;
}

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
            Move a panel with the arrows, or use the checkbox to show and hide
            it. Changes save as you make them, and apply to your account only.
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
          </div>
        </div>
      )}

      <section className="insight-grid">
        {visible.map((item) => {
          const widget = byKey.get(item.key);
          if (!widget) return null;
          return widget.wide ? (
            <div className="insight-grid__wide" key={item.key}>
              {widget.render()}
            </div>
          ) : (
            <div className="insight-grid__cell" key={item.key}>
              {widget.render()}
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
