"use client";

/**
 * THE REPORTS BLOCK'S OWN SHAPES — the dotted KPI sparkline and the top-sites
 * bar list.
 *
 * Everything else the Reports block draws — the spend trend, the repeat-rate
 * speedometer, both repeat-spend donuts and the recurrence rings — is the
 * Overview's own chart from `ov-dash-charts.tsx`, reused as it shipped. These
 * two are new SHAPES, not new mechanisms, so they are built from the pieces
 * that file exports for exactly this (`useOvSweep`, `useOvPin`,
 * `useOvHoverCapable`, `OvTip`, `OvTipAction`, `ovFraction`, `ovNiceCeiling`)
 * and they sweep, pin, dismiss and honour reduced motion identically to every
 * other chart on the three blocks.
 *
 * ── WHY THE SPEND SPARKLINE IS NOT THE OVERVIEW'S `Sparkline` ──────────────
 *
 * The brief specifies a different mark: "1.5px line in the KPI accent with
 * small dots at each point, no fill", and a tooltip per point with the exact
 * value, its share and its job count. The Overview's sparkline is a filled
 * wash with no points and no tooltip. Its scale is also min-to-max, which is
 * right for a count that hovers around 80 and wrong for money: a day with £0
 * of spend has to sit ON THE FLOOR, so this one scales 0-to-max.
 *
 * ── WHY IT IS NOT A ROW OF BUTTONS ────────────────────────────────────────
 *
 * The whole KPI card is a link — §6 sends it to the jobs behind the figure —
 * and interactive content inside an `<a>` is invalid HTML that screen readers
 * resolve unpredictably. So the per-point tooltip is driven by pointer position
 * over a non-interactive box: a mouse hovers it and a click falls through to
 * the card's link; a finger taps it to pin the point (that tap is consumed, so
 * it does not also navigate) and taps anywhere else on the card to open the
 * list. Every value is in the box's accessible name, so nothing is lost to a
 * keyboard or a screen reader.
 *
 * ── WHY THE BAR ROW IS A STRETCHED LINK ───────────────────────────────────
 *
 * Each top-sites row has two destinations — the site's page from its NAME, and
 * the jobs behind its spend from the BAR — and on a phone the row folds onto
 * two lines (name and value, then the bar under both), which is not a
 * rectangle any one element could cover. So the bar's link is an empty,
 * absolutely positioned anchor under the whole row, the name's link sits above
 * it, and the track and value are pictures with `pointer-events: none`.
 * Anything on the row that is not the name opens the jobs.
 */

import {
  useCallback,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  OvTip,
  OvTipAction,
  ovFraction,
  ovNiceCeiling,
  ovPercent,
  ovPoundsExact,
  ovPoundsShort,
  useOvHoverCapable,
  useOvPin,
  useOvSweep,
} from "./ov-dash-charts";

/* ── How the block writes money and counts ─────────────────────────────────── */

const RP_POUNDS_WHOLE = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Pence as the brief prints a figure — `£482,750`, no pence.
 *
 * The exact amount is never lost: every tooltip prints `ovPoundsExact`, to the
 * penny. A value that rounds to nothing is written as `£0` rather than `-£0`,
 * which is what `Intl` makes of a credit of a few pence.
 */
export function rpPounds(pence: number): string {
  const pounds = Number.isFinite(pence) ? Math.round(pence / 100) : 0;
  return RP_POUNDS_WHOLE.format(pounds === 0 ? 0 : pounds);
}

/** A whole count, en-GB grouped. Never `NaN`. */
export function rpCount(value: number): string {
  return (Number.isFinite(value) ? value : 0).toLocaleString("en-GB");
}

/** "1 job", "12 jobs". */
export function rpJobs(value: number): string {
  return `${rpCount(value)} ${value === 1 ? "job" : "jobs"}`;
}

/**
 * How many divisions an axis ending at `ceiling` gets.
 *
 * `ovNiceCeiling` ends every axis on 1, 2, 4, 5 or 10 of a power of ten. The
 * reference's site axis is £0 to £100k in FIVE steps of £20k; a £40k axis in
 * five steps would print £8k, £16k, £24k, so the 2 and 4 ceilings take four
 * steps instead (£10k, £20k, £30k). Every tick on every axis is then a number a
 * reader would have written down themselves.
 */
export function rpAxisDivisions(ceiling: number): number {
  if (!Number.isFinite(ceiling) || ceiling <= 0) return 1;
  const lead = Math.round(ceiling / 10 ** Math.floor(Math.log10(ceiling)));
  return lead === 2 || lead === 4 ? 4 : 5;
}

/* ── A media query, read as an external store ─────────────────────────────── */

/**
 * `true` while `query` matches. Read through `useSyncExternalStore` rather than
 * a `setState` in an effect, so there is no cascading render and no
 * `react-hooks/set-state-in-effect` exception; the server answers `false`.
 */
export function useRpMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

/** A plain left click, with no modifier — the only click a link intercepts. */
function isPlainClick(event: ReactMouseEvent): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

/* ── 1. The dotted KPI sparkline ──────────────────────────────────────────── */

export type RpSparkDatum = { key: string; label: string; pence: number; jobs: number };

/**
 * A KPI's spend across the range, one dot per day (or per week), 0-to-max.
 *
 * The line is drawn in a stretched `viewBox` with a non-scaling stroke, as the
 * Overview's trend is; the DOTS are HTML spans at percentage positions, for the
 * trend's reason — a circle in a stretched box is an ellipse. Their size comes
 * from the box's own width over the point count (`--rp-spark-n`, container
 * units), so forty-five daily points on a phone card are 2px pips that do not
 * merge into a second line, and thirteen weekly points on a desktop card are
 * the full 3.5px.
 */
export function RpSparkline({
  points,
  colour,
  totalPence,
  ariaLabel,
}: {
  points: readonly RpSparkDatum[];
  colour: string;
  /** The KPI's own figure — each tooltip's "% of the total". */
  totalPence: number;
  ariaLabel: string;
}): JSX.Element {
  const hoverCapable = useOvHoverCapable();
  const { rootRef, pinned, setHovered, togglePin, active } = useOvPin<number>();

  const values = points.map((point) => Math.max(0, Number.isFinite(point.pence) ? point.pence : 0));
  const high = values.length > 0 ? Math.max(...values) : 0;
  const eased = useOvSweep(values.map((value) => ovFraction(value, high)));

  /* Headroom top and bottom, so a dot on the floor or the peak is not shaved. */
  const xAt = (index: number) => (values.length > 1 ? (index / (values.length - 1)) * 100 : 50);
  const yAt = (fraction: number) => 84 - Math.max(0, Math.min(1, fraction)) * 68;
  const line = eased.map((fraction, index) => `${xAt(index)},${yAt(fraction)}`).join(" ");

  /** The point nearest the pointer — the band around each point, as the trend's hit columns are. */
  const indexAt = (clientX: number, element: HTMLElement): number | null => {
    const rect = element.getBoundingClientRect();
    if (values.length === 0 || rect.width <= 0) return null;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return values.length > 1 ? Math.round(ratio * (values.length - 1)) : 0;
  };

  const activeIndex = typeof active === "number" && active >= 0 && active < points.length ? active : -1;
  const at = activeIndex >= 0 ? xAt(activeIndex) : 50;

  return (
    <div
      className="rp-spark"
      ref={rootRef}
      role="img"
      aria-label={ariaLabel}
      /*
        `--rp-tip-shift` anchors the tooltip by the same fraction of its OWN
        width as its anchor is across the box, so the first day's tooltip grows
        rightwards and the last day's leftwards. `OvTip` centres by default, and
        on a 150px phone card a centred 128px tooltip at the last point hangs off
        the screen — this keeps it inside the card at every point.
      */
      style={
        {
          "--rp-spark-n": Math.max(1, values.length),
          "--rp-tip-shift": `-${Math.min(88, Math.max(12, at))}%`,
        } as CSSProperties
      }
      onPointerMove={(event) => {
        if (hoverCapable) setHovered(indexAt(event.clientX, event.currentTarget));
      }}
      onPointerLeave={() => setHovered(null)}
      onClick={(event) => {
        /* A mouse click is the card's: it opens the jobs behind the figure. */
        if (hoverCapable) return;
        /* A tap pins the point instead, and is consumed so it does not also
           navigate. The rest of the card is still the link. */
        event.preventDefault();
        event.stopPropagation();
        const index = indexAt(event.clientX, event.currentTarget);
        if (index !== null) togglePin(index);
      }}
    >
      <svg
        className="rp-spark__svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {eased.length > 1 ? (
          <polyline
            points={line}
            fill="none"
            stroke={colour}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {eased.map((fraction, index) => (
        <span
          key={points[index].key}
          className={`rp-spark__dot${activeIndex === index ? " rp-spark__dot--active" : ""}`}
          style={{ left: `${xAt(index)}%`, top: `${yAt(fraction)}%`, background: colour }}
          aria-hidden="true"
        />
      ))}
      {activeIndex >= 0 ? (
        <OvTip
          at={at}
          pinned={pinned === activeIndex}
          title={points[activeIndex].label}
          /* Two lines, not three: the tooltip sits above the sparkline inside a
             ~130px card, and a third line pushed it over the card's own figure. */
          lines={[
            `${ovPoundsExact(values[activeIndex])} · ${rpJobs(points[activeIndex].jobs)}`,
            `${ovPercent(values[activeIndex], totalPence)}% of the total`,
          ]}
        />
      ) : null}
    </div>
  );
}

/* ── 2. The top-sites bar list ────────────────────────────────────────────── */

export type RpBarDatum = {
  key: string;
  name: string;
  pence: number;
  jobs: number;
  /** The site's own page. */
  siteHref: string;
  /** The jobs behind the bar. */
  drillHref: string;
};

/**
 * Up to eight sites, a 6px bar each, on an axis the ticks under it describe.
 *
 * THE SCALE IS THE AXIS, NOT THE LEADER. The bars are drawn against
 * `ovNiceCeiling` of the largest row and the £ ticks beneath sit exactly under
 * the track, so a bar that ends over "£40k" IS £40k. (The reference fills the
 * leader's track to the end while printing £100k past it — a picture of a scale
 * that the bars do not follow. This keeps the picture and makes the scale true.)
 *
 * The percentage in each tooltip is of `totalPence` — the card's whole range,
 * every site plus "No site" — not of the eight on screen, so a reader is never
 * told a site is 40% of spend when it is 40% of the top eight.
 */
export function RpSiteBars({
  rows,
  totalPence,
  totalLabel,
  ariaLabel,
  emptyText,
  onSite,
  onDrill,
}: {
  rows: readonly RpBarDatum[];
  totalPence: number;
  /** What `totalPence` is the total OF — "the £4,210 spent in 1 – 30 Sept 2026". */
  totalLabel: string;
  ariaLabel: string;
  emptyText: string;
  onSite: (key: string) => void;
  onDrill: (key: string) => void;
}): JSX.Element {
  const hoverCapable = useOvHoverCapable();
  const { rootRef, pinned, setHovered, togglePin, active } = useOvPin<string>();

  const values = rows.map((row) => Math.max(0, Number.isFinite(row.pence) ? row.pence : 0));
  const ceiling = ovNiceCeiling(values.length > 0 ? Math.max(...values) : 0);
  const eased = useOvSweep(values.map((value) => ovFraction(value, ceiling)));
  const divisions = rpAxisDivisions(ceiling);
  const ticks = ceiling > 0 ? Array.from({ length: divisions + 1 }, (_, step) => step / divisions) : [0];
  const readout = rows.map((row, index) => `${row.name} ${rpPounds(values[index])}`).join(", ");

  if (rows.length === 0) {
    return (
      <div className="rp-bars rp-bars--empty" role="img" aria-label={`${ariaLabel}: ${emptyText}`}>
        <p className="rp-bars__empty" aria-hidden="true">
          {emptyText}
        </p>
      </div>
    );
  }

  return (
    <div className="rp-bars" ref={rootRef} role="group" aria-label={`${ariaLabel}: ${readout}`}>
      {rows.map((row, index) => {
        const isActive = active === row.key;
        const isPinned = pinned === row.key;
        const share = ovPercent(values[index], totalPence);
        return (
          <div key={row.key} className={`rp-bars__row${isActive ? " rp-bars__row--active" : ""}`}>
            <a
              className="rp-bars__name"
              href={row.siteHref}
              title={row.name}
              aria-label={`${row.name}, site page`}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                onSite(row.key);
              }}
            >
              {row.name}
            </a>
            <a
              className="rp-bars__hit"
              href={row.drillHref}
              aria-label={`${row.name}: ${ovPoundsExact(values[index])}, ${share}% of ${totalLabel}, ${rpJobs(row.jobs)}. Opens those jobs.`}
              onPointerEnter={() => {
                if (hoverCapable) setHovered(row.key);
              }}
              onPointerLeave={() => setHovered(null)}
              onFocus={() => setHovered(row.key)}
              onBlur={() => setHovered(null)}
              onClick={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                /* The trend's rule: a mouse opens the list; a finger pins the
                   figures first, with the list one more tap away. */
                if (hoverCapable) onDrill(row.key);
                else togglePin(row.key);
              }}
            />
            <span className="rp-bars__track" aria-hidden="true">
              <span className="rp-bars__bar" style={{ width: `${(eased[index] ?? 0) * 100}%` }} />
            </span>
            <span className="rp-bars__value" aria-hidden="true">
              {rpPounds(values[index])}
            </span>
            {isActive ? (
              <OvTip
                at={75}
                pinned={isPinned}
                title={row.name}
                lines={[
                  `${ovPoundsExact(values[index])} · ${rpJobs(row.jobs)}`,
                  `${share}% of ${rpPounds(totalPence)}`,
                ]}
                action={isPinned ? <OvTipAction onClick={() => onDrill(row.key)} /> : null}
              />
            ) : null}
          </div>
        );
      })}
      <div className="rp-bars__axis" aria-hidden="true">
        <span className="rp-bars__axis-track">
          {ticks.map((tick) => (
            <span className="rp-bars__tick" key={tick} style={{ left: `${tick * 100}%` }}>
              {ovPoundsShort(ceiling * tick)}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
