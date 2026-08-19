"use client";

import * as React from "react";
import { Icon } from "../../components";
import type { FormQuestion } from "../../../db/monday-board-spec";
import {
  CANONICAL_OPTION_SETS,
  LOCATION_QUESTION_ID,
  mergeOptionStates,
} from "../../lib/form-projection";
import type { BuilderForm } from "./form-builder-model";

/**
 * The per-question option editor — monday's "Add option / edit / reorder /
 * per-option actions", against OUR sources of truth.
 *
 * THREE KINDS OF QUESTION, THREE OWNERS, ONE RULE. No option a submitter can
 * be shown may exist only in the form:
 *
 *   · LOCATION — owned by the Sites register. Adding an option here CREATES a
 *     site (through /api/sites, with its duplicate detection and defaults);
 *     renaming renames the canonical site; removing ARCHIVES it — the API
 *     refuses to hard-delete because jobs, assets and compliance documents
 *     reference it, and an archived site simply leaves the form. The submit
 *     route resolves answers against `sites.name`, so an option that is not a
 *     site would be an option that can never be submitted — the exact failure
 *     this design rules out.
 *
 *   · ENGINEER and PRIORITY — owned by the option registry (`option_values`,
 *     via /api/options), the same set the board's chips and the raise-ticket
 *     panel read. Renaming edits the display LABEL and leaves the stored
 *     VALUE untouched, so 744 job rows keep meaning what they meant — and the
 *     SLA (app/lib/priority-rules.ts) is keyed on the value, so a rename
 *     cannot change a due date. Deleting an option in use walks through the
 *     registry's reassignment flow rather than orphaning rows.
 *
 *   · EVERYTHING ELSE — options exist only in the form configuration (the
 *     captured monday snapshot), and are edited there directly.
 *
 * WHAT THE FORM ITSELF OWNS is presentation: per-option ORDER and VISIBILITY,
 * stored in the question's own `options` array as a preference layer that
 * `applyOptionPreferences` merges over the canonical list. Hiding a site here
 * does not close the site; archiving a site there removes it here.
 */

type MergedOption = { label: string; value: string; hidden: boolean };

/** A site row, as /api/sites lists them. Only what this editor reads. */
type SiteRow = {
  id: string;
  name: string;
  active: boolean;
  status: string;
};

/** A registry row, as /api/options?key=… lists them. */
type RegistryRow = {
  id: string;
  value: string;
  label: string;
  active: boolean;
  system: boolean;
  usage: number;
};

type EditorKind =
  | { kind: "location" }
  | { kind: "registry"; setKey: string }
  | { kind: "plain" };

function editorKind(questionId: string): EditorKind {
  if (questionId === LOCATION_QUESTION_ID) return { kind: "location" };
  const setKey = CANONICAL_OPTION_SETS[questionId];
  if (setKey) return { kind: "registry", setKey };
  return { kind: "plain" };
}

async function readJson(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, payload };
}

export function FormQuestionOptionsEditor({
  question,
  form,
  patch,
  busy,
}: {
  question: FormQuestion;
  form: BuilderForm;
  patch: (body: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const kind = editorKind(question.id);
  const [expanded, setExpanded] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /* The canonical list, fetched when the editor opens. */
  const [siteRows, setSiteRows] = React.useState<SiteRow[] | null>(null);
  const [registryRows, setRegistryRows] = React.useState<RegistryRow[] | null>(null);

  /* Row-level edit state. */
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [addLabel, setAddLabel] = React.useState("");
  const [addAddress, setAddAddress] = React.useState("");
  /** A registry delete blocked by usage: the value awaiting reassignment. */
  const [reassigning, setReassigning] = React.useState<RegistryRow | null>(null);
  const [reassignTo, setReassignTo] = React.useState("");

  const loadCanonical = React.useCallback(async () => {
    setError(null);
    try {
      if (kind.kind === "location") {
        const { ok, payload } = await readJson(await fetch("/api/sites"));
        if (!ok) throw new Error(String(payload.error ?? "Sites could not be loaded."));
        setSiteRows((payload.sites as SiteRow[]) ?? []);
      } else if (kind.kind === "registry") {
        const { ok, payload } = await readJson(
          await fetch(`/api/options?key=${encodeURIComponent(kind.setKey)}`),
        );
        if (!ok) throw new Error(String(payload.error ?? "Options could not be loaded."));
        setRegistryRows((payload.values as RegistryRow[]) ?? []);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Options could not be loaded.");
    }
  }, [kind.kind, kind.kind === "registry" ? kind.setKey : ""]);

  React.useEffect(() => {
    if (expanded && kind.kind !== "plain" && siteRows === null && registryRows === null) {
      void loadCanonical();
    }
  }, [expanded, kind.kind, loadCanonical, registryRows, siteRows]);

  /*
   * What the editor lists: the canonical options in the form's own order, with
   * the form's own hidden flags — the same merge the projection applies, so
   * this list IS the form, hidden rows included.
   */
  const live: Array<{ label: string; value: string }> | null =
    kind.kind === "location"
      ? (siteRows?.filter((site) => site.active) ?? null)?.map((site) => ({
          label: site.name,
          value: site.name,
        })) ?? null
      : kind.kind === "registry"
        ? registryRows
            ?.filter((row) => row.active)
            .map((row) => ({ label: row.label, value: row.value })) ?? null
        : (question.options ?? []).map((option) => ({
            label: option.label,
            value: option.value,
          }));

  const merged: MergedOption[] | null =
    kind.kind === "plain"
      ? (question.options ?? []).map((option) => ({
          label: option.label,
          value: option.value,
          hidden: !(option.visible && option.active),
        }))
      : live
        ? mergeOptionStates(question.options ?? null, live)
        : null;

  /*
   * Every mutation ends by writing the MIRROR — the question's `options` array
   * — because that is where the form's order and visibility live, and because
   * the PATCH response carries a freshly computed `optionOverrides`, which is
   * how the canvas, the Preview and this list all repaint together.
   */
  function writeMirror(entries: MergedOption[]) {
    patch({
      questions: form.config.questions.map((entry) =>
        entry.id === question.id
          ? {
              ...entry,
              options: entries.map((option) => ({
                label: option.label,
                value: option.value,
                visible: !option.hidden,
                active: true,
              })),
            }
          : entry,
      ),
    });
  }

  function move(index: number, direction: -1 | 1) {
    if (!merged) return;
    const target = index + direction;
    if (target < 0 || target >= merged.length) return;
    const next = [...merged];
    [next[index], next[target]] = [next[target], next[index]];
    writeMirror(next);
  }

  function toggleHidden(index: number) {
    if (!merged) return;
    const next = merged.map((option, at) =>
      at === index ? { ...option, hidden: !option.hidden } : option,
    );
    writeMirror(next);
  }

  async function commitRename(option: MergedOption, index: number) {
    const next = renameDraft.trim();
    setRenaming(null);
    if (!next || next === option.label || !merged) return;
    setError(null);
    setNotice(null);

    if (kind.kind === "plain") {
      writeMirror(merged.map((entry, at) => (at === index ? { ...entry, label: next } : entry)));
      return;
    }

    setWorking(true);
    try {
      if (kind.kind === "location") {
        const site = siteRows?.find((row) => row.name === option.value);
        if (!site) throw new Error("That site could not be found — reload and try again.");
        const { ok, payload } = await readJson(
          await fetch("/api/sites", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: site.id, rename: next }),
          }),
        );
        if (!ok) throw new Error(String(payload.error ?? "The site could not be renamed."));
        setNotice(`Renamed across the workspace — the Sites register is the source of truth.`);
        await loadCanonical();
        writeMirror(
          merged.map((entry, at) =>
            at === index ? { ...entry, label: next, value: next } : entry,
          ),
        );
      } else if (kind.kind === "registry") {
        const row = registryRows?.find((entry) => entry.value === option.value);
        if (!row) throw new Error("That option could not be found — reload and try again.");
        const { ok, payload } = await readJson(
          await fetch("/api/options", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: kind.setKey, id: row.id, data: { label: next } }),
          }),
        );
        if (!ok) throw new Error(String(payload.error ?? "The option could not be renamed."));
        setNotice("Renamed everywhere this option set is shown — the board included.");
        await loadCanonical();
        writeMirror(
          merged.map((entry, at) => (at === index ? { ...entry, label: next } : entry)),
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rename failed.");
    } finally {
      setWorking(false);
    }
  }

  async function addOption() {
    const label = addLabel.trim();
    if (!label || !merged) return;
    setError(null);
    setNotice(null);

    if (kind.kind === "plain") {
      writeMirror([...merged, { label, value: label, hidden: false }]);
      setAddLabel("");
      setAdding(false);
      return;
    }

    setWorking(true);
    try {
      if (kind.kind === "location") {
        const address = addAddress.trim();
        if (!address) throw new Error("A new location needs a first line of address.");
        const create = async (confirmDuplicate: boolean) =>
          readJson(
            await fetch("/api/sites", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                data: { name: label, addressLine1: address },
                confirmDuplicate,
              }),
            }),
          );
        let result = await create(false);
        if (!result.ok && result.status === 409 && result.payload.requiresConfirmation) {
          const proceed = window.confirm(
            `A similar site already exists. Create "${label}" anyway?`,
          );
          if (!proceed) return;
          result = await create(true);
        }
        if (!result.ok) {
          throw new Error(String(result.payload.error ?? "The site could not be created."));
        }
        setNotice(`"${label}" was added to the Sites register.`);
      } else if (kind.kind === "registry") {
        const { ok, payload } = await readJson(
          await fetch("/api/options", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: kind.setKey, data: { value: label, label } }),
          }),
        );
        if (!ok) throw new Error(String(payload.error ?? "The option could not be added."));
        setNotice("Added to the shared option set — the board sees it too.");
      }
      await loadCanonical();
      writeMirror([...merged, { label, value: label, hidden: false }]);
      setAddLabel("");
      setAddAddress("");
      setAdding(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The option could not be added.");
    } finally {
      setWorking(false);
    }
  }

  async function removeOption(option: MergedOption, index: number) {
    if (!merged) return;
    setError(null);
    setNotice(null);

    if (kind.kind === "plain") {
      writeMirror(merged.filter((_, at) => at !== index));
      return;
    }

    setWorking(true);
    try {
      if (kind.kind === "location") {
        const site = siteRows?.find((row) => row.name === option.value);
        if (!site) throw new Error("That site could not be found — reload and try again.");
        const proceed = window.confirm(
          `Archive the site "${option.label}"?\n\nIts jobs, assets and compliance records are kept — sites are never hard-deleted — and it leaves this form and every site selector. You can reopen it from the Sites screen.`,
        );
        if (!proceed) return;
        const { ok, payload } = await readJson(
          await fetch("/api/sites", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: site.id }),
          }),
        );
        if (!ok) throw new Error(String(payload.error ?? "The site could not be archived."));
        const retained = Number(payload.retainedJobs ?? 0);
        setNotice(
          retained
            ? `"${option.label}" archived. ${retained} job${retained === 1 ? "" : "s"} keep their history.`
            : `"${option.label}" archived.`,
        );
        await loadCanonical();
        writeMirror(merged.filter((_, at) => at !== index));
      } else if (kind.kind === "registry") {
        const row = registryRows?.find((entry) => entry.value === option.value);
        if (!row) throw new Error("That option could not be found — reload and try again.");
        const { ok, status, payload } = await readJson(
          await fetch("/api/options", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: kind.setKey, id: row.id }),
          }),
        );
        if (!ok && status === 409 && payload.requiresReassignment) {
          /* Rows still use it: the registry insists they move somewhere valid. */
          setReassigning(row);
          setReassignTo("");
          return;
        }
        if (!ok) throw new Error(String(payload.error ?? "The option could not be removed."));
        setNotice(
          payload.deactivated
            ? `"${option.label}" deactivated — it is a system option, so it is retired rather than deleted.`
            : `"${option.label}" removed from the shared option set.`,
        );
        await loadCanonical();
        writeMirror(merged.filter((_, at) => at !== index));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The option could not be removed.");
    } finally {
      setWorking(false);
    }
  }

  async function confirmReassign() {
    if (!reassigning || !reassignTo || kind.kind !== "registry" || !merged) return;
    setWorking(true);
    setError(null);
    try {
      const { ok, payload } = await readJson(
        await fetch("/api/options", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: kind.setKey,
            id: reassigning.id,
            reassignTo,
          }),
        }),
      );
      if (!ok) throw new Error(String(payload.error ?? "The option could not be removed."));
      const moved = Number(payload.reassigned ?? 0);
      setNotice(
        `"${reassigning.label}" removed; ${moved} record${moved === 1 ? "" : "s"} moved to "${reassignTo}".`,
      );
      const removedValue = reassigning.value;
      setReassigning(null);
      await loadCanonical();
      writeMirror(merged.filter((entry) => entry.value !== removedValue));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The reassignment failed.");
    } finally {
      setWorking(false);
    }
  }

  const usageFor = (option: MergedOption) =>
    kind.kind === "registry"
      ? registryRows?.find((row) => row.value === option.value)?.usage ?? null
      : null;

  const shown = merged?.filter((option) => !option.hidden).length ?? 0;
  const alphabetical = question.settings?.optionsOrder === "Alphabetical";

  return (
    <div className="form-options">
      <button
        type="button"
        className="form-options__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <Icon name="list" size={13} />
        Options
        {merged ? ` (${shown} shown)` : ""}
        <Icon name="chevron" size={12} />
      </button>

      {expanded && (
        <div className="form-options__body">
          <p className="form-options__source">
            {kind.kind === "location" &&
              "These are the Sites register — the canonical list every job resolves against. Order and visibility here affect only this form; add, rename and archive change the register itself."}
            {kind.kind === "registry" &&
              `Shared with the board's ${kind.setKey === "priority" ? "Priority" : "Engineer"} column. Renames change the label everywhere; stored jobs keep their value, and priority SLAs are keyed on the value, so a rename never changes a due date.`}
            {kind.kind === "plain" &&
              "These options exist only on this form."}
          </p>
          {alphabetical && (
            <p className="form-options__source">
              Options order is set to Alphabetical, so the submitter sees these
              sorted A–Z whatever order they are in here.
            </p>
          )}

          {error && (
            <p className="form-options__error" role="alert">
              <Icon name="alert" size={13} /> {error}
            </p>
          )}
          {notice && <p className="form-options__notice">{notice}</p>}

          {!merged ? (
            <p className="form-options__source">Loading options…</p>
          ) : (
            <ol className="form-options__list">
              {merged.map((option, index) => (
                <li key={`${option.value}-${index}`} className={option.hidden ? "is-hidden" : undefined}>
                  {renaming === option.value ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      aria-label={`Rename ${option.label}`}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={() => void commitRename(option, index)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="form-options__label" title={option.label || "(unnamed)"}>
                      {option.label || "(unnamed)"}
                    </span>
                  )}
                  {usageFor(option) !== null && usageFor(option)! > 0 && (
                    <em className="form-options__usage">{usageFor(option)} in use</em>
                  )}
                  {option.hidden && <em className="form-options__usage">Hidden</em>}
                  <span className="form-options__tools">
                    <button
                      type="button"
                      disabled={busy || working || index === 0}
                      aria-label={`Move ${option.label} up`}
                      onClick={() => move(index, -1)}
                    >
                      <Icon name="chevron" size={12} />
                    </button>
                    <button
                      type="button"
                      className="is-down"
                      disabled={busy || working || index === merged.length - 1}
                      aria-label={`Move ${option.label} down`}
                      onClick={() => move(index, 1)}
                    >
                      <Icon name="chevron" size={12} />
                    </button>
                    <button
                      type="button"
                      disabled={busy || working}
                      aria-pressed={!option.hidden}
                      aria-label={
                        option.hidden
                          ? `Show ${option.label} on the form`
                          : `Hide ${option.label} from the form`
                      }
                      onClick={() => toggleHidden(index)}
                    >
                      <Icon name={option.hidden ? "close" : "check"} size={12} />
                    </button>
                    <button
                      type="button"
                      disabled={busy || working}
                      aria-label={`Rename ${option.label}`}
                      onClick={() => {
                        setRenaming(option.value);
                        setRenameDraft(option.label);
                      }}
                    >
                      <Icon name="edit" size={12} />
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      disabled={busy || working}
                      aria-label={
                        kind.kind === "location"
                          ? `Archive the site ${option.label}`
                          : `Remove ${option.label}`
                      }
                      onClick={() => void removeOption(option, index)}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}

          {reassigning && kind.kind === "registry" && (
            <div className="form-options__reassign">
              <p>
                <Icon name="alert" size={13} /> {reassigning.usage} record
                {reassigning.usage === 1 ? "" : "s"} still use “{reassigning.label}”.
                Move them to:
              </p>
              <select
                value={reassignTo}
                onChange={(event) => setReassignTo(event.target.value)}
              >
                <option value="">Choose a replacement…</option>
                {registryRows
                  ?.filter((row) => row.active && row.value !== reassigning.value)
                  .map((row) => (
                    <option key={row.id} value={row.value}>
                      {row.label}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={!reassignTo || working}
                onClick={() => void confirmReassign()}
              >
                Move & remove
              </button>
              <button type="button" onClick={() => setReassigning(null)}>
                Cancel
              </button>
            </div>
          )}

          {adding ? (
            <div className="form-options__add">
              <input
                autoFocus
                value={addLabel}
                placeholder={kind.kind === "location" ? "Site name" : "Option label"}
                aria-label="New option label"
                onChange={(event) => setAddLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setAdding(false);
                  if (event.key === "Enter" && kind.kind !== "location") void addOption();
                }}
              />
              {kind.kind === "location" && (
                <input
                  value={addAddress}
                  placeholder="First line of address"
                  aria-label="New site address"
                  onChange={(event) => setAddAddress(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setAdding(false);
                    if (event.key === "Enter") void addOption();
                  }}
                />
              )}
              <button
                type="button"
                disabled={working || !addLabel.trim()}
                onClick={() => void addOption()}
              >
                Add
              </button>
              <button type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="form-options__addbtn"
              disabled={busy || working}
              onClick={() => setAdding(true)}
            >
              <Icon name="plus" size={13} />
              {kind.kind === "location" ? "Add a location (creates a site)" : "Add option"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
