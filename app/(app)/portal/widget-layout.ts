/**
 * THE ARRANGEMENT ITSELF — order, hidden-ness, and (decision O) each panel's
 * own configuration. No React here on purpose: these are the rules the editor,
 * the grid and the tests all need, and a `.tsx` module cannot be called
 * directly from a test.
 *
 * WHAT MAY BE CONFIGURED, and why it is only these two. A workspace may say
 * what it CALLS a panel and how WIDE it sits. Both are presentation. A stored
 * filter or period would make the arrangement a second source of truth for the
 * figures — the page's own pickers are that source — and would mean two readers
 * of one dashboard could see different numbers under the same heading.
 *
 * The server cleans the same two answers, in `app/api/dashboard-layout/route.ts`,
 * and the whole arrangement is what §38 versions and restores.
 */

export type WidgetConfig = {
  /** What this workspace calls the panel. Absent means the built-in name. */
  title?: string;
  /** "full" spans the row, "half" takes a cell. Absent means the panel's own default. */
  width?: "full" | "half";
};

export const WIDGET_TITLE_LIMIT = 60;

/** One panel's place in the arrangement. */
export type LayoutItem = { key: string; hidden: boolean; config?: WidgetConfig };

/** What a panel is, as far as an arrangement is concerned. */
export type WidgetIdentity = { key: string };

/** The stored shape, cleaned in the browser exactly as the route cleans it. */
export function cleanWidgetConfig(value: unknown): WidgetConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim().slice(0, WIDGET_TITLE_LIMIT) : "";
  const width: WidgetConfig["width"] =
    record.width === "full" || record.width === "half" ? record.width : undefined;
  if (!title && !width) return undefined;
  const config: WidgetConfig = {};
  if (title) config.title = title;
  if (width) config.width = width;
  return config;
}

/**
 * The order to draw in, given what is saved and what exists.
 *
 * Saved entries keep their order, their hidden flag and their configuration,
 * but only if the registry still has them — a panel removed from the product
 * must not leave a gap in everyone's dashboard. Anything the registry has and
 * the layout does not is appended, visible: that is what makes a NEW panel
 * arrive for somebody whose layout has never heard of it.
 */
export function mergeLayout(widgets: readonly WidgetIdentity[], saved: readonly LayoutItem[]): LayoutItem[] {
  const known = new Set(widgets.map((widget) => widget.key));
  const merged: LayoutItem[] = [];
  const placed = new Set<string>();

  for (const item of saved) {
    if (!known.has(item.key) || placed.has(item.key)) continue;
    const config = cleanWidgetConfig(item.config);
    merged.push({ key: item.key, hidden: item.hidden, ...(config ? { config } : {}) });
    placed.add(item.key);
  }
  for (const widget of widgets) {
    if (placed.has(widget.key)) continue;
    merged.push({ key: widget.key, hidden: false });
  }
  return merged;
}
