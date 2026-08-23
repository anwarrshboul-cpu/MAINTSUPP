"use client";

/**
 * The searchable, grouped picker behind "When this happens" and "Then do
 * this".
 *
 * Raised above the modal it opens from (`popover-raised`), anchored to the
 * heading that opened it, and clamped into the viewport by the shared
 * positioning hook so it scrolls rather than running off the screen on a
 * phone. The list is a `listbox`; ArrowUp/Down/Home/End walk the entries
 * that can be chosen, Enter chooses, Escape closes. Entries the catalogue
 * marks unavailable are shown greyed with their reason and skipped by the
 * keys — the picker never hides what the product cannot do, and never lets
 * it be picked.
 *
 * The search and the highlighted row live in `PickerBody`, which the popover
 * mounts only while it is open — so every opening starts blank without an
 * effect having to reset anything.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CatalogEntry } from "../../../lib/automations/catalog";
import { AnchoredPopover } from "../overlay/anchored";
import { ActionIcon, catalogIcon } from "./board-icons";

type Group<T extends CatalogEntry> = { name: string; entries: T[] };

export function groupEntries<T extends CatalogEntry>(entries: T[], mostUsed: string[], query: string): Group<T>[] {
  const needle = query.trim().toLowerCase();
  const matches = (entry: T) =>
    !needle ||
    entry.label.toLowerCase().includes(needle) ||
    entry.description.toLowerCase().includes(needle) ||
    entry.group.toLowerCase().includes(needle);
  const groups: Group<T>[] = [];
  const byType = new Map(entries.map((entry) => [entry.type, entry]));
  const top = mostUsed
    .map((type) => byType.get(type))
    .filter((entry): entry is T => Boolean(entry && entry.available && matches(entry)));
  if (top.length && !needle) groups.push({ name: "Most used", entries: top });
  for (const entry of entries) {
    if (!matches(entry)) continue;
    const group = groups.find((candidate) => candidate.name === entry.group);
    // The catalogue's own "Most used" group and the curated shortlist share a
    // name; an entry already on the shortlist is not listed twice.
    if (group) {
      if (!group.entries.includes(entry)) group.entries.push(entry);
    } else groups.push({ name: entry.group, entries: [entry] });
  }
  return groups;
}

const idFor = (key: string) => `auto-pick-${key.replace(/[^a-z0-9_-]/gi, "_")}`;

function PickerBody<T extends CatalogEntry>({
  entries,
  mostUsed,
  selectedType,
  label,
  onPick,
}: {
  entries: T[];
  mostUsed: string[];
  selectedType: string | null;
  label: string;
  onPick: (entry: T) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeRaw, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /*
   * Focus the search once the popover has been placed. The surface is
   * `visibility: hidden` until the positioning hook has measured it, and a
   * hidden input refuses focus — an `autoFocus` here landed on nothing, so
   * the first keystrokes went to the heading that opened the picker and
   * Enter closed it again.
   */
  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const input = inputRef.current;
      const placed = input?.closest<HTMLElement>(".ms-popover")?.dataset.ready === "true";
      if (input && placed) input.focus({ preventScroll: true });
      if ((input && placed) || tries > 20) window.clearInterval(timer);
    }, 25);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => groupEntries(entries, mostUsed, query), [entries, mostUsed, query]);
  // The flat list the arrow keys walk: every choosable entry, in drawn order.
  const choosable = useMemo(
    () => groups.flatMap((group) => group.entries.filter((entry) => entry.available).map((entry) => `${group.name}::${entry.type}`)),
    [groups],
  );
  // Clamped at read time, so a narrowed search never points past the end.
  const active = Math.min(activeRaw, Math.max(0, choosable.length - 1));

  useEffect(() => {
    const key = choosable[active];
    if (!key || !listRef.current) return;
    listRef.current.querySelector<HTMLElement>(`[data-pick="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, choosable]);

  const pickKey = (key: string) => {
    const [, type] = key.split("::");
    const entry = entries.find((candidate) => candidate.type === type);
    if (entry?.available) onPick(entry);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(choosable.length ? (active + 1) % choosable.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(choosable.length ? (active - 1 + choosable.length) % choosable.length : 0);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, choosable.length - 1));
    } else if (event.key === "Enter") {
      const key = choosable[active];
      if (key) {
        event.preventDefault();
        pickKey(key);
      }
    }
  };

  const listId = `auto-picker-list-${label.replace(/\s+/g, "-")}`;

  return (
    <div className="auto-picker__inner" onKeyDown={onKeyDown}>
      <div className="ba-search auto-picker__search">
        <ActionIcon name="search" size={16} />
        <input
          ref={inputRef}
          className="ba-input"
          type="search"
          placeholder={`Search ${label.toLowerCase()}`}
          aria-label={`Search ${label.toLowerCase()}`}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={choosable[active] ? idFor(choosable[active]) : undefined}
          aria-autocomplete="list"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
      </div>
      <div ref={listRef} className="auto-picker__list" role="listbox" id={listId} aria-label={label}>
        {groups.length === 0 && <p className="auto-picker__none">Nothing matches “{query}”.</p>}
        {groups.map((group) => (
          <div key={group.name} className="auto-picker__group" role="group" aria-label={group.name}>
            {/* The group is named by `aria-label`; a heading element inside a
                listbox is not an owned role axe accepts, so this is decoration. */}
            <div className="auto-picker__heading" role="presentation" aria-hidden="true">
              {group.name}
            </div>
            {group.entries.map((entry) => {
              const key = `${group.name}::${entry.type}`;
              const index = choosable.indexOf(key);
              const isActive = index === active && index >= 0;
              const isSelected = entry.type === selectedType;
              return (
                <div
                  key={key}
                  id={idFor(key)}
                  data-pick={key}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={!entry.available || undefined}
                  className={`auto-picker__item${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}${entry.available ? "" : " is-unavailable"}`}
                  onMouseEnter={() => index >= 0 && setActive(index)}
                  onClick={() => entry.available && onPick(entry)}
                >
                  <span className="auto-picker__icon">
                    <ActionIcon name={catalogIcon(entry.icon)} size={18} />
                  </span>
                  <span className="auto-picker__text">
                    <strong>{entry.label}</strong>
                    <small>{entry.available ? entry.description : entry.reason ?? "Not available"}</small>
                  </span>
                  {isSelected && <ActionIcon name="check" size={16} />}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CatalogPicker<T extends CatalogEntry>({
  open,
  anchorRef,
  onClose,
  entries,
  mostUsed,
  selectedType,
  label,
  onPick,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  entries: T[];
  mostUsed: string[];
  selectedType: string | null;
  label: string;
  onPick: (entry: T) => void;
}) {
  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      layer="popover-raised"
      role="dialog"
      label={label}
      className="auto-picker"
      placement="bottom-start"
      initialFocus="none"
    >
      <PickerBody entries={entries} mostUsed={mostUsed} selectedType={selectedType} label={label} onPick={onPick} />
    </AnchoredPopover>
  );
}
