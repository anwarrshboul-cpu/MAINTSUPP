"use client";

/**
 * Search, across every workspace on this installation.
 *
 * WHY THE SCREEN IS SHAPED LIKE THIS.
 *
 * Every other console screen answers a question about one thing — the clients,
 * the users, the enquiries. This one answers "where is this?", which means the
 * two facts a reader needs first are the row's WORKSPACE and a way to get there.
 * So every result carries the workspace's name as a chip, and workspace-scoped
 * rows carry one action: Open, which switches workspace through `/api/context`
 * — the same door the Clients screen uses, so a workspace the actor is not a
 * member of is still refused by the server — and then goes to the portal screen
 * that shows the row. The platform's own rows (website pages, enquiries) have no
 * workspace and link inside the console instead.
 *
 * It searches on submit rather than as you type: a keystroke-by-keystroke search
 * across every tenant is a query per keystroke against seven tables, and this
 * console is not where that cost belongs. Enter, or the button.
 *
 * What it cannot answer is printed from the server's own list rather than
 * restated here, so the screen and the route cannot drift about it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Icon } from "../../components";
import { AdminFlash, AdminNotice } from "../portal/views/admin-shell";
import "./console-search.css";

type Item = {
  id: string;
  title: string;
  subtitle: string;
  workspaceId: string | null;
  workspaceName: string | null;
  href: string | null;
  portalHref: string | null;
};

type Group = { key: string; label: string; items: Item[] };

type Payload = {
  query: string;
  searched: string[];
  groups: Group[];
  workspaces: number;
  omissions: string[];
  error?: string;
};

/*
 * `?q=` — what the console's top-bar search sends (a plain GET form, 2026-09-24).
 * Read through `useSyncExternalStore` with an empty server snapshot, so the
 * server's first paint and the browser's agree and the field fills in after
 * hydration, without a state write inside an effect.
 */
const noSubscription = () => () => {};
const readArrivalQuery = () => new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
const noArrivalQuery = () => "";

export function ConsoleSearchView() {
  const arrivedWith = useSyncExternalStore(noSubscription, readArrivalQuery, noArrivalQuery);
  /* Null until the reader types; until then the field shows what they arrived with. */
  const [typed, setTerm] = useState<string | null>(null);
  const term = typed ?? arrivedWith;
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const search = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/admin/search?q=${encodeURIComponent(trimmed)}`, {
        headers: { accept: "application/json" },
      });
      const payload = (await response.json().catch(() => null)) as Payload | null;
      if (!response.ok || !payload) {
        setFailure(payload?.error ?? "The search could not be run.");
        setData(null);
        return;
      }
      setData(payload);
    } catch {
      setFailure("The search could not be reached.");
      setData(null);
    } finally {
      setBusy(false);
    }
  }, []);

  /* Run the query the reader arrived with, once. The search writes its own
     state after the request answers, as it does from the button. */
  const ranArrival = useRef(false);
  useEffect(() => {
    if (!arrivedWith || ranArrival.current) return;
    ranArrival.current = true;
    void search(arrivedWith);
  }, [arrivedWith, search]);

  /**
   * Switch workspace, then go where the row lives.
   *
   * The switch is a server decision — `/api/context` refuses an organisation the
   * actor is not a member of — and it sets a cookie the server reads, so the
   * navigation afterwards is a full load rather than a client route change.
   */
  async function open(item: Item) {
    if (!item.workspaceId) return;
    setOpening(item.id);
    setFailure(null);
    try {
      const response = await fetch("/api/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select_organisation", organisationId: item.workspaceId }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setFailure(payload?.error ?? "That workspace could not be opened.");
        return;
      }
      setFlash({ ok: true, message: `Opening ${item.workspaceName ?? "the workspace"}…` });
      window.location.assign(item.portalHref ?? "/dashboard");
    } catch {
      setFailure("That workspace could not be opened.");
    } finally {
      setOpening(null);
    }
  }

  const empty = data && data.groups.length === 0;

  return (
    <div className="admin-console console-search">
      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />

      <form
        className="admin-toolbar console-search__bar"
        onSubmit={(event) => {
          event.preventDefault();
          void search(term);
        }}
      >
        <label className="admin-field admin-field--grow">
          <span>Search every workspace</span>
          <input
            ref={input}
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="A job reference, a store, a contractor, a person, a page"
            aria-describedby="console-search-scope"
          />
        </label>
        <button className="primary-button" type="submit" disabled={busy || term.trim().length < 2}>
          <Icon name="search" size={15} /> {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {failure ? (
        <AdminNotice tone="error" icon="alert" title="That did not work">
          {failure}
        </AdminNotice>
      ) : null}

      {data ? (
        <p className="console-search__scope" id="console-search-scope">
          {`“${data.query}” across ${data.workspaces} ${data.workspaces === 1 ? "workspace" : "workspaces"}.`}
        </p>
      ) : null}

      {empty ? (
        <AdminNotice tone="empty" icon="search" title="Nothing matched">
          Nothing in any workspace matches that. The groups searched were{" "}
          {(data?.searched ?? []).join(", ")}.
        </AdminNotice>
      ) : null}

      {(data?.groups ?? []).map((group) => (
        <section className="console-search__group" key={group.key}>
          <h2>
            {group.label} <small>{group.items.length}</small>
          </h2>
          <ul>
            {group.items.map((item) => (
              <li key={`${group.key}:${item.id}`}>
                <div className="console-search__what">
                  <strong>{item.title}</strong>
                  {item.subtitle ? <span>{item.subtitle}</span> : null}
                </div>
                {item.workspaceName ? (
                  <span className="console-search__chip" title="The workspace this belongs to">
                    {item.workspaceName}
                  </span>
                ) : (
                  <span className="console-search__chip console-search__chip--platform" title="MAINTSUPP's own, not a workspace's">
                    MAINTSUPP
                  </span>
                )}
                {item.workspaceId ? (
                  <button
                    className="secondary-button admin-mini"
                    type="button"
                    onClick={() => void open(item)}
                    disabled={opening === item.id}
                  >
                    {opening === item.id ? "Opening…" : "Open"}
                  </button>
                ) : item.href ? (
                  <a className="secondary-button admin-mini" href={item.href}>
                    Open
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/* The kit's notice puts its children in a <p>, and this is a list — so it
          is its own block, built from the same tokens, rather than invalid markup
          inside a shared component. The lines come from the server. */}
      {data ? (
        <section className="console-search__omissions">
          <h2>What this search does not cover</h2>
          <ul>
            {data.omissions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
