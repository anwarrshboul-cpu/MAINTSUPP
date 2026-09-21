"use client";

/**
 * THE PORTAL'S GLOBAL SEARCH — §36.
 *
 * One box in the topbar that finds a job, a site, a contractor, a document,
 * an invoice, a quote or a person in THIS workspace. What it searches, and
 * what each reader is allowed to see, is decided by `GET /api/search` — the
 * panel only draws the groups the server chose to answer, so it can never
 * suggest "no invoices match" to somebody who may not see invoices.
 *
 * Ctrl+K / Cmd+K (or "/" outside a text field) focuses it from anywhere in
 * the shell. Arrow keys move through the results, Enter opens one, Escape
 * closes. A job opens its drawer in place, as every other job link in the
 * shell does; everything else follows the address the server gave it.
 *
 * On a phone the topbar already holds six touch targets, so the box collapses
 * to an icon that opens the same panel full-width.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components";
import searchCss from "./global-search.css?url";

type SearchItem = {
  id: string;
  title: string;
  subtitle: string;
  href: string | null;
  kind: "job" | "site" | "contractor" | "document" | "invoice" | "quote" | "person";
};
type SearchGroup = { key: string; label: string; items: SearchItem[] };
type SearchPayload = { query: string; searched: string[]; groups: SearchGroup[]; error?: string };

const DEBOUNCE_MS = 220;

export function GlobalSearch({
  compact,
  onOpenJob,
}: {
  /** Collapse to an icon trigger — the phone topbar. */
  compact: boolean;
  /** Open a job's drawer in place, by id. */
  onOpenJob: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [payload, setPayload] = useState<SearchPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo(() => payload?.groups.flatMap((group) => group.items) ?? [], [payload]);

  /* Ctrl/Cmd+K, or "/" when the reader is not already typing somewhere. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, select, [contenteditable='true']");
      if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setOpen(true);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        setOpen(true);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* A click anywhere else closes the panel. */
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  /* Debounced, and a stale answer never overwrites a newer question. */
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setBusy(true);
      setProblem(null);
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as SearchPayload;
        if (!response.ok) throw new Error(body.error || "Search is unavailable right now.");
        setPayload(body);
        setActive(0);
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setPayload(null);
        setProblem(error instanceof Error ? error.message : "Search is unavailable right now.");
      } finally {
        setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  const choose = useCallback(
    (item: SearchItem) => {
      setOpen(false);
      if (item.kind === "job") {
        onOpenJob(item.id);
        return;
      }
      if (!item.href) return;
      if (item.kind === "document") {
        window.open(item.href, "_blank", "noopener");
        return;
      }
      window.location.assign(item.href);
    },
    [onOpenJob],
  );

  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (items.length ? (index + 1) % items.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (items.length ? (index - 1 + items.length) % items.length : 0));
    } else if (event.key === "Enter" && items[active]) {
      event.preventDefault();
      choose(items[active]);
    }
  };

  const term = query.trim();
  const showPanel = open && (term.length >= 2 || Boolean(problem));
  let index = -1;

  return (
    <div className={`global-search${compact ? " is-compact" : ""}${open ? " is-open" : ""}`} ref={rootRef}>
      <link rel="stylesheet" href={searchCss} precedence="default" />
      {compact && !open ? (
        <button
          className="icon-button"
          type="button"
          aria-label="Search this workspace"
          onClick={() => {
            setOpen(true);
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          <Icon name="search" size={20} />
        </button>
      ) : (
        <label className="global-search__field">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={showPanel}
            aria-controls="global-search-results"
            aria-label="Search jobs, sites, contractors, documents and more"
            placeholder="Search this workspace…"
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onKeyDown={onInputKey}
          />
          {!compact && <kbd aria-hidden="true">Ctrl K</kbd>}
        </label>
      )}
      {showPanel && (
        <div className="global-search__panel" id="global-search-results" role="listbox" aria-label="Search results">
          {problem ? (
            <p className="global-search__note" role="status">{problem}</p>
          ) : busy && !payload ? (
            <p className="global-search__note" role="status">Searching…</p>
          ) : payload && payload.groups.length === 0 ? (
            <p className="global-search__note" role="status">
              Nothing in this workspace matches “{term}”.
            </p>
          ) : (
            payload?.groups.map((group) => (
              <section key={group.key} className="global-search__group">
                <h3>{group.label}</h3>
                {group.items.map((item) => {
                  index += 1;
                  const mine = index;
                  return (
                    <button
                      key={`${group.key}:${item.id}`}
                      type="button"
                      role="option"
                      aria-selected={mine === active}
                      className={mine === active ? "is-active" : ""}
                      onMouseEnter={() => setActive(mine)}
                      onClick={() => choose(item)}
                    >
                      <strong>{item.title}</strong>
                      {item.subtitle && <span>{item.subtitle}</span>}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
