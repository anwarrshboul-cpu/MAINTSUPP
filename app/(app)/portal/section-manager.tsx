"use client";

/**
 * W02 — the workspace's own sections, managed from the product.
 *
 * WHY THIS FILE EXISTS. Stage 23 built the whole server side of "add a section"
 * — `POST | PATCH | DELETE /api/workspace-sections`, the catalogue, the audit
 * lines, the archive-before-purge rule — and then nothing in the browser ever
 * called any of it. The complete set of client references to that endpoint was
 * two lines in `board-view-memory.ts`, both for the `/view` sub-route. So the
 * capability existed and was unreachable: an owner who wanted a CCTV section
 * had to write a `fetch` by hand. Five official checks were failing on a
 * missing dialog rather than on missing behaviour:
 *
 *   W02-02  provide an "Add New Section" button
 *   W02-03  rename sections
 *   W02-04  hide, archive or remove sections
 *   W02-05  confirm before permanently removing one
 *   W02-08  choose an icon and position for each section
 *
 * WHAT THIS IS NOT. The sidebar's own editor (`sidebar-nav.tsx`) already
 * arranges what is there — order, visibility and a display-label override,
 * stored per person or per workspace in `navigation_layouts`. That is
 * ARRANGEMENT. This file edits EXISTENCE: the `workspace_sections` rows
 * themselves. The two are deliberately separate tables and the separation is
 * the reason a section added today appears for somebody who arranged their
 * sidebar a year ago. Nothing here writes an arrangement, and archiving a
 * section here does not disturb anybody's — which is what lets a section
 * restored next week come back where it was.
 *
 * REMOVAL IS TWO DIFFERENT ACTS AND THE UI SAYS SO. "Remove" archives, which is
 * reversible and is what that button does. "Delete" sends the whole section to
 * the Recycle Bin, guarded here by an inline confirmation step that has to be
 * read past — not a `window.confirm`, which is the shape W07-06 is still marked
 * PARTIAL for.
 *
 * W2C — AND THE DESTRUCTIVE BUTTON NO LONGER LIES.
 *
 * It used to say "Remove permanently", send `?purge=1`, and be refused by the
 * server while the section's register held a single row — or while a single row
 * of it sat in the recycle bin, or while it held one site. The owner's report
 * was that removing a custom section therefore meant emptying it by hand first,
 * twice over, for what he regards as one object.
 *
 * So the button is "Delete", it sends `?bin=1`, and the section goes to the
 * Recycle Bin AS ONE ENTRY with its register, its rows, its views, its forms
 * and its files. It is restorable there for 30 days and destroyed after them,
 * which is what the confirmation says. The truly irreversible act — "Delete for
 * good" — lives in the bin, behind `data.delete`, where every other permanent
 * deletion in this product already lives. `?purge=1` still exists on the API,
 * unchanged and still refusing an occupied register; nothing in the product
 * sends it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../components";
import { BoardModal } from "./board-actions/board-modal";
import { BUILT_IN_GROUPS } from "../../api/navigation/layout";
import "./section-manager.css";

/** One row of `workspace_sections`, as `/api/workspace-sections` returns it. */
export type WorkspaceSectionRow = {
  key: string;
  label: string;
  description?: string | null;
  /** W02-06 — whether the register it draws belongs to this section alone. */
  ownsBoard?: boolean;
  /** W2 — the template it was created from. NULL means a legacy second door. */
  template?: string | null;
  icon: IconName;
  surface: string;
  boardKey: string | null;
  group: string;
  position: number;
  archived: boolean;
  /**
   * W2C — in the Recycle Bin, with its register and everything on it.
   *
   * A THIRD state, not a stronger `archived`, and it has to be read first: the
   * server sets both flags so that every reader which already drops an archived
   * section drops a deleted one too. Archived means "out of the sidebar, put it
   * back whenever"; deleted means "in the bin for 30 days, then gone".
   */
  deleted?: boolean;
  deletedAt?: string | null;
  /** When the bin will empty it. ISO-8601 UTC, or null when it is not deleted. */
  expiresAt?: string | null;
};

/**
 * "6 days left", from the stored expiry.
 *
 * Days rather than a date, matching the Recycle Bin's own line — "4 days left"
 * is the fact somebody acts on, and a timestamp makes them do the arithmetic.
 * The exact moment is still available: it is on the bin entry.
 */
function daysLeftLabel(expiresAt: string | null | undefined) {
  if (!expiresAt) return "In the Recycle Bin";
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return "In the Recycle Bin";
  if (remaining <= 0) return "Due to be deleted for good";
  const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
  return `${days} day${days === 1 ? "" : "s"} left`;
}

/** A screen a section may draw, as the server describes it. */
type Surface = {
  key: string;
  label: string;
  description: string;
  boardKey: string | null;
};

/**
 * A template a NEW section may be built from, as the server describes it.
 *
 * `available` is the server's word and this file does not argue with it. An
 * unavailable template is drawn — so the owner can see it exists and read why
 * it is not yet on offer — and is not selectable, because the owner's §8 rule
 * is that a fake option must not be clickable. `POST` refuses one too, so the
 * two cannot drift into disagreeing.
 */
type Template = {
  key: string;
  label: string;
  description: string;
  surface: string;
  available: boolean;
  unavailable?: string;
};

type Catalogue = {
  sections: WorkspaceSectionRow[];
  surfaces: Surface[];
  templates: Template[];
  canEdit: boolean;
};

/**
 * The icons a section may wear.
 *
 * A SUBSET, deliberately, and safe because it is a subset. The server validates
 * against `ICON_NAMES` in `app/api/workspace-sections/catalogue.ts`, which
 * `tests/stage-twentythree-sections.test.mjs` already holds equal to `IconName`.
 * Every entry below is in that set, so nothing this picker can offer will be
 * refused on write. The cost of the subset is that an owner cannot choose
 * `chevron` or `close` for a section — glyphs that mean something else
 * everywhere in the product — which is the point of leaving them out.
 */
const PICKABLE_ICONS: IconName[] = [
  "grid", "camera", "shield", "building", "store", "tool", "wrench",
  "document", "folder", "list", "calendar", "clock", "chart", "activity",
  "alert", "bell", "check", "inbox", "map", "image", "link", "message",
  "paperclip", "phone", "search", "settings", "spark", "thumb", "user",
  "users", "home", "filter", "upload", "download", "updates", "edit",
];

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Every write goes through here so one place turns a refusal into its reason. */
async function send(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "The change could not be saved.",
    );
  }
  return payload;
}

/* ── The add / edit form ──────────────────────────────────────────────────── */

/**
 * One form for both, because the fields are the same four and a second copy is
 * how "add" and "edit" come to disagree about what a section may be. `initial`
 * absent means add.
 */
function SectionForm({
  initial,
  surfaces,
  templates,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: WorkspaceSectionRow | null;
  surfaces: Surface[];
  templates: Template[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: {
    label: string;
    description: string;
    icon: IconName;
    /* Sent only when EDITING a legacy second-door section, which is the only
       row whose screen may still be changed. An instance with a register of its
       own is refused by the server if it is sent one, because re-homing it
       would leave the register with nothing that opens it. */
    surface?: string;
    /* Sent only when ADDING. A template decides the structure the new register
       is born with; it is not an editable field afterwards. */
    template?: string;
    group: string;
  }) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  /*
   * The name field takes focus when the form appears.
   *
   * `data-autofocus` is honoured by `BoardModal` when the DIALOG opens, and the
   * form is revealed later — pressing "Add new section" swapped the body's
   * contents and left focus on <body>, so a keyboard user had to Tab back in
   * from the top of the page to reach the field they had just asked for.
   * Mounted only while adding or editing, so this runs once per appearance.
   */
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const [icon, setIcon] = useState<IconName>(initial?.icon ?? "grid");
  const [surface, setSurface] = useState(initial?.surface ?? surfaces[0]?.key ?? "maintenance");
  /* The first template that can actually be chosen — never merely the first in
     the list, which may be one the server has marked unavailable. */
  const [template, setTemplate] = useState(
    () => templates.find((entry) => entry.available)?.key ?? "",
  );
  const [group, setGroup] = useState(initial?.group ?? BUILT_IN_GROUPS[0].key);

  const chosen = surfaces.find((entry) => entry.key === surface) ?? null;
  const trimmed = label.trim();
  /*
   * WHICH CONTROL THIS FORM SHOWS, and it is three cases rather than two.
   *
   *   adding                 -> the TEMPLATE chooser. The new section gets a
   *                             register of its own, and this decides its shape.
   *   editing an INSTANCE    -> no chooser at all, and a line saying what it was
   *                             built from. Its template is not editable (that
   *                             would be a migration) and its screen is not
   *                             either — see the 409 in the PATCH handler.
   *   editing a LEGACY row   -> the screen picker, unchanged. A second door onto
   *                             an existing screen is exactly what those rows
   *                             are, and this is the only way to re-home one.
   */
  const ownsRegister = initial?.ownsBoard === true;
  const builtFrom = initial?.template
    ? templates.find((entry) => entry.key === initial.template) ?? null
    : null;

  return (
    <form
      className="sec-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed || busy) return;
        onSubmit({
          label: trimmed,
          description: description.trim(),
          icon,
          /* W02-06 / W2. Adding sends a TEMPLATE and never a surface: the
             section gets a register of its own and the template says what shape
             it starts in. Editing sends a surface only for a legacy second door,
             which is the only row that has one to change. An instance sends
             neither — its screen and its template are both fixed. */
          ...(initial
            ? ownsRegister
              ? {}
              : { surface }
            : template
              ? { template }
              : {}),
          group,
        });
      }}
    >
      <label className="ba-field">
        <span>Section name</span>
        <input
          ref={nameRef}
          className="ba-input"
          value={label}
          maxLength={40}
          data-autofocus
          placeholder="CCTV"
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>

      <label className="ba-field">
        <span>Description</span>
        {/* W02-07 asks the page for a description as well as a title. Optional:
            left empty, the screen keeps its own blurb, which is what every
            section created before this column existed does. */}
        <textarea
          className="ba-input sec-textarea"
          value={description}
          maxLength={240}
          rows={2}
          placeholder="What this section is for. Optional."
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>

      <fieldset className="sec-icons">
        <legend>Icon</legend>
        {/* Native radios: the arrow-key behaviour, the group semantics and the
            "one of these is chosen" announcement all come free, and none of it
            has to be re-implemented with aria attributes that can drift. */}
        <div className="sec-icons__grid">
          {PICKABLE_ICONS.map((name) => (
            <label
              key={name}
              className={`sec-icon${icon === name ? " is-chosen" : ""}`}
              title={name}
            >
              <input
                type="radio"
                name="section-icon"
                value={name}
                checked={icon === name}
                onChange={() => setIcon(name)}
              />
              <Icon name={name} size={17} />
              <span className="sec-visually-hidden">{name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {!initial ? (
        /*
         * W2 §3 — THE TEMPLATE CHOOSER, back where the owner asked for it.
         *
         * It went missing when W02-06 made every new section a register of its
         * own: the screen picker was removed from Add (correctly — it offered
         * the second-door behaviour the owner had just ruled out) and nothing
         * took its place, so "what is this section made of" stopped being a
         * question anybody could answer.
         *
         * Native radios, like the icon grid above and for the same reasons: the
         * arrow keys, the group semantics and the "one of these is chosen"
         * announcement all come free, and `disabled` on a radio is a state
         * assistive technology already knows how to say.
         */
        <fieldset className="sec-templates">
          <legend>Template</legend>
          <p className="ba-hint sec-templates__intro">
            What the section is built from. Its STRUCTURE is copied — columns,
            groups and view tabs. Its DATA is not: the register starts empty, and
            nothing you do in it touches the section it was modelled on.
          </p>
          <div className="sec-templates__list">
            {templates.map((entry) => (
              <label
                key={entry.key}
                className={`sec-template${template === entry.key ? " is-chosen" : ""}${
                  entry.available ? "" : " is-unavailable"
                }`}
              >
                <input
                  type="radio"
                  name="section-template"
                  value={entry.key}
                  checked={template === entry.key}
                  /* §8 — "do NOT present clickable fake options". A template the
                     server cannot yet give an independent instance is shown and
                     explained, and cannot be picked. */
                  disabled={!entry.available}
                  onChange={() => setTemplate(entry.key)}
                />
                <span className="sec-template__text">
                  <strong>
                    {entry.label}
                    {!entry.available && (
                      <span className="sec-template__tag">Not available yet</span>
                    )}
                  </strong>
                  <small>{entry.available ? entry.description : entry.unavailable}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : ownsRegister ? (
        /* An instance. Its template is a fact about it, not a control: changing
           it would mean rebuilding the columns and groups under rows already
           filed on them, and its screen is fixed for the same reason. Stated
           rather than hidden, so the answer to "what is this?" is on the page. */
        <p className="ba-hint sec-owns">
          {builtFrom
            ? `Built from the ${builtFrom.label} template, with a register of its own.`
            : "This section has a register of its own."}{" "}
          Its columns, groups, views and items are its alone. A template cannot be
          changed after a section is created.
        </p>
      ) : (
        /*
         * Only for a LEGACY row, and only because sections created before
         * W02-06 are doors onto a shared screen. Removing the control would
         * leave those rows with no way to be re-homed; offering it for an
         * instance is what silently orphaned board `test` — see the PATCH
         * handler's note in `app/api/workspace-sections/route.ts`.
         */
        <>
          <label className="ba-field">
            <span>Screen it opens</span>
            <select
              className="ba-select"
              value={surface}
              onChange={(event) => setSurface(event.target.value)}
            >
              {surfaces.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          {chosen && <p className="ba-hint">{chosen.description}</p>}
          <p className="ba-hint">
            This section is a second door onto a screen the product already has,
            so it shows that screen&rsquo;s own data. Sections added now get a
            register of their own instead.
          </p>
        </>
      )}

      <label className="ba-field">
        <span>Heading</span>
        <select
          className="ba-select"
          value={group}
          onChange={(event) => setGroup(event.target.value)}
        >
          {BUILT_IN_GROUPS.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <p className="ba-hint">
        Where it lands before anybody rearranges their sidebar. Each person can
        still move it with Customise sidebar.
      </p>

      <div className="sec-form__foot">
        <button type="button" className="ba-btn ba-btn--quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="ba-btn ba-btn--primary" disabled={!trimmed || busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Add section"}
        </button>
      </div>
    </form>
  );
}

/* ── The manager ──────────────────────────────────────────────────────────── */

export function SectionManager({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after any write, so the sidebar re-reads its catalogue. */
  onChanged: () => void;
}) {
  return (
    <BoardModal
      open={open}
      onClose={onClose}
      title="Sections"
      titleId="section-manager-title"
      size="md"
      className="sec-modal"
    >
      {/*
        The state lives one component down, and that is what makes the dialog
        start clean every time it is opened.

        `BoardModal` returns null while closed, so nothing below here is mounted
        until it is. Resetting the form, the pending confirmation and the status
        line in an effect keyed on `open` was the alternative, and it is the
        cascading-render pattern the lint rule refuses — `board-settings-dialogs.tsx`
        already solves it this way for the same reason.
      */}
      <SectionManagerBody onClose={onClose} onChanged={onChanged} />
    </BoardModal>
  );
}

function SectionManagerBody({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<{ kind: "add" } | { kind: "edit"; key: string } | null>(null);
  /** The section a permanent removal is waiting to be confirmed for. */
  const [purging, setPurging] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/workspace-sections", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("The sections could not be loaded.");
      const payload = (await response.json()) as Catalogue;
      setCatalogue({
        sections: payload.sections ?? [],
        surfaces: payload.surfaces ?? [],
        templates: payload.templates ?? [],
        canEdit: payload.canEdit === true,
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sections could not be loaded.");
    }
  }, []);

  /* Deferred by a zero-delay timer, which is how every loader in `portal-app`
     is written: the fetch is kicked off after the first paint rather than
     synchronously inside the effect, so the dialog appears immediately with
     "Loading…" instead of the effect body reaching setState during commit. */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /* The confirmation takes focus when it appears. Without this the destructive
     button is somewhere behind the reader's cursor and the warning is never
     announced — which is most of what makes a confirmation a confirmation. */
  useEffect(() => {
    if (purging) confirmRef.current?.focus();
  }, [purging]);

  const live = useMemo(
    () => (catalogue?.sections ?? []).filter((entry) => !entry.archived),
    [catalogue],
  );
  /*
   * W2C — THREE LISTS, BECAUSE THERE ARE NOW THREE STATES.
   *
   * Deleting a section sets `archived` as well as `deleted` — see the column's
   * note in `db/schema.ts` — so `deleted` has to be tested FIRST or a section
   * in the recycle bin would appear under "Removed" offering a Restore that the
   * server refuses. The bin owns the recovery of a deleted section; this screen
   * says where it is and gets out of the way.
   */
  const archived = useMemo(
    () => (catalogue?.sections ?? []).filter((entry) => entry.archived && !entry.deleted),
    [catalogue],
  );
  const binned = useMemo(
    () => (catalogue?.sections ?? []).filter((entry) => entry.deleted),
    [catalogue],
  );

  /** Every mutation lands here so success, failure and the reload are one path. */
  const run = useCallback(
    async (work: () => Promise<unknown>, announced: string) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await load();
        onChanged();
        setStatus(announced);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The change could not be saved.");
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  const move = (key: string, delta: number) => {
    const order = live.map((entry) => entry.key);
    const from = order.indexOf(key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    const label = live.find((entry) => entry.key === key)?.label ?? "The section";
    void run(
      () =>
        send("/api/workspace-sections", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ order }),
        }),
      `${label} moved to position ${to + 1} of ${order.length}.`,
    );
  };

  const canEdit = catalogue?.canEdit === true;
  const editing =
    mode?.kind === "edit" ? live.find((entry) => entry.key === mode.key) ?? null : null;

  return (
    /* A fragment, not a second `BoardModal`: the shell above owns the dialog,
       and `.ba-modal__body` / `.ba-modal__foot` are its direct children by
       design — the foot has to sit outside the scrolling body to stay put. */
    <>
      <div className="ba-modal__body sec-body">
        {!canEdit && catalogue && (
          <p className="ba-error" role="note">
            Only roles with the settings.edit permission can change the platform
            structure. You can see what exists.
          </p>
        )}
        {error && (
          <p className="ba-error" role="alert">
            {error}
          </p>
        )}

        {mode?.kind === "add" || editing ? (
          <SectionForm
            initial={editing}
            surfaces={catalogue?.surfaces ?? []}
            templates={catalogue?.templates ?? []}
            busy={busy}
            onCancel={() => setMode(null)}
            onSubmit={(values) => {
              const target = editing;
              void run(
                () =>
                  send("/api/workspace-sections", {
                    method: target ? "PATCH" : "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(target ? { key: target.key, ...values } : values),
                  }),
                target
                  ? `${values.label} saved.`
                  : `${values.label} added to the sidebar.`,
              ).then(() => setMode(null));
            }}
          />
        ) : (
          <>
            {catalogue === null ? (
              <p className="ba-hint">Loading…</p>
            ) : live.length === 0 ? (
              /* The empty state names what a section is FOR. "No sections" would
                 be true and useless — this is the only screen that explains the
                 feature, because it is the only screen it appears on. */
              <p className="sec-empty">
                This workspace has not added any sections of its own. Adding one
                creates a register of its own — a CCTV list, say — with its own
                name, icon, columns, filters, views and items, and its own place
                in the sidebar.
              </p>
            ) : (
              <ul className="sec-list">
                {live.map((entry, index) => (
                  <li key={entry.key} className="sec-row">
                    <span className="sec-row__icon">
                      <Icon name={entry.icon} size={17} />
                    </span>
                    <span className="sec-row__text">
                      <strong>{entry.label}</strong>
                      <small>
                        {/* Its own register, or the shared screen it opens.
                            An owner deciding whether a section is safe to
                            remove needs to know which. */}
                        {entry.ownsBoard
                          ? `${
                              catalogue.templates.find((t) => t.key === entry.template)
                                ?.label ?? "Own"
                            } register`
                          : catalogue.surfaces.find((s) => s.key === entry.surface)?.label ??
                            entry.surface}
                        {" · "}
                        {BUILT_IN_GROUPS.find((g) => g.key === entry.group)?.label ??
                          entry.group}
                      </small>
                    </span>
                    {canEdit && (
                      <span className="sec-row__tools">
                        <button
                          type="button"
                          className="ba-iconbtn"
                          aria-label={`Move ${entry.label} up`}
                          disabled={index === 0 || busy}
                          onClick={() => move(entry.key, -1)}
                        >
                          <Icon name="chevron" size={15} className="sec-up" />
                        </button>
                        <button
                          type="button"
                          className="ba-iconbtn"
                          aria-label={`Move ${entry.label} down`}
                          disabled={index === live.length - 1 || busy}
                          onClick={() => move(entry.key, 1)}
                        >
                          <Icon name="chevron" size={15} />
                        </button>
                        <button
                          type="button"
                          className="ba-btn ba-btn--small"
                          disabled={busy}
                          onClick={() => setMode({ kind: "edit", key: entry.key })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ba-btn ba-btn--small"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                send(
                                  `/api/workspace-sections?key=${encodeURIComponent(entry.key)}`,
                                  { method: "DELETE" },
                                ),
                              `${entry.label} removed. It is archived and can be restored.`,
                            )
                          }
                        >
                          Remove
                        </button>
                        {/* W2C — the lifecycle's third step, reachable without
                            archiving first. "Remove" takes the section out of
                            the sidebar and leaves everything in place; this
                            takes the section AND its register, its rows, views,
                            forms and files to the Recycle Bin as one thing. The
                            owner asked for a custom section to be deletable as
                            one object rather than emptied row by row first. */}
                        <button
                          type="button"
                          className="ba-btn ba-btn--small ba-btn--danger"
                          disabled={busy}
                          onClick={() => setPurging(entry.key)}
                        >
                          Delete
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Gated on `canEdit`, not merely its buttons. A reader who
                cannot restore or purge has nothing to do with a list of
                sections somebody removed, and `GET /api/workspace-sections`
                returns archived rows to any member — so without this the names
                and icons of removed sections were on show to a client. */}
            {canEdit && archived.length > 0 && (
              <>
                <h3 className="sec-heading">Removed</h3>
                <p className="ba-hint">
                  Archived, not deleted. Restoring one puts it back where every
                  person had it.
                </p>
                <ul className="sec-list sec-list--archived">
                  {archived.map((entry) => (
                    <li key={entry.key} className="sec-row">
                      <span className="sec-row__icon">
                        <Icon name={entry.icon} size={17} />
                      </span>
                      <span className="sec-row__text">
                        <strong>{entry.label}</strong>
                      </span>
                      {canEdit && (
                        <span className="sec-row__tools">
                          <button
                            type="button"
                            className="ba-btn ba-btn--small"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  send("/api/workspace-sections", {
                                    method: "PATCH",
                                    headers: { "content-type": "application/json" },
                                    body: JSON.stringify({ key: entry.key, archived: false }),
                                  }),
                                `${entry.label} restored.`,
                              )
                            }
                          >
                            Restore
                          </button>
                          {/* W2C — "Delete", not "Remove permanently", because
                              it is not permanent. It moves the section and
                              everything on it to the Recycle Bin, where it can
                              be restored for 30 days. The irreversible act
                              lives in the bin and is called "Delete for
                              good" there. */}
                          <button
                            type="button"
                            className="ba-btn ba-btn--small ba-btn--danger"
                            disabled={busy}
                            onClick={() => setPurging(entry.key)}
                          >
                            Delete
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* W2C — the third state, read-only on purpose.
                A section in the bin has ONE owner of its recovery, and it is
                the Recycle Bin: restoring it there brings back the register,
                the rows, the views, the forms and the files in one act. A
                Restore button here would either duplicate that or half-do it,
                so this says where the section is and how long is left. */}
            {canEdit && binned.length > 0 && (
              <>
                <h3 className="sec-heading">In the Recycle Bin</h3>
                <p className="ba-hint">
                  Deleted, with everything the section held. Restore it — or
                  delete it for good — from the Recycle Bin in the sidebar. It
                  is emptied automatically after 30 days.
                </p>
                <ul className="sec-list sec-list--archived">
                  {binned.map((entry) => (
                    <li key={entry.key} className="sec-row">
                      <span className="sec-row__icon">
                        <Icon name="trash" size={17} />
                      </span>
                      <span className="sec-row__text">
                        <strong>{entry.label}</strong>
                        <small>{daysLeftLabel(entry.expiresAt)}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* W02-05. A step that has to be read past, focused when it opens,
                and it says what cannot be undone rather than "Are you sure?". */}
            {purging && (
              <div
                className="sec-confirm"
                role="alertdialog"
                aria-labelledby="sec-confirm-title"
                tabIndex={-1}
                ref={confirmRef}
              >
                <strong id="sec-confirm-title">
                  Delete “
                  {(catalogue?.sections ?? []).find((entry) => entry.key === purging)?.label ??
                    "this section"}
                  ”?
                </strong>
                {/* W2C — THE CONSEQUENCE, STATED HONESTLY.
                    This used to say "It cannot be restored and it cannot be
                    undone", which was true of the old one-step purge and is
                    false of this one. The sentence a confirmation makes has to
                    match what the button does, or the next confirmation is not
                    believed either. So: what moves, where it goes, how long
                    there is, and — still — the one thing that really cannot be
                    undone, which is what happens at the end of the thirty days
                    or when somebody chooses "Delete for good" in the bin. */}
                <p>
                  This section and its data will move to the Recycle Bin for 30
                  days — its register, the items on it, its views, its forms and
                  its files, together as one entry. Restoring it brings all of
                  it back exactly where it was.
                </p>
                <p>
                  It leaves every sidebar straight away, including
                  colleagues&rsquo; own. After 30 days, or if somebody chooses
                  Delete for good in the Recycle Bin, it is destroyed — and that
                  cannot be undone.
                </p>
                <div className="sec-confirm__foot">
                  <button
                    type="button"
                    className="ba-btn ba-btn--quiet"
                    onClick={() => setPurging(null)}
                  >
                    Keep it
                  </button>
                  <button
                    type="button"
                    className="ba-btn ba-btn--danger"
                    disabled={busy}
                    onClick={() => {
                      const target = (catalogue?.sections ?? []).find(
                        (entry) => entry.key === purging,
                      );
                      const key = purging;
                      setPurging(null);
                      void run(
                        () =>
                          /* W2C — `bin=1`, NOT `purge=1`. `purge=1` is the old
                             one-step destruction: it still exists, still needs
                             `data.delete`, and still refuses a register that
                             holds anything — which is exactly the dead end this
                             screen was making people walk into. Nothing in the
                             product sends it any more. */
                          send(
                            `/api/workspace-sections?key=${encodeURIComponent(key)}&bin=1`,
                            { method: "DELETE" },
                          ),
                        `${target?.label ?? "The section"} deleted. It is in the Recycle Bin for 30 days.`,
                      );
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {!(mode?.kind === "add" || editing) && (
        <div className="ba-modal__foot">
          <button type="button" className="ba-btn ba-btn--quiet" onClick={onClose}>
            Done
          </button>
          {/* W02-02 — the button the checklist asks for, on the screen that
              lists what already exists so "add" is always in context. */}
          <button
            type="button"
            className="ba-btn ba-btn--primary"
            data-section-add
            disabled={!canEdit || busy}
            onClick={() => setMode({ kind: "add" })}
          >
            Add new section
          </button>
        </div>
      )}

      {/* Every add, rename, move, remove and restore is announced. The buttons
          re-render in place, so without this a screen reader is told nothing at
          all happened. */}
      <span className="sec-visually-hidden" role="status" aria-live="polite">
        {status}
      </span>
    </>
  );
}

export default SectionManager;
