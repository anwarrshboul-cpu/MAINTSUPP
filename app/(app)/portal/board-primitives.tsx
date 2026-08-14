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
      popover?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layoutKey, ref, visible]);
}
