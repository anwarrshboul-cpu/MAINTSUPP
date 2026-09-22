"use client";
/* eslint-disable @next/next/no-img-element -- every picture here is a website media
   file from this app's own `/media/...` route, already web-sized and served
   immutable; this Node build has no `next/image` optimiser to hand it to. */

/**
 * Choosing an image or a video for a page block, from the website media library
 * (decision K).
 *
 * The field shows what is chosen — its picture, its title, and whether it has
 * alt text — and opens a dialog listing the library's assets of the right kind.
 * Archived assets are not offered (a block that already uses one keeps it). The
 * page's save checks the choice again against the library, so this is a
 * convenience, never the rule.
 */

import { useEffect, useMemo, useState } from "react";

import { Icon } from "../../components";
import { useDialogBehaviour } from "../portal/overlay/dialog-behaviour";
import "./site-media.css";

/** Which kind of asset a block field takes — the catalogue's `accept`. */
export type MediaAccept = "image" | "video";

type PickerItem = {
  id: string;
  kind: "image" | "video" | "document";
  title: string;
  altText: string | null;
  status: "active" | "archived";
  current: { url: string; display: { url: string } | null; originalName: string } | null;
};

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !payload) throw new Error(payload?.error ?? "The media library could not be reached.");
  return payload;
}

function Preview({ item }: { item: PickerItem }) {
  if (item.kind === "image" && item.current) {
    return <img src={item.current.display?.url ?? item.current.url} alt="" loading="lazy" decoding="async" />;
  }
  return <Icon name={item.kind === "video" ? "camera" : "document"} size={24} />;
}

export function MediaField({
  accept,
  required,
  value,
  onChange,
}: {
  accept: MediaAccept;
  required?: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = typeof value === "string" ? value : "";
  const [chosen, setChosen] = useState<PickerItem | null>(null);
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /* What an existing choice is, read once per id — the block stores only the id. */
  useEffect(() => {
    if (!id || chosen?.id === id) return;
    let cancelled = false;
    void (async () => {
      try {
        const detail = await readJson<{ item: PickerItem }>(`/api/cms-media?id=${encodeURIComponent(id)}`);
        if (!cancelled) {
          setChosen(detail.item);
          setProblem(null);
        }
      } catch (caught) {
        if (!cancelled) setProblem(caught instanceof Error ? caught.message : "That asset could not be read.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, chosen?.id]);

  const shown = id && chosen?.id === id ? chosen : null;
  const label = accept === "image" ? "Image" : "Video";
  return (
    <div className="admin-field media-field">
      <span>
        {label}
        {required ? " (required)" : ""}
      </span>
      <div className="media-field__row">
        {shown ? (
          <>
            <span className="media-field__thumb">
              <Preview item={shown} />
            </span>
            <span className="media-field__name">
              {shown.title}
              <small>
                {shown.status === "archived" ? "Archived — still shown here. " : ""}
                {accept === "image" ? (shown.altText ? "Has alt text." : "No alt text in the library — add it on this block.") : ""}
              </small>
            </span>
          </>
        ) : (
          <span className="media-field__name">
            {id ? (problem ?? "Reading…") : `No ${accept === "image" ? "image" : "video"} chosen.`}
          </span>
        )}
        <button type="button" className="secondary-button admin-mini" onClick={() => setPicking(true)}>
          {id ? "Change…" : "Choose from library…"}
        </button>
        {id && !required ? (
          <button type="button" className="secondary-button admin-mini" onClick={() => onChange("")}>
            Remove
          </button>
        ) : null}
      </div>
      <small>From Website media. Upload new files there.</small>
      {picking && (
        <MediaPicker
          accept={accept}
          onClose={() => setPicking(false)}
          onSelect={(item) => {
            setChosen(item);
            onChange(item.id);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

function MediaPicker({
  accept,
  onClose,
  onSelect,
}: {
  accept: "image" | "video";
  onClose: () => void;
  onSelect: (item: PickerItem) => void;
}) {
  const { surface, onBackdrop, onKeyDown } = useDialogBehaviour(true, onClose);
  const [items, setItems] = useState<PickerItem[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const library = await readJson<{ items: PickerItem[] }>("/api/cms-media");
        if (!cancelled) setItems(library.items);
      } catch (caught) {
        if (!cancelled) setProblem(caught instanceof Error ? caught.message : "The media library could not be reached.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const offered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items ?? []).filter(
      (item) => item.kind === accept && item.status === "active" && (!needle || item.title.toLowerCase().includes(needle)),
    );
  }, [items, accept, query]);

  return (
    <div className="media-picker__backdrop" role="presentation" onPointerDown={onBackdrop}>
      <div
        ref={surface}
        className="media-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-picker-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="media-picker__head">
          <h2 id="media-picker-title">Choose {accept === "image" ? "an image" : "a video"}</h2>
          <button type="button" className="secondary-button admin-mini" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <label className="admin-field">
          <span>Search</span>
          <input type="search" data-autofocus value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {problem && <p role="alert">{problem}</p>}
        {!problem && items === null && <p>Loading the library…</p>}
        {items !== null && offered.length === 0 && (
          <p>
            No {accept === "image" ? "images" : "videos"} {query ? "match" : "in the library yet"}. Upload them in Website media.
          </p>
        )}
        <ul className="media-picker__grid">
          {offered.map((item) => (
            <li key={item.id}>
              <button type="button" className="media-picker__choice" onClick={() => onSelect(item)}>
                <span className="media-field__thumb">
                  <Preview item={item} />
                </span>
                <span>{item.title}</span>
                {accept === "image" && !item.altText ? <small>No alt text</small> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
