"use client";

/**
 * THE CONFIGURED COLOURS AND LABELS BEHIND THE FIVE OVERVIEW METERS.
 *
 * WHY THIS FETCHES RATHER THAN READING THE REGISTRY.
 *
 * `publishedBoardOptions()` in lib/board-option-registry.ts is the browser-side
 * cache the board fills when it loads, and it is the right source for anything
 * downstream of the board. The Overview is not downstream of anything: it is
 * usually the first page a session lands on, so on that path the registry is
 * empty and every meter would draw in the neutral fallback until the reader had
 * visited /dashboard/jobs and come back. Colours that appear only after you
 * have been somewhere else are worse than no colours.
 *
 * So this asks /api/options directly — the canonical `option_values` store, the
 * same one the board's own options mirror.
 *
 * WHY IT DOES NOT WRITE BACK INTO THAT REGISTRY.
 *
 * It was going to, on the reasoning that the Overview may as well warm the
 * cache for whoever renders next. `publishBoardOptions` REPLACES the array
 * wholesale, and this hook only cares about five of the fifteen option sets —
 * so warming the cache from here would have quietly evicted the ten sets the
 * board had already loaded, and broken the colour of every column that depends
 * on them. A read-only consumer stays a read-only consumer.
 *
 * WHY A MISSING ANSWER IS NOT AN ERROR HERE.
 *
 * A meter with no configured options is still a correct meter — it shows the
 * stored values in the neutral palette, which is honest. So a failed or slow
 * fetch degrades the colours and nothing else; it never blocks the figures, and
 * it never puts an error on a dashboard over data that loaded fine.
 */

import { useEffect, useState } from "react";
import {
  JOB_METER_COLUMNS,
  type JobMeterKey,
  type MeterOption,
} from "./views/overview-series";

type OptionsByKey = Partial<Record<JobMeterKey, MeterOption[]>>;

interface OptionValuePayload {
  value?: unknown;
  label?: unknown;
  colourHex?: unknown;
  textColour?: unknown;
  position?: unknown;
  active?: unknown;
}

interface OptionSetPayload {
  key?: unknown;
  values?: unknown;
}

/** The option-set key each meter colours from, as a lookup. */
const METER_KEY_BY_SET = new Map<string, JobMeterKey>(
  JOB_METER_COLUMNS.map((column) => [column.optionSetKey, column.key]),
);

function readOption(raw: OptionValuePayload): MeterOption | null {
  if (typeof raw.value !== "string" || !raw.value.trim()) return null;
  return {
    value: raw.value,
    // An option with no label of its own is displayed as its stored value,
    // which is what the board does with the same row.
    label: typeof raw.label === "string" && raw.label ? raw.label : raw.value,
    colourHex: typeof raw.colourHex === "string" ? raw.colourHex : "",
    textColour: typeof raw.textColour === "string" ? raw.textColour : "#ffffff",
    position: typeof raw.position === "number" ? raw.position : 0,
  };
}

export function useJobMeterOptions(): OptionsByKey {
  const [options, setOptions] = useState<OptionsByKey>({});

  useEffect(() => {
    // Abandoned rather than cancelled: a fetch that lands after the reader has
    // navigated away must not set state on an unmounted tree.
    let live = true;

    (async () => {
      try {
        const response = await fetch("/api/options", {
          headers: { accept: "application/json" },
        });
        if (!response.ok) return;
        const body = (await response.json()) as { sets?: OptionSetPayload[] };
        if (!live || !Array.isArray(body.sets)) return;

        const next: OptionsByKey = {};
        for (const set of body.sets) {
          if (typeof set.key !== "string" || !Array.isArray(set.values)) continue;
          const meterKey = METER_KEY_BY_SET.get(set.key);
          if (!meterKey) continue;

          for (const entry of set.values as OptionValuePayload[]) {
            /*
             * Retired options are skipped for COLOURING only. A job still
             * holding a retired value keeps its segment — `buildJobMeters`
             * simply finds no option for it and marks it unconfigured, which
             * is the truth: the value is real and the option is gone.
             */
            if (entry.active === false) continue;
            const option = readOption(entry);
            if (option) (next[meterKey] ??= []).push(option);
          }
        }

        setOptions(next);
      } catch {
        /* Colours degrade, figures do not. See the header. */
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  return options;
}
