"use client";

/**
 * The monday board import screen.
 *
 * Two steps, deliberately. The file is parsed and reported on first, and
 * nothing is written until the numbers have been read — a 744-row import into
 * the wrong board is not something to discover afterwards. Both steps call the
 * same endpoint with the same file, so the preview cannot describe an outcome
 * the commit does not produce.
 *
 * What the preview shows is what a migration actually goes wrong on: how many
 * items and groups were found, which of the file's columns matched nothing on
 * the board, which of the board's columns the file never supplied, and every
 * row that was skipped with the reason. A silent import that "worked" and lost
 * a column is the failure worth designing against.
 */

import { useRef, useState } from "react";
import { Icon } from "../../components";

type Preview = {
  board: string;
  groups: string[];
  itemCount: number;
  groupCount: number;
  unmatchedColumns: string[];
  missingColumns: string[];
  skipped: Array<{ sourceRow: number; reason: string }>;
  skippedCount: number;
  sample: Array<{ group: string; values: Record<string, string> }>;
};

type Result = {
  groupsCreated: number;
  created: number;
  updated: number;
  cellsWritten: number;
};

const BOARDS = [
  { key: "maintenance", label: "Maintenance" },
  { key: "store-documentation", label: "Store Documentation UK" },
];

export function MondayImportPanel({ onImported }: { onImported?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [board, setBoard] = useState("maintenance");
  const [busy, setBusy] = useState<"" | "preview" | "commit">("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (mode: "preview" | "commit") => {
    if (!file) {
      setError("Choose a monday export first.");
      return;
    }
    setBusy(mode);
    setError(null);
    if (mode === "preview") setResult(null);

    const body = new FormData();
    body.append("file", file);
    body.append("board", board);
    body.append("mode", mode);

    try {
      const response = await fetch("/api/import", { method: "POST", body });
      const payload = (await response.json()) as {
        preview?: Preview;
        result?: Result;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "The import could not be run.");
      if (payload.preview) setPreview(payload.preview);
      if (payload.result) {
        setResult(payload.result);
        onImported?.();
      }
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The import could not be run.");
    } finally {
      setBusy("");
    }
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="monday-import">
      <div className="monday-import__intro">
        <h3>Bring a board across from monday</h3>
        <p>
          In monday, open the board menu and choose <strong>Export board to Excel</strong>.
          Upload the file here. Nothing is written until you have seen the preview.
        </p>
      </div>

      <div className="monday-import__controls">
        <label className="form-field">
          <span>Board</span>
          <select
            value={board}
            onChange={(event) => {
              setBoard(event.target.value);
              setPreview(null);
              setResult(null);
            }}
          >
            {BOARDS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="form-field">
          <span>Export file</span>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xlsm,.csv,.tsv,.txt"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
              setError(null);
            }}
          />
        </label>
      </div>

      <div className="monday-import__actions">
        <button
          className="secondary-button"
          type="button"
          disabled={!file || busy !== ""}
          onClick={() => void send("preview")}
        >
          {busy === "preview" ? "Reading…" : "Preview"}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!preview || busy !== "" || Boolean(result)}
          onClick={() => void send("commit")}
        >
          {busy === "commit"
            ? "Importing…"
            : preview
              ? `Import ${preview.itemCount} items`
              : "Import"}
        </button>
        {(preview || result || file) && (
          <button className="secondary-button" type="button" onClick={reset}>
            Start again
          </button>
        )}
      </div>

      {error && (
        <p className="monday-import__error" role="alert">
          <Icon name="alert" size={16} />
          {error}
        </p>
      )}

      {result && (
        <div className="monday-import__done" role="status">
          <Icon name="check" size={18} />
          <div>
            <strong>Import complete</strong>
            <span>
              {result.created} created · {result.updated} already present and updated ·{" "}
              {result.groupsCreated} groups added · {result.cellsWritten} cells written
            </span>
          </div>
        </div>
      )}

      {preview && !result && (
        <div className="monday-import__preview">
          <div className="monday-import__stats">
            <div>
              <strong>{preview.itemCount}</strong>
              <span>items found</span>
            </div>
            <div>
              <strong>{preview.groupCount}</strong>
              <span>groups</span>
            </div>
            <div className={preview.skippedCount ? "is-warning" : ""}>
              <strong>{preview.skippedCount}</strong>
              <span>rows skipped</span>
            </div>
          </div>

          {preview.unmatchedColumns.length > 0 && (
            <section>
              <h4>
                <Icon name="alert" size={15} />
                Columns in the file that this board has no home for
              </h4>
              <p>
                These values will not be imported. Add a matching column to the board
                first if you need them.
              </p>
              <ul>
                {preview.unmatchedColumns.map((column) => (
                  <li key={column}>{column}</li>
                ))}
              </ul>
            </section>
          )}

          {preview.missingColumns.length > 0 && (
            <section>
              <h4>Columns the board has that the file did not supply</h4>
              <p>These will be left empty on every imported item.</p>
              <ul>
                {preview.missingColumns.map((column) => (
                  <li key={column}>{column}</li>
                ))}
              </ul>
            </section>
          )}

          {preview.skipped.length > 0 && (
            <section>
              <h4>
                <Icon name="alert" size={15} />
                Skipped rows
              </h4>
              <ul>
                {preview.skipped.map((entry) => (
                  <li key={entry.sourceRow}>
                    Row {entry.sourceRow} — {entry.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h4>First few items, as they will be read</h4>
            <table className="monday-import__sample">
              <thead>
                <tr>
                  <th scope="col">Group</th>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Location</th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((item, index) => (
                  <tr key={`${item.values.name}-${index}`}>
                    <td>{item.group || "—"}</td>
                    <td>{item.values.name ?? "—"}</td>
                    <td>{item.values.status ?? item.values.storeType ?? "—"}</td>
                    <td>
                      {item.values.location ??
                        item.values.storeLocation ??
                        item.values.storeAddress ??
                        "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}
