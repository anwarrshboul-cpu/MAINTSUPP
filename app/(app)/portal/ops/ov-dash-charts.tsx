"use client";

/**
 * THE DASHBOARD BLOCK'S CHART SHAPES — hand-rolled inline SVG, no new dependency.
 *
 * This product has five runtime dependencies and none of them draws a chart.
 * `overview-charts.tsx` next door established that a proportional bar, a ring
 * and a polyline are each one element with one attribute, and that a charting
 * library would buy a bundle, a second theming system and a second
 * accessibility story to draw them. Nothing in this file changes that
 * judgement, so the idioms here are deliberately the same ones: a `viewBox`
 * whose coordinates are percentages, `vector-effect="non-scaling-stroke"` on
 * anything stretched, an `aria-hidden` picture with real focusable controls
 * beside it, and tap-to-pin rather than a `title` attribute.
 *
 * It does NOT import from that file, and the duplication is the point. That
 * module is the themeable Operations overview: every colour it touches is a
 * `--ms-*` token that flips with the light/dark switch, and its segment type
 * carries a "not recorded" flag whose whole meaning is that overview's
 * denominator rule. This block is a fixed, always-dark presentation layer with
 * its own palette and its own `.ov-dash` scope, and coupling the two would mean
 * every future change to either one had to be safe for both.
 *
 * ── WHY THE ARCS ARE DASHED CIRCLES AND NOT WEDGE PATHS ───────────────────
 *
 * Every ring in here — donut, speedometer, ring meter, radial bar, horseshoe —
 * is a `<circle>` with `fill: none`, a stroke as thick as the ring, and a
 * `stroke-dasharray` of "drawn, remaining" in user units, offset by the arc's
 * start. There is no trigonometry in it at all, a full ring is `dasharray:
 * C, 0` rather than the two-half-arcs special case a wedge path needs, and the
 * partial gauges are the same code with the track shortened: a 180° gauge is a
 * track of `C/2`, a 270° horseshoe a track of `0.75C`, each rotated into place
 * by a `transform` on the group. Only the speedometer's needle and its tick
 * marks need a cosine, because only they are not arcs.
 *
 * The circumference is computed rather than declared with `pathLength`. They
 * are equivalent where `pathLength` is supported, and where it is not, a
 * dasharray expressed in fractions of 1 would be read as fractions of a user
 * unit and every arc in the block would vanish. Computing 2πr cannot fail that
 * way.
 *
 * ── WHY THE GAUGES ARE DRAWN AT THEIR NATURAL SIZE ────────────────────────
 *
 * Each SVG carries `width`/`height` attributes equal to its `viewBox`, and the
 * stylesheet only ever shrinks it (`max-width: 100%; height: auto`). The stroke
 * widths this file is specified in — 24px on the donut ring, 12px on the
 * speedometer, 8px on a ring meter, 7px on a radial bar, 14px on the horseshoe
 * — are therefore literal CSS pixels wherever the card is wide enough to hold
 * the chart, and shrink proportionally with everything else when it is not.
 * Scaling an SVG up and then pinning the stroke with `non-scaling-stroke`
 * would have kept the number and lost the proportion.
 *
 * ── MOTION ────────────────────────────────────────────────────────────────
 *
 * `useOvSweep` eases FRACTIONS, never raw values, and always from 0. That one
 * decision covers both halves of the requirement with one mechanism: on mount
 * every arc and every line grows out of nothing over 600ms, and when the
 * numbers change the same easing runs from wherever the shape currently is to
 * wherever it now belongs — a mount is just the special case where "wherever it
 * currently is" happens to be zero.
 *
 * It is JavaScript rather than a CSS transition because a CSS transition cannot
 * interpolate a `d` attribute in every engine, and because a JS gate is the
 * only way to make the reduced-motion promise literally true: with
 * `prefers-reduced-motion: reduce`, `useOvSweep` returns the target fractions
 * unchanged and no frame is ever requested, so the rendered geometry is
 * identical to the end state of the animation rather than merely similar to it.
 * The stylesheet carries the matching `@media (prefers-reduced-motion: reduce)`
 * block for the hover and tooltip transitions, which are CSS.
 *
 * ── COLOUR, AND WHAT MAY BE TEXT ──────────────────────────────────────────
 *
 * Colours arrive from DATA as `slice.colour` and are written as inline styles,
 * which is the only place a data colour can come from. Measured against
 * `--ov-card` (#0E1721): `--ov-text` 16.79:1, `--ov-text-2` 11.88:1,
 * `--ov-text-nav` 7.39:1, `--ov-text-muted` 5.10:1 and `--ov-teal` 6.05:1 all
 * clear WCAG AA for text; `--ov-blue` (3.66), `--ov-red` (4.26) and `--ov-grey`
 * (3.27) do not, and are used only as fills, where the 3:1 non-text threshold
 * applies and all three pass. That is why no number in this file is ever
 * painted in its own slice's colour.
 *
 * ── DIVISION BY ZERO ──────────────────────────────────────────────────────
 *
 * `ovFraction` is the only division in this file and it answers 0 for a
 * zero, negative or non-finite denominator. A chart with nothing in it draws
 * its track and prints `0` or `0%`; it never prints `NaN` and it is never
 * blank, because an empty ring is a fact about the data and an empty card is a
 * fact about the code.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import "./ov-dash.css";

/* ── The slice shape the whole block agrees on ────────────────────────────── */

/**
 * One category of a breakdown.
 *
 * `labels` is not drawn by anything here. It is the set of raw values behind a
 * merged bucket — the live payload's "Other" trade covers seven of them — and
 * it travels with the slice so that a caller handed one back by `onSelect` can
 * build the drill-through filter without re-deriving the mapping.
 */
export type OvSlice = { key: string; label: string; value: number; colour: string; labels: string[] };

/* ── Pure maths, exported because it is the part worth testing ────────────── */

/**
 * `value / total`, clamped to 0..1, and 0 rather than `NaN` or `Infinity` for
 * every denominator that cannot answer the question. Every proportion in this
 * file goes through here, so there is exactly one place that decides what a
 * zero total looks like.
 */
export function ovFraction(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(1, value / total));
}

/** A whole-number percentage on the same terms. Never negative, never over 100. */
export function ovPercent(value: number, total: number): number {
  return Math.round(ovFraction(value, total) * 100);
}

/**
 * The top of an axis, rounded up to a number a reader can divide into quarters.
 *
 * The ladder is 1 / 2 / 4 / 5 / 10 and it is shorter than the usual one on
 * purpose. The trend prints FOUR divisions, so the ceiling is not the only
 * number a reader sees — its quarters are on the axis too, and a ceiling of
 * 7.5 puts £56.3k and £18.8k up the side of the chart. Every step here divides
 * into quarters that are themselves round: £75k against £74,000 of spend is a
 * tighter fit than £100k, and it is the worse axis.
 */
export function ovNiceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

const OV_POUNDS_EXACT = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const OV_POUNDS_WHOLE = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

/** Pence to the exact pounds a reader could reconcile against an invoice. */
export function ovPoundsExact(pence: number): string {
  return OV_POUNDS_EXACT.format(Number.isFinite(pence) ? pence / 100 : 0);
}

/**
 * Pence as axis ink — `£0`, `£300`, `£25k`, `£1.2m`.
 *
 * An axis is read at a glance and four significant figures on five stacked
 * ticks is a wall. The exact figure is never lost: it is what the tooltip
 * prints, to the penny.
 */
export function ovPoundsShort(pence: number): string {
  const pounds = Number.isFinite(pence) ? pence / 100 : 0;
  const trim = (n: number) => (Math.round(n * 10) / 10).toString();
  if (Math.abs(pounds) >= 1_000_000) return `£${trim(pounds / 1_000_000)}m`;
  if (Math.abs(pounds) >= 1_000) return `£${trim(pounds / 1_000)}k`;
  return OV_POUNDS_WHOLE.format(pounds);
}

/**
 * How big the number in the middle of a ring may be.
 *
 * The specification asks for 26px, and the donut, the speedometer and the
 * horseshoe all get it because their inner holes are over 100px across. A
 * 76px ring meter's hole is 60px and a radial-bar stack's innermost hole
 * shrinks with every extra category, so the size is derived from the hole
 * rather than declared: 26px is a ceiling, not a promise, and the floor of
 * 14px is where the digits stop being legible at all. Nothing overlaps a ring,
 * at any category count, without this.
 */
function ovCentreSize(clearDiameter: number): number {
  return Math.max(14, Math.min(26, clearDiameter * 0.35));
}

/**
 * A DOM id that is safe inside `url(#…)`.
 *
 * React 19's `useId` returns delimiters that are not URL-fragment characters
 * (`«r0»`), and an SVG `fill="url(#«r0»)"` is a reference the engine may or may
 * not resolve. Stripping to word characters keeps what makes the id unique —
 * the tree position between the delimiters — and drops what makes it risky, so
 * two KPI sparklines on one page still get two different gradients.
 */
function ovSafeId(prefix: string, raw: string): string {
  return `${prefix}-${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/* ── Environment hooks ────────────────────────────────────────────────────── */

/**
 * A media query as a boolean, false until the client has answered.
 *
 * Server-rendered HTML has no viewport, no pointer and no motion preference, so
 * every one of these starts false and the first effect corrects it. Guessing
 * from a user agent instead is wrong on every tablet and on every desktop
 * browser with a touch screen.
 */
function useOvMediaQuery(query: string): boolean {
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

/** True only where a real pointer can hover. Decides tooltip versus tap-to-pin. */
function useOvHoverCapable(): boolean {
  return useOvMediaQuery("(hover: hover) and (pointer: fine)");
}

/** True when the reader has asked the operating system for less movement. */
function useOvReducedMotion(): boolean {
  return useOvMediaQuery("(prefers-reduced-motion: reduce)");
}

const OV_SWEEP_MS = 600;

/** Ease-out cubic — fast at the start, settling rather than stopping. */
const ovEaseOut = (progress: number) => 1 - (1 - progress) ** 3;

/**
 * THE ONE ANIMATION IN THE BLOCK.
 *
 * Takes the fractions a chart wants to draw and returns the fractions it should
 * draw this frame. On mount those start at 0 and ease to the targets over
 * 600ms; when the targets change they ease from whatever is currently on screen,
 * so a filter change is a movement rather than a jump and an interrupted sweep
 * does not snap back to zero first.
 *
 * The targets are re-derived from a signature string rather than depended on
 * directly. The caller builds a fresh array every render, so an effect that
 * depended on the array itself would restart the animation on every parent
 * render — including the sixty renders a second the animation itself causes.
 * Keyed on the numbers, the effect runs when the numbers change and at no other
 * time.
 *
 * With reduced motion no frame is ever requested and the targets are returned
 * as they arrived, which is what makes the reduced-motion rendering identical
 * to the end of the animation rather than an approximation of it.
 */
function useOvSweep(fractions: number[]): number[] {
  const reduced = useOvReducedMotion();
  const signature = fractions
    .map((fraction) => (Number.isFinite(fraction) ? Math.round(fraction * 10_000) / 10_000 : 0))
    .join("|");
  const target = useMemo(
    () => (signature === "" ? [] : signature.split("|").map(Number)),
    [signature],
  );

  const [shown, setShown] = useState<number[]>(() => target.map(() => 0));
  const shownRef = useRef<number[]>(shown);

  useEffect(() => {
    /*
     * REDUCED MOTION IS A RETURN, NOT A `setState`.
     *
     * Writing the targets into state here would be a synchronous set inside an
     * effect — a cascading render, and `react-hooks/set-state-in-effect` is
     * right to refuse it. Nothing needs to be stored: with motion off the hook
     * returns the targets directly below, so the geometry is the animation's
     * end state on the very first paint. The ref is still brought up to date so
     * that a reader who turns motion back on does not get one sweep out of a
     * stale shape.
     */
    if (reduced || typeof window === "undefined") {
      shownRef.current = target;
      return;
    }
    const from = target.map((_, index) => shownRef.current[index] ?? 0);
    const started = performance.now();
    let handle = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / OV_SWEEP_MS);
      const eased = ovEaseOut(progress);
      const next = target.map((value, index) => from[index] + (value - from[index]) * eased);
      shownRef.current = next;
      setShown(next);
      if (progress < 1) handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [target, reduced]);

  if (reduced) return target;
  /*
   * The state array was sized on the first render. If the caller's category
   * count has changed since — a filter that turns six trades into three — the
   * frame is short or long, and a missing entry has to read as an arc of zero
   * rather than as an arc of `undefined`: the effect above will sweep it in on
   * the next frame, which is what a category that has just appeared should do.
   */
  return target.map((_, index) => shown[index] ?? 0);
}

/**
 * TAP TO PIN, TAP AWAY TO DISMISS, ESCAPE TO CLOSE.
 *
 * The dismissal listener is on `pointerdown` rather than `click` so a tap that
 * begins outside the chart closes the tooltip before it can also press whatever
 * it landed on, and it is attached only while something is pinned — an
 * always-on document listener on a page with six charts is six listeners doing
 * nothing.
 */
function useOvPin<Key extends string | number>() {
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

  return { rootRef, pinned, setPinned, hovered, setHovered, togglePin, active: pinned ?? hovered };
}

/* ── The tooltip ──────────────────────────────────────────────────────────── */

/**
 * One tooltip shape for every chart in the block.
 *
 * `at` is a percentage across the plot, so nothing has to be measured and no
 * resize observer is needed. It is clamped away from both edges because a
 * tooltip centred on the first month of a full-width trend would otherwise hang
 * off the left of a 390px screen, and a chart that explains itself by pushing
 * the page sideways has not explained itself.
 */
function OvTip({
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
  const left = Math.min(88, Math.max(12, Number.isFinite(at) ? at : 50));
  return (
    <div
      className={`ov-tip${pinned ? " ov-tip--pinned" : ""}`}
      style={{ left: `${left}%` }}
      role="status"
    >
      <strong className="ov-tip__title">{title}</strong>
      {lines.map((line) => (
        <span className="ov-tip__line" key={line}>
          {line}
        </span>
      ))}
      {action}
    </div>
  );
}

/* ── One arc ──────────────────────────────────────────────────────────────── */

/**
 * A stroked arc, addressed as fractions of a full turn.
 *
 * `from` is where the arc starts and `sweep` how far it goes, both in turns, so
 * a caller never converts to degrees or radians and cannot get the conversion
 * the wrong way round. Twelve o'clock is whatever the enclosing group has been
 * rotated to; every ring here rotates its group rather than each arc.
 *
 * An arc of nothing renders NOTHING, and that is not an optimisation. A
 * zero-length dash with a round cap is drawn by the engine as a dot, so a
 * category with no jobs in it would sit on the ring as a small coloured pip
 * that a reader would read as a value, and every arc in the block would flash
 * one at the first frame of its own sweep.
 */
function OvArc({
  cx,
  cy,
  radius,
  width,
  colour,
  from,
  sweep,
  rounded,
  className,
  onPointerEnter,
  onPointerLeave,
  onClick,
}: {
  cx: number;
  cy: number;
  radius: number;
  width: number;
  colour: string;
  from: number;
  sweep: number;
  rounded?: boolean;
  className?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onClick?: () => void;
}) {
  const circumference = 2 * Math.PI * radius;
  const drawn = Math.max(0, Math.min(1, Number.isFinite(sweep) ? sweep : 0)) * circumference;
  if (drawn <= 0.05) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={radius}
      fill="none"
      stroke={colour}
      strokeWidth={width}
      strokeLinecap={rounded ? "round" : "butt"}
      strokeDasharray={`${drawn} ${Math.max(0.01, circumference - drawn)}`}
      strokeDashoffset={-(Number.isFinite(from) ? from : 0) * circumference}
      className={className}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onClick={onClick}
    />
  );
}

/* ── The keyboard route into a multi-slice chart ──────────────────────────── */

/**
 * A REAL BUTTON PER SLICE, NOT A `<path>` WITH AN `onClick`.
 *
 * An SVG path cannot take focus and is not in the tab order, so a chart whose
 * only controls are its arcs is a picture to anybody not holding a mouse. These
 * are ordinary HTML buttons stacked at the centre of the chart, one per slice,
 * each carrying the slice's name and numbers as its accessible name. They are
 * invisible and inert to a pointer until focused — the arcs are the pointer
 * target and they are large enough to hit — and on focus each becomes a legible
 * chip naming its slice, so a sighted keyboard reader can see where they are.
 *
 * Enter and Space activate them exactly as they activate any button.
 */
function OvSliceKeys({
  slices,
  denominator,
  activeKey,
  onFocusSlice,
  onBlurSlice,
  onActivate,
}: {
  slices: OvSlice[];
  denominator: number;
  activeKey: string | null;
  onFocusSlice: (key: string) => void;
  onBlurSlice: () => void;
  onActivate?: (slice: OvSlice) => void;
}) {
  return (
    <ul className="ov-keys">
      {slices.map((slice) => (
        <li key={slice.key}>
          <button
            type="button"
            className={`ov-keys__button${activeKey === slice.key ? " ov-keys__button--active" : ""}`}
            aria-label={`${slice.label}: ${slice.value}, ${ovPercent(slice.value, denominator)}%`}
            onFocus={() => onFocusSlice(slice.key)}
            onBlur={onBlurSlice}
            onClick={() => onActivate?.(slice)}
          >
            {slice.label} {slice.value}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The drill action a pinned tooltip carries on touch, where there is no hover. */
function OvTipAction({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="ov-tip__action" onClick={onClick}>
      View these →
    </button>
  );
}

/* ── 1. The KPI sparkline ─────────────────────────────────────────────────── */

/**
 * THE THIRTY-ONE-DAY TRACE UNDER A KPI NUMBER.
 *
 * A 1.5px line in the card's accent over a vertical wash of the same accent,
 * 18% at the line and nothing at the floor. Drawn in a `viewBox` of 0–100 with
 * `preserveAspectRatio="none"`, so every coordinate is a percentage of the box
 * and no measurement, resize observer or re-render on a window change is
 * needed; the stretch would smear the stroke, so the stroke does not scale.
 *
 * A FLAT SERIES IS NOT A DIVISION BY ZERO. The live payload's open-jobs trace
 * is thirty-one identical values, and a min-to-max scale over it has a range of
 * nought. That draws as a line down the middle of the box, which is what a
 * series that never moved looks like — not as an empty card and not as `NaN`.
 *
 * Each gradient needs an id of its own or the second KPI card on the page
 * inherits the first one's colour, which is why the id comes from `useId` and
 * not from a module-level counter that would collide across two roots.
 */
export function Sparkline({
  points,
  colour,
  ariaLabel,
}: {
  points: { day: string; value: number }[];
  colour: string;
  ariaLabel: string;
}): JSX.Element {
  const gradientId = ovSafeId("ov-spark", useId());
  const values = points.map((point) => (Number.isFinite(point.value) ? point.value : 0));
  const low = values.length > 0 ? Math.min(...values) : 0;
  const high = values.length > 0 ? Math.max(...values) : 0;
  const span = high - low;

  const targets = values.map((value) => (span > 0 ? (value - low) / span : 0.5));
  const eased = useOvSweep(targets);

  /* 6 units of headroom top and bottom so a 1.5px stroke at the extremes is not clipped. */
  const xAt = (index: number) =>
    values.length > 1 ? (index / (values.length - 1)) * 100 : 50;
  const yAt = (fraction: number) => 94 - Math.max(0, Math.min(1, fraction)) * 88;

  const line = eased.map((fraction, index) => `${xAt(index)},${yAt(fraction)}`).join(" ");
  const area =
    eased.length > 0
      ? `M ${xAt(0)},100 L ${eased.map((fraction, index) => `${xAt(index)},${yAt(fraction)}`).join(" L ")} L ${xAt(eased.length - 1)},100 Z`
      : "";

  return (
    <span className="ov-spark" role="img" aria-label={ariaLabel}>
      <svg
        className="ov-spark__svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity={0.18} />
            <stop offset="100%" stopColor={colour} stopOpacity={0} />
          </linearGradient>
        </defs>
        {area === "" ? null : <path d={area} fill={`url(#${gradientId})`} stroke="none" />}
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
    </span>
  );
}

/* ── 2. The donut ─────────────────────────────────────────────────────────── */

const DONUT_BOX = 176;
const DONUT_RADIUS = 68;
const DONUT_STROKE = 24;

/**
 * JOBS BY STATUS — a ring, a total in the middle, and the caller's legend beside it.
 *
 * The legend is deliberately not drawn here. `.ov-legend` belongs to the block
 * that composes these charts, because the same legend shape has to serve a
 * donut, a radial stack and a pair of ring meters, and because a legend that
 * lived inside the chart could not sit in the right-hand column of the card
 * where the reference puts it.
 *
 * THE RING AND THE CENTRE MAY DISAGREE, AND THAT IS THE PROP'S PURPOSE. The
 * geometry and the printed percentages both divide by the sum of the slices,
 * because a share of a ring means a share of the ring. `total` is only the
 * number in the middle. Where the two are the same — 18 + 12 + 6 + 5 + 4 open
 * jobs, 45 in the middle — nothing is visible; where a caller has a recorded
 * total that is larger than the buckets it could classify, the middle stays
 * honest instead of being back-computed from the picture.
 *
 * `ariaLabel` should name the chart — "Jobs by status" — and not repeat its
 * values: the values are appended here, so a screen-reader user hears the
 * numbers whether or not the caller remembered them.
 */
export function Donut({
  slices,
  total,
  caption,
  onSelect,
  ariaLabel,
}: {
  slices: OvSlice[];
  total: number;
  caption: string;
  onSelect?: (slice: OvSlice) => void;
  ariaLabel: string;
}): JSX.Element {
  const hoverCapable = useOvHoverCapable();
  const { rootRef, pinned, setHovered, togglePin, active } = useOvPin<string>();

  const values = slices.map((slice) => Math.max(0, Number.isFinite(slice.value) ? slice.value : 0));
  const sum = values.reduce((running, value) => running + value, 0);
  const eased = useOvSweep(values.map((value) => ovFraction(value, sum)));

  /*
   * A plain loop rather than a `map` over a running total: the React Compiler
   * lint refuses a variable reassigned inside a render callback, and it is
   * right to — the callback could outlive the render and read a total from the
   * wrong pass.
   */
  const starts: number[] = [];
  for (let index = 0, cursor = 0; index < eased.length; index += 1) {
    starts.push(cursor);
    cursor += eased[index];
  }

  const readout = slices
    .map((slice, index) => `${slice.label} ${values[index]} (${ovPercent(values[index], sum)}%)`)
    .join(", ");
  const activeIndex = slices.findIndex((slice) => slice.key === active);
  const centre = ovCentreSize(2 * (DONUT_RADIUS - DONUT_STROKE / 2) - 8);

  return (
    <div className="ov-chart" ref={rootRef}>
      {/*
        `group`, not `img`: `img` makes its whole subtree presentational, and
        every key below is a button a keyboard reader has to be able to reach.
        Where there is nothing to drill into there are no buttons, so `img` is
        both accurate and simpler.
      */}
      <div
        className="ov-chart__plot"
        role={onSelect ? "group" : "img"}
        aria-label={`${ariaLabel}: ${readout || "no data"}. ${total} ${caption}`}
      >
        <svg
          className="ov-chart__svg"
          viewBox={`0 0 ${DONUT_BOX} ${DONUT_BOX}`}
          width={DONUT_BOX}
          height={DONUT_BOX}
          aria-hidden="true"
          focusable="false"
        >
          <g transform={`rotate(-90 ${DONUT_BOX / 2} ${DONUT_BOX / 2})`}>
            <OvArc
              cx={DONUT_BOX / 2}
              cy={DONUT_BOX / 2}
              radius={DONUT_RADIUS}
              width={DONUT_STROKE}
              colour="var(--ov-track)"
              from={0}
              sweep={1}
            />
            {slices.map((slice, index) => (
              <OvArc
                key={slice.key}
                cx={DONUT_BOX / 2}
                cy={DONUT_BOX / 2}
                radius={DONUT_RADIUS}
                width={DONUT_STROKE}
                colour={slice.colour}
                from={starts[index] ?? 0}
                sweep={eased[index] ?? 0}
                className={`ov-arc${active === slice.key ? " ov-arc--active" : ""}`}
                onPointerEnter={() => {
                  if (hoverCapable) setHovered(slice.key);
                }}
                onPointerLeave={() => setHovered(null)}
                onClick={() => {
                  if (hoverCapable && onSelect) onSelect(slice);
                  else togglePin(slice.key);
                }}
              />
            ))}
          </g>
        </svg>
        <span className="ov-chart__centre" style={{ fontSize: `${centre}px` }} aria-hidden="true">
          <strong className="ov-chart__centre-value">{Number.isFinite(total) ? total : 0}</strong>
          <small className="ov-chart__centre-caption">{caption}</small>
        </span>
        {onSelect ? (
          <OvSliceKeys
            slices={slices}
            denominator={sum}
            activeKey={typeof active === "string" ? active : null}
            onFocusSlice={setHovered}
            onBlurSlice={() => setHovered(null)}
            onActivate={onSelect}
          />
        ) : null}
        {activeIndex >= 0 ? (
          <OvTip
            at={50}
            pinned={pinned === slices[activeIndex].key}
            title={slices[activeIndex].label}
            lines={[
              `${values[activeIndex]} of ${sum}`,
              `${ovPercent(values[activeIndex], sum)}%`,
            ]}
            action={
              onSelect && pinned === slices[activeIndex].key ? (
                <OvTipAction onClick={() => onSelect(slices[activeIndex])} />
              ) : null
            }
          />
        ) : null}
      </div>
    </div>
  );
}

/* ── 3. The speedometer ───────────────────────────────────────────────────── */

const SPEEDO_WIDTH = 200;
const SPEEDO_HEIGHT = 152;
const SPEEDO_CX = 100;
const SPEEDO_CY = 100;
const SPEEDO_RADIUS = 76;
const SPEEDO_STROKE = 12;

/**
 * WIDGET A, LEFT HALF — a 180° gauge with a needle.
 *
 * The arc's colour is the caller's, not this component's. Whether 26% on time
 * is red, amber or green is a judgement about the business that belongs where
 * the thresholds are, and a gauge that decided its own colour would quietly
 * hold a second, disagreeing copy of them.
 *
 * THE READOUT SITS UNDER THE PIVOT, NOT INSIDE THE ARC. A 180° needle sweeps
 * through the entire interior of its own semicircle, so at 50% it passes
 * straight through wherever a centred number would be. Every alternative —
 * shortening the needle, hiding it behind a disc the width of the number,
 * fading it under the text — either breaks the gauge or makes the number hard
 * to read at one particular value, which is the worst possible place to put a
 * defect. Below the pivot the two can never collide, at any percentage.
 */
export function Speedometer({
  percent,
  caption,
  colour,
  onSelect,
  ariaLabel,
}: {
  percent: number;
  caption: string;
  colour: string;
  onSelect?: () => void;
  ariaLabel: string;
}): JSX.Element {
  const safe = Math.max(0, Math.min(100, Number.isFinite(percent) ? Math.round(percent) : 0));
  const [eased] = useOvSweep([safe / 100]);
  const fraction = eased ?? 0;

  /* The one place in this file that needs a cosine: the needle and the ticks. */
  const pointAt = (turn: number, radius: number) => {
    const angle = Math.PI - turn * Math.PI;
    return {
      x: SPEEDO_CX + radius * Math.cos(angle),
      y: SPEEDO_CY - radius * Math.sin(angle),
    };
  };
  const tip = pointAt(fraction, SPEEDO_RADIUS - 16);

  const body = (
    <span className="ov-gauge__body">
      <svg
        className="ov-chart__svg"
        viewBox={`0 0 ${SPEEDO_WIDTH} ${SPEEDO_HEIGHT}`}
        width={SPEEDO_WIDTH}
        height={SPEEDO_HEIGHT}
        aria-hidden="true"
        focusable="false"
      >
        {/*
          Rotating the group by 180° puts the circle's start point at nine
          o'clock, so the first half of the path is exactly the top semicircle
          and the track is a dasharray of half the circumference.
        */}
        <g transform={`rotate(180 ${SPEEDO_CX} ${SPEEDO_CY})`}>
          <OvArc
            cx={SPEEDO_CX}
            cy={SPEEDO_CY}
            radius={SPEEDO_RADIUS}
            width={SPEEDO_STROKE}
            colour="var(--ov-track)"
            from={0}
            sweep={0.5}
            rounded
          />
          <OvArc
            cx={SPEEDO_CX}
            cy={SPEEDO_CY}
            radius={SPEEDO_RADIUS}
            width={SPEEDO_STROKE}
            colour={colour}
            from={0}
            sweep={fraction * 0.5}
            rounded
          />
        </g>
        {[0, 0.25, 0.5, 0.75, 1].map((turn) => {
          const inner = pointAt(turn, SPEEDO_RADIUS + 8);
          const outer = pointAt(turn, SPEEDO_RADIUS + 13);
          return (
            <line
              key={turn}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="var(--ov-text-muted)"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        })}
        <line
          x1={SPEEDO_CX}
          y1={SPEEDO_CY}
          x2={tip.x}
          y2={tip.y}
          stroke="var(--ov-text)"
          strokeOpacity={0.85}
          strokeWidth={2}
          strokeLinecap="round"
        />
        <circle cx={SPEEDO_CX} cy={SPEEDO_CY} r={5} fill="var(--ov-text)" fillOpacity={0.85} />
      </svg>
      <span className="ov-gauge__readout" aria-hidden="true">
        <strong className="ov-chart__centre-value" style={{ fontSize: "26px" }}>
          {safe}%
        </strong>
        <small className="ov-chart__centre-caption">{caption}</small>
      </span>
    </span>
  );

  const label = `${ariaLabel}: ${safe}%, ${caption}`;
  return (
    <div className="ov-chart ov-gauge">
      {onSelect ? (
        <button type="button" className="ov-gauge__hit" aria-label={label} onClick={onSelect}>
          {body}
        </button>
      ) : (
        <span className="ov-gauge__hit" role="img" aria-label={label}>
          {body}
        </span>
      )}
    </div>
  );
}

/* ── 4. The ring meter ────────────────────────────────────────────────────── */

const RING_BOX = 76;
const RING_STROKE = 8;
const RING_RADIUS = (RING_BOX - RING_STROKE) / 2;

/**
 * WIDGET A, RIGHT HALF — one small ring per sub-count.
 *
 * The centre carries the COUNT, not the percentage, because the count is the
 * thing a maintenance manager acts on: seven units requiring attention is a
 * morning's work whether it is 7% of the estate or 70% of it. The share is in
 * the ring, in the accessible name, and in the tooltip.
 *
 * It has no `ariaLabel` prop by design — a ring meter's label, value and total
 * are all already here, so the accessible name is composed from them and cannot
 * drift away from what is drawn.
 */
export function RingMeter({
  value,
  total,
  label,
  colour,
  onSelect,
}: {
  value: number;
  total: number;
  label: string;
  colour: string;
  onSelect?: () => void;
}): JSX.Element {
  const hoverCapable = useOvHoverCapable();
  const { rootRef, pinned, setHovered, togglePin, active } = useOvPin<string>();
  const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
  const safeTotal = Math.max(0, Number.isFinite(total) ? total : 0);
  const [eased] = useOvSweep([ovFraction(safeValue, safeTotal)]);
  const centre = ovCentreSize(2 * (RING_RADIUS - RING_STROKE / 2) - 6);
  const percent = ovPercent(safeValue, safeTotal);
  const name = `${label}: ${safeValue} of ${safeTotal}, ${percent}%`;

  const body = (
    <span className="ov-ring__body">
      <span className="ov-chart__plot">
        <svg
          className="ov-chart__svg"
          viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
          width={RING_BOX}
          height={RING_BOX}
          aria-hidden="true"
          focusable="false"
        >
          <g transform={`rotate(-90 ${RING_BOX / 2} ${RING_BOX / 2})`}>
            <OvArc
              cx={RING_BOX / 2}
              cy={RING_BOX / 2}
              radius={RING_RADIUS}
              width={RING_STROKE}
              colour="var(--ov-track)"
              from={0}
              sweep={1}
            />
            <OvArc
              cx={RING_BOX / 2}
              cy={RING_BOX / 2}
              radius={RING_RADIUS}
              width={RING_STROKE}
              colour={colour}
              from={0}
              sweep={eased ?? 0}
              rounded
            />
          </g>
        </svg>
        <span className="ov-chart__centre" style={{ fontSize: `${centre}px` }} aria-hidden="true">
          <strong className="ov-chart__centre-value">{safeValue}</strong>
        </span>
      </span>
      <span className="ov-ring__label" aria-hidden="true">
        {label}
      </span>
    </span>
  );

  return (
    <div className="ov-chart ov-ring" ref={rootRef}>
      {onSelect ? (
        <button
          type="button"
          className="ov-ring__hit"
          aria-label={name}
          onPointerEnter={() => {
            if (hoverCapable) setHovered(label);
          }}
          onPointerLeave={() => setHovered(null)}
          onFocus={() => setHovered(label)}
          onBlur={() => setHovered(null)}
          onClick={onSelect}
        >
          {body}
        </button>
      ) : (
        <span
          className="ov-ring__hit"
          role="img"
          aria-label={name}
          onPointerEnter={() => {
            if (hoverCapable) setHovered(label);
          }}
          onPointerLeave={() => setHovered(null)}
          onClick={() => togglePin(label)}
        >
          {body}
        </span>
      )}
      {active === label ? (
        <OvTip
          at={50}
          pinned={pinned === label}
          title={label}
          lines={[`${safeValue} of ${safeTotal}`, `${percent}%`]}
        />
      ) : null}
    </div>
  );
}

/* ── 5. The radial bars ───────────────────────────────────────────────────── */

const RADIAL_BOX = 216;
const RADIAL_OUTER = 100;
const RADIAL_STROKE = 7;
const RADIAL_PITCH = 11;
const RADIAL_SWEEP = 0.75;

/**
 * WIDGET B — concentric radial bars, outermost the largest, 270° at full length.
 *
 * A ring per category rather than a slice per category, because these are
 * counts to be COMPARED, not parts of one whole: the eye reads two arc lengths
 * on two concentric tracks far more accurately than two wedge angles, and the
 * comparison stays honest when a category is missing.
 *
 * The scale is relative to the LARGEST category, which is what makes the shape
 * legible — the biggest bar always fills its track, so the picture uses its
 * full range whether the leader has four jobs or four hundred. The percentages
 * in the tooltip and in the accessible name are of the TOTAL, not of the
 * leader, so nothing is misread as a share.
 *
 * A 7px bar with a 4px gap is the specification and it is what six categories
 * get. Beyond seven the gap tightens rather than the innermost ring
 * disappearing, and the number in the middle is sized from whatever hole is
 * left, so a caller that hands this fifteen trades gets a crowded but correct
 * chart rather than a ring drawn through its own caption.
 */
export function RadialRings({
  slices,
  total,
  caption,
  onSelect,
  ariaLabel,
}: {
  slices: OvSlice[];
  total: number;
  caption: string;
  onSelect?: (slice: OvSlice) => void;
  ariaLabel: string;
}): JSX.Element {
  const hoverCapable = useOvHoverCapable();
  const { rootRef, pinned, setHovered, togglePin, active } = useOvPin<string>();

  const ordered = useMemo(
    () =>
      [...slices].sort(
        (left, right) =>
          (Number.isFinite(right.value) ? right.value : 0) -
          (Number.isFinite(left.value) ? left.value : 0),
      ),
    [slices],
  );
  const values = ordered.map((slice) => Math.max(0, Number.isFinite(slice.value) ? slice.value : 0));
  const largest = values.length > 0 ? Math.max(...values) : 0;
  const sum = values.reduce((running, value) => running + value, 0);
  const eased = useOvSweep(values.map((value) => ovFraction(value, largest)));

  const count = Math.max(1, ordered.length);
  const pitch =
    count > 1
      ? Math.max(RADIAL_STROKE + 1, Math.min(RADIAL_PITCH, (RADIAL_OUTER - 30) / (count - 1)))
      : RADIAL_PITCH;
  const innermost = RADIAL_OUTER - (count - 1) * pitch;
  const centre = ovCentreSize(Math.max(28, 2 * (innermost - RADIAL_STROKE / 2) - 8));

  const readout = ordered
    .map((slice, index) => `${slice.label} ${values[index]} (${ovPercent(values[index], sum)}%)`)
    .join(", ");
  const activeIndex = ordered.findIndex((slice) => slice.key === active);

  return (
    <div className="ov-chart" ref={rootRef}>
      <div
        className="ov-chart__plot"
        role={onSelect ? "group" : "img"}
        aria-label={`${ariaLabel}: ${readout || "no data"}. ${total} ${caption}`}
      >
        <svg
          className="ov-chart__svg"
          viewBox={`0 0 ${RADIAL_BOX} ${RADIAL_BOX}`}
          width={RADIAL_BOX}
          height={RADIAL_BOX}
          aria-hidden="true"
          focusable="false"
        >
          <g transform={`rotate(-90 ${RADIAL_BOX / 2} ${RADIAL_BOX / 2})`}>
            {(ordered.length > 0 ? ordered : [null]).map((slice, index) => {
              const radius = RADIAL_OUTER - index * pitch;
              return (
                <OvArc
                  key={slice ? `${slice.key}-track` : "empty-track"}
                  cx={RADIAL_BOX / 2}
                  cy={RADIAL_BOX / 2}
                  radius={radius}
                  width={RADIAL_STROKE}
                  colour="var(--ov-track)"
                  from={0}
                  sweep={RADIAL_SWEEP}
                  rounded
                />
              );
            })}
            {ordered.map((slice, index) => (
              <OvArc
                key={slice.key}
                cx={RADIAL_BOX / 2}
                cy={RADIAL_BOX / 2}
                radius={RADIAL_OUTER - index * pitch}
                width={RADIAL_STROKE}
                colour={slice.colour}
                from={0}
                sweep={(eased[index] ?? 0) * RADIAL_SWEEP}
                rounded
                className={`ov-arc${active === slice.key ? " ov-arc--active" : ""}`}
                onPointerEnter={() => {
                  if (hoverCapable) setHovered(slice.key);
                }}
                onPointerLeave={() => setHovered(null)}
                onClick={() => {
                  if (hoverCapable && onSelect) onSelect(slice);
                  else togglePin(slice.key);
                }}
              />
            ))}
          </g>
        </svg>
        <span className="ov-chart__centre" style={{ fontSize: `${centre}px` }} aria-hidden="true">
          <strong className="ov-chart__centre-value">{Number.isFinite(total) ? total : 0}</strong>
          <small className="ov-chart__centre-caption">{caption}</small>
        </span>
        {onSelect ? (
          <OvSliceKeys
            slices={ordered}
            denominator={sum}
            activeKey={typeof active === "string" ? active : null}
            onFocusSlice={setHovered}
            onBlurSlice={() => setHovered(null)}
            onActivate={onSelect}
          />
        ) : null}
        {activeIndex >= 0 ? (
          <OvTip
            at={50}
            pinned={pinned === ordered[activeIndex].key}
            title={ordered[activeIndex].label}
            lines={[
              `${values[activeIndex]} of ${sum}`,
              `${ovPercent(values[activeIndex], sum)}%`,
            ]}
            action={
              onSelect && pinned === ordered[activeIndex].key ? (
                <OvTipAction onClick={() => onSelect(ordered[activeIndex])} />
              ) : null
            }
          />
        ) : null}
      </div>
    </div>
  );
}

/* ── 6. The horseshoe ─────────────────────────────────────────────────────── */

const HORSESHOE_WIDTH = 190;
const HORSESHOE_HEIGHT = 168;
const HORSESHOE_CENTRE = 95;
const HORSESHOE_RADIUS = 76;
const HORSESHOE_STROKE = 14;

/**
 * THE COMPLIANCE GAUGE FROM THE REFERENCE — 270°, open at the bottom.
 *
 * Rotating the circle's group by 135° puts its start point at the bottom left,
 * so three quarters of the path travel up the left, over the top and down the
 * right, and the quarter that is never drawn is the gap the shape is named for.
 * The `viewBox` is cropped to where the arc actually ends rather than to a
 * square, which is why the card's gauge is wider than it is tall.
 *
 * `caption` is the word inside the ring, under the percentage — "On track" —
 * and `sub` is the sentence beneath the whole gauge — "276 of 300 requirements
 * on track". Both are in the accessible name, in that order, so the reading is
 * the same whichever way round a caller supplies them.
 */
export function Horseshoe({
  percent,
  caption,
  sub,
  colour,
  onSelect,
  ariaLabel,
}: {
  percent: number;
  caption: string;
  sub: string;
  colour: string;
  onSelect?: () => void;
  ariaLabel: string;
}): JSX.Element {
  const safe = Math.max(0, Math.min(100, Number.isFinite(percent) ? Math.round(percent) : 0));
  const [eased] = useOvSweep([safe / 100]);

  const body = (
    <span className="ov-gauge__body">
      <span className="ov-chart__plot">
        <svg
          className="ov-chart__svg"
          viewBox={`0 0 ${HORSESHOE_WIDTH} ${HORSESHOE_HEIGHT}`}
          width={HORSESHOE_WIDTH}
          height={HORSESHOE_HEIGHT}
          aria-hidden="true"
          focusable="false"
        >
          <g transform={`rotate(135 ${HORSESHOE_CENTRE} ${HORSESHOE_CENTRE})`}>
            <OvArc
              cx={HORSESHOE_CENTRE}
              cy={HORSESHOE_CENTRE}
              radius={HORSESHOE_RADIUS}
              width={HORSESHOE_STROKE}
              colour="var(--ov-track)"
              from={0}
              sweep={0.75}
              rounded
            />
            <OvArc
              cx={HORSESHOE_CENTRE}
              cy={HORSESHOE_CENTRE}
              radius={HORSESHOE_RADIUS}
              width={HORSESHOE_STROKE}
              colour={colour}
              from={0}
              sweep={(eased ?? 0) * 0.75}
              rounded
            />
          </g>
        </svg>
        <span className="ov-chart__centre ov-chart__centre--horseshoe" aria-hidden="true">
          <strong className="ov-chart__centre-value" style={{ fontSize: "26px" }}>
            {safe}%
          </strong>
          <small className="ov-chart__centre-caption">{caption}</small>
        </span>
      </span>
      <span className="ov-gauge__sub" aria-hidden="true">
        {sub}
      </span>
    </span>
  );

  const label = `${ariaLabel}: ${safe}%, ${caption}. ${sub}`;
  return (
    <div className="ov-chart ov-gauge">
      {onSelect ? (
        <button type="button" className="ov-gauge__hit" aria-label={label} onClick={onSelect}>
          {body}
        </button>
      ) : (
        <span className="ov-gauge__hit" role="img" aria-label={label}>
          {body}
        </span>
      )}
    </div>
  );
}

/* ── 7. The spend trend ───────────────────────────────────────────────────── */

/**
 * SPEND OVER THE PERIOD — an area under a line, with a dot on every month.
 *
 * The plot is one stretched `viewBox` for the same reason the sparkline is: a
 * polyline needs a coordinate space, and percentages of the box need no
 * measurement. The DOTS are not in it. A circle in a box stretched to a card's
 * width would be drawn as an ellipse and would change shape as the column
 * resized, so each dot is an HTML span positioned at `left`/`top` percentages,
 * which stays round at every width and costs no measurement either.
 *
 * The hit areas are real buttons, one per month, each a full-height column of
 * the plot. That is what makes the chart keyboard-reachable, and it is also the
 * only tap target on it that a finger can hit: a 1.5px line cannot be tapped
 * and a 7px dot is a tenth of the 44px floor.
 *
 * AN EMPTY PERIOD IS AN AXIS OF `£0` AND A LINE ON THE FLOOR. Ten of the live
 * payload's twelve months are zero and a nice ceiling of nothing is nothing, so
 * the axis prints a single `£0` rather than four ticks that all say the same
 * thing, and no month is ever divided by it.
 */
export function AreaTrend({
  points,
  onSelect,
  ariaLabel,
}: {
  points: { label: string; pence: number }[];
  onSelect?: (point: { label: string; pence: number }, index: number) => void;
  ariaLabel: string;
}): JSX.Element {
  const hoverCapable = useOvHoverCapable();
  const { rootRef, pinned, setHovered, togglePin, active } = useOvPin<number>();
  const gradientId = ovSafeId("ov-trend", useId());

  const values = points.map((point) => Math.max(0, Number.isFinite(point.pence) ? point.pence : 0));
  const ceiling = ovNiceCeiling(values.length > 0 ? Math.max(...values) : 0);
  const sum = values.reduce((running, value) => running + value, 0);
  const eased = useOvSweep(values.map((value) => ovFraction(value, ceiling)));

  const xAt = (index: number) => (values.length > 1 ? (index / (values.length - 1)) * 100 : 50);
  const yAt = (fraction: number) => 96 - Math.max(0, Math.min(1, fraction)) * 92;

  /*
   * THE HIT COLUMN IS THE BAND AROUND ITS OWN POINT, NOT AN EQUAL SLICE.
   *
   * The line runs edge to edge — the first month is at 0% and the last at 100%,
   * which is what the reference shows — so twelve equal columns would each be
   * offset half a column from the dot they belong to and the last one would
   * point at nothing. Each column instead covers half the gap either side of
   * its own point and is clipped at the plot's edges, so the first and last are
   * half-width and every tap lands on the month under the finger.
   */
  const spacing = values.length > 1 ? 100 / (values.length - 1) : 100;
  const bandAt = (index: number) => {
    const from = Math.max(0, xAt(index) - spacing / 2);
    const to = Math.min(100, xAt(index) + spacing / 2);
    return { left: from, width: Math.max(0, to - from) };
  };

  const line = eased.map((fraction, index) => `${xAt(index)},${yAt(fraction)}`).join(" ");
  const area =
    eased.length > 0
      ? `M ${xAt(0)},100 L ${eased.map((fraction, index) => `${xAt(index)},${yAt(fraction)}`).join(" L ")} L ${xAt(eased.length - 1)},100 Z`
      : "";

  const ticks = ceiling > 0 ? [1, 0.75, 0.5, 0.25, 0] : [0];
  const readout = points
    .map((point, index) => `${point.label} ${ovPoundsExact(values[index])}`)
    .join(", ");
  const activeIndex = typeof active === "number" ? active : -1;

  return (
    <div className="ov-trend" ref={rootRef}>
      <div className="ov-trend__axis" aria-hidden="true">
        {ticks.map((tick) => (
          <span className="ov-trend__axis-tick" key={tick}>
            {ovPoundsShort(ceiling * tick)}
          </span>
        ))}
      </div>
      <div
        className="ov-chart__plot ov-trend__plot"
        role="group"
        aria-label={`${ariaLabel}: ${readout || "no data"}`}
      >
        <svg
          className="ov-trend__svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ov-teal)" stopOpacity={0.34} />
              <stop offset="100%" stopColor="var(--ov-teal)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {ticks.map((tick) => (
            <line
              key={tick}
              x1={0}
              y1={yAt(tick)}
              x2={100}
              y2={yAt(tick)}
              stroke="var(--ov-divider)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {area === "" ? null : <path d={area} fill={`url(#${gradientId})`} stroke="none" />}
          {eased.length > 1 ? (
            <polyline
              points={line}
              fill="none"
              stroke="var(--ov-teal)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {eased.map((fraction, index) => (
          <span
            className={`ov-trend__dot${activeIndex === index ? " ov-trend__dot--active" : ""}`}
            key={points[index].label}
            style={{ left: `${xAt(index)}%`, top: `${yAt(fraction)}%` }}
            aria-hidden="true"
          />
        ))}
        <ul className="ov-trend__hits">
          {points.map((point, index) => (
            <li
              key={point.label}
              className="ov-trend__hit-slot"
              style={{ left: `${bandAt(index).left}%`, width: `${bandAt(index).width}%` }}
            >
              <button
                type="button"
                className={`ov-trend__hit${activeIndex === index ? " ov-trend__hit--active" : ""}`}
                aria-label={`${point.label}: ${ovPoundsExact(values[index])}, ${ovPercent(values[index], sum)}% of the period`}
                onPointerEnter={() => {
                  if (hoverCapable) setHovered(index);
                }}
                onPointerLeave={() => setHovered(null)}
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered(null)}
                onClick={() => {
                  if (hoverCapable && onSelect) onSelect(point, index);
                  else togglePin(index);
                }}
              />
            </li>
          ))}
        </ul>
        {activeIndex >= 0 ? (
          <OvTip
            at={xAt(activeIndex)}
            pinned={pinned === activeIndex}
            title={points[activeIndex].label}
            lines={[
              ovPoundsExact(values[activeIndex]),
              `${ovPercent(values[activeIndex], sum)}% of the period`,
            ]}
            action={
              onSelect && pinned === activeIndex ? (
                <OvTipAction onClick={() => onSelect(points[activeIndex], activeIndex)} />
              ) : null
            }
          />
        ) : null}
      </div>
      {/*
        The month labels are positioned at their own points rather than laid out
        as equal columns, for the same reason the hit columns are: the line runs
        edge to edge, so an evenly divided row would put every label half a slot
        away from the dot it names. The first and last are pulled inside the
        plot instead of hanging off it.
      */}
      <ul className="ov-trend__ticks" aria-hidden="true">
        {points.map((point, index) => (
          <li className="ov-trend__tick" key={point.label} style={{ left: `${xAt(index)}%` }}>
            {point.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
