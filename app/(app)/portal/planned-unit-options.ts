/**
 * The planned-task form's "Linked unit" choices.
 *
 * QA found two faults in the list this replaces: it offered EVERY unit in the
 * workspace whatever Site was chosen above it — so a task at one store could be
 * linked to a boiler at another — and units that share a name ("Boiler",
 * "Boiler") were indistinguishable.
 *
 *   · only the chosen site's units are offered;
 *   · the unit the record is ALREADY linked to stays offered even when it is at
 *     another site, labelled with that site, so opening an old record never
 *     renders a blank select and lets the next Save drop the link silently;
 *   · a name that occurs more than once is followed by what tells the units
 *     apart — serial number, then model, then manufacturer, then a short id.
 */

import type { WorkspaceUnit } from "../../lib/workspace-data";

type UnitLike = Pick<
  WorkspaceUnit,
  "id" | "siteId" | "siteName" | "name" | "serialNumber" | "model" | "manufacturer"
>;

function distinguisher(unit: UnitLike) {
  const serial = unit.serialNumber?.trim();
  if (serial) return `S/N ${serial}`;
  return unit.model?.trim() || unit.manufacturer?.trim() || `#${unit.id.slice(-4)}`;
}

export function plannedUnitOptions(
  units: UnitLike[],
  siteId: string | null | undefined,
  linkedUnitId?: string | null,
): Array<{ value: string; label: string }> {
  const offered = siteId ? units.filter((unit) => unit.siteId === siteId) : units;
  const linked = linkedUnitId
    ? units.find((unit) => unit.id === linkedUnitId && !offered.includes(unit))
    : undefined;
  const counts = new Map<string, number>();
  for (const unit of offered) {
    const key = unit.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const options = offered.map((unit) => ({
    value: unit.id,
    label:
      (counts.get(unit.name.trim().toLowerCase()) ?? 0) > 1
        ? `${unit.name} — ${distinguisher(unit)}`
        : unit.name,
  }));
  if (linked) options.push({ value: linked.id, label: `${linked.name} (at ${linked.siteName})` });
  return [{ value: "", label: "No linked unit" }, ...options];
}
