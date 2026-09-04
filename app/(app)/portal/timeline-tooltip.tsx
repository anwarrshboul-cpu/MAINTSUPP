"use client";

/**
 * The Timeline cell's button, and the duration card it shows on hover or focus.
 *
 * WHAT THIS ADDS. The strip reads `08-20 → 08-23` and says nothing about how
 * long that is, which is the question a coordinator opens the column to answer.
 * Hovering — or tabbing to it — now shows the start, the end and the length in
 * days, the way monday does. Nothing about the underlying dates changes: this
 * is `timeline-duration.ts` rendered, and that module reads the same values the
 * cell already holds through the same `dateInputValue`.
 *
 * WHY THE BUTTON MOVED HERE. `board-cells.tsx` is at 1,248 lines against an
 * enforced ceiling of 1,300, and a hover surface needs an anchor ref, an open
 * state, a portal and four event handlers. Wrapping the button and its tooltip
 * in one component keeps the cell smaller than it was rather than larger, and
 * gives the tooltip a file where its reasoning can be written down.
 *
 * A TOOLTIP, NOT A MENU. `AnchoredPopover` would have been fewer lines and is
 * wrong here: it takes focus on open, returns it on close and closes on a press
 * outside — all correct for a menu and all disruptive for something that
 * appears because the pointer passed over a cell. So this composes the two
 * primitives underneath it, `LayerPortal` + `useAnchoredPosition`, which is the
 * same positioning, the same layer scale and the same collision handling with
 * none of the menu behaviour. There is no second positioning implementation
 * here, and nothing in this file measures a rect.
 *
 * FOCUS COUNTS AS HOVER. `onFocus`/`onBlur` sit beside `onMouseEnter`/
 * `onMouseLeave`, so the keyboard reaches the duration; `aria-describedby`
 * points at the card, so a screen reader announces it; and the button keeps a
 * plain `title` carrying the same sentence, so the fact survives even where
 * neither the card nor the announcement does.
 *
 * ON A PHONE THERE IS NO HOVER, so nothing here renders: `MobileBoardContext`
 * suppresses the card and `TimelineCell` shows the same summary inside the
 * sheet a tap already opens. A tooltip that needs a tap is a menu wearing the
 * wrong clothes.
 */

import { useContext, useId, useRef, useState } from "react";
import { LayerPortal, useAnchoredPosition } from "./overlay/anchored";
import { MobileBoardContext } from "./board-primitives";
import { timelineSummary, timelineSummaryText } from "./timeline-duration";
import "./timeline-tooltip.css";

export function TimelineRangeButton({
  label,
  title,
  start,
  end,
  onOpenEditor,
}: {
  /** The strip the cell already draws, e.g. `08-20 → 08-23`. */
  label: string;
  /** The column's own title, so the card says which timeline this is. */
  title: string;
  start: string | null | undefined;
  end: string | null | undefined;
  onOpenEditor: () => void;
}) {
  const mobile = useContext(MobileBoardContext);
  const [showing, setShowing] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const tipId = useId();

  const summary = timelineSummary(start, end);
  const sentence = timelineSummaryText(summary);

  // Suppressed on a touch board: see the header.
  const open = showing && !mobile;
  const { ref, style, ready } = useAnchoredPosition({
    open,
    anchorRef,
    placement: "bottom-start",
    offset: 8,
  });

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        /* The same sentence as the card. A native tooltip is the floor this
           cannot fall below — it survives a portal that failed to mount and it
           is what a browser reads out when nothing else does. */
        title={sentence}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={() => setShowing(true)}
        onMouseLeave={() => setShowing(false)}
        onFocus={() => setShowing(true)}
        onBlur={() => setShowing(false)}
        onClick={() => {
          /* Opening the editor hides the card: two surfaces over one cell,
             one of them explaining the other, is noise. */
          setShowing(false);
          onOpenEditor();
        }}
      >
        <span>{label}</span>
      </button>
      {open && (
        <LayerPortal layer="popover">
          <div
            ref={ref}
            id={tipId}
            role="tooltip"
            className="ms-popover timeline-tip"
            style={style}
            data-ready={ready ? "true" : "false"}
          >
            <strong className="timeline-tip__title">{title}</strong>
            <dl className="timeline-tip__facts">
              <div>
                <dt>Start</dt>
                <dd>{summary.startLabel ?? "Not set"}</dd>
              </div>
              <div>
                <dt>End</dt>
                <dd>{summary.endLabel ?? "Not set"}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                {/* Never a number this could not work out — see
                    `timelineSummary`, which returns a reason instead. */}
                <dd className="timeline-tip__duration">
                  {summary.durationLabel ?? "—"}
                </dd>
              </div>
            </dl>
            {summary.note && <p className="timeline-tip__note">{summary.note}</p>}
          </div>
        </LayerPortal>
      )}
    </>
  );
}

/**
 * The same facts as a line of text, for the mobile sheet.
 *
 * The phone has no hover, so the sheet a tap already opens carries the duration
 * outright. One summary, two renderings.
 */
export function TimelineDurationLine({
  start,
  end,
}: {
  start: string | null | undefined;
  end: string | null | undefined;
}) {
  const summary = timelineSummary(start, end);
  return (
    <p className="timeline-duration-line" role="status">
      {summary.durationLabel ? (
        <>
          <strong>{summary.durationLabel}</strong>
          <span>
            {summary.startLabel} – {summary.endLabel}
          </span>
        </>
      ) : (
        <span>{summary.note ?? "No dates set yet."}</span>
      )}
    </p>
  );
}
