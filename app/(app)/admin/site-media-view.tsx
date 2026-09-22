"use client";
/* eslint-disable @next/next/no-img-element -- every picture here is a website media
   file from this app's own `/media/...` route, already web-sized and served
   immutable; this Node build has no `next/image` optimiser to hand it to. */

/**
 * The website media library — decision K (§77 item 12).
 *
 * Upload, browse, preview, describe, replace, archive and delete the images,
 * video and PDFs the website uses. Built on the admin kit (`useAdminResource`,
 * `adminWrite`, the notices and the flash) like every console screen.
 *
 * EVERY RULE IS THE SERVER'S. The accepted types, the size ceilings and the
 * honest gaps come from `GET /api/cms-media`; the storage state (ready, bucket
 * missing, unreachable) is measured there and shown here before anyone tries an
 * upload. Uploads go through `uploadWebsiteMedia` in `client-upload.ts` — the
 * same session-bound multipart path every other upload uses.
 *
 * DELETE IS GUARDED BY USE. The server refuses to delete an asset any website
 * page names; the button says why before it is pressed, and archive is offered
 * instead, because archiving never breaks a page.
 */

import { useMemo, useRef, useState } from "react";

import { Icon } from "../../components";
import { describeUploadStage, uploadWebsiteMedia, type UploadStage } from "../../lib/client-upload";
import { formatShortDateTime } from "../../lib/format-date";
import { useUnsavedChanges } from "../../lib/use-unsaved-changes";
import { AdminFlash, AdminLoading, AdminNotice, adminWrite, useAdminResource } from "../portal/views/admin-shell";
import "./site-pages.css";
import "./site-media.css";

type Usage = { slug: string; title: string; state: "draft" | "scheduled" | "live" | "ended" };
type Version = {
  id: string;
  versionNo: number;
  url: string;
  originalName: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  display: { url: string; width: number | null; height: number | null } | null;
  uploadedByEmail: string | null;
  createdAt: string;
};
type Item = {
  id: string;
  kind: "image" | "video" | "document";
  title: string;
  altText: string | null;
  status: "active" | "archived";
  current: Version | null;
  versionCount: number;
  updatedAt: string;
  updatedByEmail: string | null;
  usage: Usage[];
};
type Payload = {
  items: Item[];
  storage: { state: "ready" | "missing" | "unavailable"; bucket: string; message: string | null };
  accept: string;
  rules: { titleMax: number; altMax: number; maxVideoBytes: number; maxFileBytes: number };
  omissions: string[];
};
type Detail = { item: Item; versions: Version[]; usage: Usage[] };

const bytes = (value: number) =>
  value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;

const KIND_LABEL: Record<Item["kind"], string> = { image: "Image", video: "Video", document: "PDF" };

/** A card's picture: the web-sized copy of an image, an icon for anything else. */
function Thumb({ item }: { item: Item }) {
  const version = item.current;
  if (item.kind === "image" && version) {
    return <img src={version.display?.url ?? version.url} alt="" loading="lazy" decoding="async" />;
  }
  return (
    <span className="site-media__glyph" aria-hidden="true">
      <Icon name={item.kind === "video" ? "camera" : "document"} size={28} />
    </span>
  );
}

export function SiteMediaView() {
  const { data, loading, denied, error, reload } = useAdminResource<Payload>("/api/cms-media");
  const [flash, setFlash] = useState<{ ok: boolean; message: string } | null>(null);
  const [kind, setKind] = useState<"all" | Item["kind"]>("all");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const [query, setQuery] = useState("");
  const [uploads, setUploads] = useState<Array<{ id: string; name: string; stage: UploadStage }>>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<{ title: string; altText: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const replacer = useRef<HTMLInputElement>(null);

  const dirty = Boolean(selected && draft && (draft.title !== selected.item.title || draft.altText !== (selected.item.altText ?? "")));
  const confirmLeave = useUnsavedChanges(dirty);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.items ?? []).filter(
      (item) =>
        (kind === "all" || item.kind === kind) &&
        (status === "all" || item.status === status) &&
        (!needle || item.title.toLowerCase().includes(needle) || (item.current?.originalName ?? "").toLowerCase().includes(needle)),
    );
  }, [data, kind, status, query]);

  const open = async (id: string) => {
    if (!confirmLeave()) return;
    const response = await fetch(`/api/cms-media?id=${encodeURIComponent(id)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as (Detail & { error?: string }) | null;
    if (!response.ok || !payload) {
      setFlash({ ok: false, message: payload?.error ?? "That asset could not be opened." });
      return;
    }
    setSelected(payload);
    setDraft({ title: payload.item.title, altText: payload.item.altText ?? "" });
  };

  const upload = async (files: FileList | null, replaces?: string) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setUploads((current) => [...current, { id, name: file.name, stage: { phase: "preparing" } }]);
      const update = (stage: UploadStage) =>
        setUploads((current) => current.map((entry) => (entry.id === id ? { ...entry, stage } : entry)));
      try {
        const result = await uploadWebsiteMedia({ file, replaces, onStage: update });
        const saved = typeof result.item?.id === "string" ? result.item.id : null;
        setFlash({ ok: true, message: replaces ? `Replaced with ${file.name}. Every page that uses it now shows the new file.` : `Uploaded ${file.name}.` });
        if (replaces && saved) await open(saved);
      } catch (caught) {
        setFlash({ ok: false, message: caught instanceof Error ? caught.message : `${file.name} could not be uploaded.` });
      }
    }
    await reload();
  };

  const patch = async (body: Record<string, unknown>, done: string) => {
    if (!selected) return;
    setBusy(true);
    const result = await adminWrite("/api/cms-media", "PATCH", { id: selected.item.id, ...body });
    setBusy(false);
    setFlash({ ok: result.ok, message: result.ok ? done : result.message });
    if (result.ok && result.payload) {
      const next = result.payload as unknown as Detail;
      setSelected(next);
      setDraft({ title: next.item.title, altText: next.item.altText ?? "" });
      await reload();
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete "${selected.item.title}" and all ${selected.versions.length} of its files? This cannot be undone.`)) return;
    setBusy(true);
    const result = await adminWrite(`/api/cms-media?id=${encodeURIComponent(selected.item.id)}`, "DELETE");
    setBusy(false);
    setFlash({ ok: result.ok, message: result.ok ? `Deleted "${selected.item.title}".` : result.message });
    if (result.ok) {
      setSelected(null);
      setDraft(null);
      await reload();
    }
  };

  if (loading && !data) return <AdminLoading label="Loading the website's media…" />;
  if (denied) {
    return (
      <AdminNotice tone="denied" icon="shield" title="This screen is for MAINTSUPP platform staff">
        {denied} The server refused this request — the screen is not hidden behind a button.
      </AdminNotice>
    );
  }
  if (error || !data) {
    return (
      <AdminNotice tone="error" icon="alert" title="The media library could not be loaded">
        {error ?? "That could not be loaded."}
      </AdminNotice>
    );
  }

  const ready = data.storage.state === "ready";
  const item = selected?.item ?? null;
  const version = item?.current ?? null;

  return (
    <div className="admin-console cms-admin site-media">
      <AdminFlash flash={flash} onDismiss={() => setFlash(null)} />
      {!ready && (
        <AdminNotice tone="error" icon="alert" title="Uploads are not possible yet">
          {data.storage.message}
        </AdminNotice>
      )}

      <div className="admin-toolbar">
        <strong>Website media</strong>
        <span className="admin-subtle">
          {data.items.length} asset{data.items.length === 1 ? "" : "s"} · video up to {bytes(data.rules.maxVideoBytes)}, other files up to{" "}
          {bytes(data.rules.maxFileBytes)}
        </span>
        <span className="admin-toolbar__spacer" />
        <input
          ref={picker}
          type="file"
          multiple
          accept={data.accept}
          className="site-media__file"
          aria-label="Choose files to upload"
          onChange={(event) => {
            void upload(event.target.files);
            event.target.value = "";
          }}
        />
        <button className="primary-button" type="button" disabled={!ready} onClick={() => picker.current?.click()}>
          <Icon name="upload" size={16} /> Upload
        </button>
      </div>

      {uploads.length > 0 && (
        <ul className="site-media__uploads" aria-live="polite">
          {uploads.map((entry) => (
            <li key={entry.id} className={entry.stage.phase === "failed" ? "is-failed" : undefined}>
              <span>{entry.name}</span>
              <small>{describeUploadStage(entry.stage)}</small>
            </li>
          ))}
        </ul>
      )}

      <div className="site-media__filters">
        <label className="admin-field">
          <span>Type</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="all">All</option>
            <option value="image">Images</option>
            <option value="video">Video</option>
            <option value="document">PDFs</option>
          </select>
        </label>
        <label className="admin-field">
          <span>Showing</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="active">In the library</option>
            <option value="archived">Archived</option>
            <option value="all">Everything</option>
          </select>
        </label>
        <label className="admin-field admin-field--grow">
          <span>Search</span>
          <input type="search" value={query} placeholder="Title or file name" onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>

      <div className="site-media__layout">
        {shown.length === 0 ? (
          <AdminNotice tone="info" icon="image" title={data.items.length ? "Nothing matches" : "No media yet"}>
            {data.items.length ? "Change the filters to see more." : "Upload an image, a video or a PDF to start the library."}
          </AdminNotice>
        ) : (
          <ul className="site-media__grid">
            {shown.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`site-media__card${item?.id === entry.id ? " is-selected" : ""}`}
                  aria-pressed={item?.id === entry.id}
                  onClick={() => void open(entry.id)}
                >
                  <span className="site-media__thumb">
                    <Thumb item={entry} />
                  </span>
                  <span className="site-media__name">{entry.title}</span>
                  <small>
                    {KIND_LABEL[entry.kind]}
                    {entry.current ? ` · ${bytes(entry.current.byteSize)}` : ""}
                    {entry.current?.width && entry.current?.height ? ` · ${entry.current.width}×${entry.current.height}` : ""}
                  </small>
                  <small>
                    {entry.usage.length ? `Used on ${entry.usage.length} page${entry.usage.length === 1 ? "" : "s"}` : "Not used yet"}
                    {entry.status === "archived" ? " · Archived" : ""}
                    {entry.kind === "image" && !entry.altText ? " · No alt text" : ""}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}

        {item && draft && (
          <section className="admin-panel site-media__detail" aria-labelledby="site-media-detail">
            <h2 id="site-media-detail" className="site-media__heading">
              {item.title}
            </h2>
            <div className="site-media__preview">
              {version && item.kind === "image" && <img src={version.display?.url ?? version.url} alt={item.altText ?? ""} />}
              {version && item.kind === "video" && (
                <video controls preload="metadata" aria-label={item.title}>
                  <source src={version.url} type={version.contentType} />
                </video>
              )}
              {version && item.kind === "document" && (
                <a className="secondary-button" href={version.url} target="_blank" rel="noopener noreferrer">
                  <Icon name="document" size={16} /> Open the PDF
                </a>
              )}
            </div>
            {version && (
              <p className="admin-subtle">
                {version.originalName} · {bytes(version.byteSize)}
                {version.width && version.height ? ` · ${version.width}×${version.height}` : ""}
                {version.durationMs ? ` · ${Math.round(version.durationMs / 1000)} s` : ""} · version {version.versionNo} of {selected?.versions.length}
              </p>
            )}
            {version && (
              <label className="admin-field">
                <span>Address</span>
                <input readOnly value={version.url} onFocus={(event) => event.target.select()} />
                <small>Link to this from a page button (a PDF, for example). A replacement keeps pages up to date; this address is this version&apos;s.</small>
              </label>
            )}
            <label className="admin-field">
              <span>Title</span>
              <input maxLength={data.rules.titleMax} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            {item.kind === "image" && (
              <label className="admin-field">
                <span>Alt text</span>
                <textarea
                  rows={2}
                  maxLength={data.rules.altMax}
                  value={draft.altText}
                  onChange={(event) => setDraft({ ...draft, altText: event.target.value })}
                />
                <small>What a screen reader says when a page shows this image. A page cannot use an image with none.</small>
              </label>
            )}
            <div className="site-media__actions">
              <button
                className="primary-button"
                type="button"
                disabled={busy || !dirty}
                onClick={() => void patch({ title: draft.title, altText: draft.altText || null }, "Saved.")}
              >
                Save details
              </button>
              <input
                ref={replacer}
                type="file"
                accept={data.accept}
                className="site-media__file"
                aria-label={`Choose a file to replace ${item.title}`}
                onChange={(event) => {
                  void upload(event.target.files, item.id);
                  event.target.value = "";
                }}
              />
              <button className="secondary-button" type="button" disabled={busy || !ready} onClick={() => replacer.current?.click()}>
                Replace file…
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  void patch(
                    { status: item.status === "archived" ? "active" : "archived" },
                    item.status === "archived" ? "Back in the library." : "Archived. It keeps working wherever it is used.",
                  )
                }
              >
                {item.status === "archived" ? "Restore from archive" : "Archive"}
              </button>
              <button
                className="secondary-button admin-mini--danger"
                type="button"
                disabled={busy || (selected?.usage.length ?? 0) > 0}
                aria-describedby="site-media-delete-note"
                onClick={() => void remove()}
              >
                Delete
              </button>
            </div>
            <p id="site-media-delete-note" className="admin-subtle">
              {selected?.usage.length
                ? "It is used on a website page, so it cannot be deleted. Remove it from these pages first, or archive it."
                : "Not used on any page, so it can be deleted — permanently, with every file it has had."}
            </p>
            {selected && selected.usage.length > 0 && (
              <ul className="site-media__usage">
                {selected.usage.map((page) => (
                  <li key={page.slug}>
                    <a href={`/p/${page.slug}${page.state === "live" ? "" : "?preview=1"}`} target="_blank" rel="noopener noreferrer">
                      {page.title}
                    </a>{" "}
                    <small>/p/{page.slug} · {page.state}</small>
                  </li>
                ))}
              </ul>
            )}
            {selected && selected.versions.length > 1 && (
              <>
                <h3 className="site-media__subheading">Every file it has had</h3>
                <ol className="site-media__versions">
                  {selected.versions.map((entry) => (
                    <li key={entry.id}>
                      <span>
                        Version {entry.versionNo}: {entry.originalName} · {bytes(entry.byteSize)} · {formatShortDateTime(entry.createdAt)}
                        {entry.uploadedByEmail ? ` · ${entry.uploadedByEmail}` : ""}
                      </span>
                      {entry.id === version?.id ? (
                        <small>Current</small>
                      ) : (
                        <button
                          type="button"
                          className="secondary-button admin-mini"
                          disabled={busy}
                          onClick={() => void patch({ currentVersion: entry.id }, `Version ${entry.versionNo} is current again.`)}
                        >
                          Make current
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        )}
      </div>

      <details className="site-media__omissions">
        <summary>What the media library does not do</summary>
        <ul className="cms-admin__omissions">
          {data.omissions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
