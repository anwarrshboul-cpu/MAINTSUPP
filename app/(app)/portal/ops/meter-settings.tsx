"use client";

/**
 * SETTINGS → DASHBOARD METERS — §2.5.
 *
 * Statuses on the left, the eight meters as targets, and a preview bar drawn
 * from the CURRENT PERIOD'S REAL COUNTS so the operator can see what the change
 * they are staging does to the page they are changing.
 *
 * ── NOTHING APPLIES UNTIL SAVE ────────────────────────────────────────────
 *
 * Every control below edits a STAGED copy. The payload the server returned is
 * kept beside it untouched, `Discard` restores it, and the difference between
 * the two is what enables the Save button. §2.5 says so in as many words, and
 * the reason is that this screen changes how every figure on the Overview is
 * grouped: an operator who drags a status and then navigates away must not have
 * silently repartitioned the dashboard for everybody else.
 *
 * ── TWO WAYS TO MOVE A STATUS, BOTH REAL ──────────────────────────────────
 *
 * §1.8's mobile parity table is explicit: "Long-press drag AND a tap-based
 * 'Move to…' menu on every status row — the menu is the primary path on touch
 * and also satisfies keyboard access." So:
 *
 *   · DRAG is built on Pointer Events rather than HTML5 drag-and-drop, because
 *     `dragstart` does not fire for touch at all. One implementation therefore
 *     covers mouse (drag begins on the first movement past a 6px threshold) and
 *     touch (a 350ms long-press arms it, so a scroll that starts on the handle
 *     is still a scroll);
 *   · the MENU is a native `<select>`. That is not a shortcut: a native select
 *     is the only picker that is simultaneously a 44px tap target, a real
 *     keyboard control with type-ahead, and a platform sheet on iOS and
 *     Android. A hand-built popup would have to re-earn all three, and the
 *     briefs' own complaint about this product is surfaces that re-implement
 *     what already works.
 *
 * The meters themselves reorder with buttons rather than by dragging. A drag is
 * the wrong affordance for a list of eight on a phone, and Up/Down is
 * keyboard-operable without a single extra line.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toolsCss from "./overview-tools.css?url";
import { ErrorState, OpsCard, SegmentedMeter, SkeletonRow, plural } from "./ops-primitives";
import type { MeterSettingsPayload } from "./overview-contract";

type StagedMeter = {
  key: string;
  label: string;
  colour: string;
  sortOrder: number;
  visible: boolean;
  isCatchAll: boolean;
};

type StagedStatus = {
  id: string;
  label: string;
  displayLabel: string;
  count: number;
  meterKey: string;
};

type Staged = { meters: StagedMeter[]; statuses: StagedStatus[] };

function stage(payload: MeterSettingsPayload): Staged {
  return {
    meters: payload.meters.map((meter) => ({
      key: meter.key,
      label: meter.label,
      colour: meter.colour,
      sortOrder: meter.sortOrder,
      visible: meter.visible,
      isCatchAll: meter.isCatchAll,
    })),
    statuses: payload.meters.flatMap((meter) =>
      meter.statuses.map((status) => ({
        id: status.id,
        label: status.label,
        displayLabel: status.displayLabel,
        count: status.count,
        meterKey: meter.key,
      })),
    ),
  };
}

/** The wire shape of a save. Colour travels so a future palette edit needs no new field. */
function body(staged: Staged) {
  return {
    meters: staged.meters.map((meter) => ({
      key: meter.key,
      label: meter.label,
      colour: meter.colour,
      sortOrder: meter.sortOrder,
      visible: meter.visible,
    })),
    statuses: staged.statuses.map((status) => ({
      label: status.label,
      meterKey: status.meterKey,
    })),
  };
}

export function MeterSettings({ onSaved }: { onSaved?: () => void } = {}) {
  const [payload, setPayload] = useState<MeterSettingsPayload | null>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    fetch("/api/overview/meter-settings", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const read = (await response.json().catch(() => null)) as
          | (MeterSettingsPayload & { error?: string })
          | null;
        if (!live) return;
        if (!response.ok || !read || read.error) {
          /* A failed read is reported, never rendered as an empty configuration:
             an empty screen here is indistinguishable from a workspace that maps
             nothing, and somebody would then "fix" it by pressing Save. */
          setError(read?.error ?? "The meter settings could not be loaded.");
          return;
        }
        setError(null);
        setPayload(read);
        setStaged(stage(read));
      })
      .catch(() => {
        if (live) setError("The meter settings could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  const dirty = useMemo(() => {
    if (!payload || !staged) return false;
    return JSON.stringify(body(stage(payload))) !== JSON.stringify(body(staged));
  }, [payload, staged]);

  const moveStatus = useCallback((label: string, meterKey: string) => {
    setStaged((current) =>
      current
        ? {
            ...current,
            statuses: current.statuses.map((status) =>
              status.label === label ? { ...status, meterKey } : status,
            ),
          }
        : current,
    );
    setNotice(null);
  }, []);

  const editMeter = useCallback((key: string, change: Partial<StagedMeter>) => {
    setStaged((current) =>
      current
        ? {
            ...current,
            meters: current.meters.map((meter) =>
              meter.key === key ? { ...meter, ...change } : meter,
            ),
          }
        : current,
    );
    setNotice(null);
  }, []);

  /** Reorder by swapping with the neighbour, then renumbering from zero. */
  const shiftMeter = useCallback((key: string, direction: -1 | 1) => {
    setStaged((current) => {
      if (!current) return current;
      const ordered = [...current.meters].sort((a, b) => a.sortOrder - b.sortOrder);
      const index = ordered.findIndex((meter) => meter.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) return current;
      const swapped = [...ordered];
      [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
      return {
        ...current,
        meters: swapped.map((meter, position) => ({ ...meter, sortOrder: position })),
      };
    });
    setNotice(null);
  }, []);

  const save = useCallback(
    async (reset: boolean) => {
      if (!staged) return;
      setSaving(true);
      setError(null);
      try {
        const response = await fetch("/api/overview/meter-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(reset ? { reset: true } : body(staged)),
        });
        const read = (await response.json().catch(() => null)) as
          | (MeterSettingsPayload & { error?: string; moves?: unknown[] })
          | null;
        if (!response.ok || !read || read.error) {
          setError(read?.error ?? "The meter settings could not be saved.");
          return;
        }
        setPayload(read);
        setStaged(stage(read));
        setConfirmingReset(false);
        const moves = Array.isArray(read.moves) ? read.moves.length : 0;
        setNotice(
          reset
            ? "The meters are back to their defaults."
            : `Saved. ${plural(moves, "status")} moved.`,
        );
        onSaved?.();
      } catch {
        setError("The meter settings could not be saved.");
      } finally {
        setSaving(false);
      }
    },
    [onSaved, staged],
  );

  /* ── The drag ───────────────────────────────────────────────────────────── */

  const drag = useRef<{
    pointerId: number;
    label: string;
    from: string;
    x: number;
    y: number;
    armed: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const [carrying, setCarrying] = useState<{ label: string; over: string | null } | null>(null);

  const endDrag = useCallback(() => {
    if (drag.current?.timer) clearTimeout(drag.current.timer);
    drag.current = null;
    setCarrying(null);
  }, []);

  const onHandleDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, status: StagedStatus) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const mouse = event.pointerType === "mouse";
      drag.current = {
        pointerId: event.pointerId,
        label: status.label,
        from: status.meterKey,
        x: event.clientX,
        y: event.clientY,
        armed: false,
        timer: mouse
          ? null
          : /* Long-press on touch. Shorter and a scroll that happens to begin on
               the handle becomes a drag; longer and the gesture feels broken. */
            setTimeout(() => {
              if (!drag.current) return;
              drag.current.armed = true;
              setCarrying({ label: status.label, over: status.meterKey });
            }, 350),
      };
    },
    [],
  );

  const onHandleMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.armed) {
      // Mouse arms on movement; touch arms on the timer above and ignores this.
      if (event.pointerType !== "mouse") return;
      const moved = Math.abs(event.clientX - state.x) + Math.abs(event.clientY - state.y);
      if (moved < 6) return;
      state.armed = true;
    }
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const target = under?.closest<HTMLElement>("[data-ovt-meter]");
    setCarrying({ label: state.label, over: target?.dataset.ovtMeter ?? null });
  }, []);

  const onHandleUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) {
        endDrag();
        return;
      }
      const over = carrying?.over ?? null;
      if (state.armed && over && over !== state.from) moveStatus(state.label, over);
      endDrag();
    },
    [carrying, endDrag, moveStatus],
  );

  useEffect(() => endDrag, [endDrag]);

  /* ── Render ─────────────────────────────────────────────────────────────── */

  if (error && !payload) {
    return (
      <>
        <link rel="stylesheet" href={toolsCss} precedence="default" />
        <OpsCard title="Dashboard meters">
          <ErrorState what={error} onRetry={reload} />
        </OpsCard>
      </>
    );
  }

  if (!payload || !staged) {
    return (
      <>
        <link rel="stylesheet" href={toolsCss} precedence="default" />
        <OpsCard title="Dashboard meters">
          <SkeletonRow lines={6} height={280} />
        </OpsCard>
      </>
    );
  }

  const ordered = [...staged.meters].sort((a, b) => a.sortOrder - b.sortOrder);
  const countFor = (key: string) =>
    staged.statuses.reduce(
      (sum, status) => (status.meterKey === key ? sum + status.count : sum),
      0,
    );
  const hidden = ordered.filter((meter) => !meter.visible);
  const readOnly = !payload.canEdit;

  return (
    <div className="ovt">
      <link rel="stylesheet" href={toolsCss} precedence="default" />
      <OpsCard
        title="Dashboard meters"
        subtitle={
          <>
            Every status this workspace has ever used belongs to exactly one meter.
            Moving a status here changes how the Overview groups its figures and{" "}
            <strong>alters no job record</strong>.
          </>
        }
      >
        {readOnly ? (
          <p className="ovt__notice" role="status">
            You can see this configuration but not change it. Editing the meters needs the
            Settings capability.
          </p>
        ) : null}

        {/* The live preview — §2.5, drawn from the current period's real counts. */}
        <div className="ovt-preview">
          <h3 className="ovt-preview__title">
            Preview · {plural(payload.cohortTotal, "job")} in the current period
          </h3>
          {/*
            THE PREVIEW DREW THE OPPOSITE OF WHAT THE PAGE DRAWS.

            Its total, its segments and its legend were all filtered to
            `meter.visible`, directly under a caption reading "Hidden from the
            bar, still counted" and a label promising "as this configuration
            would draw it". The Overview does the opposite, and correctly:
            `overview-glance.tsx` builds the bar from EVERY meter and passes
            `total={data.cohortTotal}`, because §2.5 makes hiding a meter remove
            its TILE and not its share of the work. So the one screen whose job
            is to show the consequence of a setting showed a bar the page would
            never draw, and the heading above it used `payload.cohortTotal` — a
            third denominator, different again from the bar beneath it.

            Now the bar is every meter over the cohort total, the same two
            values the page uses, and the hidden note below explains what
            hiding actually does.
          */}
          <SegmentedMeter
            label="At a glance, as this configuration would draw it"
            height={14}
            total={payload.cohortTotal}
            segments={ordered
              .map((meter) => ({
                key: meter.key,
                label: meter.label,
                value: countFor(meter.key),
                colour: meter.colour,
              }))}
          />
          <ul className="ovt-preview__legend">
            {ordered
              .map((meter) => (
                <li key={meter.key}>
                  <span
                    className="ovt-preview__swatch"
                    style={{ background: meter.colour }}
                    aria-hidden="true"
                  />
                  {meter.label} <b>{countFor(meter.key)}</b>
                </li>
              ))}
          </ul>
          {hidden.length ? (
            <p className="ovt-preview__hidden">
              Hidden from the tiles, still in the bar and in the total:{" "}
              {hidden.map((meter) => `${meter.label} ${countFor(meter.key)}`).join(" · ")}
            </p>
          ) : null}
        </div>

        {/* Two columns at 768px and above, one below it — §1.8. */}
        <div className="ovt-grid">
          {ordered.map((meter) => {
            const statuses = staged.statuses
              .filter((status) => status.meterKey === meter.key)
              .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
            const isOver = carrying?.over === meter.key;
            return (
              <section
                key={meter.key}
                className={`ovt-meter${isOver ? " is-over" : ""}${meter.visible ? "" : " is-hidden"}`}
                data-ovt-meter={meter.key}
              >
                <header className="ovt-meter__head">
                  <span
                    className="ovt-meter__swatch"
                    style={{ background: meter.colour }}
                    aria-hidden="true"
                  />
                  <label className="ovt-meter__name">
                    <span className="visually-hidden">Display name for the {meter.key} meter</span>
                    <input
                      type="text"
                      value={meter.label}
                      maxLength={60}
                      disabled={readOnly}
                      onChange={(event) => editMeter(meter.key, { label: event.target.value })}
                    />
                  </label>
                  <span className="ovt-meter__count">{countFor(meter.key)}</span>
                </header>

                <div className="ovt-meter__tools">
                  <button
                    type="button"
                    className="ovt-btn"
                    disabled={readOnly || meter.sortOrder === 0}
                    onClick={() => shiftMeter(meter.key, -1)}
                    aria-label={`Move ${meter.label} earlier`}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="ovt-btn"
                    disabled={readOnly || meter.sortOrder === ordered.length - 1}
                    onClick={() => shiftMeter(meter.key, 1)}
                    aria-label={`Move ${meter.label} later`}
                  >
                    Down
                  </button>
                  {/* `other` is the permanent catch-all: every unmapped status
                      counts there, so hiding it would hide work. The server
                      refuses it too — the UI is not the enforcement. */}
                  <label className="ovt-toggle">
                    <input
                      type="checkbox"
                      checked={meter.visible}
                      disabled={readOnly || meter.isCatchAll}
                      onChange={(event) =>
                        editMeter(meter.key, { visible: event.target.checked })
                      }
                    />
                    <span>{meter.visible ? "Shown" : "Hidden"}</span>
                  </label>
                  {meter.isCatchAll ? (
                    <span className="ovt-meter__pin">Catch-all</span>
                  ) : null}
                </div>

                {statuses.length ? (
                  <ul className="ovt-statuses">
                    {statuses.map((status) => (
                      <li
                        key={status.id}
                        className={`ovt-status${carrying?.label === status.label ? " is-carried" : ""}`}
                      >
                        <button
                          type="button"
                          className="ovt-status__grip"
                          disabled={readOnly}
                          aria-label={`Drag ${status.displayLabel} to another meter`}
                          onPointerDown={(event) => !readOnly && onHandleDown(event, status)}
                          onPointerMove={onHandleMove}
                          onPointerUp={onHandleUp}
                          onPointerCancel={endDrag}
                        >
                          <span className="ovt-status__dots" aria-hidden="true" />
                        </button>
                        <span className="ovt-status__label">
                          {status.displayLabel}
                          <b>{status.count}</b>
                        </span>
                        {/* The tap and keyboard path. See the header. */}
                        <label className="ovt-status__move">
                          <span className="visually-hidden">
                            Move {status.displayLabel} to another meter
                          </span>
                          <select
                            value={status.meterKey}
                            disabled={readOnly}
                            onChange={(event) => moveStatus(status.label, event.target.value)}
                          >
                            {ordered.map((option) => (
                              <option key={option.key} value={option.key}>
                                {option.key === status.meterKey
                                  ? option.label
                                  : `Move to ${option.label}`}
                              </option>
                            ))}
                          </select>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ovt-statuses__empty">
                    No statuses. Drop one here, or pick this meter from a status row.
                  </p>
                )}
              </section>
            );
          })}
        </div>

        {notice ? (
          <p className="ovt__notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="ovt__error" role="alert">
            {error}
          </p>
        ) : null}

        {readOnly ? null : (
          <div className="ovt-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || saving}
              onClick={() => void save(false)}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!dirty || saving}
              onClick={() => {
                setStaged(stage(payload));
                setNotice(null);
              }}
            >
              Discard
            </button>
            {confirmingReset ? (
              <span className="ovt-actions__confirm" role="alertdialog" aria-label="Confirm reset">
                Reset every meter name, order and status assignment to the defaults?
                <button
                  type="button"
                  className="danger-button"
                  disabled={saving}
                  onClick={() => void save(true)}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setConfirmingReset(false)}
                >
                  Keep mine
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="secondary-button"
                disabled={saving}
                onClick={() => setConfirmingReset(true)}
              >
                Reset to defaults
              </button>
            )}
            <span className="ovt-actions__state">
              {dirty ? "Not saved yet — nothing applies until you save." : "Up to date."}
            </span>
          </div>
        )}
      </OpsCard>
    </div>
  );
}
