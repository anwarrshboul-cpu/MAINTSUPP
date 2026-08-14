"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Icon } from "../../../components";
import { chipStyle as sharedChipStyle } from "../chip-ink";
import { maintenanceFormSpec } from "../../../../db/monday-board-spec";
import { uploadEvidenceFile } from "../../../lib/client-upload";
import {
  type BoardItem,
  formatDate,
  formatMoney,
  groupBy,
} from "./view-model";

type Palette = Record<string, string>;

/*
 * Was a perceived-brightness test — `(0.299r + 0.587g + 0.114b)/255 > 0.6` —
 * which is not a contrast ratio and got the mid-tones wrong in both themes:
 * it put white on monday's #00c875 at 2.21:1 and on #fdab3d at 1.90:1. The
 * shared helper measures the real ratio instead. Same signature, same call
 * sites, and the pale chips keep the dark ink they already had.
 */
function chipStyle(palette: Palette, value: string | null) {
  return sharedChipStyle((value && palette[value]) || "#c4c4c4");
}

/* ── Kanban — P3 ─────────────────────────────────────────────────────────── */

export function KanbanView({
  items,
  palette,
  groupField = "status",
  onOpen,
  onMove,
}: {
  items: BoardItem[];
  palette: Palette;
  groupField?: string;
  onOpen?: (item: BoardItem) => void;
  onMove?: (itemId: string, value: string) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const columns = useMemo(() => {
    const buckets = groupBy(items, groupField);
    return [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items, groupField]);

  if (!items.length) {
    return <p className="view-empty">No items match the current filters.</p>;
  }

  return (
    <div className="kanban" role="list">
      {columns.map(([value, columnItems]) => (
        <section
          key={value}
          role="listitem"
          className={`kanban__column${overColumn === value ? " is-over" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setOverColumn(value);
          }}
          onDragLeave={() => setOverColumn(null)}
          onDrop={() => {
            setOverColumn(null);
            if (dragId && onMove) onMove(dragId, value);
            setDragId(null);
          }}
        >
          <header className="kanban__head">
            <span className="kanban__chip" style={chipStyle(palette, value)}>
              {value}
            </span>
            <em>{columnItems.length}</em>
          </header>

          <div className="kanban__cards">
            {columnItems.map((item) => (
              <article
                key={item.id}
                className="kanban__card"
                draggable
                onDragStart={() => setDragId(item.id)}
                onDragEnd={() => setDragId(null)}
              >
                <button type="button" onClick={() => onOpen?.(item)}>
                  <span className="kanban__ref">{item.reference ?? "—"}</span>
                  <strong>{item.title}</strong>
                  <span className="kanban__meta">
                    {item.priority && (
                      <span className="kanban__pill" style={chipStyle(palette, item.priority)}>
                        {item.priority}
                      </span>
                    )}
                    {item.category && <span className="kanban__muted">{item.category}</span>}
                  </span>
                  <span className="kanban__foot">
                    <span>{formatDate(item.requestedAt)}</span>
                    {(item.attachmentCount ?? 0) > 0 && (
                      <span title={`${item.attachmentCount} files`}>
                        <Icon name="paperclip" size={13} /> {item.attachmentCount}
                      </span>
                    )}
                    {(item.commentCount ?? 0) > 0 && (
                      <span title={`${item.commentCount} updates`}>
                        <Icon name="updates" size={13} /> {item.commentCount}
                      </span>
                    )}
                  </span>
                </button>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── Calendar — P4 ───────────────────────────────────────────────────────── */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarView({
  items,
  palette,
  dateField = "requestedAt",
  onOpen,
}: {
  items: BoardItem[];
  palette: Palette;
  dateField?: keyof BoardItem;
  onOpen?: (item: BoardItem) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  const { cells, monthLabel } = useMemo(() => {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    // Monday-first, as the UK working week runs.
    const leading = (first.getUTCDay() + 6) % 7;

    const byDay = new Map<string, BoardItem[]>();
    for (const item of items) {
      const raw = item[dateField];
      if (typeof raw !== "string" || !raw) continue;
      const when = new Date(raw);
      if (Number.isNaN(when.getTime())) continue;
      if (when.getUTCFullYear() !== year || when.getUTCMonth() !== month) continue;
      const key = String(when.getUTCDate());
      byDay.set(key, [...(byDay.get(key) ?? []), item]);
    }

    const built: Array<{ day: number | null; items: BoardItem[] }> = [];
    for (let i = 0; i < leading; i += 1) built.push({ day: null, items: [] });
    for (let day = 1; day <= daysInMonth; day += 1) {
      built.push({ day, items: byDay.get(String(day)) ?? [] });
    }

    return {
      cells: built,
      monthLabel: new Intl.DateTimeFormat("en-GB", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(first),
    };
  }, [cursor, items, dateField]);

  function shift(months: number) {
    setCursor(
      new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + months, 1)),
    );
  }

  return (
    <div className="calendar-view">
      <header className="calendar-view__head">
        <button type="button" onClick={() => shift(-1)} aria-label="Previous month">
          <Icon name="chevron" size={16} />
        </button>
        <strong>{monthLabel}</strong>
        <button type="button" onClick={() => shift(1)} aria-label="Next month">
          <Icon name="chevron" size={16} />
        </button>
      </header>

      <div className="calendar-view__weekdays" aria-hidden="true">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="calendar-view__grid">
        {cells.map((cell, index) => (
          <div
            key={index}
            className={`calendar-view__cell${cell.day ? "" : " is-blank"}`}
          >
            {cell.day && <span className="calendar-view__day">{cell.day}</span>}
            {cell.items.slice(0, 3).map((item) => (
              <button
                key={item.id}
                type="button"
                className="calendar-view__item"
                style={chipStyle(palette, item.priority)}
                onClick={() => onOpen?.(item)}
                title={item.title}
              >
                {item.title}
              </button>
            ))}
            {cell.items.length > 3 && (
              <span className="calendar-view__more">+{cell.items.length - 3} more</span>
            )}
          </div>
        ))}
      </div>

      <p className="calendar-view__hint">
        Showing <strong>{String(dateField)}</strong>. Items without that date are not
        placed on the calendar.
      </p>
    </div>
  );
}

/* ── File gallery — P7 ───────────────────────────────────────────────────── */

export function GalleryView({
  items,
  onOpen,
}: {
  items: BoardItem[];
  onOpen?: (item: BoardItem) => void;
}) {
  const withFiles = items.filter((item) => (item.attachmentCount ?? 0) > 0);

  if (!withFiles.length) {
    return (
      <p className="view-empty">
        No items in this view carry attachments yet.
      </p>
    );
  }

  return (
    <div className="gallery-view">
      {withFiles.map((item) => (
        <button
          key={item.id}
          type="button"
          className="gallery-view__tile"
          onClick={() => onOpen?.(item)}
        >
          <span className="gallery-view__thumb">
            <Icon name="image" size={22} />
            <em>{item.attachmentCount}</em>
          </span>
          <span className="gallery-view__label">
            <strong>{item.title}</strong>
            <span>{item.reference ?? "—"} · {formatDate(item.requestedAt)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── Reports — P8 ────────────────────────────────────────────────────────── */

export function ReportsView({ items }: { items: BoardItem[] }) {
  const stats = useMemo(() => {
    const open = items.filter((item) => !item.completedAt).length;
    const urgent = items.filter(
      (item) => (item.priority ?? "").toLowerCase() === "urgent" && !item.completedAt,
    ).length;
    const unassigned = items.filter((item) => !item.assignee && !item.completedAt).length;
    const spend = items.reduce((total, item) => total + (item.cost ?? 0), 0);

    const closed = items.filter((item) => item.completedAt && item.requestedAt);
    const averageDays = closed.length
      ? Math.round(
          closed.reduce((total, item) => {
            const from = new Date(item.requestedAt as string).getTime();
            const to = new Date(item.completedAt as string).getTime();
            return total + Math.max(0, (to - from) / 86_400_000);
          }, 0) / closed.length,
        )
      : null;

    return { open, urgent, unassigned, spend, averageDays, total: items.length };
  }, [items]);

  return (
    <div className="reports-view">
      {[
        { label: "Items in view", value: String(stats.total) },
        { label: "Open", value: String(stats.open) },
        { label: "Urgent and open", value: String(stats.urgent) },
        { label: "Open and unassigned", value: String(stats.unassigned) },
        { label: "Total cost", value: formatMoney(stats.spend) },
        {
          label: "Average days to close",
          value: stats.averageDays === null ? "—" : String(stats.averageDays),
        },
      ].map((card) => (
        <div key={card.label} className="reports-view__card">
          <span>{card.label}</span>
          <strong>{card.value}</strong>
        </div>
      ))}
    </div>
  );
}

/* ── Form — monday view 646339 ───────────────────────────────────────────── */

type FormChoice = { value: string; label: string; isDefault: boolean };

type FormConfiguration = {
  sites: Array<{ id: string; name: string }>;
  priorities: FormChoice[];
  engineers: FormChoice[];
  categories: FormChoice[];
};

/**
 * The public request form, rendered inside the board the way monday's Form tab
 * does — the live form, not a preview of one.
 *
 * The Form tab used to render nothing at all: `board-chrome` excluded
 * `type === "form"` from its placeholder branch and had no case for it, so the
 * tab switched to an empty pane.
 *
 * Question order, labels, help text and mandatory flags come from
 * `maintenanceFormSpec`, captured from the WorkForms configuration. Two rules
 * monday enforces are reproduced here rather than in the API, because they are
 * properties of this form and not of every way a job can be raised:
 *
 *  - photographs are required, per the form's own warning that requests
 *    without them are declined;
 *  - "Handyman Required" is shown only when Engineer Required is "Handyman",
 *    which is monday's single conditional rule (8874e83b…).
 *
 * Choices come from `/api/context`, so they are the option rows an admin has
 * configured rather than a hard-coded list.
 */
export function FormView({
  onSubmitted,
}: {
  onSubmitted?: () => void;
}) {
  const [config, setConfig] = useState<FormConfiguration | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [engineer, setEngineer] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<"form" | "sending" | "done">("form");
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/context", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const payload = (await response.json()) as {
          context?: { requestConfiguration?: FormConfiguration };
          error?: string;
        };
        if (!response.ok || !payload.context?.requestConfiguration) {
          throw new Error(payload.error || "The request form is unavailable.");
        }
        if (active) setConfig(payload.context.requestConfiguration);
      })
      .catch((caught: unknown) => {
        if (active) {
          setLoadError(
            caught instanceof Error ? caught.message : "The request form is unavailable.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!files.length) {
      setError(
        "Please attach photographs or video of the issue. Requests without them are declined.",
      );
      return;
    }

    setState("sending");
    const data = new FormData(event.currentTarget);
    const handyman = String(data.get("handymanRequired") ?? "").trim();
    const description = String(data.get("description") ?? "").trim();

    try {
      const response = await fetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: String(data.get("location") ?? ""),
          requester: String(data.get("requester") ?? ""),
          contact: String(data.get("contact") ?? ""),
          // Monday keeps the handyman follow-up as its own question. There is no
          // column for it, so it is appended to the description rather than
          // dropped — the detail is the point of asking.
          description: handyman ? `${description}\n\nHandyman required: ${handyman}` : description,
          category: "Other",
          engineer: String(data.get("engineer") ?? ""),
          priority: String(data.get("priority") ?? ""),
          requestedAt: String(data.get("requestedAt") ?? ""),
        }),
      });
      const result = (await response.json()) as {
        request?: { id: string };
        uploadToken?: string;
        error?: string;
      };
      if (!response.ok || !result.request) {
        throw new Error(result.error || "Your request could not be submitted.");
      }

      for (const file of files) {
        await uploadEvidenceFile({
          file,
          requestId: result.request.id,
          uploadToken: result.uploadToken,
          kind: "issue",
        }).catch(() => undefined);
      }

      setReference(result.request.id);
      setState("done");
      setFiles([]);
      onSubmitted?.();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Your request could not be submitted.");
      setState("form");
    }
  }

  if (loadError) {
    return <p className="view-empty">{loadError}</p>;
  }
  if (!config) {
    return <p className="view-empty">Loading the request form…</p>;
  }
  if (state === "done") {
    return (
      <div className="form-view form-view--done">
        <Icon name="check" size={22} />
        <h3>{maintenanceFormSpec.title} received</h3>
        <p>
          Logged as <strong>{reference}</strong>. It is now in Incoming requests.
        </p>
        <button type="button" onClick={() => setState("form")}>
          Submit another response
        </button>
      </div>
    );
  }

  const showHandyman = engineer === "Handyman";

  return (
    <form className="form-view" onSubmit={submit}>
      <header className="form-view__head">
        <h3>{maintenanceFormSpec.title}</h3>
        <p>{maintenanceFormSpec.description}</p>
      </header>

      <label className="form-view__field">
        <span>
          Location <em aria-hidden="true">*</em>
        </span>
        <select name="location" required defaultValue="">
          <option value="" disabled>
            Choose a location
          </option>
          {config.sites.map((site) => (
            <option key={site.id} value={site.name}>
              {site.name}
            </option>
          ))}
        </select>
      </label>

      <label className="form-view__field">
        <span>
          Manager <em aria-hidden="true">*</em>
        </span>
        <input name="requester" required maxLength={120} autoComplete="name" />
      </label>

      <label className="form-view__field">
        <span>
          Contact number <em aria-hidden="true">*</em>
        </span>
        <input name="contact" required maxLength={80} inputMode="tel" autoComplete="tel" />
      </label>

      <label className="form-view__field">
        <span>
          Date Requested <em aria-hidden="true">*</em>
        </span>
        <input
          name="requestedAt"
          type="date"
          required
          defaultValue={new Date().toISOString().slice(0, 10)}
        />
      </label>

      <label className="form-view__field">
        <span>
          Engineer Required <em aria-hidden="true">*</em>
        </span>
        <select
          name="engineer"
          required
          value={engineer}
          onChange={(event) => setEngineer(event.target.value)}
        >
          <option value="" disabled>
            Choose a trade
          </option>
          {config.engineers.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>

      {showHandyman && (
        <label className="form-view__field">
          <span>Handyman Required</span>
          <input name="handymanRequired" maxLength={200} />
        </label>
      )}

      <label className="form-view__field">
        <span>
          Description of Works to be done <em aria-hidden="true">*</em>
        </span>
        <textarea name="description" required minLength={10} maxLength={800} rows={4} />
        <small>
          Please submit only one issue or request per ticket. Do not combine or mention
          more than one issue in a single request.
        </small>
      </label>

      <label className="form-view__field">
        <span>
          Pictures of Maintenance Issue <em aria-hidden="true">*</em>
        </span>
        <input
          type="file"
          multiple
          accept="image/*,video/*"
          onChange={(event) => setFiles([...(event.target.files ?? [])])}
        />
        <small>
          You must upload pictures and videos of the issue. Any request without clear
          pictures and videos will be declined.
        </small>
      </label>

      <label className="form-view__field">
        <span>
          Status <em aria-hidden="true">*</em>
        </span>
        <select name="priority" required defaultValue="">
          <option value="" disabled>
            Choose a priority
          </option>
          {config.priorities.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p className="form-view__error" role="alert">
          {error}
        </p>
      )}

      <div className="form-view__actions">
        <button type="submit" disabled={state === "sending"}>
          {state === "sending" ? "Submitting…" : "Submit"}
        </button>
      </div>
    </form>
  );
}
