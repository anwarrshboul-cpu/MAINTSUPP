"use client";

/**
 * THE COMPLIANCE BLOCK'S OWN CHART SHAPE — the segmented ring meter, and the
 * grid of them that is "Compliance by type".
 *
 * Everything else the block draws — the score donut, the countdown rings, the
 * "Who's renewing" donut and the sites speedometer — is the Overview's own
 * component from `ov-dash-charts.tsx`, reused as it shipped. This file holds
 * the one shape that module does not have: a ring split into the four status
 * segments, in the score donut's colours and order, so the eye reads a type
 * ring and the score donut the same way.
 *
 * It is a new SHAPE, not a new animation, tooltip or arc model. The sweep is
 * `useOvSweep`, the tap-to-pin and tap-away dismissal are `useOvPin`, the arcs
 * are `OvArc` and the tooltip is `OvTip` — so this block sweeps, pins, dismisses
 * and honours reduced motion exactly as the Overview does.
 *
 * ── IT DRAWS; IT DOES NOT COUNT ───────────────────────────────────────────
 *
 * Every value arrives from the composer, which takes it from the payload. The
 * only arithmetic here is geometry — where on the ring a segment starts — and
 * the share printed beside a count in a tooltip, which is presentation of two
 * numbers already on screen.
 *
 * ── ROUNDED CAPS WITH A 2PX GAP, AND THE SEGMENT TOO SMALL FOR EITHER ─────
 *
 * The brief asks for rounded caps AND 2px gaps. A round cap extends half the
 * stroke past each end of its dash, so a segment's dash is its arc MINUS the
 * gap MINUS one stroke width — which leaves the visible gap at exactly 2px.
 *
 * That subtraction has a failure the Overview's butt-capped donut does not: on
 * this estate a type ring is typically thirty requirements, and one expired
 * certificate is a 3% arc — about 8px on an 84px ring, less than the 10px the
 * caps and gap consume. Subtracted naively it would vanish, and the ring would
 * show no red while the dot beside it said there was some. So a segment too
 * short for its own caps is drawn as a DOT at the centre of its slot, one
 * stroke wide, painted last so it sits on its neighbours rather than under
 * them. A count of one is always visible; it is never widened into a claim.
 *
 * ── WHY THE TOOLTIP BELONGS TO THE GRID, NOT TO A TILE ────────────────────
 *
 * A tile is 64px of ring in a ~74px column on a phone, and `OvTip` is at least
 * 128px wide. Centred on a tile in the first or last column it would hang past
 * the card and, on the right, past the viewport — a chart that explains itself
 * by scrolling the page sideways. So there is one tooltip for the whole grid,
 * placed under the tile that asked for it and clamped so its widest possible
 * box stays inside the grid. The position is read from the tile when a pointer,
 * a focus or a tap arrives — never in render, and with no resize observer.
 */

import { useCallback, useEffect, useState, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import {
  OvArc,
  OvTip,
  OvTipAction,
  ovFraction,
  useOvHoverCapable,
  useOvPin,
  useOvSweep,
} from "./ov-dash-charts";

/* ── Shapes ───────────────────────────────────────────────────────────────── */

/** One status segment of a ring, in drawing order (clockwise from twelve). */
export type CpSegment = { key: string; value: number; colour: string };

/**
 * One tile of the "Compliance by type" grid, with every word it prints already
 * composed — the composer owns the vocabulary and the payload owns the numbers.
 */
export type CpTypeTile = {
  key: string;
  /** The full requirement name; clamped to two lines under the ring. */
  label: string;
  /** What the centre prints — the payload's whole percent compliant. */
  centre: string;
  /** The muted `x/y` under the name. */
  count: string;
  segments: CpSegment[];
  /** Whether the red dot is drawn — the type has at least one Expired record. */
  flagged: boolean;
  /** The ring button's accessible name: the figures and where it goes. */
  ringName: string;
  /** The dot button's accessible name. */
  flagName: string;
  /** The tooltip's lines, under the full name. */
  tipLines: string[];
};

/* ── Environment ──────────────────────────────────────────────────────────── */

/**
 * The brief sizes a type ring by tier — 84px at 768 and up, 64px below — and
 * keeps the stroke at 8px in both. Scaling one drawing with CSS would thin the
 * stroke to 6px on a phone, so the geometry is drawn for the tier instead.
 *
 * False until the client answers, like every media hook in this block. The
 * grid is never drawn before the first payload lands, and by then this has
 * answered, so no reader sees the ring resize.
 */
function useCpMediaQuery(query: string): boolean {
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

/** 768 is the agreed breakpoint the brief's "mobile" tier ends at. */
const CP_WIDE_QUERY = "(min-width: 768px)";

const RING_DESKTOP = 84;
const RING_MOBILE = 64;
const RING_STROKE = 8;
const RING_GAP = 2;

/* ── The segmented ring ───────────────────────────────────────────────────── */

/**
 * ONE RING, FOUR SEGMENTS — Compliant, Expiring soon, Expired, Missing, in
 * that order clockwise from twelve o'clock, over an `--ov-track` ring.
 *
 * The centre is SVG text rather than a positioned span, so it scales with the
 * ring when a 320px screen shrinks the drawing below its natural size: a span
 * would keep its 16px and overprint the stroke.
 */
export function SegmentedRing({
  size,
  segments,
  centre,
  stroke = RING_STROKE,
  gap = RING_GAP,
}: {
  size: number;
  segments: CpSegment[];
  centre: string;
  stroke?: number;
  gap?: number;
}): JSX.Element {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const values = segments.map((segment) =>
    Math.max(0, Number.isFinite(segment.value) ? segment.value : 0),
  );
  const sum = values.reduce((running, value) => running + value, 0);
  const targets = values.map((value) => ovFraction(value, sum));
  const eased = useOvSweep(targets);

  /* A plain loop rather than a running total inside `map` — the React Compiler
     lint refuses a variable reassigned inside a render callback. */
  const starts: number[] = [];
  for (let index = 0, cursor = 0; index < eased.length; index += 1) {
    starts.push(cursor);
    cursor += eased[index] ?? 0;
  }

  /*
   * The gap and both caps come out of each segment, so the ring still closes
   * on itself. With one segment there is nothing to separate: it is a closed
   * ring, exactly as a single-status type should read.
   */
  const present = values.filter((value) => value > 0).length;
  const reserve = present > 1 ? gap + stroke : 0;
  const dotTurn = 0.1 / circumference;
  const half = size / 2;
  const fontSize = size >= 80 ? 18 : 16;

  const arcs: JSX.Element[] = [];
  const dots: JSX.Element[] = [];
  segments.forEach((segment, index) => {
    const target = targets[index] ?? 0;
    const share = eased[index] ?? 0;
    if (target <= 0) return;
    const start = starts[index] ?? 0;
    if (present > 1 && target * circumference <= reserve) {
      /* Too short for its caps and gap: a dot at the centre of its slot, faded
         in with the sweep rather than parked at twelve o'clock from frame one. */
      dots.push(
        <g key={segment.key} opacity={ovFraction(share, target)}>
          <OvArc
            cx={half}
            cy={half}
            radius={radius}
            width={stroke}
            colour={segment.colour}
            from={start + share / 2 - dotTurn / 2}
            sweep={dotTurn}
            rounded
          />
        </g>,
      );
      return;
    }
    const drawn = share * circumference - reserve;
    if (drawn <= 0) return;
    arcs.push(
      <OvArc
        key={segment.key}
        cx={half}
        cy={half}
        radius={radius}
        width={stroke}
        colour={segment.colour}
        from={start + reserve / 2 / circumference}
        sweep={drawn / circumference}
        rounded
      />,
    );
  });

  return (
    <svg
      className="ov-chart__svg cp-ring__svg"
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g transform={`rotate(-90 ${half} ${half})`}>
        <OvArc
          cx={half}
          cy={half}
          radius={radius}
          width={stroke}
          colour="var(--ov-track)"
          from={0}
          sweep={1}
        />
        {arcs}
        {dots}
      </g>
      <text
        className="cp-ring__centre"
        x={half}
        y={half}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
      >
        {centre}
      </text>
    </svg>
  );
}

/* ── The grid ─────────────────────────────────────────────────────────────── */

/** Where the one tooltip sits: a percentage across the grid, and a top in px. */
type TipPlace = { at: number; top: number };

/**
 * The widest the tooltip can be (`.cp-types .ov-tip`'s max-width), halved. The
 * anchor is clamped this far from both edges of the grid, so no tooltip can
 * leave it whatever its content turns out to be.
 */
const TIP_HALF_WIDTH = 100;

/**
 * "COMPLIANCE BY TYPE" — a grid of segmented rings, worst first, as the
 * payload ordered them.
 *
 * On a pointer that can hover, hovering shows the tooltip and a click opens the
 * register on that type — the red dot on that type's Expired records. On
 * touch, a tap pins the tooltip and its buttons do the opening, exactly as the
 * Overview's donut behaves: a 64px ring's corner is no place for a second tap
 * target, and those buttons are the 44px targets the brief asks for. The dot
 * is still its own button for a mouse and for the keyboard.
 */
export function CpTypeGrid({
  tiles,
  ariaLabel,
  onSelect,
  onSelectFlag,
}: {
  tiles: CpTypeTile[];
  ariaLabel: string;
  onSelect: (key: string) => void;
  onSelectFlag: (key: string) => void;
}): JSX.Element {
  const hoverCapable = useOvHoverCapable();
  const wide = useCpMediaQuery(CP_WIDE_QUERY);
  const size = wide ? RING_DESKTOP : RING_MOBILE;
  const { rootRef, pinned, setHovered, togglePin, active } = useOvPin<string>();
  const [places, setPlaces] = useState<Record<string, TipPlace>>({});

  /** Read the tile's position from the element that was pointed at, focused or tapped. */
  const place = useCallback(
    (element: HTMLElement, key: string) => {
      const grid = rootRef.current;
      const tile = element.closest<HTMLElement>(".cp-type");
      if (!grid || !tile) return;
      const plot = tile.querySelector<HTMLElement>(".cp-type__plot");
      const width = grid.clientWidth;
      if (width <= 0) return;
      const halfWidth = Math.min(TIP_HALF_WIDTH, width / 2);
      const centre = tile.offsetLeft + tile.offsetWidth / 2;
      const x = Math.min(Math.max(centre, halfWidth), width - halfWidth);
      const top =
        tile.offsetTop + (plot ? plot.offsetTop + plot.offsetHeight : tile.offsetHeight) + 2;
      setPlaces((current) => ({ ...current, [key]: { at: (x / width) * 100, top } }));
    },
    [rootRef],
  );

  const hover = (event: ReactPointerEvent<HTMLElement>, key: string) => {
    if (!hoverCapable) return;
    place(event.currentTarget, key);
    setHovered(key);
  };

  const activeTile = tiles.find((tile) => tile.key === active) ?? null;
  const activePlace = activeTile ? places[activeTile.key] : undefined;

  return (
    <div className="cp-types" ref={rootRef} role="group" aria-label={ariaLabel}>
      {tiles.map((tile) => (
        <div className="cp-type" key={tile.key}>
          <button
            type="button"
            className={`cp-type__hit${active === tile.key ? " cp-type__hit--active" : ""}`}
            aria-label={tile.ringName}
            onPointerEnter={(event) => hover(event, tile.key)}
            onPointerLeave={() => setHovered(null)}
            onFocus={(event) => {
              place(event.currentTarget, tile.key);
              setHovered(tile.key);
            }}
            onBlur={() => setHovered(null)}
            onClick={(event) => {
              if (hoverCapable) {
                onSelect(tile.key);
                return;
              }
              place(event.currentTarget, tile.key);
              togglePin(tile.key);
            }}
          >
            <span className="cp-type__plot">
              <SegmentedRing size={size} segments={tile.segments} centre={tile.centre} />
            </span>
            <span className="cp-type__name" aria-hidden="true">
              {tile.label}
            </span>
            <span className="cp-type__count" aria-hidden="true">
              {tile.count}
            </span>
          </button>
          {tile.flagged ? (
            <button
              type="button"
              className="cp-type__flag"
              aria-label={tile.flagName}
              onPointerEnter={(event) => hover(event, tile.key)}
              onPointerLeave={() => setHovered(null)}
              onFocus={(event) => {
                place(event.currentTarget, tile.key);
                setHovered(tile.key);
              }}
              onBlur={() => setHovered(null)}
              onClick={() => onSelectFlag(tile.key)}
            />
          ) : null}
        </div>
      ))}
      {activeTile && activePlace ? (
        <div className="cp-types__tip" style={{ top: `${activePlace.top}px` }}>
          <OvTip
            at={activePlace.at}
            pinned={pinned === activeTile.key}
            title={activeTile.label}
            lines={activeTile.tipLines}
            action={
              pinned === activeTile.key ? (
                <>
                  <OvTipAction onClick={() => onSelect(activeTile.key)} />
                  {activeTile.flagged ? (
                    <button
                      type="button"
                      className="ov-tip__action"
                      onClick={() => onSelectFlag(activeTile.key)}
                    >
                      View expired →
                    </button>
                  ) : null}
                </>
              ) : null
            }
          />
        </div>
      ) : null}
    </div>
  );
}
