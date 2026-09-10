"use client";

/**
 * THE OVERVIEW'S FIVE CHART SHAPES — hand-rolled, no library, no canvas.
 *
 * This product has five runtime dependencies and none of them draws a chart.
 * That is deliberate and it is not a limitation here: everything the master
 * prompt asks for is a proportional box, a ring, or a polyline, and each of
 * those is a `div` with a width or one `<path>` with a `d`. A charting library
 * would add a bundle, a second theming system and a second accessibility story
 * to draw shapes CSS already draws.
 *
 * ── WHY THE PINNING IS NOT A HOVER TITLE ──────────────────────────────────
 *
 * §1.8: "Tap to pin a tooltip, tap elsewhere to dismiss; drag to scrub across a
 * time series." A `title` attribute satisfies none of that — it needs a hover,
 * it cannot be dismissed, it cannot be reached from a keyboard and it never
 * appears on a phone. So every chart here owns a real tooltip element driven by
 * `useTapToPin`, and every chart's segments are real `<button>`s so the same
 * tooltip appears on focus.
 *
 * The drill-down and the tooltip are the same gesture on touch and different
 * gestures on a mouse, which is the only mapping that keeps §1.8's promise that
 * no capability is desktop-only:
 *
 *   · pointer: fine, hover: hover  — hovering shows the tooltip, clicking
 *     drills. Exactly what a desktop reader expects.
 *   · anything else (touch)        — the first tap PINS the tooltip, and the
 *     pinned tooltip carries the drill button. Two taps, but the capability is
 *     there, which is the requirement.
 *
 * `useHoverCapable` defaults to FALSE, so a server render and the first client
 * frame both behave as touch. Guessing "desktop" and being wrong costs a phone
 * user their tooltip; guessing "touch" and being wrong costs a mouse user one
 * extra frame before hover starts working.
 *
 * ── WHY THE LINES ARE ONE STRETCHED SVG ───────────────────────────────────
 *
 * The columns are HTML boxes with percentage heights, because that is what they
 * are. The lines cannot be — a polyline needs a coordinate space — so they are
 * drawn in a `viewBox="0 0 100 100"` overlay with `preserveAspectRatio="none"`,
 * which makes every coordinate a percentage of the plot and needs no
 * measurement, no resize observer and no re-render on a window change. The
 * stretch would smear the stroke, so every stroked element carries
 * `vector-effect="non-scaling-stroke"`.
 *
 * ── PERCENTAGES ───────────────────────────────────────────────────────────
 *
 * Nothing in this file divides by a total. Every share comes from
 * `sharesOfRecorded` in `app/lib/overview-meters.ts` (§1.4), through
 * `sharesExcludingNotRecorded` below, which is the one place that knows a
 * "not recorded" bucket is outside the denominator AND outside the printed
 * percentages.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  NOT_RECORDED_INK,
  OVERVIEW_PRIORITY_COLOUR,
  sharesOfRecorded,
} from "../../../lib/overview-meters";

/* ── Pure maths, exported because it is the part worth testing ────────────── */

/**
 * ONE DONUT SEGMENT, as an annular wedge.
 *
 * `start` and `sweep` are FRACTIONS of the whole ring, not degrees, because
 * that is what a share is and converting twice is where an off-by-one-segment
 * bug lives. Twelve o'clock is zero, which is why every angle carries the
 * `- Math.PI / 2`.
 *
 * A sweep of a whole ring is the case that breaks the naive version: an arc
 * whose start and end points are identical draws nothing at all, so a single
 * category at 100% would render an empty donut. It is split into two halves
 * instead.
 */
export function donutSegmentPath(
  centre: number,
  outer: number,
  inner: number,
  start: number,
  sweep: number,
): string {
  if (!Number.isFinite(sweep) || sweep <= 0) return "";
  if (sweep >= 1) {
    return `${donutSegmentPath(centre, outer, inner, start, 0.5)} ${donutSegmentPath(
      centre,
      outer,
      inner,
      start + 0.5,
      0.5,
    )}`;
  }
  const angle = (fraction: number) => fraction * 2 * Math.PI - Math.PI / 2;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const x = (radius: number, at: number) => round(centre + radius * Math.cos(at));
  const y = (radius: number, at: number) => round(centre + radius * Math.sin(at));
  const from = angle(start);
  const to = angle(start + sweep);
  const large = sweep > 0.5 ? 1 : 0;
  return [
    `M ${x(outer, from)} ${y(outer, from)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${x(outer, to)} ${y(outer, to)}`,
    `L ${x(inner, to)} ${y(inner, to)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${x(inner, from)} ${y(inner, from)}`,
    "Z",
  ].join(" ");
}

/**
 * WHICH BUCKET A FINGER IS OVER.
 *
 * Used by the time-series scrub. The right edge belongs to the LAST bucket
 * rather than to a bucket that does not exist — `floor` at exactly `left+width`
 * yields `count`, and a scrub that ran off the end of the array was the first
 * thing this returned. Outside the plot on either side clamps rather than
 * reporting nothing, because a drag that strays a few pixels above the plot is
 * still a drag across it.
 */
export function scrubIndexAt(
  clientX: number,
  left: number,
  width: number,
  count: number,
): number {
  if (!Number.isFinite(clientX) || count <= 0 || width <= 0) return -1;
  const raw = Math.floor(((clientX - left) / width) * count);
  return Math.min(count - 1, Math.max(0, raw));
}

/**
 * SHARES, WITH "NOT RECORDED" OUTSIDE THE DENOMINATOR — §1.4.
 *
 * Returns `null` for every excluded entry, and `null` is what stops a
 * percentage being printed beside a grey count. The recorded entries are handed
 * to `sharesOfRecorded` untouched, so the sum-to-100 correction and the
 * zero-denominator behaviour are the shared ones rather than a second copy.
 */
export function sharesExcludingNotRecorded(
  values: readonly number[],
  excluded: readonly boolean[],
): Array<number | null> {
  const recorded = values.filter((_, index) => !excluded[index]);
  const shares = sharesOfRecorded(recorded);
  let cursor = 0;
  return values.map((_, index) => {
    if (excluded[index]) return null;
    const share = shares[cursor] ?? 0;
    cursor += 1;
    return share;
  });
}

/** The top of an axis, rounded up to something a reader can divide by. */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/* ── Environment hooks ────────────────────────────────────────────────────── */

/**
 * A media query as a boolean, false until the client has answered.
 *
 * Server-rendered HTML has no viewport and no pointer, so every one of these
 * starts false and the first effect corrects it. The alternative — guessing
 * from a user agent — is wrong on every tablet and on every desktop browser
 * with a touch screen.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const apply = () => setMatches(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [query]);
  return matches;
}

/** True only where a real pointer can hover. See the header for why it matters. */
export function useHoverCapable(): boolean {
  return useMediaQuery("(hover: hover) and (pointer: fine)");
}

/**
 * TAP TO PIN, TAP AWAY TO DISMISS — §1.8, and Escape as well for §1.9.
 *
 * The dismissal listener is on `pointerdown` rather than `click` so a tap that
 * begins outside the chart closes the tooltip before it can also press whatever
 * it landed on, and it is only attached while something is pinned — an
 * always-on document listener on a page with six charts is six listeners doing
 * nothing.
 */
export function useTapToPin<Key extends string | number>() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState<Key | null>(null);
  const [hovered, setHovered] = useState<Key | null>(null);

  useEffect(() => {
    if (pinned === null) return;
    const dismiss = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      setPinned(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinned(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [pinned]);

  const togglePin = useCallback((key: Key) => {
    setPinned((current) => (current === key ? null : key));
  }, []);

  return {
    rootRef,
    pinned,
    setPinned,
    hovered,
    setHovered,
    togglePin,
    active: pinned ?? hovered,
  };
}

/* ── The tooltip ──────────────────────────────────────────────────────────── */

/**
 * One tooltip shape for all five charts.
 *
 * `at` is a percentage across the plot, so nothing has to be measured. It is
 * clamped away from both edges because a tooltip centred on the first bucket of
 * a full-width bar would otherwise hang off the left of a 320px screen — which
 * is §1.8's "no horizontal page scroll at any breakpoint" broken by the thing
 * added to explain the chart.
 */
function ChartTip({
  at,
  title,
  lines,
  action,
  pinned,
}: {
  at: number;
  title: string;
  lines: string[];
  action?: ReactNode;
  pinned: boolean;
}) {
  const left = Math.min(92, Math.max(8, at));
  return (
    <div
      className={`ovw-tip${pinned ? " ovw-tip--pinned" : ""}`}
      style={{ left: `${left}%` }}
      role="status"
    >
      <strong className="ovw-tip__title">{title}</strong>
      {lines.map((line) => (
        <span className="ovw-tip__line" key={line}>
          {line}
        </span>
      ))}
      {action}
    </div>
  );
}

/* ── Segment types ────────────────────────────────────────────────────────── */

/**
 * `notRecorded` is an ADDITIVE extension to the agreed segment shape.
 *
 * The component contract lists `{ key, label, value, colour }`. §1.4 and §1.5
 * both require that a "not recorded" bucket draws grey, carries no percentage
 * and stays out of the denominator, and none of those three can be decided from
 * a key, a label or a colour without sniffing one of them. The field is
 * optional, so every call site written against the four-field shape compiles
 * and behaves exactly as before.
 */
export type ChartSegment = {
  key: string;
  label: string;
  value: number;
  colour: string;
  notRecorded?: boolean;
};

const percentText = (share: number | null) => (share === null ? "" : ` · ${share}% of recorded`);

/* ── 1. The segmented bar ─────────────────────────────────────────────────── */

/**
 * THE RECONCILIATION BAR — §2.3(a).
 *
 * `SegmentedMeter` in `ops-primitives.tsx` draws the same track and this does
 * not replace it: the primitive stays the right answer for a bar inside a dense
 * row, and it is what `SeverityBar` uses. This one exists because §2.3 asks for
 * a segment that can be hovered, tapped, pinned, focused and drilled, and for a
 * legend beneath carrying every name, count and share — none of which a
 * `title` attribute on a `<span>` can do.
 *
 * Zero-value segments are dropped from the PAINT and kept in the legend and the
 * readout, which is the primitive's rule and the reason for it: a 0px div still
 * takes a border and reads as data.
 */
export function SegmentedBar({
  segments,
  total,
  onSelect,
  label,
}: {
  segments: ChartSegment[];
  total: number;
  onSelect?: (key: string) => void;
  label: string;
}) {
  const hoverCapable = useHoverCapable();
  const { rootRef, pinned, setHovered, togglePin, active } = useTapToPin<string>();

  const shares = sharesExcludingNotRecorded(
    segments.map((segment) => segment.value),
    segments.map((segment) => segment.notRecorded === true),
  );
  const parts = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const scale = total > 0 ? total : parts;
  const readout = segments
    .map((segment, index) => `${segment.label} ${segment.value}${percentText(shares[index])}`)
    .join(", ");

  const activeIndex = segments.findIndex((segment) => segment.key === active);
  /*
   * A plain loop rather than a `map` over a running total: the React Compiler
   * lint refuses a variable reassigned inside a render callback, and it is
   * right to — the callback could outlive the render and read a total from the
   * wrong pass.
   */
  const midpoints: number[] = [];
  for (let index = 0, cursor = 0; index < segments.length; index += 1) {
    const width = scale > 0 ? (Math.max(0, segments[index].value) / scale) * 100 : 0;
    midpoints.push(cursor + width / 2);
    cursor += width;
  }

  return (
    <div className="ovw-segbar" ref={rootRef}>
      <div className="ovw-segbar__plot">
        {/*
          `group`, NOT `img`, and the difference is not cosmetic: `img` makes
          its whole subtree presentational, and every segment here is a
          `<button>` that a keyboard reader has to be able to reach. The label
          is the same either way; only the children survive.
        */}
        <div className="ovw-segbar__track" role="group" aria-label={`${label}: ${readout}`}>
          {scale > 0 ? (
            segments
              .filter((segment) => segment.value > 0)
              .map((segment) => {
                const index = segments.indexOf(segment);
                return (
                  <button
                    type="button"
                    key={segment.key}
                    className={`ovw-segbar__fill${
                      active === segment.key ? " ovw-segbar__fill--active" : ""
                    }`}
                    style={{
                      width: `${(segment.value / scale) * 100}%`,
                      background: segment.colour,
                    }}
                    aria-label={`${segment.label}: ${segment.value}${percentText(shares[index])}`}
                    onPointerEnter={() => {
                      if (hoverCapable) setHovered(segment.key);
                    }}
                    onPointerLeave={() => setHovered(null)}
                    onFocus={() => setHovered(segment.key)}
                    onBlur={() => setHovered(null)}
                    onClick={() => {
                      if (hoverCapable && onSelect) onSelect(segment.key);
                      else togglePin(segment.key);
                    }}
                  />
                );
              })
          ) : (
            <span className="ovw-segbar__empty" />
          )}
        </div>
        {activeIndex >= 0 ? (
          <ChartTip
            at={midpoints[activeIndex]}
            pinned={pinned === segments[activeIndex].key}
            title={segments[activeIndex].label}
            lines={[
              `${segments[activeIndex].value} jobs`,
              shares[activeIndex] === null
                ? "No percentage — not a recorded value"
                : `${shares[activeIndex]}% of recorded`,
            ]}
            action={
              onSelect && pinned === segments[activeIndex].key ? (
                <button
                  type="button"
                  className="ovw-tip__action"
                  onClick={() => onSelect(segments[activeIndex].key)}
                >
                  View these jobs →
                </button>
              ) : null
            }
          />
        ) : null}
      </div>
      <ul className="ovw-legend">
        {segments.map((segment, index) => (
          <li key={segment.key} className="ovw-legend__item">
            <button
              type="button"
              className="ovw-legend__button"
              onPointerEnter={() => {
                if (hoverCapable) setHovered(segment.key);
              }}
              onPointerLeave={() => setHovered(null)}
              onFocus={() => setHovered(segment.key)}
              onBlur={() => setHovered(null)}
              onClick={() => {
                if (hoverCapable && onSelect) onSelect(segment.key);
                else togglePin(segment.key);
              }}
            >
              <span
                className="ovw-legend__swatch"
                style={{ background: segment.colour }}
                aria-hidden="true"
              />
              <span className="ovw-legend__label">{segment.label}</span>
              <span className="ovw-legend__value">{segment.value}</span>
              {shares[index] === null ? null : (
                <span className="ovw-legend__share">{shares[index]}%</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── 2. The donut ─────────────────────────────────────────────────────────── */

/**
 * A RING, AND THE RECORDED COUNT IN THE MIDDLE — §5.3.
 *
 * The centre is the caller's `centreValue`, and the reason the prop exists at
 * all is defect 3 in §7: the Engineer-required donut printed the cohort total
 * in the middle while its own caption said "193 of 226 recorded". The component
 * therefore cannot compute the centre from its segments — the two numbers are
 * genuinely different and the recorded one is the honest one — so it is handed
 * in, with the word beside it.
 *
 * The SVG is `aria-hidden`. The legend beneath is the accessible control: real
 * buttons, in the tab order, carrying the same name, count and share. A path is
 * not focusable and a keyboard reader would otherwise have a picture and
 * nothing else.
 */
export function Donut({
  segments,
  centreValue,
  centreLabel,
  onSelect,
  label,
}: {
  segments: ChartSegment[];
  centreValue: number;
  centreLabel: string;
  onSelect?: (key: string) => void;
  label: string;
}) {
  const hoverCapable = useHoverCapable();
  const { rootRef, pinned, setHovered, togglePin, active } = useTapToPin<string>();

  const size = 168;
  const centre = size / 2;
  const outer = 78;
  const inner = 50;

  const shares = sharesExcludingNotRecorded(
    segments.map((segment) => segment.value),
    segments.map((segment) => segment.notRecorded === true),
  );
  const sum = segments.reduce((count, segment) => count + Math.max(0, segment.value), 0);
  const readout = segments
    .map((segment, index) => `${segment.label} ${segment.value}${percentText(shares[index])}`)
    .join(", ");

  let cursor = 0;
  const wedges = segments.map((segment) => {
    const sweep = sum > 0 ? Math.max(0, segment.value) / sum : 0;
    const start = cursor;
    cursor += sweep;
    return { segment, start, sweep };
  });

  const activeIndex = segments.findIndex((segment) => segment.key === active);

  return (
    <div className="ovw-donut" ref={rootRef}>
      <div className="ovw-donut__plot">
        <svg
          className="ovw-donut__svg"
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          aria-hidden="true"
          focusable="false"
        >
          {sum > 0 ? (
            wedges
              .filter((wedge) => wedge.sweep > 0)
              .map((wedge) => (
                <path
                  key={wedge.segment.key}
                  d={donutSegmentPath(centre, outer, inner, wedge.start, wedge.sweep)}
                  fill={wedge.segment.colour}
                  className={`ovw-donut__wedge${
                    active === wedge.segment.key ? " ovw-donut__wedge--active" : ""
                  }`}
                  onPointerEnter={() => {
                    if (hoverCapable) setHovered(wedge.segment.key);
                  }}
                  onPointerLeave={() => setHovered(null)}
                  onClick={() => {
                    if (hoverCapable && onSelect) onSelect(wedge.segment.key);
                    else togglePin(wedge.segment.key);
                  }}
                />
              ))
          ) : (
            <circle
              cx={centre}
              cy={centre}
              r={(outer + inner) / 2}
              fill="none"
              stroke="var(--ms-line)"
              strokeWidth={outer - inner}
            />
          )}
        </svg>
        {/*
          The one `role="img"` that is right: this subtree is two glyphs and no
          controls, and the label carries the centre figure as well as the
          segments — §5.3's whole point is that the number in the middle is the
          RECORDED count, so a reader who cannot see it must still be told it.
        */}
        <span
          className="ovw-donut__centre"
          role="img"
          aria-label={`${label}: ${centreValue} ${centreLabel}. ${readout}`}
        >
          <strong>{centreValue}</strong>
          <small>{centreLabel}</small>
        </span>
        {activeIndex >= 0 ? (
          <ChartTip
            at={50}
            pinned={pinned === segments[activeIndex].key}
            title={segments[activeIndex].label}
            lines={[
              `${segments[activeIndex].value} jobs`,
              shares[activeIndex] === null
                ? "No percentage — not a recorded value"
                : `${shares[activeIndex]}% of recorded`,
            ]}
            action={
              onSelect && pinned === segments[activeIndex].key ? (
                <button
                  type="button"
                  className="ovw-tip__action"
                  onClick={() => onSelect(segments[activeIndex].key)}
                >
                  View these jobs →
                </button>
              ) : null
            }
          />
        ) : null}
      </div>
      <ul className="ovw-legend ovw-legend--donut">
        {segments.map((segment, index) => (
          <li key={segment.key} className="ovw-legend__item">
            <button
              type="button"
              className="ovw-legend__button"
              onPointerEnter={() => {
                if (hoverCapable) setHovered(segment.key);
              }}
              onPointerLeave={() => setHovered(null)}
              onFocus={() => setHovered(segment.key)}
              onBlur={() => setHovered(null)}
              onClick={() => {
                if (hoverCapable && onSelect) onSelect(segment.key);
                else togglePin(segment.key);
              }}
            >
              <span
                className="ovw-legend__swatch"
                style={{ background: segment.colour }}
                aria-hidden="true"
              />
              <span className="ovw-legend__label">{segment.label}</span>
              <span className="ovw-legend__value">{segment.value}</span>
              {shares[index] === null ? (
                <span className="ovw-legend__share ovw-legend__share--none">not recorded</span>
              ) : (
                <span className="ovw-legend__share">{shares[index]}%</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── 3. Ranked bars ───────────────────────────────────────────────────────── */

export type RankedRow = {
  key: string;
  label: string;
  value: number;
  share: number;
  colour: string;
  /** §3.6 — renders with no bar fill, so it never reads as verified performance. */
  muted?: boolean;
  /** Additive, for the same reason as `ChartSegment.notRecorded`. */
  notRecorded?: boolean;
  byPriority?: Record<string, number>;
  suffix?: ReactNode;
};

/**
 * THE LIST THAT REPLACES A PIE WITH SEVEN SLICES — §1.10.
 *
 * Above five categories a ring stops being readable and a ranked list starts
 * being one, and the list has the further advantage that it can carry the row's
 * own numbers — spend, job count, median, coverage (§3.4) — in the `suffix`
 * without a second layout.
 *
 * `marker` is §3.4's portfolio median. With no budgets in the data, the only
 * honest comparison left is against the portfolio itself, and the marker is how
 * a site that runs expensive per job becomes visible without inventing a target.
 */
export function RankedBars({
  rows,
  splitByPriority,
  marker,
  max,
  onSelect,
  onDrill,
  format,
}: {
  rows: RankedRow[];
  splitByPriority?: boolean;
  marker?: { value: number; label: string } | null;
  max?: number;
  onSelect?: (key: string) => void;
  onDrill?: (key: string) => void;
  format?: (value: number) => string;
}) {
  const show = format ?? ((value: number) => String(value));
  const ceiling = Math.max(
    max ?? 0,
    ...rows.map((row) => Math.max(0, row.value)),
    1,
  );
  const markerAt =
    marker && marker.value > 0 ? Math.min(100, (marker.value / ceiling) * 100) : null;

  return (
    <div className="ovw-ranked">
      {markerAt === null ? null : (
        <p className="ovw-ranked__marker-key">
          <span className="ovw-ranked__marker-swatch" aria-hidden="true" />
          {marker?.label}
        </p>
      )}
      <ul className="ovw-ranked__list">
        {rows.map((row) => {
          const width = Math.min(100, (Math.max(0, row.value) / ceiling) * 100);
          const stacks =
            splitByPriority && row.byPriority
              ? Object.entries(row.byPriority).filter(([, count]) => count > 0)
              : [];
          const stackTotal = stacks.reduce((sum, [, count]) => sum + count, 0);
          const body = (
            <>
              <span className="ovw-ranked__label">{row.label}</span>
              <span className="ovw-ranked__bar" aria-hidden="true">
                {row.muted ? (
                  <span className="ovw-ranked__fill ovw-ranked__fill--muted" style={{ width: `${width}%` }} />
                ) : stacks.length > 0 ? (
                  <span className="ovw-ranked__fill" style={{ width: `${width}%` }}>
                    {stacks.map(([priority, count]) => (
                      <span
                        key={priority}
                        className="ovw-ranked__stack"
                        style={{
                          width: `${stackTotal > 0 ? (count / stackTotal) * 100 : 0}%`,
                          background: OVERVIEW_PRIORITY_COLOUR[priority] ?? NOT_RECORDED_INK,
                        }}
                      />
                    ))}
                  </span>
                ) : (
                  <span
                    className="ovw-ranked__fill"
                    style={{ width: `${width}%`, background: row.colour }}
                  />
                )}
                {markerAt === null ? null : (
                  <span className="ovw-ranked__marker" style={{ left: `${markerAt}%` }} />
                )}
              </span>
              <span className="ovw-ranked__value">{show(row.value)}</span>
              {row.notRecorded ? (
                <span className="ovw-ranked__share ovw-ranked__share--none">not recorded</span>
              ) : (
                <span className="ovw-ranked__share">{row.share}%</span>
              )}
            </>
          );
          const description = `${row.label}: ${show(row.value)}${
            row.notRecorded ? ", not a recorded value" : `, ${row.share}% of recorded`
          }${
            splitByPriority && stacks.length > 0
              ? `, ${stacks.map(([priority, count]) => `${priority} ${count}`).join(", ")}`
              : ""
          }`;
          return (
            <li
              key={row.key}
              className={`ovw-ranked__row${row.muted ? " ovw-ranked__row--muted" : ""}`}
            >
              {onSelect ? (
                <button
                  type="button"
                  className="ovw-ranked__hit"
                  onClick={() => onSelect(row.key)}
                  aria-label={description}
                >
                  {body}
                </button>
              ) : (
                <span className="ovw-ranked__hit" role="img" aria-label={description}>
                  {body}
                </span>
              )}
              {row.suffix ? <span className="ovw-ranked__suffix">{row.suffix}</span> : null}
              {onDrill ? (
                <button
                  type="button"
                  className="ovw-ranked__drill"
                  onClick={() => onDrill(row.key)}
                  aria-label={`Open the jobs behind ${row.label}`}
                >
                  →
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── 4. The time series ───────────────────────────────────────────────────── */

type SeriesValues = Array<number | null>;

/** A run of consecutive drawable points, so a gap is a gap and not a straight line through it. */
function runsOf(values: SeriesValues, drawable: boolean[]): Array<Array<{ index: number; value: number }>> {
  const runs: Array<Array<{ index: number; value: number }>> = [];
  let run: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value) || !drawable[index]) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ index, value });
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * COLUMNS, LINES, AND THE GAPS THAT MUST STAY GAPS — §4.3.
 *
 * "Buckets with fewer than 3 completed jobs render as a gap with a dotted
 * connector." A median of one job is noise drawn as a trend, and joining across
 * it with a solid line asserts a value that was never measured. The connector
 * is dotted precisely so the eye can follow the series without reading the
 * span as data.
 *
 * COLUMNS AND LINES DO NOT SHARE A SCALE. §3.3 puts recorded spend in the
 * columns and a jobs-with-cost COUNT on the line; pounds and jobs on one axis
 * would be a chart whose crossings mean nothing. Each side gets its own
 * ceiling, and both ceilings are printed.
 */
export function TimeSeries({
  buckets,
  columns,
  lines,
  formatValue,
  onSelectBucket,
  label,
  minSample,
}: {
  buckets: Array<{
    label: string;
    start: string;
    endInclusive: string;
    partial?: boolean;
    sample?: number;
  }>;
  columns?: Array<{ key: string; label: string; colour: string; values: SeriesValues }>;
  lines?: Array<{
    key: string;
    label: string;
    colour: string;
    dashed?: boolean;
    values: SeriesValues;
  }>;
  formatValue?: (value: number, seriesKey: string) => string;
  onSelectBucket?: (bucket: { start: string; endInclusive: string }) => void;
  label: string;
  minSample?: number;
}) {
  const hoverCapable = useHoverCapable();
  const { rootRef, pinned, setPinned, setHovered, active } = useTapToPin<number>();
  const plotRef = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);
  const titleId = useId();

  const columnSeries = columns ?? [];
  const lineSeries = lines ?? [];
  const show = formatValue ?? ((value: number) => String(value));
  const floor = minSample ?? 0;

  /** A bucket below the sample floor is not drawable — §4.3, not a zero. */
  const drawable = buckets.map(
    (bucket) => bucket.sample === undefined || bucket.sample >= floor,
  );

  const columnCeiling = niceCeiling(
    Math.max(
      0,
      ...columnSeries.flatMap((series) =>
        series.values.map((value) => (value === null ? 0 : value)),
      ),
    ),
  );
  const lineCeiling = niceCeiling(
    Math.max(
      0,
      ...lineSeries.flatMap((series) =>
        series.values.map((value, index) => (value === null || !drawable[index] ? 0 : value)),
      ),
    ),
  );

  const count = buckets.length;
  const xAt = (index: number) => ((index + 0.5) / Math.max(1, count)) * 100;
  const yAt = (value: number) => 100 - Math.min(100, (value / lineCeiling) * 100);

  const move = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (!plot) return;
      const rect = plot.getBoundingClientRect();
      const index = scrubIndexAt(event.clientX, rect.left, rect.width, count);
      if (index < 0) return;
      if (scrubbing.current) setPinned(index);
      else if (hoverCapable) setHovered(index);
    },
    [count, hoverCapable, setHovered, setPinned],
  );

  const activeIndex = typeof active === "number" ? active : -1;
  const activeBucket = activeIndex >= 0 ? buckets[activeIndex] : null;

  const readout = buckets
    .map((bucket, index) => {
      const parts = [
        ...columnSeries.map(
          (series) =>
            `${series.label} ${series.values[index] === null ? "no data" : show(series.values[index] as number, series.key)}`,
        ),
        ...lineSeries.map((series) =>
          !drawable[index] || series.values[index] === null
            ? `${series.label} insufficient data`
            : `${series.label} ${show(series.values[index] as number, series.key)}`,
        ),
      ];
      return `${bucket.label}: ${parts.join(", ")}`;
    })
    .join("; ");

  return (
    <div className="ovw-ts" ref={rootRef}>
      <p className="ovw-ts__scales">
        {columnSeries.length > 0 ? (
          <span className="ovw-ts__scale">Columns to {columnCeiling}</span>
        ) : null}
        {lineSeries.length > 0 ? (
          <span className="ovw-ts__scale">Lines to {lineCeiling}</span>
        ) : null}
      </p>
      {/*
        THE PLOT AND ITS TICKS SCROLL TOGETHER, INSIDE THEIR OWN CONTAINER.
        §1.8 forbids the PAGE scrolling sideways at any breakpoint and allows
        "explicitly scrollable containers with a visible edge affordance". A
        daily bucketing over 31 days does not fit 320px at a legible tick size,
        so this is the container, and the ticks are inside it because a plot
        that scrolls away from its own labels is worse than no labels.
      */}
      <div className="ovw-ts__scroller">
      <div
        className={`ovw-ts__plot${count > 8 ? " ovw-ts__plot--dense" : ""}`}
        ref={plotRef}
        role="group"
        aria-labelledby={titleId}
      >
        <span className="visually-hidden" id={titleId}>
          {label}: {readout}
        </span>
        <div className="ovw-ts__columns" aria-hidden="true">
          {buckets.map((bucket, index) => (
            <span
              className={`ovw-ts__slot${activeIndex === index ? " ovw-ts__slot--active" : ""}`}
              key={bucket.start}
            >
              {columnSeries.map((series) => {
                const value = series.values[index];
                if (value === null || value <= 0) return <span className="ovw-ts__bar ovw-ts__bar--none" key={series.key} />;
                return (
                  <span
                    className={`ovw-ts__bar${bucket.partial ? " ovw-ts__bar--partial" : ""}`}
                    key={series.key}
                    style={{
                      height: `${Math.min(100, (value / columnCeiling) * 100)}%`,
                      background: series.colour,
                    }}
                  />
                );
              })}
            </span>
          ))}
        </div>
        {lineSeries.length > 0 ? (
          <svg
            className="ovw-ts__lines"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {lineSeries.map((series) => {
              const runs = runsOf(series.values, drawable);
              return (
                <g key={series.key}>
                  {runs.map((run, runIndex) => (
                    <polyline
                      key={`${series.key}-run-${runIndex}`}
                      points={run
                        .map((point) => `${xAt(point.index)},${yAt(point.value)}`)
                        .join(" ")}
                      fill="none"
                      stroke={series.colour}
                      strokeWidth={2}
                      strokeDasharray={series.dashed ? "5 4" : undefined}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  {runs.slice(1).map((run, runIndex) => {
                    const previous = runs[runIndex][runs[runIndex].length - 1];
                    const next = run[0];
                    return (
                      <line
                        key={`${series.key}-gap-${runIndex}`}
                        x1={xAt(previous.index)}
                        y1={yAt(previous.value)}
                        x2={xAt(next.index)}
                        y2={yAt(next.value)}
                        stroke={series.colour}
                        strokeWidth={2}
                        strokeDasharray="1 4"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
        ) : null}
        {/*
          THE SCRUB SURFACE.
          One element rather than a handler per bucket: a drag has to keep
          reporting after the finger leaves the column it started in, and
          `setPointerCapture` on this surface is what makes that work on touch.
          `touch-action: pan-y` in the stylesheet keeps the page scrollable
          vertically through it, so a scroll gesture is never stolen by a chart.
        */}
        <div
          className="ovw-ts__scrub"
          onPointerDown={(event) => {
            scrubbing.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            move(event);
          }}
          onPointerMove={move}
          onPointerUp={(event) => {
            scrubbing.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={() => {
            scrubbing.current = false;
          }}
          onPointerLeave={() => setHovered(null)}
        />
        {activeBucket ? (
          <ChartTip
            at={xAt(activeIndex)}
            pinned={pinned === activeIndex}
            title={activeBucket.label}
            lines={[
              ...columnSeries.map((series) =>
                series.values[activeIndex] === null
                  ? `${series.label}: no data`
                  : `${series.label}: ${show(series.values[activeIndex] as number, series.key)}`,
              ),
              ...lineSeries.map((series) =>
                !drawable[activeIndex] || series.values[activeIndex] === null
                  ? `${series.label}: insufficient data`
                  : `${series.label}: ${show(series.values[activeIndex] as number, series.key)}`,
              ),
              activeBucket.sample === undefined
                ? ""
                : `Sample ${activeBucket.sample}${activeBucket.partial ? " · period still running" : ""}`,
            ].filter(Boolean)}
            action={
              onSelectBucket && pinned === activeIndex ? (
                <button
                  type="button"
                  className="ovw-tip__action"
                  onClick={() =>
                    onSelectBucket({
                      start: activeBucket.start,
                      endInclusive: activeBucket.endInclusive,
                    })
                  }
                >
                  View this period →
                </button>
              ) : null
            }
          />
        ) : null}
      </div>
      <ul className="ovw-ts__ticks">
        {buckets.map((bucket, index) => (
          <li className="ovw-ts__tick" key={bucket.start}>
            <button
              type="button"
              className="ovw-ts__tick-button"
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(null)}
              onClick={() => {
                if (onSelectBucket && hoverCapable) {
                  onSelectBucket({ start: bucket.start, endInclusive: bucket.endInclusive });
                } else {
                  setPinned(pinned === index ? null : index);
                }
              }}
            >
              {bucket.label}
            </button>
          </li>
        ))}
      </ul>
      </div>
      {lineSeries.length + columnSeries.length > 1 ? (
        <ul className="ovw-legend">
          {[...columnSeries, ...lineSeries].map((series) => (
            <li className="ovw-legend__item" key={series.key}>
              <span className="ovw-legend__button ovw-legend__button--static">
                <span
                  className="ovw-legend__swatch"
                  style={{ background: series.colour }}
                  aria-hidden="true"
                />
                <span className="ovw-legend__label">{series.label}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ── 5. Grouped columns ───────────────────────────────────────────────────── */

/**
 * ONE GROUP PER BUCKET, ONE COLUMN PER STAGE — §4.4.
 *
 * A `null` value is NOT a zero-height column. §4.4: "A stage with no timestamp
 * shows 'Not measured — no timestamp recorded', never 0% or 100%." A zero
 * column and an unmeasured stage look identical once drawn, and one of them
 * says the team missed every target.
 */
export function GroupedColumns({
  buckets,
  series,
  onSelectBucket,
  label,
  suffix,
}: {
  buckets: Array<{ label: string; start: string; endInclusive: string }>;
  series: Array<{
    key: string;
    label: string;
    colour: string;
    values: SeriesValues;
    samples?: number[];
  }>;
  onSelectBucket?: (bucket: { start: string; endInclusive: string }) => void;
  label: string;
  suffix?: string;
}) {
  const hoverCapable = useHoverCapable();
  const { rootRef, pinned, setPinned, setHovered, active } = useTapToPin<number>();
  const titleId = useId();
  const unit = suffix ?? "";

  const ceiling =
    unit === "%"
      ? 100
      : niceCeiling(
          Math.max(
            0,
            ...series.flatMap((line) => line.values.map((value) => (value === null ? 0 : value))),
          ),
        );

  const readout = buckets
    .map((bucket, index) => {
      const parts = series.map((line) =>
        line.values[index] === null
          ? `${line.label} not measured`
          : `${line.label} ${line.values[index]}${unit}`,
      );
      return `${bucket.label}: ${parts.join(", ")}`;
    })
    .join("; ");

  const activeIndex = typeof active === "number" ? active : -1;
  const activeBucket = activeIndex >= 0 ? buckets[activeIndex] : null;

  return (
    <div className="ovw-grouped" ref={rootRef}>
      {/* Its own scroller, for the same reason as the time series above. */}
      <div className="ovw-grouped__scroller">
      {/* `group` again: every bucket in here is a real button. */}
      <div className="ovw-grouped__plot" role="group" aria-labelledby={titleId}>
        <span className="visually-hidden" id={titleId}>
          {label}: {readout}
        </span>
        {buckets.map((bucket, index) => (
          <div
            className={`ovw-grouped__group${
              activeIndex === index ? " ovw-grouped__group--active" : ""
            }`}
            key={bucket.start}
          >
            <button
              type="button"
              className="ovw-grouped__hit"
              aria-label={`${bucket.label}: ${series
                .map((line) =>
                  line.values[index] === null
                    ? `${line.label} not measured`
                    : `${line.label} ${line.values[index]}${unit}`,
                )
                .join(", ")}`}
              onPointerEnter={() => {
                if (hoverCapable) setHovered(index);
              }}
              onPointerLeave={() => setHovered(null)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(null)}
              onClick={() => {
                if (hoverCapable && onSelectBucket) {
                  onSelectBucket({ start: bucket.start, endInclusive: bucket.endInclusive });
                } else {
                  setPinned(pinned === index ? null : index);
                }
              }}
            >
              <span className="ovw-grouped__columns" aria-hidden="true">
                {series.map((line) => {
                  const value = line.values[index];
                  if (value === null) {
                    return (
                      <span className="ovw-grouped__unmeasured" key={line.key} title="Not measured" />
                    );
                  }
                  return (
                    <span
                      className="ovw-grouped__column"
                      key={line.key}
                      style={{
                        height: `${Math.min(100, (value / ceiling) * 100)}%`,
                        background: line.colour,
                      }}
                    />
                  );
                })}
              </span>
              <span className="ovw-grouped__label">{bucket.label}</span>
            </button>
          </div>
        ))}
        {activeBucket ? (
          <ChartTip
            at={((activeIndex + 0.5) / Math.max(1, buckets.length)) * 100}
            pinned={pinned === activeIndex}
            title={activeBucket.label}
            lines={series.map((line, lineIndex) =>
              line.values[activeIndex] === null
                ? `${line.label}: Not measured — no timestamp recorded`
                : `${line.label}: ${line.values[activeIndex]}${unit}${
                    series[lineIndex].samples?.[activeIndex] === undefined
                      ? ""
                      : ` (sample ${series[lineIndex].samples?.[activeIndex]})`
                  }`,
            )}
            action={
              onSelectBucket && pinned === activeIndex ? (
                <button
                  type="button"
                  className="ovw-tip__action"
                  onClick={() =>
                    onSelectBucket({
                      start: activeBucket.start,
                      endInclusive: activeBucket.endInclusive,
                    })
                  }
                >
                  View this period →
                </button>
              ) : null
            }
          />
        ) : null}
      </div>
      </div>
      <ul className="ovw-legend">
        {series.map((line) => (
          <li className="ovw-legend__item" key={line.key}>
            <span className="ovw-legend__button ovw-legend__button--static">
              <span
                className="ovw-legend__swatch"
                style={{ background: line.colour }}
                aria-hidden="true"
              />
              <span className="ovw-legend__label">{line.label}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
