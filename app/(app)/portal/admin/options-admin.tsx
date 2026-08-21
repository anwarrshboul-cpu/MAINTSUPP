"use client";

import { useEffect, useState } from "react";
import { useLoader } from "../sites/use-loader";
import { ApiError, api, type OptionChoice } from "../sites/site-types";

type OptionSet = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  values: OptionChoice[];
};

type Draft = {
  value: string;
  label: string;
  colourHex: string;
  textColour: string;
};

const BLANK_DRAFT: Draft = {
  value: "",
  label: "",
  colourHex: "#12b4a8",
  textColour: "#101820",
};

export function OptionsAdmin({ onNotify }: { onNotify: (message: string) => void }) {
  const [activeKey, setActiveKey] = useState("");
  const [values, setValues] = useState<OptionChoice[]>([]);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [error, setError] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [reassign, setReassign] = useState<{ option: OptionChoice; usage: number } | null>(null);
  const [replacement, setReplacement] = useState("");

  const { data: setsPayload, error: setsError } = useLoader<{ sets: OptionSet[] }>(
    () => api<{ sets: OptionSet[] }>("/api/options"),
    "Options could not be loaded.",
  );
  const sets = setsPayload?.sets ?? [];

  // The first list is opened automatically once the sets arrive.
  const firstKey = sets[0]?.key ?? "";
  const currentKey = activeKey || firstKey;

  useEffect(() => {
    let active = true;
    async function run() {
      if (!currentKey) return;
      try {
        const payload = await api<{ values: OptionChoice[] }>(
          `/api/options?key=${encodeURIComponent(currentKey)}`,
        );
        if (active) setValues(payload.values);
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "That list could not be loaded.");
        }
      }
    }
    run();
    return () => {
      active = false;
    };
  }, [currentKey, refreshNonce]);

  async function add() {
    try {
      await api("/api/options", {
        method: "POST",
        body: {
          key: currentKey,
          data: { ...draft, label: draft.label || draft.value, position: values.length },
        },
      });
      setDraft(BLANK_DRAFT);
      onNotify("Option added.");
      setRefreshNonce((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The option could not be added.");
    }
  }

  async function patch(id: string, data: Record<string, unknown>) {
    try {
      await api("/api/options", { method: "PATCH", body: { key: currentKey, id, data } });
      setRefreshNonce((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const next = [...values];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setValues(next);
    await api("/api/options", {
      method: "PATCH",
      body: { key: currentKey, order: next.map((entry) => entry.id) },
    });
  }

  async function remove(option: OptionChoice, replaceWith?: string) {
    try {
      const result = await api<{ reassigned: number; deactivated: boolean }>("/api/options", {
        method: "DELETE",
        body: { key: currentKey, id: option.id, reassignTo: replaceWith },
      });
      setReassign(null);
      setReplacement("");
      onNotify(
        result.reassigned
          ? `${result.reassigned} record${result.reassigned === 1 ? "" : "s"} moved across.`
          : result.deactivated
            ? `${option.label} deactivated.`
            : `${option.label} removed.`,
      );
      setRefreshNonce((current) => current + 1);
    } catch (caught) {
      if (caught instanceof ApiError && caught.requiresReassignment) {
        setReassign({ option, usage: caught.usage ?? 0 });
        setError("");
        return;
      }
      setError(caught instanceof Error ? caught.message : "The option could not be removed.");
    }
  }

  const activeSet = sets.find((entry) => entry.key === currentKey);

  return (
    <section className="section-stack">
      <header className="section-header">
        <div>
          <h2>Lists and labels</h2>
          <p className="drawer-label">
            Statuses, priorities, trades, site types and asset categories. Change
            them here and every screen follows — no deploy needed.
          </p>
        </div>
        {currentKey ? (
          <a
            className="secondary-button"
            href={`/api/options?key=${encodeURIComponent(currentKey)}&format=csv`}
            download
          >
            Export CSV
          </a>
        ) : null}
      </header>

      <div className="view-switch view-switch--text" role="tablist" aria-label="Option lists">
        {sets.map((set) => (
          <button
            key={set.id}
            type="button"
            role="tab"
            aria-selected={currentKey === set.key}
            className={currentKey === set.key ? "is-active" : ""}
            onClick={() => setActiveKey(set.key)}
          >
            {set.name}
          </button>
        ))}
      </div>

      {activeSet?.description ? <p className="drawer-label">{activeSet.description}</p> : null}
      {error || setsError ? (
        <p className="form-error" role="alert">{error || setsError}</p>
      ) : null}

      {reassign ? (
        <div className="panel" role="alertdialog" aria-labelledby="reassign-heading">
          <h3 id="reassign-heading">
            {reassign.usage} record{reassign.usage === 1 ? "" : "s"} still use &ldquo;
            {reassign.option.label}&rdquo;
          </h3>
          <p>Choose what they should say instead. Renaming keeps history intact.</p>
          <div className="form-field">
            <label htmlFor="reassign-to">Move those records to</label>
            <select
              id="reassign-to"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
            >
              <option value="">Choose one</option>
              {values
                .filter((entry) => entry.active && entry.id !== reassign.option.id)
                .map((entry) => (
                  <option key={entry.id} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
            </select>
          </div>
          <div className="section-header__actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setReassign(null);
                setReplacement("");
              }}
            >
              Keep it
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!replacement}
              onClick={() => remove(reassign.option, replacement)}
            >
              Move and remove
            </button>
          </div>
        </div>
      ) : null}

      {values.length === 0 ? (
        <p className="analytics-empty">This list is empty. Add the first option below.</p>
      ) : (
        <div className="table-scroll">
          <table className="analytics-table analytics-table--mobile-cards">
            <caption className="visually-hidden">{activeSet?.name ?? "Options"}</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Shown as</th>
                <th scope="col">Stored value</th>
                <th scope="col">Colour</th>
                <th scope="col">In use</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {values.map((option, index) => (
                <tr key={option.id}>
                  <td data-label="Order">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${option.label} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${option.label} down`}
                      disabled={index === values.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      ↓
                    </button>
                  </td>
                  <td data-label="Shown as">
                    <label className="visually-hidden" htmlFor={`label-${option.id}`}>
                      Label for {option.value}
                    </label>
                    <input
                      id={`label-${option.id}`}
                      type="text"
                      defaultValue={option.label}
                      onBlur={(event) => {
                        if (event.target.value !== option.label) {
                          void patch(option.id, { label: event.target.value });
                        }
                      }}
                    />
                  </td>
                  <td data-label="Stored value">
                    <code>{option.value}</code>
                  </td>
                  <td data-label="Colour">
                    <label className="visually-hidden" htmlFor={`colour-${option.id}`}>
                      Colour for {option.label}
                    </label>
                    <input
                      id={`colour-${option.id}`}
                      type="color"
                      defaultValue={option.colourHex}
                      onBlur={(event) => void patch(option.id, { colourHex: event.target.value })}
                    />
                  </td>
                  <td data-label="In use">{option.usage ?? 0}</td>
                  <td data-label="Actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void patch(option.id, { active: !option.active })}
                    >
                      {option.active ? "Deactivate" : "Reactivate"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void remove(option)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <h3>Add an option</h3>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="new-value">Stored value</label>
            <input
              id="new-value"
              type="text"
              value={draft.value}
              aria-describedby="new-value-hint"
              onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            />
            <p id="new-value-hint" className="form-hint">
              What gets saved on the record. Keep it stable — the label is what people see.
            </p>
          </div>
          <div className="form-field">
            <label htmlFor="new-label">Shown as</label>
            <input
              id="new-label"
              type="text"
              value={draft.label}
              placeholder={draft.value}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </div>
          <div className="form-field">
            <label htmlFor="new-colour">Colour</label>
            <input
              id="new-colour"
              type="color"
              value={draft.colourHex}
              onChange={(event) => setDraft({ ...draft, colourHex: event.target.value })}
            />
          </div>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={!draft.value.trim() || !currentKey}
          onClick={add}
        >
          Add option
        </button>
      </div>
    </section>
  );
}
