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

import { type ReactNode } from "react";
import { LayerPortal } from "../overlay/anchored";
/* Escape, focus-in, focus-restore, the Tab trap and the scroll lock, lifted out
   of this file so the Overview's data tools use the SAME implementation rather
   than a second one. Behaviour here is unchanged. */
import { useDialogBehaviour } from "../overlay/dialog-behaviour";
import { ActionIcon } from "./board-icons";
import "./board-actions.css";

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
