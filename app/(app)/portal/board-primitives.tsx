"use client";

/**
 * Shared board primitives — the mobile context, the mobile cell sheet and the
 * popover reveal hook.
 *
 * Extracted from live-board.tsx (Stage 8, item H1). These live in their own
 * file because both the board and the cell components need them; importing
 * them from live-board would make the split circular.
 */
import {
  createContext,
  useEffect,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components";

export const MobileBoardContext = createContext(false);
export function MobileCellSheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  headerAction,
  closeFirst = false,
  className = "",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  headerAction?: ReactNode;
  closeFirst?: boolean;
  className?: string;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return createPortal(
    <div
      className={`mobile-cell-sheet${className ? ` ${className}` : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        className="mobile-cell-sheet__backdrop"
        type="button"
        aria-label={`Close ${title}`}
        onClick={onClose}
      />
      <section className="mobile-cell-sheet__panel">
        <span className="mobile-cell-sheet__handle" aria-hidden="true" />
        <header className={closeFirst ? "has-leading-close" : ""}>
          {closeFirst && (
            <button
              className="mobile-cell-sheet__close"
              type="button"
              aria-label={`Close ${title}`}
              onClick={onClose}
            >
              <Icon name="close" size={24} />
            </button>
          )}
          <div>
            <strong>{title}</strong>
            {subtitle && <small>{subtitle}</small>}
          </div>
          {!closeFirst && (
            <button
              className="mobile-cell-sheet__close"
              type="button"
              aria-label={`Close ${title}`}
              onClick={onClose}
            >
              <Icon name="close" size={20} />
            </button>
          )}
          {headerAction && (
            <div className="mobile-cell-sheet__header-action">
              {headerAction}
            </div>
          )}
        </header>
        <div className="mobile-cell-sheet__body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}

export function useRevealBoardPopover(
  visible: boolean,
  ref: { current: HTMLDivElement | null },

  layoutKey: unknown = visible,
) {
  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      const popover = ref.current?.querySelector<HTMLElement>(
        ".sheet-option-popover, .sheet-timeline-popover",
      );
      if (!popover) return;
      /*
       * ONLY WHEN IT IS ACTUALLY OUT OF VIEW.
       *
       * This ran unconditionally, and it re-runs on every change of
       * `layoutKey` — which for the option popovers is the editing flag, so it
       * fires again while a popover is merely being typed into. An
       * unconditional `scrollIntoView({ inline: "nearest" })` is not a no-op
       * for something already visible: `.live-board-scroll` carries
       * `scroll-padding: 24px 24px 320px`, and "nearest" resolves against the
       * PADDED box, so a popover sitting comfortably on screen but within
       * 24px of the scroller's left edge gets scrolled to satisfy the padding.
       * Mid-drag or mid-scroll that reads as the board snapping back by
       * itself. Measuring first turns the common case — already visible —
       * into nothing at all.
       */
      const scroller = popover.closest<HTMLElement>(".live-board-scroll");
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        const rect = popover.getBoundingClientRect();
        if (
          rect.left >= box.left &&
          rect.right <= box.right &&
          rect.top >= box.top &&
          rect.bottom <= box.bottom
        ) {
          return;
        }
      }
      popover.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layoutKey, ref, visible]);
}
