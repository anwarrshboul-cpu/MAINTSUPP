"use client";

/**
 * The shared floating-layer primitive: a portal host, a collision-aware
 * anchored position, and a popover that combines the two.
 *
 * WHY A PORTAL. Every menu on the portal used to be an `absolute` or `fixed`
 * child of the thing that opened it. That works until an ancestor becomes a
 * containing block — `backdrop-filter` on the top bar, `transform` on a
 * sliding drawer, `contain: paint` on a deferred board group — at which point
 * `position: fixed` stops meaning "the viewport" and a `bottom: 8px` panel
 * lands 632px above the screen (the avatar menu on /dashboard/account, as
 * recorded in the bug this file fixes). Rendering into `#maintsupp-layers` on
 * `<body>` takes every ancestor out of the equation; the surface is positioned
 * from the anchor's CURRENT `getBoundingClientRect()` in viewport coordinates,
 * re-measured on resize, on any scroll (capture, so the board's own scroll
 * containers are heard) and whenever the surface itself changes size.
 *
 * WHY ONE Z SCALE. `.ms-layer[data-layer]` maps onto the tokens in
 * globals.css — popover < submenu < popover-raised, drawer < modal, toast on
 * top — so a surface's depth is declared by role rather than by a number
 * chosen to beat whichever number was last in the way.
 *
 * Exports are the contract the board chrome codes against; keep the names and
 * signatures stable.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import "./overlay.css";

export { useBodyScrollLock } from "./scroll-lock";

export type LayerName =
  | "popover"
  | "submenu"
  | "drawer"
  | "modal"
  | "toast"
  | "popover-raised";

export type AnchoredPlacement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "top-end"
  | "right-start"
  | "left-start";

const HOST_ID = "maintsupp-layers";

/** Breathing room kept between a surface and the edge of the viewport. */
const DEFAULT_PADDING = 8;

/** Gap between the anchor and the surface. */
const DEFAULT_OFFSET = 6;

/**
 * Below this a surface would be a sliver, so it scrolls rather than shrinking
 * further — and is pushed back inside the viewport instead.
 */
const MIN_HEIGHT = 120;

/** What the menu's arrow keys walk across. */
const MENU_ITEMS = '[role="menuitem"], button, a[href]';

/** What receives focus when a popover opens with `initialFocus: "first"`. */
const FOCUSABLE =
  '[role="menuitem"], button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function layerHost(): HTMLElement {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    document.body.appendChild(host);
  }
  return host;
}

/**
 * How many layers are open. While it is non-zero the host is a named region
 * landmark, so what is inside it is reachable by landmark and is not "content
 * outside any landmark" (axe: region) the way it would be as a bare child of
 * <body>; at zero the landmark goes, so an empty region is never announced.
 */
let openLayers = 0;

/** The layer host never changes identity, so a subscriber has nothing to hear. */
function subscribeNever() {
  return () => undefined;
}
function serverHost(): HTMLElement | null {
  return null;
}

function occupyHost(host: HTMLElement) {
  openLayers += 1;
  host.setAttribute("role", "region");
  host.setAttribute("aria-label", "Open menus and panels");
  return () => {
    openLayers = Math.max(0, openLayers - 1);
    if (openLayers === 0) {
      host.removeAttribute("role");
      host.removeAttribute("aria-label");
    }
  };
}

/**
 * A `role="menu"` surface must own only menu items, but what the board puts in
 * one is plain buttons, links and the odd checkbox — the same markup it had
 * before the menus moved onto the layer. Rather than ask every menu to carry
 * the roles itself (several live in files this primitive does not own), the
 * surface gives them their menu roles as they appear. Elements that already
 * declare a role keep it. Runs before paint, on every render of an open menu,
 * so an item that appears later (a composer, a row that toggles) is covered.
 */
function stampMenuRoles(surface: HTMLElement) {
  surface
    .querySelectorAll<HTMLElement>("button:not([role]), a[href]:not([role])")
    .forEach((node) => node.setAttribute("role", "menuitem"));
  surface
    .querySelectorAll<HTMLElement>('input[type="checkbox"]:not([role])')
    .forEach((node) => node.setAttribute("role", "menuitemcheckbox"));
  surface
    .querySelectorAll<HTMLElement>('input[type="radio"]:not([role])')
    .forEach((node) => node.setAttribute("role", "menuitemradio"));
}

/**
 * Renders its children into the shared layer host on `document.body`.
 *
 * SSR-safe: nothing is rendered until the component has mounted in a browser,
 * because the host is created on demand and there is no document on the
 * server. The wrapper carries `data-board-popover` so the board's own
 * "click away closes the menus" listener treats a press inside any layer as
 * inside.
 */
export function LayerPortal({
  children,
  layer,
}: {
  children: ReactNode;
  layer: LayerName;
}): React.JSX.Element {
  /*
   * The host is read through `useSyncExternalStore`: null on the server and
   * during hydration (no portal in the server tree, so nothing to mismatch),
   * the shared <div id="maintsupp-layers"> once the document exists. A state
   * set from a layout effect did the same job and tripped the compiler lint
   * (react-hooks/set-state-in-effect); this is the same timing without the
   * extra render.
   */
  const host = useSyncExternalStore(subscribeNever, layerHost, serverHost);
  useLayoutEffect(() => (host ? occupyHost(host) : undefined), [host]);
  if (!host) return <></>;
  return createPortal(
    <div className="ms-layer" data-layer={layer} data-board-popover="">
      {children}
    </div>,
    host,
  );
}

type Measured = {
  style: CSSProperties;
  placement: string;
  ready: boolean;
};

const UNMEASURED: Measured = {
  style: { position: "fixed", top: 0, left: 0, visibility: "hidden" },
  placement: "",
  ready: false,
};

function sameMeasure(left: Measured, right: Measured) {
  if (left.ready !== right.ready || left.placement !== right.placement) return false;
  const a = left.style;
  const b = right.style;
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.maxHeight === b.maxHeight &&
    a.maxWidth === b.maxWidth &&
    a.width === b.width
  );
}

/**
 * Where the surface goes, given the anchor's rect and the surface's wanted
 * size. Flips to the opposite side when the preferred side has less room than
 * the other AND cannot fit; clamps inside `padding` of every viewport edge;
 * returns a `maxHeight` so a long menu scrolls inside the viewport.
 */
function computePosition(
  anchor: DOMRect,
  surface: HTMLElement,
  placement: AnchoredPlacement,
  offset: number,
  matchWidth: boolean,
  padding: number,
): Measured {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  // scrollHeight is the full content height even while max-height clips it,
  // so this asks "how tall do you want to be" without undoing the clamp.
  const verticalChrome = surface.offsetHeight - surface.clientHeight;
  const wantedHeight = surface.scrollHeight + verticalChrome;
  const horizontalChrome = surface.offsetWidth - surface.clientWidth;
  const wantedWidth = matchWidth
    ? anchor.width
    : Math.max(surface.offsetWidth, surface.scrollWidth + horizontalChrome);

  const maxWidth = Math.max(0, vw - padding * 2);
  const width = Math.min(wantedWidth, maxWidth);

  const [preferredSide, align] = placement.split("-") as [
    "bottom" | "top" | "right" | "left",
    "start" | "end",
  ];
  const spaceBelow = vh - anchor.bottom - offset - padding;
  const spaceAbove = anchor.top - offset - padding;
  const spaceRight = vw - anchor.right - offset - padding;
  const spaceLeft = anchor.left - offset - padding;

  let side = preferredSide;
  if (side === "bottom" && wantedHeight > spaceBelow && spaceAbove > spaceBelow) {
    side = "top";
  } else if (side === "top" && wantedHeight > spaceAbove && spaceBelow > spaceAbove) {
    side = "bottom";
  } else if (side === "right" && width > spaceRight && spaceLeft > spaceRight) {
    side = "left";
  } else if (side === "left" && width > spaceLeft && spaceRight > spaceLeft) {
    side = "right";
  }

  let top: number;
  let left: number;
  let maxHeight: number;

  if (side === "bottom" || side === "top") {
    const space = side === "bottom" ? spaceBelow : spaceAbove;
    maxHeight = Math.max(MIN_HEIGHT, Math.min(wantedHeight, space));
    const height = Math.min(wantedHeight, maxHeight);
    top = side === "bottom" ? anchor.bottom + offset : anchor.top - offset - height;
    left = align === "end" ? anchor.right - width : anchor.left;
  } else {
    maxHeight = Math.max(MIN_HEIGHT, vh - padding * 2);
    const height = Math.min(wantedHeight, maxHeight);
    left = side === "right" ? anchor.right + offset : anchor.left - offset - width;
    top = Math.min(anchor.top, vh - padding - height);
  }

  // Clamp into the viewport. Height is already bounded by maxHeight, so only
  // the top edge needs holding; the surface scrolls rather than overflowing.
  left = Math.max(padding, Math.min(left, vw - padding - width));
  top = Math.max(padding, Math.min(top, vh - padding - MIN_HEIGHT));
  maxHeight = Math.min(maxHeight, vh - padding - top);

  const style: CSSProperties = {
    position: "fixed",
    top: Math.round(top),
    left: Math.round(left),
    maxHeight: Math.round(maxHeight),
    maxWidth: Math.round(maxWidth),
    margin: 0,
  };
  if (matchWidth) style.width = Math.round(anchor.width);

  return { style, placement: `${side}-${align}`, ready: true };
}

/**
 * Positions a floating element against an anchor, in viewport coordinates.
 *
 * Measures in a layout effect on open so the first paint is already in place;
 * re-measures on window resize, on any scroll (capture) and — through a
 * ResizeObserver — whenever the floating element or the anchor changes size.
 * Returns the ref to attach to the floating element, the inline style to give
 * it, the placement actually used (after any flip) and whether a measurement
 * has been taken yet.
 */
export function useAnchoredPosition(args: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  placement?: AnchoredPlacement;
  offset?: number;
  matchWidth?: boolean;
  padding?: number;
}): {
  ref: RefObject<HTMLDivElement | null>;
  style: CSSProperties;
  placement: string;
  ready: boolean;
} {
  const {
    open,
    anchorRef,
    placement = "bottom-start",
    offset = DEFAULT_OFFSET,
    matchWidth = false,
    padding = DEFAULT_PADDING,
  } = args;
  const ref = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<Measured>(UNMEASURED);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const anchor = anchorRef.current;
      const surface = ref.current;
      if (!anchor || !surface) return;
      const next = computePosition(
        anchor.getBoundingClientRect(),
        surface,
        placement,
        offset,
        matchWidth,
        padding,
      );
      setMeasured((current) => (sameMeasure(current, next) ? current : next));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    if (observer) {
      if (ref.current) observer.observe(ref.current);
      if (anchorRef.current) observer.observe(anchorRef.current);
    }
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer?.disconnect();
    };
  }, [open, anchorRef, placement, offset, matchWidth, padding]);

  /*
   * Gated on `open` rather than reset by an effect: while closed the caller
   * gets the unmeasured shape, and the stale measurement left behind is
   * replaced in the layout effect before the next open ever paints.
   */
  return {
    ref,
    style: open ? measured.style : UNMEASURED.style,
    placement: open ? measured.placement : UNMEASURED.placement,
    ready: open && measured.ready,
  };
}

function isVisible(node: HTMLElement) {
  return node.offsetParent !== null || node.getClientRects().length > 0;
}

/**
 * A portalled, anchored, dismissable surface.
 *
 *   - closes on Escape, and on a pointerdown outside the anchor, outside the
 *     surface, AND outside any `.ms-layer` opened after it — so a submenu
 *     does not close the menu that opened it;
 *   - returns focus to the anchor on close, unless focus has already moved
 *     somewhere deliberate (a click on another control keeps that control);
 *   - `role="menu"` gets ArrowUp/Down/Home/End roving focus across its
 *     `[role=menuitem]`, buttons and links, and Tab closes it the way a native
 *     menu does. Keys inside an input or select are left to the control.
 */
export function AnchoredPopover(props: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  placement?: AnchoredPlacement;
  offset?: number;
  matchWidth?: boolean;
  layer?: "popover" | "submenu" | "popover-raised";
  role?: "menu" | "dialog" | "listbox";
  label?: string;
  className?: string;
  restoreFocus?: boolean;
  initialFocus?: "first" | "none";
  children: ReactNode;
}): React.JSX.Element | null {
  const {
    open,
    anchorRef,
    onClose,
    placement,
    offset,
    matchWidth,
    layer = "popover",
    role = "menu",
    label,
    className,
    restoreFocus = true,
    initialFocus = "first",
    children,
  } = props;
  const { ref, style, placement: placed, ready } = useAnchoredPosition({
    open,
    anchorRef,
    placement,
    offset,
    matchWidth,
  });

  // The latest close, without rebinding the listeners on every render.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // Escape from anywhere, and presses outside.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      closeRef.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const surface = ref.current;
      if (surface?.contains(target) || anchorRef.current?.contains(target)) return;
      // A layer that opened after this one is a child of it — a submenu, a
      // picker inside the menu — so a press in there is not "outside".
      const mine = surface?.closest(".ms-layer");
      const theirs = target instanceof Element ? target.closest(".ms-layer") : null;
      if (
        mine &&
        theirs &&
        theirs !== mine &&
        mine.compareDocumentPosition(theirs) & Node.DOCUMENT_POSITION_FOLLOWING
      ) {
        return;
      }
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, anchorRef, ref]);

  useLayoutEffect(() => {
    if (!open || role !== "menu") return;
    const surface = ref.current;
    if (surface) stampMenuRoles(surface);
  });

  // Focus in on open (once the surface is in place), and back out on close.
  useEffect(() => {
    if (!open || !ready || initialFocus !== "first") return;
    const surface = ref.current;
    if (!surface || surface.contains(document.activeElement)) return;
    const first = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
      isVisible,
    );
    (first ?? surface).focus({ preventScroll: true });
  }, [open, ready, initialFocus, ref]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const anchor = anchorRef.current;
    const surface = ref.current;
    return () => {
      if (!restoreFocus || !anchor) return;
      const active = document.activeElement;
      // Only take focus back if it would otherwise be lost: a click on another
      // control has already put it somewhere deliberate.
      if (!active || active === document.body || surface?.contains(active)) {
        anchor.focus({ preventScroll: true });
      }
    };
  }, [open, restoreFocus, anchorRef, ref]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (role !== "menu") return;
      const target = event.target as HTMLElement;
      if (target.matches("input, select, textarea")) return;
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const surface = ref.current;
      if (!surface) return;
      const items = Array.from(surface.querySelectorAll<HTMLElement>(MENU_ITEMS)).filter(
        (node) => isVisible(node) && !node.hasAttribute("disabled"),
      );
      if (!items.length) return;
      event.preventDefault();
      // A submenu is a child component of the item that opened it, so React
      // would bubble this to the parent menu's handler too and move ITS focus.
      event.stopPropagation();
      const index = items.indexOf(document.activeElement as HTMLElement);
      let next = 0;
      if (event.key === "ArrowDown") next = (index + 1) % items.length;
      else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
      else if (event.key === "End") next = items.length - 1;
      items[next]?.focus({ preventScroll: true });
    },
    [role, ref],
  );

  if (!open) return null;

  return (
    <LayerPortal layer={layer}>
      <div
        ref={ref}
        className={`ms-popover${className ? ` ${className}` : ""}`}
        style={style}
        role={role}
        aria-label={label}
        aria-modal={role === "dialog" ? undefined : undefined}
        data-placement={placed || undefined}
        data-ready={ready ? "true" : "false"}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </LayerPortal>
  );
}
