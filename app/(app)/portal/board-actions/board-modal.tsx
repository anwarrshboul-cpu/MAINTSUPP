"use client";

/**
 * The two shells the board's actions open in: a centred modal and a
 * right-hand drawer.
 *
 * Both render through `LayerPortal` so they sit on the shared z scale —
 * `drawer` under `modal`, both under `popover-raised` so a picker opened from
 * inside a modal stacks above it. Both take the one body scroll lock, close on
 * Escape and on a press on their own backdrop, put focus inside on open and
 * hand it back on close. Below 768px the modal fills the screen and the
 * drawer becomes a full-height sheet.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { LayerPortal, useBodyScrollLock } from "../overlay/anchored";
import { ActionIcon } from "./board-icons";
import "./board-actions.css";

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useDialogBehaviour(open: boolean, onClose: () => void) {
  const surface = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useBodyScrollLock(open);

  // Focus in on open; back to the opener on close.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const node = surface.current;
    if (node && !node.contains(document.activeElement)) {
      const first = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
        (candidate) => !candidate.closest("[data-autofocus-skip]"),
      );
      (node.querySelector<HTMLElement>("[data-autofocus]") ?? first ?? node).focus({
        preventScroll: true,
      });
    }
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || node?.contains(active)) {
        opener?.focus?.({ preventScroll: true });
      }
    };
  }, [open]);

  // Escape from anywhere, unless a popover above us has already taken it.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      // A raised popover (a picker inside the modal) owns its own Escape.
      if (target?.closest('.ms-layer[data-layer="popover-raised"], .ms-layer[data-layer="popover"], .ms-layer[data-layer="submenu"]')) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const onBackdrop = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) closeRef.current();
  }, []);

  // Keep Tab inside the dialog.
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const node = surface.current;
    if (!node) return;
    const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (candidate) => candidate.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  return { surface, onBackdrop, onKeyDown };
}

export function BoardModal({
  open,
  onClose,
  title,
  titleId,
  size = "lg",
  className,
  header,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
  size?: "lg" | "md" | "sm";
  className?: string;
  /** Replaces the default heading row entirely. Must render `#titleId`. */
  header?: ReactNode;
  children: ReactNode;
}) {
  const { surface, onBackdrop, onKeyDown } = useDialogBehaviour(open, onClose);
  if (!open) return null;
  return (
    <LayerPortal layer="modal">
      <div className="ba-backdrop ba-backdrop--modal" onPointerDown={onBackdrop}>
        <div
          ref={surface}
          className={`ba-modal ba-modal--${size}${className ? ` ${className}` : ""}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {header ?? (
            <div className="ba-modal__head">
              <h2 id={titleId}>{title}</h2>
              <button type="button" className="ba-iconbtn" aria-label="Close" onClick={onClose}>
                <ActionIcon name="close" size={18} />
              </button>
            </div>
          )}
          {children}
        </div>
      </div>
    </LayerPortal>
  );
}

export function BoardDrawer({
  open,
  onClose,
  title,
  titleId,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const { surface, onBackdrop, onKeyDown } = useDialogBehaviour(open, onClose);
  if (!open) return null;
  return (
    <LayerPortal layer="drawer">
      <div className="ba-backdrop ba-backdrop--drawer" onPointerDown={onBackdrop}>
        <aside
          ref={surface}
          className="ba-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <div className="ba-drawer__head">
            <div>
              <h2 id={titleId}>{title}</h2>
              {subtitle && <p className="ba-drawer__subtitle">{subtitle}</p>}
            </div>
            <button type="button" className="ba-iconbtn" aria-label="Close" onClick={onClose}>
              <ActionIcon name="close" size={18} />
            </button>
          </div>
          {children}
        </aside>
      </div>
    </LayerPortal>
  );
}
