"use client";

/**
 * A JOB'S TYPE, chosen in the job's drawer — the desktop half.
 *
 * The phone's Columns tab edits the type through the drawer's own option sheet
 * (`MobileMondayColumns` in portal-app.tsx). On a desktop that sheet is not
 * drawn and the drawer's detail cards are read-only, and the grid has no Job
 * type column (it would need a built-in column in `db/monday-board-spec.ts`,
 * which re-seeds every board), so without this a job's type could be chosen
 * when it was raised and never again. One native, labelled `<select>`: the
 * platform's own control is the accessible one, at every width.
 *
 * WHAT IT OFFERS is `jobTypeChoices`: every active type, plus the job's own
 * type if that has since been deactivated — so re-saving never drops what a job
 * was filed under, and a retired type is never offered to anything else. The
 * server enforces the same rule (`resolveJobTypeWrite`); this only avoids
 * offering what it would refuse.
 *
 * It writes through the drawer's own `onFieldsChange` — `PATCH /api/maintenance`
 * with `{ jobTypeId }` — so the change is logged to the job's Activity like any
 * other field. Disabled for a reader without `board.edit`, the capability that
 * PATCH holds; enabled while that answer is unknown, and the server decides.
 */

import { useId, useState } from "react";
import { useCapability } from "../../../lib/client-capabilities";
import { UNCLASSIFIED_LABEL } from "../../../lib/job-type-contract";
import type { MaintenanceRequest } from "../../../lib/types";
import { jobTypeChoices, useJobTypes } from "../use-job-types";

export function JobTypeDrawerField({
  request,
  hidden,
  onFieldsChange,
  onRequestChange,
  onNotify,
}: {
  request: MaintenanceRequest;
  /** The drawer's own tab rule: shown on Columns, kept mounted elsewhere. */
  hidden: boolean;
  onFieldsChange: (fields: Record<string, string | number | null>) => Promise<MaintenanceRequest>;
  onRequestChange: (request: MaintenanceRequest) => void;
  onNotify: (message: string) => void;
}) {
  const { jobTypes, loaded } = useJobTypes();
  const canEdit = useCapability("board.edit");
  const [saving, setSaving] = useState(false);
  const selectId = useId();
  const current = request.jobTypeId ?? "";
  const choices = jobTypeChoices(jobTypes, current || null);
  const known = !current || choices.some((type) => type.id === current);

  const choose = async (value: string) => {
    if (value === current || saving) return;
    setSaving(true);
    try {
      const updated = await onFieldsChange({ jobTypeId: value || null });
      onRequestChange(updated);
      const chosen = jobTypes.find((type) => type.id === value);
      onNotify(`${request.id} is now ${chosen ? chosen.label : UNCLASSIFIED_LABEL}.`);
    } catch (caught) {
      onNotify(caught instanceof Error ? caught.message : "The job type could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={`drawer-section desktop-request-columns${hidden ? " is-tab-hidden" : ""}`}
    >
      {/* `form-field` is the new-request dialog's field — the same themed
          select in light and dark, rather than a fourth copy of its rules. */}
      <label className="form-field" htmlFor={selectId}>
        <span>Job type</span>
        <select
          id={selectId}
          value={current}
          disabled={saving || canEdit === false || (!loaded && !current)}
          onChange={(event) => void choose(event.target.value)}
        >
          <option value="">{UNCLASSIFIED_LABEL}</option>
          {choices.map((type) => (
            <option key={type.id} value={type.id}>
              {type.active ? type.label : `${type.label} (deactivated)`}
            </option>
          ))}
          {/* The job's type before the list has arrived, so the control never
              claims "Unclassified" for a job that has a type. */}
          {!known ? <option value={current}>{loaded ? "Unknown type" : "Loading…"}</option> : null}
        </select>
      </label>
    </section>
  );
}

export default JobTypeDrawerField;
