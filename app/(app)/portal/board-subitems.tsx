"use client";

/**
 * Subitem components — monday's `subitems` column and the child board behind it
 * (1164003119).
 *
 * Split out of board-cells.tsx, which the Stage 8 size rule caps at 1,300
 * lines. Kept together because the cell and the panel it opens are one feature:
 * the cell is the expander, the panel is what it expands to.
 */
import { useState } from "react";
import { Icon } from "../../components";
import type { Option } from "./board-model";
import { DateCell, ItemNameEditor, OptionCell } from "./board-cells";


/**
 * The Subitems cell: a count and an expander.
 *
 * Monday keeps children on a separate board and shows the parent a chevron with
 * a count. Here a subitem is a request whose `parentId` is the parent's id, so
 * the count is simply how many children the board is already holding.
 */
export function SubitemsCell({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`sheet-subitems${expanded ? " is-open" : ""}`}
      onClick={onToggle}
      aria-expanded={expanded}
      title={
        count === 0
          ? "Add a subitem"
          : `${count} subitem${count === 1 ? "" : "s"} — click to ${expanded ? "hide" : "show"}`
      }
    >
      <Icon name="chevron" size={14} />
      <span>{count === 0 ? "Add" : count}</span>
    </button>
  );
}

/**
 * The child rows revealed under a parent.
 *
 * Four fields, matching monday's subitem board exactly: Name, Owner, Status and
 * Date. Status uses the child board's own three labels rather than the parent
 * board's twenty-three — a subitem is "Working on it", "Done" or "Stuck", and
 * offering it "Deposit Invoice Received" would be nonsense.
 *
 * Rendered as its own table rather than more rows in the parent's, because the
 * parent's columns are 25 wide and a subitem has four; sharing the grid would
 * force four values across a layout built for twenty-five.
 */
export function SubitemRows({
  subitems,
  statusOptions,
  assigneeOptions,
  onSave,
  onAdd,
  onOpen,
}: {
  subitems: Array<{
    id: string;
    title: string;
    assignee: string | null;
    status: string;
    dueAt: string | null;
  }>;
  statusOptions: Option[];
  assigneeOptions: Option[];
  onSave: (id: string, fields: Record<string, unknown>) => void;
  onAdd: (title: string) => void;
  onOpen?: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const value = draft.trim();
    if (!value) return;
    onAdd(value);
    setDraft("");
  };

  return (
    <div className="sheet-subitem-panel">
      <table className="sheet-subitem-table">
        <thead>
          <tr>
            <th scope="col">Subitem</th>
            <th scope="col">Owner</th>
            <th scope="col">Status</th>
            <th scope="col">Date</th>
          </tr>
        </thead>
        <tbody>
          {subitems.map((subitem) => (
            <tr key={subitem.id}>
              <td>
                <ItemNameEditor
                  value={subitem.title}
                  onSave={(title) => onSave(subitem.id, { title })}
                />
                {onOpen && (
                  <button
                    type="button"
                    className="sheet-open-item"
                    onClick={() => onOpen(subitem.id)}
                    title="Open subitem"
                    aria-label={`Open ${subitem.title}`}
                  >
                    <Icon name="arrow" size={13} />
                  </button>
                )}
              </td>
              <td>
                <OptionCell
                  title="Owner"
                  value={subitem.assignee ?? ""}
                  options={assigneeOptions}
                  columns={2}
                  onChange={(assignee) => onSave(subitem.id, { assignee })}
                />
              </td>
              <td>
                <OptionCell
                  title="Status"
                  value={subitem.status}
                  options={statusOptions}
                  columns={1}
                  onChange={(status) => onSave(subitem.id, { status })}
                />
              </td>
              <td>
                <DateCell
                  title="Date"
                  value={subitem.dueAt}
                  onSave={(dueAt) => onSave(subitem.id, { dueAt })}
                />
              </td>
            </tr>
          ))}
          <tr className="sheet-subitem-add">
            <td colSpan={4}>
              <input
                value={draft}
                placeholder="+ Add subitem"
                aria-label="Add a subitem"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={submit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submit();
                  }
                  if (event.key === "Escape") setDraft("");
                }}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
