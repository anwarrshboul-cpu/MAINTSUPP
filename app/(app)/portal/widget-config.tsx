"use client";

/**
 * A DASHBOARD PANEL'S OWN NAME, where the panel draws its heading — decision O.
 *
 * WHY A CONTEXT RATHER THAN A PROP ON EVERY PANEL. Eight panels each print
 * their own heading twice — once for the chart and once for the empty state —
 * so threading a title through would be sixteen edits, and a ninth panel would
 * quietly miss it. Every panel already draws its heading through one component,
 * `InsightPanel`, so the override is read there: one place, and any panel added
 * later inherits it without knowing this feature exists.
 *
 * The title is presentation only. It never changes what a panel counts, and the
 * editor shows the built-in name beside it so nobody is left wondering what a
 * renamed panel is measuring. The rules for what may be stored live in
 * `widget-layout.ts`, which has no React in it so the tests can call them.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { WidgetConfig } from "./widget-layout";

const WidgetConfigContext = createContext<WidgetConfig | null>(null);

export function WidgetConfigProvider({ config, children }: { config: WidgetConfig | null; children: ReactNode }) {
  return <WidgetConfigContext.Provider value={config}>{children}</WidgetConfigContext.Provider>;
}

/** The workspace's name for the panel being drawn, or null outside a dashboard. */
export function useWidgetTitle(): string | null {
  const config = useContext(WidgetConfigContext);
  const title = config?.title?.trim();
  return title ? title : null;
}
