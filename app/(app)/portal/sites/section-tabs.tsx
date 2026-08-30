"use client";

import { useRef } from "react";

/**
 * The tab pattern the two Sites screens were only half-implementing.
 *
 * WHAT WAS WRONG, MEASURED RATHER THAN READ. Both `site-form.tsx` and
 * `site-detail.tsx` rendered `role="tablist"` with `role="tab"` children and
 * `aria-selected`, and stopped there. Walked with a keyboard at 1440px:
 *
 *   tabs carrying aria-controls        0 of 7   (form)   0 of 7   (detail)
 *   elements with role="tabpanel"      0        (form)   0        (detail)
 *   tab stops inside the strip         7        (form)   7        (detail)
 *   ArrowRight from "Identity"         focus did not move; selection unchanged
 *   End                                focus did not move
 *
 * So the strip announced itself as a tablist and then behaved like seven
 * unrelated buttons: a screen reader was told "tab, 1 of 7" with nothing to
 * say what it controlled, and a keyboard user paid seven Tab presses to cross
 * a control the ARIA contract says costs one. Declaring `role="tablist"`
 * without the keyboard behaviour is worse than not declaring it, because the
 * role is a promise about how the thing works.
 *
 * WHAT THIS IMPLEMENTS (WAI-ARIA APG, Tabs, automatic activation):
 *   - every tab has an `id`, `aria-selected` and `aria-controls` naming its panel
 *   - every panel has `role="tabpanel"` and `aria-labelledby` naming its tab
 *   - roving tabindex: the selected tab is `tabindex="0"`, the rest are `-1`,
 *     so the whole strip is ONE tab stop and Tab moves on to the content
 *   - ArrowLeft / ArrowRight wrap, Home / End jump to the ends, and focus moves
 *     with selection
 *
 * AUTOMATIC ACTIVATION, not manual. The APG asks for manual activation only
 * when revealing a panel is expensive; on both screens every panel is drawn
 * from data the view has already fetched and switching is a `useState` write,
 * so selection follows focus — the behaviour the APG prefers when it is
 * affordable.
 *
 * ArrowUp / ArrowDown are deliberately NOT bound. The strip is a horizontal
 * tablist that happens to wrap onto several rows on a phone (`.view-switch--text`
 * sets `flex-wrap: wrap`), and binding the vertical keys would take page
 * scrolling away from a keyboard user for no gain.
 *
 * One component for both screens rather than the same block written twice: the
 * two strips had identical markup and therefore had the identical defect, and
 * a second copy is a second thing to forget.
 */

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function tabId(prefix: string, section: string) {
  return `${prefix}-tab-${slug(section)}`;
}

export function panelId(prefix: string, section: string) {
  return `${prefix}-panel-${slug(section)}`;
}

export function SectionTabs<T extends string>({
  idPrefix,
  label,
  sections,
  active,
  onChange,
}: {
  /** Unique per screen, so the form's ids cannot collide with the detail's. */
  idPrefix: string;
  label: string;
  sections: readonly T[];
  active: T;
  onChange: (section: T) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function move(to: number) {
    // Wraps in both directions: ArrowRight past the last tab lands on the
    // first, ArrowLeft from the first lands on the last, which is what the APG
    // asks a tablist to do.
    const index = (to + sections.length) % sections.length;
    onChange(sections[index]);
    // Selection follows focus, so focus has to follow selection. The node is
    // keyed on the section name, so it survives the re-render `onChange`
    // schedules and is the same element afterwards.
    buttons.current[index]?.focus();
  }

  return (
    <div className="view-switch view-switch--text" role="tablist" aria-label={label}>
      {sections.map((entry, index) => (
        <button
          key={entry}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          role="tab"
          id={tabId(idPrefix, entry)}
          aria-selected={active === entry}
          aria-controls={panelId(idPrefix, entry)}
          /* Roving tabindex — the strip is one stop, not seven. */
          tabIndex={active === entry ? 0 : -1}
          className={active === entry ? "is-active" : ""}
          onClick={() => onChange(entry)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              move(index + 1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              move(index - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              move(0);
            } else if (event.key === "End") {
              event.preventDefault();
              move(sections.length - 1);
            }
          }}
        >
          {entry}
        </button>
      ))}
    </div>
  );
}

/*
 * Inline, not a class, and this is the reason.
 *
 * `[hidden]` is a UA rule at `display: none`, and every panel here carries a
 * class that also sets `display` — `.form-grid` is a grid, `.site-stat-grid`
 * is a grid, `.panel` is a block. Author beats user agent whatever the
 * specificity, so `hidden` alone leaves all seven panels painted on top of one
 * another. An inline declaration cannot be outranked by a stylesheet, so the
 * component carries its own hiding rather than depending on a CSS file it does
 * not own.
 */
const HIDDEN = { display: "none" } as const;

/**
 * The panel half of the pair.
 *
 * THE PANEL ELEMENT IS ALWAYS IN THE DOM; ITS CONTENT IS NOT. Both screens
 * used to render the selected section only, so six of seven `aria-controls`
 * would have pointed at an id that was not on the page — a reference that
 * resolves to nothing is not a relationship, and "jump to controlled element"
 * would have been a dead key on six tabs out of seven. Keeping the empty,
 * hidden panel costs one `<div>` each and makes every reference resolve at
 * every moment.
 *
 * `{active ? children : null}` keeps the CONTENT lazy, which is what actually
 * costs anything: the detail screen's panels hold up to 200 job rows and 200
 * file rows, and mounting all five lists to satisfy an id reference would be
 * paying in DOM for a pointer.
 *
 * `focusable` follows the APG rule rather than a house style: a panel whose
 * content contains no focusable element is given `tabindex="0"` so a keyboard
 * user can reach and scroll it, and a panel that opens on a form field is not,
 * because that would add a tab stop in front of every field for nothing. The
 * site editor's panels are all fields; the detail screen's are read-only text,
 * tables and lists. A hidden panel is never a tab stop either way.
 */
export function SectionPanel({
  idPrefix,
  section,
  active,
  focusable,
  className,
  children,
}: {
  idPrefix: string;
  section: string;
  active: boolean;
  focusable?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, section)}
      aria-labelledby={tabId(idPrefix, section)}
      hidden={!active}
      style={active ? undefined : HIDDEN}
      tabIndex={active && focusable ? 0 : undefined}
      className={className}
    >
      {active ? children : null}
    </div>
  );
}
