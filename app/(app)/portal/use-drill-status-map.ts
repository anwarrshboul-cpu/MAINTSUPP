"use client";

/**
 * THE ORGANISATION'S CLOSED STATUSES, FOR THE JOBS DRILL.
 *
 * `job_status_map.counts_as_open` decides what the Overview counts as open, so
 * the list a figure opens has to be filtered by the same rule or the two
 * disagree — a tile reading 68 over a board showing 88. `readDrillFilter` runs
 * in `portal-app.tsx`, where the map was not available: the only component that
 * ever fetched it is the Operations calendar surface, which is not mounted when
 * a drill lands on the Jobs board, and its index is local state that never
 * leaves it.
 *
 * Fetched the way `useJobTypes` is fetched, and gated the same way — only when
 * a drill could actually be in play, so the shell does not add a request to
 * every page load for a list most navigations never consult.
 *
 * `loaded` is separate from the keys on purpose. An empty array means "this
 * organisation closes nothing", which would open completed jobs into an
 * `family=open` list; the caller must pass `undefined` until `loaded` is true,
 * exactly as it already does for `jobTypes`. See `closedKeysOf` in
 * `board-drill-filter.ts`, which falls back to the shipped vocabulary.
 */

import { useEffect, useState } from "react";
import { closedStatusKeys, type StatusOpenness } from "../../lib/job-metrics";

type StatusMapResponse = { mappings?: StatusOpenness[] };

export function useDrillStatusMap(enabled: boolean): {
  closedStatusKeys: string[];
  loaded: boolean;
} {
  const [state, setState] = useState<{ keys: string[]; loaded: boolean }>({
    keys: [],
    loaded: false,
  });

  useEffect(() => {
    if (!enabled || state.loaded) return;
    let cancelled = false;
    fetch("/api/calendar/status-map", { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: StatusMapResponse | null) => {
        if (cancelled || !body?.mappings) return;
        setState({ keys: closedStatusKeys(body.mappings), loaded: true });
      })
      /* A failed read leaves `loaded` false, so the drill keeps the shipped
         vocabulary rather than concluding this organisation closes nothing. */
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, state.loaded]);

  return { closedStatusKeys: state.keys, loaded: state.loaded };
}
